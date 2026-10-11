import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { resolveReadPathAsync } from "../core/tools/path-utils.ts";
import { detectSupportedImageMimeType } from "../utils/mime.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Terminal drops arrive as paths: shell-escaped words, quoted paths, or file URLs. */
export function imagePathsFromInput(text: string): string[] {
	const candidates: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		// Finder clipboard paths can contain unquoted spaces; try each complete line as well.
		candidates.push(line.trim());
		for (const match of line.matchAll(/(?:^|\s)(@?(?:"[^"\r\n]+"|'[^'\r\n]+'|(?:\\[ \t'"\\]|[^\s])+))/g)) {
			candidates.push(match[1]);
		}
		// Clipboard paths are inserted without quoting, including alongside an existing caption.
		for (const match of line.matchAll(
			/(?:^|\s)(@?(?:\/|~\/|\.\.?\/|[a-z]:[\\/])[^"\r\n]*?\.(?:png|jpe?g|gif|webp|bmp))(?=\s|$)/gi,
		)) {
			candidates.push(match[1]);
		}
	}
	const paths = new Set<string>();
	for (let candidate of candidates) {
		if (candidate.startsWith("@")) candidate = candidate.slice(1);
		if (
			(candidate.startsWith('"') && candidate.endsWith('"')) ||
			(candidate.startsWith("'") && candidate.endsWith("'"))
		) {
			candidate = candidate.slice(1, -1);
		} else if (!/^[a-z]:\\/i.test(candidate)) {
			candidate = candidate.replace(/\\([ \t'"\\])/g, "$1");
		}
		if (!/^(?:\/|~\/|\.\.?\/|[a-z]:[\\/]|file:\/\/)/i.test(candidate)) continue;
		if (IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) paths.add(candidate);
	}
	return [...paths];
}

export default function imageAttachments(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || ctx.mode !== "tui" || /^\/[\w:-]+(?:\s|$)/.test(event.text)) return;
		const paths = imagePathsFromInput(event.text);
		const seen = new Set<string>();
		const images: ImageContent[] = [...(event.images ?? [])];
		let added = 0;
		for (const candidate of paths) {
			try {
				const path = await resolveReadPathAsync(candidate, ctx.cwd);
				if (seen.has(path)) continue;
				seen.add(path);
				const info = await stat(path);
				if (!info.isFile()) continue;
				if (info.size > MAX_ATTACHMENT_BYTES) {
					ctx.ui.notify(`Image exceeds the 20 MiB attachment limit: ${candidate}`, "warning");
					continue;
				}
				const bytes = await readFile(path);
				const mimeType = detectSupportedImageMimeType(bytes);
				if (!mimeType) {
					ctx.ui.notify(`Could not attach image: unsupported image data in ${candidate}`, "warning");
					continue;
				}
				const data = bytes.toString("base64");
				if (images.some((image) => image.mimeType === mimeType && image.data === data)) continue;
				images.push({ type: "image", mimeType, data });
				added++;
			} catch (error) {
				// Whole-line candidates containing prose or multiple paths are expected to miss.
				if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
					if (paths.length === 1) ctx.ui.notify(`Image file not found: ${candidate}`, "warning");
					continue;
				}
				ctx.ui.notify(`Could not attach image: ${candidate}`, "warning");
			}
		}
		if (added === 0) return;
		ctx.ui.notify(`Attached ${added} image${added === 1 ? "" : "s"}`, "info");
		return { action: "transform", text: event.text, images };
	});
}
