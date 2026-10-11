import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "../src/core/extensions/types.ts";
import imageAttachments, { imagePathsFromInput } from "../src/extensions/image-attachments.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1cAAAAASUVORK5CYII=",
	"base64",
);
let directory: string;
let handleInput: (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | undefined>;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-image-drop-"));
	imageAttachments({
		on: (_event: string, handler: typeof handleInput) => {
			handleInput = handler;
		},
	} as unknown as ExtensionAPI);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function context() {
	return {
		mode: "tui",
		cwd: directory,
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
}

describe("terminal image drops", () => {
	it.each([
		['Review "/tmp/My Photos/photo.png"', "/tmp/My Photos/photo.png"],
		["Review '/tmp/My Photos/photo.jpg'", "/tmp/My Photos/photo.jpg"],
		["Review /tmp/My\\ Photos/photo.png", "/tmp/My Photos/photo.png"],
		["Review /tmp/My Photos/photo.png", "/tmp/My Photos/photo.png"],
		['Review @"/tmp/My Photos/photo.png"', "/tmp/My Photos/photo.png"],
		['Review "C:\\My Photos\\photo.PNG"', "C:\\My Photos\\photo.PNG"],
		["Review C:\\Photos\\photo.png", "C:\\Photos\\photo.png"],
		["Review ./photo.webp", "./photo.webp"],
		["Review ~/photo.gif", "~/photo.gif"],
	])("parses %s", (text, path) => {
		expect(imagePathsFromInput(text)).toEqual([path]);
	});

	it("ignores remote URLs, prose, and non-image paths", () => {
		expect(imagePathsFromInput("Look at https://example.com/photo.png and /tmp/data.txt")).toEqual([]);
		expect(imagePathsFromInput("Look at image.png")).toEqual([]);
	});

	it.each(["escaped", "quoted", "file URL", "Finder clipboard"])(
		"attaches image bytes from a %s path",
		async (format) => {
			const path = join(directory, "Screenshot 2026-10-10 at 1.00.00 PM.png");
			await writeFile(path, png);
			const input =
				format === "escaped"
					? path.replaceAll(" ", "\\ ")
					: format === "quoted"
						? `"${path}"`
						: format === "file URL"
							? pathToFileURL(path).href
							: path;
			const ctx = context();
			const result = await handleInput({ type: "input", text: input, source: "interactive" }, ctx);
			expect(result).toEqual({
				action: "transform",
				text: input,
				images: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
			});
			expect(ctx.ui.notify).toHaveBeenCalledWith("Attached 1 image", "info");
		},
	);

	it("preserves prompt text and existing attachments, and deduplicates repeated paths", async () => {
		const path = join(directory, "photo.png");
		await writeFile(path, png);
		const existing = { type: "image" as const, mimeType: "image/jpeg", data: "existing" };
		const text = `Compare these ${path} "${path}" ${pathToFileURL(path).href}`;
		const result = await handleInput({ type: "input", text, source: "interactive", images: [existing] }, context());
		expect(result).toEqual({
			action: "transform",
			text,
			images: [existing, { type: "image", mimeType: "image/png", data: png.toString("base64") }],
		});
	});

	it("attaches an unquoted clipboard path alongside a caption", async () => {
		const path = join(directory, "My screenshot.png");
		await writeFile(path, png);
		const text = `What is wrong with this? ${path}`;
		expect(await handleInput({ type: "input", text, source: "interactive" }, context())).toEqual({
			action: "transform",
			text,
			images: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
		});
	});

	it("keeps incidental path-like prose as text when the candidate is not a file", async () => {
		const text = `Look at ${directory}/data.txt or image.png`;
		expect(await handleInput({ type: "input", text, source: "interactive" }, context())).toBeUndefined();
	});

	it("warns when a dropped image is missing", async () => {
		const ctx = context();
		const text = join(directory, "missing.png");
		expect(await handleInput({ type: "input", text, source: "interactive" }, ctx)).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(`Image file not found: ${text}`, "warning");
	});

	it("attaches multiple images in order", async () => {
		const first = join(directory, "first.png");
		const second = join(directory, "second.gif");
		const gif = Buffer.from("GIF89a");
		await writeFile(first, png);
		await writeFile(second, gif);
		const text = `${first}\n${second}`;
		expect(await handleInput({ type: "input", text, source: "interactive" }, context())).toEqual({
			action: "transform",
			text,
			images: [
				{ type: "image", mimeType: "image/png", data: png.toString("base64") },
				{ type: "image", mimeType: "image/gif", data: gif.toString("base64") },
			],
		});
	});

	it("does not attach files for extension, RPC, or slash-command input", async () => {
		const path = join(directory, "photo.png");
		await writeFile(path, png);
		for (const source of ["extension", "rpc"] as const) {
			expect(await handleInput({ type: "input", text: path, source }, context())).toBeUndefined();
		}
		expect(
			await handleInput({ type: "input", text: `/command ${path}`, source: "interactive" }, context()),
		).toBeUndefined();
	});

	it("warns when image contents do not match a supported format", async () => {
		const path = join(directory, "fake.png");
		await writeFile(path, "plain text");
		const ctx = context();
		expect(await handleInput({ type: "input", text: path, source: "interactive" }, ctx)).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("unsupported image data"), "warning");
	});
});
