import type { ToolInfo } from "../extensions/types.ts";
import type { AnalyticClient, AnalyticQuestion } from "./client.ts";

export interface RetrievalDocument {
	id: string;
	text: string;
	source: string;
	parentId?: string | null;
	metadata?: Record<string, unknown>;
}

const STOP_WORDS = new Set(["a", "an", "and", "for", "in", "is", "of", "on", "or", "the", "to", "with"]);

export function tokenize(value: string): string[] {
	return [...new Set(value.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? [])].filter((token) => !STOP_WORDS.has(token));
}

export function rankLexically(query: string, documents: RetrievalDocument[]): RetrievalDocument[] {
	const terms = tokenize(query);
	return documents
		.map((document, index) => {
			const haystack = document.text.toLowerCase();
			const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
			return { document, score, index };
		})
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ document }) => document);
}

export async function rerankWithAnalytic(
	query: string,
	documents: RetrievalDocument[],
	client: AnalyticClient,
	signal?: AbortSignal,
): Promise<RetrievalDocument[]> {
	const candidates = documents.slice(0, 24);
	if (candidates.length === 0) return [];
	const questions: Record<string, AnalyticQuestion> = {};
	for (const [index] of candidates.entries()) {
		questions[`candidate_${index}`] = {
			type: "noul",
			instructions: `Is candidate ${index} useful evidence for the current task?`,
		};
	}
	const state = [
		{ role: "user", content: `Current task:\n${query.slice(0, 8000)}` },
		...candidates.map((document, index) => ({
			role: "user",
			content: `Candidate ${index} (${document.source}):\n${document.text.slice(0, 1400)}`,
		})),
	];
	const result = await client.evaluate(state, questions, signal);
	return candidates
		.map((document, index) => {
			const answer = result.answers[`candidate_${index}`];
			return { document, score: answer?.type === "noul" ? answer.noul : 0 };
		})
		.sort((a, b) => b.score - a.score)
		.map(({ document }) => document);
}

export interface SelectToolsOptions {
	limit?: number;
	shortlist?: number;
	score?: (candidates: RetrievalDocument[]) => Promise<Map<string, number>>;
}

export async function selectTools(
	task: string,
	tools: ToolInfo[],
	options: SelectToolsOptions = {},
): Promise<ToolInfo[]> {
	const limit = options.limit ?? 12;
	const documents = tools.map((tool) => ({
		id: tool.name,
		source: tool.name,
		text: `${tool.name}\n${tool.description}`,
	}));
	const lexical = rankLexically(task, documents).slice(0, options.shortlist ?? 24);
	const scores = options.score ? await options.score(lexical) : new Map<string, number>();
	const exactNames = new Set(
		tools
			.filter((tool) => new RegExp(`\\b${tool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(task))
			.map((tool) => tool.name),
	);
	const ordered = lexical.sort((a, b) => {
		if (exactNames.has(a.id) !== exactNames.has(b.id)) return exactNames.has(a.id) ? -1 : 1;
		return (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
	});
	const selected = new Set(ordered.slice(0, limit).map((document) => document.id));
	return ordered.flatMap((document) => {
		const tool = tools.find((candidate) => candidate.name === document.id);
		return tool && selected.has(document.id) ? [tool] : [];
	});
}
