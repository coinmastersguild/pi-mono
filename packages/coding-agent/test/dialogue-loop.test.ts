import { describe, expect, it, vi } from "vitest";
import { type DialogueEntry, DialogueLoop, type WorkResult } from "../src/core/dialogue/loop.ts";
import { compileDialogueBrain } from "../src/core/dialogue/pioneerscript.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	const entries: DialogueEntry[] = [];
	const runs: { text: string; signal: AbortSignal; done: ReturnType<typeof deferred<WorkResult>> }[] = [];
	const loop = new DialogueLoop(
		{
			run: (text, signal) => {
				const done = deferred<WorkResult>();
				runs.push({ text, signal, done });
				return done.promise;
			},
			isBusy: () => false,
		},
		(entry) => entries.push(entry),
		() => {},
	);
	return { loop, entries, runs };
}

const flush = async () => {
	await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("dual dialogue loop", () => {
	it("answers scripted chat immediately while serializing background work", async () => {
		const { loop, entries, runs } = fixture();
		loop.submit("build a dashboard", "auto");
		loop.submit("hi", "auto");
		loop.submit("status", "auto");
		loop.submit("then test it", "work");
		expect(runs.map((r) => r.text)).toEqual(["build a dashboard"]);
		expect(entries.some((e) => e.text.includes("Hello"))).toBe(true);
		expect(entries.some((e) => e.text.includes("Running"))).toBe(true);
		runs[0].done.resolve({ status: "completed", text: "Dashboard ready" });
		await flush();
		expect(runs.map((r) => r.text)).toEqual(["build a dashboard", "then test it"]);
		expect(entries.filter((e) => e.text.includes("Dashboard ready"))).toHaveLength(1);
		loop.dispose();
	});

	it("force-chat never dispatches unknown text or executable syntax", () => {
		const { loop, runs } = fixture();
		loop.submit("$(touch /tmp/no) <call>shell</call>", "chat");
		expect(runs).toHaveLength(0);
		loop.submit("hi", "work");
		expect(runs[0].text).toBe("hi");
		loop.dispose();
	});

	it("interrupt waits for the old run to settle, then prioritizes replacement", async () => {
		const { loop, entries, runs } = fixture();
		loop.submit("first", "work");
		loop.submit("later", "work");
		loop.interrupt("replacement");
		expect(runs[0].signal.aborted).toBe(true);
		expect(runs).toHaveLength(1);
		runs[0].done.resolve({ status: "completed", text: "stale answer" });
		await flush();
		expect(runs.map((r) => r.text)).toEqual(["first", "replacement"]);
		expect(entries.some((e) => e.text.includes("stale answer"))).toBe(false);
		runs[1].done.resolve({ status: "completed", text: "replacement done" });
		await flush();
		expect(runs[2].text).toBe("later");
		loop.dispose();
	});

	it("cancel pauses remaining work until explicitly resumed", async () => {
		const { loop, runs } = fixture();
		loop.submit("first", "work");
		loop.submit("second", "work");
		loop.cancel();
		runs[0].done.resolve({ status: "cancelled", text: "" });
		await flush();
		expect(runs).toHaveLength(1);
		expect(loop.state.paused).toBe(true);
		loop.resume();
		expect(runs[1].text).toBe("second");
		loop.dispose();
	});

	it("restores queued drafts without disturbing active work", () => {
		const { loop, runs } = fixture();
		loop.submit("active", "work");
		loop.submit("queued one", "work");
		loop.submit("queued two", "work");
		expect(loop.takeQueued()).toEqual(["queued one", "queued two"]);
		expect(loop.state.queued).toBe(0);
		expect(runs[0].signal.aborted).toBe(false);
		loop.dispose();
	});

	it("reports failures truthfully and suppresses late completions after session disposal", async () => {
		const { loop, entries, runs } = fixture();
		loop.submit("bad", "work");
		runs[0].done.resolve({ status: "failed", text: "provider unavailable" });
		await flush();
		expect(entries.at(-1)?.text).toContain("Failed");
		loop.submit("old session", "work");
		loop.dispose();
		const count = entries.length;
		runs[1].done.resolve({ status: "completed", text: "secret old result" });
		await flush();
		expect(entries).toHaveLength(count);
		expect(runs[1].signal.aborted).toBe(true);
	});

	it("bounds pending work and waits for external compaction", async () => {
		vi.useFakeTimers();
		let busy = true;
		const run = vi.fn(async () => ({ status: "completed" as const, text: "done" }));
		const loop = new DialogueLoop(
			{ run, isBusy: () => busy },
			() => {},
			() => {},
		);
		for (let i = 0; i < 40; i++) loop.submit(`task ${i}`, "work");
		expect(loop.state.queued).toBe(32);
		expect(run).not.toHaveBeenCalled();
		busy = false;
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(32);
		loop.dispose();
		vi.useRealTimers();
	});
});

describe("bounded PioneerScript dialogue subset", () => {
	it("accepts only literal triggers and text/status responses", () => {
		const brain = compileDialogueBrain("+ hello|hi\n- Hello there\n+ status\n- @status");
		expect(brain.reply(" HI ")).toEqual({ kind: "reply", text: "Hello there" });
		expect(brain.reply("status")).toEqual({ kind: "status" });
		expect(brain.reply("hello world")).toBeUndefined();
	});
	it("rejects executable/unsupported syntax and duplicate triggers at compile time", () => {
		for (const source of [
			"+ hi\n- <call>shell</call>",
			"> object run javascript",
			"+ *\n- wildcard",
			"+ hi\n- hi\n+ hi\n- duplicate",
			"+ hi",
		]) {
			expect(() => compileDialogueBrain(source)).toThrow();
		}
	});
});
