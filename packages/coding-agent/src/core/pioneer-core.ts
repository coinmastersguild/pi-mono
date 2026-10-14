import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export class PioneerCoreError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface CoreQuestion {
	type: "noul";
	instructions: string;
}

/** Core credentials stay in files; this client never falls back to cloud analytics or discovery credentials. */
export class PioneerCoreClient {
	private readonly discoveryPath: string;
	private readonly tokenPath: string | undefined;
	private readonly request: typeof fetch;
	constructor(options: { discoveryPath?: string; tokenPath?: string; fetch?: typeof fetch } = {}) {
		this.discoveryPath = options.discoveryPath ?? join(homedir(), ".pioneer", "agent-api", "discovery.json");
		this.tokenPath = options.tokenPath ?? process.env.PIONEER_CORE_AGENT_TOKEN_FILE;
		this.request = options.fetch ?? fetch;
	}

	async call(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		if (!this.tokenPath) throw new PioneerCoreError(401, "Core: awaiting approved connection");
		if (!path.startsWith("/v1/") || path.startsWith("//")) throw new Error("Invalid Core API path");
		const discovery: unknown = JSON.parse(await readFile(this.discoveryPath, "utf8"));
		if (!discovery || typeof discovery !== "object" || !("url" in discovery) || typeof discovery.url !== "string")
			throw new Error("Invalid Core discovery");
		const origin = new URL(discovery.url);
		if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password)
			throw new Error("Core must use local loopback HTTP");
		const token = (await readFile(this.tokenPath, "utf8")).trim();
		if (!token || /[\r\n]/.test(token)) throw new Error("Invalid Core token file");
		const response = await this.request(origin.origin + path, {
			method: body === undefined ? "GET" : "POST",
			redirect: "error",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
		});
		if (!response.ok) {
			const messages: Record<number, string> = {
				401: "Core: scoped token required",
				403: "Core: check access grants",
				423: "Core: unlock vault in app",
				429: "Core: analytics queue busy",
				503: "Core: evaluator unavailable",
			};
			throw new PioneerCoreError(
				response.status,
				messages[response.status] ?? `Core: request failed (${response.status})`,
			);
		}
		return response.json();
	}

	async evaluate(
		text: string,
		questions: Record<string, CoreQuestion>,
		signal?: AbortSignal,
	): Promise<Record<string, number>> {
		const entries = Object.entries(questions);
		if (
			!text.length ||
			text.length > 2000 ||
			!entries.length ||
			entries.length > 4 ||
			entries.some(
				([key, q]) =>
					!/^[a-z][a-z0-9_]{0,30}$/.test(key) ||
					q.type !== "noul" ||
					!q.instructions.length ||
					q.instructions.length > 3000,
			)
		)
			throw new Error("Core analytics request exceeds typed API limits");
		const payload = await this.call("/v1/analytic/evaluate", { text, questions }, signal);
		if (
			!payload ||
			typeof payload !== "object" ||
			!("answers" in payload) ||
			!payload.answers ||
			typeof payload.answers !== "object"
		)
			throw new Error("Invalid Core analytics response");
		const answers: Record<string, number> = {};
		for (const [key] of entries) {
			const answer: unknown = (payload.answers as Record<string, unknown>)[key];
			if (typeof answer !== "number" || !Number.isFinite(answer) || answer < 0 || answer > 1)
				throw new Error("Invalid Core probability");
			answers[key] = answer;
		}
		return answers;
	}
}
