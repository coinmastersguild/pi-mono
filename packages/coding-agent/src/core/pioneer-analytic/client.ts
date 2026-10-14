const DEFAULT_ENDPOINT = "https://alpha.pioneers.dev/api/v1/analytic";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_STATE_ITEMS = 64;
const MAX_QUESTIONS = 32;

export type AnalyticState = { role: string; content: string };
export type AnalyticQuestion =
	| { type: "noul"; instructions: string }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };
export type AnalyticAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
	| {
			type: "score";
			score: number;
			probabilities: Record<string, number>;
			legend?: Record<string, string>;
			confidence?: number;
	  };

export interface AnalyticResult {
	answers: Record<string, AnalyticAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
	creditsCharged?: number;
}

export interface AnalyticClientOptions {
	apiKey: string;
	endpoint?: string;
	model?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

function assertProbability(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`Pioneer Analytic returned invalid ${label}`);
	}
}

function validateAnswer(key: string, question: AnalyticQuestion, raw: unknown): AnalyticAnswer {
	if (!raw || typeof raw !== "object") throw new Error(`Pioneer Analytic omitted answer ${key}`);
	const answer = raw as Record<string, unknown>;
	if (answer.type !== question.type) throw new Error(`Pioneer Analytic returned wrong type for ${key}`);
	if (question.type === "noul") {
		assertProbability(answer.noul, "noul probability");
		return { type: "noul", noul: answer.noul };
	}
	if (!answer.probabilities || typeof answer.probabilities !== "object") {
		throw new Error(`Pioneer Analytic returned invalid probabilities for ${key}`);
	}
	const probabilities = answer.probabilities as Record<string, unknown>;
	for (const [probabilityKey, value] of Object.entries(probabilities))
		assertProbability(value, `${key}.${probabilityKey}`);
	if (question.type === "choice") {
		if (typeof answer.choice !== "string" || !(answer.choice in question.criteria)) {
			throw new Error(`Pioneer Analytic returned unknown choice for ${key}`);
		}
		for (const criterion of Object.keys(question.criteria)) {
			if (!(criterion in probabilities)) throw new Error(`Pioneer Analytic omitted choice probability ${criterion}`);
		}
		return {
			type: "choice",
			choice: answer.choice,
			probabilities: probabilities as Record<string, number>,
			confidence: typeof answer.confidence === "number" ? answer.confidence : undefined,
		};
	}
	if (
		typeof answer.score !== "number" ||
		!Number.isFinite(answer.score) ||
		answer.score < 0 ||
		answer.score > question.criteria.length - 1
	) {
		throw new Error(`Pioneer Analytic returned invalid score for ${key}`);
	}
	return {
		type: "score",
		score: answer.score,
		probabilities: probabilities as Record<string, number>,
		legend: answer.legend as Record<string, string> | undefined,
		confidence: typeof answer.confidence === "number" ? answer.confidence : undefined,
	};
}

export class AnalyticClient {
	private readonly options: Required<Omit<AnalyticClientOptions, "fetch">> & { fetch: typeof fetch };

	constructor(options: AnalyticClientOptions) {
		this.options = {
			apiKey: options.apiKey,
			endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
			model: options.model ?? "analytic-latest",
			timeoutMs: options.timeoutMs ?? 1500,
			fetch: options.fetch ?? fetch,
		};
	}

	async evaluate(
		state: AnalyticState[],
		questions: Record<string, AnalyticQuestion>,
		signal?: AbortSignal,
	): Promise<AnalyticResult> {
		if (state.length === 0 || state.length > MAX_STATE_ITEMS)
			throw new Error("Pioneer Analytic state must contain 1-64 items");
		const entries = Object.entries(questions);
		if (entries.length === 0 || entries.length > MAX_QUESTIONS)
			throw new Error("Pioneer Analytic requires 1-32 questions");
		const body = JSON.stringify({ model: this.options.model, state, questions });
		if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("Pioneer Analytic request exceeds 64 KiB");
		const timeout = AbortSignal.timeout(this.options.timeoutMs);
		const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const response = await this.options.fetch(this.options.endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
			body,
			signal: combinedSignal,
		});
		if (!response.ok) throw new Error(`Pioneer Analytic request failed (${response.status})`);
		const payload = (await response.json()) as { answers?: Record<string, unknown>; usage?: AnalyticResult["usage"] };
		if (!payload.answers) throw new Error("Pioneer Analytic response has no answers");
		const answers: Record<string, AnalyticAnswer> = {};
		for (const [key, question] of entries) answers[key] = validateAnswer(key, question, payload.answers[key]);
		const creditsHeader = response.headers.get("x-pioneer-credits-charged");
		return {
			answers,
			usage: payload.usage,
			creditsCharged: creditsHeader ? Number.parseInt(creditsHeader, 10) : undefined,
		};
	}
}
