import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPioneerAnalyticExtension } from "../../src/core/pioneer-analytic/extension.ts";
import { GOAL_ENTRY, type PioneerGoal, readPioneerGoal } from "../../src/core/pioneer-goal.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import pioneerGoalExtension from "../../src/extensions/pioneer-goal.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
});

function goalState(harness: Harness): PioneerGoal {
	const entry = harness.sessionManager
		.getBranch()
		.findLast((item) => item.type === "custom" && item.customType === GOAL_ENTRY);
	if (entry?.type !== "custom") throw new Error("No persisted goal");
	return readPioneerGoal(entry.data);
}

async function goalHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [pioneerGoalExtension], ...options });
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return harness;
}

async function runGoal(harness: Harness, command: string): Promise<void> {
	const settled = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_settled") {
				unsubscribe();
				resolve();
			}
		});
	});
	await harness.session.prompt(command);
	await settled;
}

function update(harness: Harness, status: "progress" | "complete" | "blocked", summary: string, evidence?: string[]) {
	return fauxAssistantMessage(
		fauxToolCall("goal_update", {
			goalId: goalState(harness).id,
			status,
			summary,
			...(evidence ? { evidence } : {}),
		}),
		{ stopReason: "toolUse" },
	);
}

describe("Pioneer goal mode", () => {
	it("writes and reads actual files, continues after an interim reply, and saves completion evidence", async () => {
		const harness = await goalHarness({ initialActiveToolNames: ["read", "write", "goal_update"] });
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("goal_update");
				expect(JSON.stringify(context.messages)).toContain("Write and verify the result file");
				return fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "verified goal\n" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(fauxToolCall("read", { path: "result.txt" }), { stopReason: "toolUse" }),
			() => {
				expect(getMessageText(getToolResult(harness, "read"))).toBe("verified goal\n");
				return update(harness, "progress", "File written and read back");
			},
			fauxAssistantMessage("The file is ready; verification is next."),
			(context) => {
				expect(JSON.stringify(context.messages).match(/The user explicitly enabled goal mode/g)).toHaveLength(1);
				return update(harness, "complete", "Verified the requested result", [
					"read result.txt returned verified goal",
				]);
			},
			fauxAssistantMessage("Completed and verified."),
		]);
		await runGoal(harness, "/goal Write and verify the result file");
		expect(readFileSync(join(harness.tempDir, "result.txt"), "utf8")).toBe("verified goal\n");
		expect(goalState(harness)).toMatchObject({
			status: "complete",
			turns: 5,
			evidence: ["read result.txt returned verified goal"],
		});
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("rejects completion without evidence and allows the model to correct it", async () => {
		const harness = await goalHarness();
		harness.setResponses([
			() => update(harness, "complete", "Done"),
			() => {
				expect(getToolResult(harness, "goal_update").isError).toBe(true);
				expect(goalState(harness).status).toBe("active");
				return update(harness, "complete", "Verified", ["The requested answer was checked against the fixture"]);
			},
			fauxAssistantMessage("Verified."),
		]);
		await runGoal(harness, "/goal Check the fixture");
		expect(goalState(harness).status).toBe("complete");
	});

	it("stops on an explicit blocker and rejects stale goal IDs", async () => {
		const harness = await goalHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("goal_update", {
					goalId: "another-goal",
					status: "complete",
					summary: "Done",
					evidence: ["Unrelated check"],
				}),
				{ stopReason: "toolUse" },
			),
			() => {
				expect(getToolResult(harness, "goal_update").isError).toBe(true);
				return update(harness, "blocked", "Need the user to supply the acceptance criteria");
			},
			fauxAssistantMessage("Please supply the acceptance criteria."),
			fauxAssistantMessage("Must not run"),
		]);
		await runGoal(harness, "/goal Review the unknown requirements");
		expect(goalState(harness)).toMatchObject({
			status: "blocked",
			summary: "Need the user to supply the acceptance criteria",
		});
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("enforces the turn limit and gives an explicit resume a fresh budget", async () => {
		const harness = await goalHarness();
		harness.setResponses([
			fauxAssistantMessage("First"),
			fauxAssistantMessage("Second"),
			fauxAssistantMessage("Third"),
			fauxAssistantMessage("Must not run"),
		]);
		await runGoal(harness, "/goal start --turns 3 Review the fixture");
		expect(goalState(harness)).toMatchObject({
			status: "paused",
			turns: 3,
			runTurns: 3,
			maxTurns: 3,
			pauseReason: "Turn limit reached",
		});
		expect(harness.getPendingResponseCount()).toBe(1);
		harness.setResponses([
			() => update(harness, "complete", "Review verified", ["Fixture checks passed"]),
			fauxAssistantMessage("Done"),
		]);
		await runGoal(harness, "/goal resume");
		expect(goalState(harness)).toMatchObject({ status: "complete", turns: 4, runTurns: 1, maxTurns: 3 });
	});

	it("also limits consecutive tool turns before the model reaches a final reply", async () => {
		const harness = await goalHarness({ initialActiveToolNames: ["write", "goal_update"] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "first.txt", content: "one" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("write", { path: "second.txt", content: "two" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Must not run"),
		]);
		await runGoal(harness, "/goal start --turns 2 Write files");
		expect(goalState(harness)).toMatchObject({ status: "paused", turns: 2 });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["error", "aborted"] as const)(
		"pauses after a %s response without starting another goal request",
		async (stopReason) => {
			const harness = await goalHarness({ settings: { retry: { enabled: false } } });
			harness.setResponses([
				fauxAssistantMessage("", { stopReason, errorMessage: "Fixture failure" }),
				fauxAssistantMessage("Must not run"),
			]);
			await runGoal(harness, "/goal Inspect the fixture");
			expect(goalState(harness).status).toBe("paused");
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it.each(["pause", "cancel", "escape"])(
		"honors %s during a running tool and never schedules another turn",
		async (action) => {
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started = () => {};
			const starting = new Promise<void>((resolve) => {
				started = resolve;
			});
			const tool: AgentTool = {
				name: "wait",
				label: "Wait",
				description: "Wait for test release",
				parameters: Type.Object({}),
				execute: async () => {
					started();
					await released;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			};
			const harness = await goalHarness({ tools: [tool], initialActiveToolNames: ["wait", "goal_update"] });
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("Must not run"),
			]);
			const running = runGoal(harness, "/goal Wait for the fixture");
			await starting;
			if (action === "escape") {
				const aborted = harness.session.abort();
				release();
				await aborted;
			} else {
				await harness.session.prompt(`/goal ${action}`);
				release();
			}
			await running;
			expect(goalState(harness).status).toBe(action === "cancel" ? "cancelled" : "paused");
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("restores a persisted active goal paused and preserves progress across restart", async () => {
		const first = await goalHarness();
		const directory = join(first.tempDir, "saved");
		const manager = SessionManager.create(first.tempDir, directory);
		const saved: PioneerGoal = {
			version: 1,
			id: "saved-goal",
			objective: "Finish the saved work",
			status: "active",
			turns: 7,
			runTurns: 7,
			maxTurns: 20,
			summary: "Implementation checked",
			pauseReason: "",
			evidence: ["Existing test passed"],
			updatedAt: Date.now(),
		};
		// SessionManager writes a file once the first assistant message has arrived.
		manager.appendMessage(fauxAssistantMessage("Earlier work"));
		manager.appendCustomEntry(GOAL_ENTRY, saved);
		const path = manager.getSessionFile();
		if (!path) throw new Error("No session file");
		const reopened = await goalHarness({ sessionManager: SessionManager.open(path, directory) });
		expect(goalState(reopened)).toMatchObject({
			...saved,
			updatedAt: expect.any(Number),
			status: "paused",
			pauseReason: "Restored session; continuation requires /goal resume",
		});
		expect(reopened.session.messages).toEqual([]);
		expect(readFileSync(path, "utf8")).toContain(GOAL_ENTRY);
		reopened.setResponses([
			() => update(reopened, "complete", "Finished", ["Final test passed"]),
			fauxAssistantMessage("Done"),
		]);
		await runGoal(reopened, "/goal resume");
		expect(goalState(reopened)).toMatchObject({ status: "complete", turns: 8, runTurns: 1 });
	});

	it("restores only the selected branch and preserves invalid saved state", async () => {
		const manager = SessionManager.inMemory();
		const beforeGoal = manager.appendMessage(fauxAssistantMessage("Before the goal"));
		manager.appendCustomEntry(GOAL_ENTRY, { version: 1, status: "active", turns: "invalid" });
		const damaged = await goalHarness({ sessionManager: manager });
		damaged.setResponses([fauxAssistantMessage("Must not run")]);
		await damaged.session.prompt("/goal Start over");
		expect(damaged.getPendingResponseCount()).toBe(1);
		expect(
			manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY),
		).toHaveLength(1);
		manager.branch(beforeGoal);
		const otherBranch = await goalHarness({ sessionManager: manager });
		otherBranch.setResponses([() => update(otherBranch, "blocked", "Need input"), fauxAssistantMessage("Waiting")]);
		await runGoal(otherBranch, "/goal Work on this branch");
		expect(goalState(otherBranch).objective).toBe("Work on this branch");
	});

	it("keeps goal_update available through analytics tool selection", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("PIONEER_ANALYTIC_ENABLED", "1");
		const seed = await goalHarness();
		const harness = await goalHarness({
			extensionFactories: [pioneerGoalExtension, createPioneerAnalyticExtension],
			sessionManager: SessionManager.create(seed.tempDir, join(seed.tempDir, "analytic-sessions")),
		});
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("goal_update");
				return update(harness, "complete", "Verified", ["Typed goal tool survived selection"]);
			},
			fauxAssistantMessage("Done"),
		]);
		await runGoal(harness, "/goal Evaluate the configuration");
		expect(goalState(harness).status).toBe("complete");
	});

	it("does not make model calls for status, invalid commands, or missing authentication", async () => {
		const harness = await goalHarness({ withConfiguredAuth: false });
		const notifications: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (text) => notifications.push(text) }),
		});
		harness.setResponses([fauxAssistantMessage("Must not run")]);
		for (const command of [
			"/goal",
			"/goal status",
			"/goal status extra",
			"/goal resume",
			"/goal start --turns 0 Invalid",
			"/goal start --turns 1001 Invalid",
			"/goal start",
			"/goal Test auth",
		])
			await harness.session.prompt(command);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY),
		).toHaveLength(0);
		expect(notifications.join("\n")).toContain("authentication");
	});

	it("does not silently replace a blocked goal and allows cancellation then a new goal", async () => {
		const harness = await goalHarness();
		harness.setResponses([() => update(harness, "blocked", "Need a fixture"), fauxAssistantMessage("Waiting")]);
		await runGoal(harness, "/goal First objective");
		const firstId = goalState(harness).id;
		await harness.session.prompt("/goal Second objective");
		expect(goalState(harness).id).toBe(firstId);
		await harness.session.prompt("/goal cancel");
		harness.setResponses([
			() => update(harness, "complete", "Verified second goal", ["Second fixture passed"]),
			fauxAssistantMessage("Done"),
		]);
		await runGoal(harness, "/goal Second objective");
		expect(goalState(harness).id).not.toBe(firstId);
		expect(goalState(harness).objective).toBe("Second objective");
	});
});
