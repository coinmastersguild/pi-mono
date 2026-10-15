import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { estimateRequestTokens } from "../../src/core/compaction/compaction.ts";
import { GOAL_ENTRY, readPioneerGoal } from "../../src/core/pioneer-goal.ts";
import pioneerGoalExtension from "../../src/extensions/pioneer-goal.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("working context budget", () => {
	it("counts the declared tool catalog in the request budget", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "large_catalog",
					label: "Large catalog",
					description: "description".repeat(14000),
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Must not run")]);
		await harness.session.prompt("Small prompt");
		expect(harness.faux.state.callCount).toBe(0);
	});
	it("compacts a large-window model around 24k and retains recent work and raw history", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		for (let index = 0; index < 4; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `history-${index}:`.padEnd(32000, "x") }],
				timestamp: Date.now() - 1000,
			});
			harness.sessionManager.appendMessage(
				fauxAssistantMessage(`Checked step ${index}`, { timestamp: Date.now() - 500 }),
			);
		}
		harness.session.refreshContext();
		const oldCount = harness.sessionManager.getEntries().length;
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("<conversation>");
				return fauxAssistantMessage(
					"Checkpoint: preserve the requested fix, completed steps, and pending verification.",
				);
			},
			(context) => {
				const text = JSON.stringify(context.messages);
				expect(text).toContain("Checkpoint:");
				expect(text).toContain("history-3:");
				expect(text).not.toContain("history-0:");
				return fauxAssistantMessage("Continued from checkpoint");
			},
		]);
		await harness.session.prompt("Continue the verified fix");
		expect(harness.eventsOfType("compaction_start")).toContainEqual({
			type: "compaction_start",
			reason: "threshold",
		});
		expect(estimateRequestTokens(harness.session.messages)).toBeLessThan(32768);
		expect(harness.sessionManager.getEntries().length).toBeGreaterThan(oldCount);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("history-0:");
		expect(harness.session.getContextUsage()?.contextWindow).toBe(32768);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([true, false])(
		"rejects an oversized single prompt without calling the provider (auto=%s)",
		async (enabled) => {
			const harness = await createHarness({ tools: [], settings: { compaction: { enabled } } });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("Must not run")]);
			await harness.session.prompt("x".repeat(140000));
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "error",
				errorMessage: expect.stringContaining("Pioneer working context exceeds"),
			});
		},
	);

	it("checks context added by extensions before any provider request", async () => {
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => ({
						messages: [
							...event.messages,
							{
								role: "user",
								content: [{ type: "text", text: "injected".repeat(20000) }],
								timestamp: Date.now(),
							},
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Must not run")]);
		await harness.session.prompt("Small prompt");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("counts forced system prompts in the request budget", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt: "large-system".repeat(13000) }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Must not run")]);
		await harness.session.prompt("Small prompt");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("allows an explicit opt-out or per-model larger budget", async () => {
		for (const maxContextTokens of [0, 65536]) {
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false, modelOverrides: { "faux/faux-1": { maxContextTokens } } } },
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("Allowed by explicit setting")]);
			await harness.session.prompt("x".repeat(140000));
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.getLastAssistantText()).toBe("Allowed by explicit setting");
		}
	});

	it("retains the live goal after compaction removes its earlier instructions", async () => {
		const harness = await createHarness({
			settings: { compaction: { maxContextTokens: 8192, reserveTokens: 2048, keepRecentTokens: 100 } },
			extensionFactories: [
				pioneerGoalExtension,
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Checkpoint: verification remains",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("Progress report ".repeat(1800)),
			(context) => {
				const text = JSON.stringify(context.messages);
				expect(text).toContain("The user explicitly enabled goal mode");
				expect(text).toContain("Verify the goal after compaction");
				const entry = harness.sessionManager
					.getBranch()
					.findLast((item) => item.type === "custom" && item.customType === GOAL_ENTRY);
				if (entry?.type !== "custom") throw new Error("Goal state missing");
				const goal = readPioneerGoal(entry.data);
				return fauxAssistantMessage(
					fauxToolCall("goal_update", {
						goalId: goal.id,
						status: "complete",
						summary: "Goal survived compaction",
						evidence: ["Checkpoint and current goal were present in the request"],
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Verified"),
		]);
		const settled = new Promise<void>((resolve) => {
			const stop = harness.session.subscribe((event) => {
				if (event.type === "agent_settled") {
					stop();
					resolve();
				}
			});
		});
		await harness.session.prompt("/goal Verify the goal after compaction");
		await settled;
		expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(0);
		const entry = harness.sessionManager
			.getBranch()
			.findLast((item) => item.type === "custom" && item.customType === GOAL_ENTRY);
		if (entry?.type !== "custom") throw new Error("Goal state missing");
		expect(readPioneerGoal(entry.data).status).toBe("complete");
	});
});
