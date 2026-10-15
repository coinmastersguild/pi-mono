import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDialogueWorker } from "../../src/core/dialogue/agent-worker.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("dialogue AgentSession bridge", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const h of harnesses.splice(0)) h.cleanup();
	});

	it("waits for delayed completion hooks before declaring the worker free", async () => {
		let release!: () => void;
		let entered!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const hookStarted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async () => {
						entered();
						await pending;
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		let finished = false;
		const result = createDialogueWorker(h.session)
			.run("work", new AbortController().signal)
			.then((value) => {
				finished = true;
				return value;
			});
		await hookStarted;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(finished).toBe(false);
		release();
		expect(await result).toEqual({ status: "completed", text: "done" });
	});

	it("publishes only the final assistant text after tools, excluding reasoning", async () => {
		const h = await createHarness({
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "Echo",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "private tool output" }], details: {} }),
				},
			],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage([
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Finished the task" },
			]),
		]);
		const result = await createDialogueWorker(h.session).run("do work", new AbortController().signal);
		expect(result).toEqual({ status: "completed", text: "Finished the task" });
	});

	it("waits through overflow compaction and the scheduled recovery response", async () => {
		const h = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "Local test summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage("seed"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("Recovered result"),
		]);
		const worker = createDialogueWorker(h.session);
		await worker.run("first", new AbortController().signal);
		expect(await worker.run("second", new AbortController().signal)).toEqual({
			status: "completed",
			text: "Recovered result",
		});
		expect(h.eventsOfType("compaction_end").some((event) => event.willRetry)).toBe(true);
	});

	it("does not reuse a previous response when an extension handles input", async () => {
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) =>
						event.text === "handled" ? { action: "handled" } : { action: "continue" },
					);
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("previous")]);
		const worker = createDialogueWorker(h.session);
		await worker.run("first", new AbortController().signal);
		expect(await worker.run("handled", new AbortController().signal)).toEqual({ status: "completed", text: "" });
	});

	it("cancels the scheduled overflow recovery before it can execute tools", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "should not execute" }],
			details: {},
		}));
		const h = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			tools: [{ name: "echo", label: "Echo", description: "Echo", parameters: Type.Object({}), execute }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "Local summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage("seed"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
		]);
		const worker = createDialogueWorker(h.session);
		await worker.run("first", new AbortController().signal);
		const abort = new AbortController();
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.willRetry) abort.abort();
		});
		expect((await worker.run("second", abort.signal)).status).toBe("cancelled");
		unsubscribe();
		expect(execute).not.toHaveBeenCalled();
		expect(h.session.isStreaming).toBe(false);
		h.setResponses([fauxAssistantMessage("next task")]);
		expect(await worker.run("third", new AbortController().signal)).toEqual({
			status: "completed",
			text: "next task",
		});
	});

	it("cancels during asynchronous preflight before starting model work", async () => {
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						entered();
						await waiting;
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("must not run")]);
		const abort = new AbortController();
		const result = createDialogueWorker(h.session).run("cancel me", abort.signal);
		await started;
		abort.abort();
		release();
		expect((await result).status).toBe("cancelled");
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.eventsOfType("agent_start")).toHaveLength(0);
	});
});
