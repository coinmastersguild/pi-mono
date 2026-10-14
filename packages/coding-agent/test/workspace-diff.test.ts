import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { foldWorkspaceDiff, parseWorkspaceDiff, WorkspaceDiffView } from "../src/modes/interactive/workspace-diff.ts";
import { WorkspaceMonitor } from "../src/modes/interactive/workspace-monitor.ts";

const directories: string[] = [];
const monitors: WorkspaceMonitor[] = [];
afterEach(async () => {
	for (const monitor of monitors.splice(0)) monitor.dispose();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "pioneer-diff-test-"));
	directories.push(cwd);
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"core.hooksPath=/dev/null",
				...args,
			],
			{ cwd },
		);
	git("init", "--quiet");
	return { cwd, git };
}

test("numbers removed and added lines independently, including header-like source", () => {
	const lines = parseWorkspaceDiff(
		"diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,2 +10,3 @@\n context\n---old\n+++new\n+next\n\\ No newline at end of file\n",
	);
	expect(lines).toEqual([
		{ kind: "context", text: "context", oldLine: 10, newLine: 10 },
		{ kind: "delete", text: "--old", oldLine: 11 },
		{ kind: "add", text: "++new", newLine: 11 },
		{ kind: "add", text: "next", newLine: 12 },
		{ kind: "meta", text: "No newline at end of file" },
	]);
});
test("folds unchanged sections between edits and restores exact context on expansion", () => {
	const patch = `@@ -1,31 +1,31 @@\n-old\n+new\n${Array.from({ length: 30 }, (_, i) => ` context${i}`).join("\n")}\n-last\n+updated\n`;
	const lines = parseWorkspaceDiff(patch),
		folded = foldWorkspaceDiff(lines, new Set());
	const gap = folded.find((row) => row.kind === "fold");
	expect(gap?.text).toContain("24 unchanged lines");
	if (gap?.kind !== "fold") throw new Error("Missing fold");
	const expanded = foldWorkspaceDiff(lines, new Set([gap.id]));
	expect(expanded.filter((row) => row.kind !== "fold")).toEqual(lines);
	expect(folded.filter((row) => row.kind === "add")).toHaveLength(2);
});
test("reads combined changes and new/deleted files while refusing private and binary previews", async () => {
	const { cwd, git } = await fixture();
	await writeFile(join(cwd, "code.ts"), "old\ncontext\n");
	await writeFile(join(cwd, "deleted.ts"), "deleted\n");
	git("add", "code.ts", "deleted.ts");
	git("commit", "--quiet", "-m", "fixture");
	await writeFile(join(cwd, "code.ts"), "staged\ncontext\n");
	git("add", "code.ts");
	await writeFile(join(cwd, "code.ts"), "unstaged\ncontext\n");
	await rm(join(cwd, "deleted.ts"));
	await writeFile(join(cwd, ".env"), "PRIVATE_FIXTURE=do-not-preview");
	await writeFile(join(cwd, "new.ts"), "new\n");
	await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1]));
	const monitor = new WorkspaceMonitor(cwd, () => {});
	monitors.push(monitor);
	await monitor.refresh();
	const diff = await monitor.fileDiff("code.ts");
	expect(diff.lines).toContainEqual({ kind: "delete", text: "old", oldLine: 1 });
	expect(diff.lines).toContainEqual({ kind: "add", text: "unstaged", newLine: 1 });
	expect((await monitor.fileDiff("deleted.ts")).lines[0]).toEqual({ kind: "delete", text: "deleted", oldLine: 1 });
	expect((await monitor.fileDiff("new.ts")).lines[0]).toMatchObject({ kind: "add", text: "new" });
	expect((await monitor.fileDiff(".env")).lines).toEqual([]);
	expect((await monitor.fileDiff("binary.dat")).message).toContain("Binary");
});
test("rename diff uses the original path and literal pathspecs", async () => {
	const { cwd, git } = await fixture();
	await writeFile(join(cwd, "old.ts"), "one\ntwo\nthree\nfour\n");
	git("add", "old.ts");
	git("commit", "--quiet", "-m", "fixture");
	git("mv", "old.ts", "[new].ts");
	await writeFile(join(cwd, "[new].ts"), "one\nchanged\nthree\nfour\n");
	const monitor = new WorkspaceMonitor(cwd, () => {});
	monitors.push(monitor);
	await monitor.refresh();
	const diff = await monitor.fileDiff("[new].ts");
	expect(diff.lines.filter((line) => line.kind === "delete").map((line) => line.text)).toEqual(["two"]);
	expect(diff.lines.filter((line) => line.kind === "add").map((line) => line.text)).toEqual(["changed"]);
});
test("viewer expands clicked ellipses, scrolls, sanitizes code, and returns to files", async () => {
	initTheme("dark");
	const lines = parseWorkspaceDiff(
		`@@ -1,40 +1,40 @@\n${Array.from({ length: 39 }, (_, i) => ` line${i}`).join("\n")}\n-old\n+new\u001b[2J\n`,
	);
	const back = vi.fn();
	const view = new WorkspaceDiffView(
		new KeybindingsManager(),
		async () => ({ lines, message: "Working tree vs HEAD" }),
		() => {},
		back,
	);
	view.open("code.ts");
	await vi.waitFor(() => expect(view.render(80, 16).join("\n")).toContain("unchanged lines"));
	const mouse: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 20,
		y: 4,
		screenX: 100,
		screenY: 4,
		width: 80,
		height: 16,
		shift: false,
		alt: false,
		ctrl: false,
	};
	view.handleMouse(mouse);
	expect(view.render(80, 16).map(stripTerminalSequences).join("\n")).toContain("line0");
	view.handleMouse({ ...mouse, type: "wheel", wheelDelta: 100 });
	const bottom = view.render(80, 16).join("\n");
	expect(bottom).toContain("new");
	expect(bottom).not.toContain("\u001b[2J");
	view.handleInput("\u001b");
	expect(back).toHaveBeenCalledOnce();
	view.close();
});
