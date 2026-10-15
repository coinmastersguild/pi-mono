import type { RetrievalDocument } from "./retrieval.ts";
import { rankLexically } from "./retrieval.ts";

const EXCLUDED_PATHS = /(^|\/)(node_modules|dist|build|coverage|\.git|vendor)(\/|$)|\.(min\.js|map|lock)$/i;

export interface TextFile {
	path: string;
	content: string;
}

export function buildCodeCandidates(files: TextFile[]): RetrievalDocument[] {
	return files
		.filter((file) => !EXCLUDED_PATHS.test(file.path))
		.filter((file) => file.content.trim().length > 0)
		.map((file) => ({
			id: file.path,
			source: file.path,
			text: `${file.path}\n${file.content.slice(0, 6000)}`,
		}));
}

export function buildGuildCandidates(files: TextFile[], task: string): RetrievalDocument[] {
	const documents = files
		.filter((file) => file.path.endsWith(".md"))
		.map((file) => ({ id: file.path, source: file.path, text: `${file.path}\n${file.content.slice(0, 6000)}` }));
	return rankLexically(task, documents);
}
