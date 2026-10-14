import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { RetrievalDocument } from "./retrieval.ts";

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(
				part &&
					typeof part === "object" &&
					(part as { type?: string }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			),
		)
		.map((part) => part.text)
		.join("\n");
}

export function extractSessionDocuments(lines: string[]): RetrievalDocument[] {
	let sessionId = "unknown";
	const documents: RetrievalDocument[] = [];
	for (const line of lines) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "session" && typeof entry.id === "string") {
			sessionId = entry.id;
			continue;
		}
		if (entry.type !== "message" || typeof entry.id !== "string") continue;
		const text = messageText(entry.message);
		if (!text.trim()) continue;
		documents.push({
			id: `${sessionId}:${entry.id}`,
			text,
			source: `${sessionId}.jsonl`,
			parentId: typeof entry.parentId === "string" ? entry.parentId : null,
			metadata: { parentId: typeof entry.parentId === "string" ? entry.parentId : null },
		});
	}
	return documents;
}

async function readSessionFile(path: string, remaining: number): Promise<RetrievalDocument[]> {
	let header: string | undefined;
	const lines: string[] = [];
	const reader = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of reader) {
		if (!header) {
			header = line;
			continue;
		}
		lines.push(line);
		if (lines.length > remaining) lines.shift();
	}
	return extractSessionDocuments(header ? [header, ...lines] : lines).map((document) => ({
		...document,
		source: path,
	}));
}

export async function loadSessionHistory(sessionDir: string, maxDocuments = 2000): Promise<RetrievalDocument[]> {
	if (!existsSync(sessionDir)) return [];
	const paths = readdirSync(sessionDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(sessionDir, name))
		.sort((a, b) => {
			try {
				return statSync(b).mtimeMs - statSync(a).mtimeMs;
			} catch {
				return 0;
			}
		});
	const documents: RetrievalDocument[] = [];
	for (const path of paths) {
		if (documents.length >= maxDocuments) break;
		documents.push(...(await readSessionFile(path, maxDocuments - documents.length)));
	}
	return documents.slice(0, maxDocuments);
}
