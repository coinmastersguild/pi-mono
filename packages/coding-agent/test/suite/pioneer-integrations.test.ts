import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createPioneerAnalyticExtension } from "../../src/core/pioneer-analytic/extension.ts";
import { PioneerCoreClient } from "../../src/core/pioneer-core.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import pioneerCoreExtension from "../../src/extensions/pioneer-core.ts";
import { createHarness, getMessageText, getToolResult } from "./harness.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("lets the harness save/retrieve long-term Core findings and request typed local analytics", async () => {
	const call = vi.spyOn(PioneerCoreClient.prototype, "call").mockImplementation(async (path, body) => {
		if (path === "/v1/memory") return { saved: true, finding: body };
		if (path.startsWith("/v1/memory/search"))
			return { items: [{ text: "Use a local repository", source: "user decision" }] };
		if (path === "/v1/analytic/evaluate") return { answers: { review: 0.75 } };
		throw new Error(`Unexpected Core route: ${path}`);
	});
	const harness = await createHarness({
		extensionFactories: [pioneerCoreExtension],
		initialActiveToolNames: ["core_memory_save", "core_memory_search", "core_analytic_evaluate"],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("core_memory_save", {
					namespace: "test",
					key: "git",
					text: "Use a local repository",
					source: "user decision",
					author: "user",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("core_memory_search", { namespace: "test", query: "repository" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("core_analytic_evaluate", {
					text: "Changed persistence code",
					questions: { review: { type: "noul", instructions: "Does this need review?" } },
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Save the sourced finding, recall it, and evaluate whether this work needs review.");
		for (const name of ["core_memory_save", "core_memory_search", "core_analytic_evaluate"])
			expect(getToolResult(harness, name).isError).toBe(false);
		expect(getMessageText(getToolResult(harness, "core_memory_search"))).toContain("Use a local repository");
		expect(getMessageText(getToolResult(harness, "core_analytic_evaluate"))).toContain("0.75");
		expect(call).toHaveBeenCalledTimes(3);
	} finally {
		harness.cleanup();
	}
});

it("uses saved Pioneer credentials for Alpha decisions and keeps Core recall available", async () => {
	vi.stubEnv("PI_OFFLINE", "0");
	vi.stubEnv("PIONEER_API_KEY", "");
	vi.stubEnv("PIONEER_JWT", "");
	vi.stubEnv("PIONEER_ANALYTIC_ENABLED", "");
	vi.spyOn(PioneerCoreClient.prototype, "call").mockResolvedValue({
		items: [{ text: "Previously verified decision" }],
	});
	const request = vi.fn<typeof fetch>(async (_url, options) => {
		const body = JSON.parse(String(options?.body)) as { questions: Record<string, { type: string }> };
		return Response.json({
			answers: Object.fromEntries(
				Object.entries(body.questions).map(([key, question]) => [key, { type: question.type, noul: 0.8 }]),
			),
		});
	});
	vi.stubGlobal("fetch", request);
	const state = await mkdtemp(join(tmpdir(), "pioneer-analytic-harness-"));
	directories.push(state);
	const harness = await createHarness({
		extensionFactories: [pioneerCoreExtension, createPioneerAnalyticExtension],
		initialActiveToolNames: ["core_memory_search"],
		sessionManager: SessionManager.create(state, join(state, "sessions")),
	});
	const key = `sk-pioneer-${"b".repeat(64)}`;
	try {
		await harness.authStorage.modify("pioneer", async () => ({ type: "api_key", key }));
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("core_memory_search", { namespace: "test", query: "decision" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Found the decision"),
		]);
		await harness.session.prompt("Use core_memory_search to recall the previously verified decision.");
		expect(getToolResult(harness, "core_memory_search").isError).toBe(false);
		expect(request).toHaveBeenCalled();
		expect(request.mock.calls[0][0]).toBe("https://alpha.pioneers.dev/api/v1/analytic");
		expect(request.mock.calls[0][1]?.headers).toMatchObject({ authorization: `Bearer ${key}` });
		expect(harness.session.getActiveToolNames()).toContain("core_memory_search");
	} finally {
		harness.cleanup();
	}
});
