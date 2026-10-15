import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { analyticEnabled } from "../src/core/pioneer-analytic/extension.ts";
import {
	AnalyticClient,
	buildCodeCandidates,
	buildGuildCandidates,
	classifyToolRisk,
	extractSessionDocuments,
	rankLexically,
	selectTools,
} from "../src/core/pioneer-analytic/index.ts";

describe("Pioneer Analytic client", () => {
	it("uses resolved Pioneer credentials by default and honors explicit analytics disable", () => {
		vi.stubEnv("PIONEER_ANALYTIC_ENABLED", "");
		expect(analyticEnabled("saved-login-key")).toBe(true);
		expect(analyticEnabled()).toBe(false);
		vi.stubEnv("PIONEER_ANALYTIC_ENABLED", "0");
		expect(analyticEnabled("saved-login-key")).toBe(false);
		expect(analyticEnabled("saved-login-key", true)).toBe(true);
		vi.unstubAllEnvs();
	});
	it("validates typed answers", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						answers: {
							tool_read: { type: "noul", noul: 0.91 },
						},
						usage: { input_tokens: 12, output_tokens: 1 },
					}),
					{ status: 200 },
				),
		);
		const client = new AnalyticClient({ apiKey: "TEST_KEY", fetch: fetchMock });
		const result = await client.evaluate([{ role: "user", content: "read a file" }], {
			tool_read: { type: "noul", instructions: "Is read useful?" },
		});

		expect(result.answers.tool_read).toEqual({ type: "noul", noul: 0.91 });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://alpha.pioneers.dev/api/v1/analytic",
			expect.objectContaining({
				headers: expect.objectContaining({ authorization: "Bearer TEST_KEY" }),
			}),
		);
	});

	it("rejects malformed probabilities", async () => {
		const client = new AnalyticClient({
			apiKey: "TEST_KEY",
			fetch: async () =>
				new Response(JSON.stringify({ answers: { unsafe: { type: "noul", noul: 2 } } }), { status: 200 }),
		});
		await expect(
			client.evaluate([{ role: "user", content: "state" }], { unsafe: { type: "noul", instructions: "Unsafe?" } }),
		).rejects.toThrow("invalid noul");
	});
});

describe("Pioneer Analytic retrieval", () => {
	it("selects exact and analytic-ranked tools", async () => {
		const sourceInfo = { path: "test", source: "TEST", scope: "temporary" as const, origin: "top-level" as const };
		const tools = [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({}),
				exposure: "direct" as const,
				sourceInfo,
			},
			{
				name: "bash",
				description: "Execute a shell command",
				parameters: Type.Object({}),
				exposure: "direct" as const,
				sourceInfo,
			},
			{
				name: "weather",
				description: "Get a weather forecast",
				parameters: Type.Object({}),
				exposure: "direct" as const,
				sourceInfo,
			},
		];
		const selected = await selectTools("please use read to inspect code", tools, {
			limit: 2,
			score: async (candidates) =>
				new Map(candidates.map((candidate) => [candidate.id, candidate.id === "bash" ? 0.8 : 0.2])),
		});
		expect(selected.map((tool) => tool.name)).toEqual(["read", "bash"]);
	});

	it("ranks history locally when analytics is unavailable", () => {
		const ranked = rankLexically("typescript auth failure", [
			{ id: "1", text: "CSS button colors", source: "a" },
			{ id: "2", text: "TypeScript authentication failure in middleware", source: "b" },
		]);
		expect(ranked[0]?.id).toBe("2");
	});

	it("preserves session ancestry metadata", () => {
		const docs = extractSessionDocuments([
			JSON.stringify({ type: "session", id: "s1", cwd: "/repo" }),
			JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "first" } }),
			JSON.stringify({
				type: "message",
				id: "b",
				parentId: "a",
				message: { role: "assistant", content: [{ type: "text", text: "done" }] },
			}),
		]);
		expect(docs).toMatchObject([
			{ id: "s1:a", parentId: null, text: "first" },
			{ id: "s1:b", parentId: "a", text: "done" },
		]);
	});
});

describe("Pioneer Analytic triage and guardrails", () => {
	it("builds source candidates while excluding generated files", () => {
		const candidates = buildCodeCandidates([
			{ path: "src/auth.ts", content: "export function authenticate() {}" },
			{ path: "dist/auth.js", content: "generated" },
		]);
		expect(candidates.map((candidate) => candidate.source)).toEqual(["src/auth.ts"]);
	});

	it("finds applicable guild documents", () => {
		const candidates = buildGuildCandidates(
			[
				{ path: "docs/guild/security.md", content: "Review authentication and secret handling" },
				{ path: "docs/guild/css.md", content: "Use design tokens" },
			],
			"JWT authentication",
		);
		expect(candidates[0]?.source).toBe("docs/guild/security.md");
	});

	it("keeps deterministic critical risk as the floor", () => {
		expect(classifyToolRisk("bash", { command: "rm -rf /" })).toMatchObject({ level: 4, block: true });
		expect(classifyToolRisk("write", { path: ".env", content: "secret" })).toMatchObject({ level: 4, block: true });
	});
});
