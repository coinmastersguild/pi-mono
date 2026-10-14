import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OfficeInbox, officeResult } from "../src/core/pioneer-office.ts";

const dirs: string[] = [];
function inboxPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pioneer-office-test-"));
	dirs.push(dir);
	return join(dir, "inbox.json");
}
const task = { cursor: 4, kind: "task_assigned", body: "Inspect a fixture", channelId: "general", taskId: "task-1" };

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Office durable task handoff", () => {
	it("recovers pending assignments after restart and deduplicates replay", () => {
		const path = inboxPath();
		const first = new OfficeInbox(path);
		expect(first.receive({ events: [task], nextCursor: 4 })).toBe(1);
		const restored = new OfficeInbox(path);
		expect(restored.cursor).toBe(4);
		expect(restored.items).toEqual([{ event: task, accepted: false }]);
		expect(restored.receive({ events: [task], nextCursor: 4 })).toBe(0);
		expect(restored.items).toHaveLength(1);
	});
	it("never automatically repeats an accepted task after restart", () => {
		const path = inboxPath();
		const first = new OfficeInbox(path);
		first.receive({ events: [task], nextCursor: 4 });
		expect(first.accept(4)).toEqual(task);
		const restored = new OfficeInbox(path);
		expect(() => restored.accept(4)).toThrow("Already accepted");
		expect(restored.accept(4, true)).toEqual(task);
	});
	it("does not advance the cursor when validation or persistence fails", () => {
		const path = inboxPath();
		const inbox = new OfficeInbox(path);
		expect(() => inbox.receive({ events: [task], nextCursor: 9 })).toThrow("skipped");
		expect(() => inbox.receive({ events: [{ ...task, body: 12 }], nextCursor: 4 })).toThrow("invalid");
		expect(inbox.cursor).toBe(0);
		rmSync(dirs.at(-1)!, { recursive: true });
		expect(() => inbox.receive({ events: [task], nextCursor: 4 })).toThrow();
		expect(inbox.cursor).toBe(0);
	});
	it("rejects a mention as a delegated task", () => {
		const inbox = new OfficeInbox(inboxPath());
		inbox.receive({ events: [{ ...task, kind: "mention" }], nextCursor: 4 });
		expect(() => inbox.accept(4)).toThrow("assigned task");
	});
	it("preserves corrupt state rather than silently resetting the cursor", () => {
		const path = inboxPath();
		writeFileSync(path, '{"cursor":4,"items":"invalid"}');
		expect(() => new OfficeInbox(path)).toThrow("invalid");
		expect(readFileSync(path, "utf8")).toContain("invalid");
	});
	it("rejects MCP failures even when a JSON payload accompanies them", () => {
		expect(() => officeResult({ isError: true, content: [{ type: "text", text: "{}" }] })).toThrow("permissions");
		expect(officeResult({ content: [{ type: "text", text: '{"events":[]}' }] })).toEqual({ events: [] });
	});
});
