import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	parseWorkspaceStatus,
	WorkspaceMonitor,
	workspacePathFlags,
} from "../src/modes/interactive/workspace-monitor.ts";
import { repeatedBlocks, WorkspaceQuality } from "../src/modes/interactive/workspace-quality.ts";
import { readWorkspaceFile } from "../src/modes/interactive/workspace-read.ts";
import { parseWorkspaceRules } from "../src/modes/interactive/workspace-rules.ts";

const directories: string[] = [];
const monitors: WorkspaceMonitor[] = [];
afterEach(async () => {
	for (const monitor of monitors.splice(0)) monitor.dispose();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pioneer-workspace-test-"));
	directories.push(path);
	execFileSync("git", ["init", "--quiet", path]);
	return path;
}
function git(cwd: string, ...args: string[]): void {
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
}

describe("workspace evidence", () => {
	test("bounded reads refuse symlink aliases and oversized files", async () => {
		const cwd = await fixture();
		await mkdir(join(cwd, "private"));
		await writeFile(join(cwd, "private", "code.ts"), "secret-fixture");
		await symlink(join(cwd, "private"), join(cwd, "alias"));
		expect(await readWorkspaceFile(cwd, "alias/code.ts", 100)).toBeUndefined();
		expect(await readWorkspaceFile(cwd, "private/code.ts", 3)).toBeUndefined();
		expect(await readWorkspaceFile(cwd, "../outside", 100)).toBeUndefined();
	});
	test("live quality runs the installed linter and strict profile, then updates after edits", async () => {
		const cwd = await fixture();
		await symlink(resolve("../../node_modules"), join(cwd, "node_modules"));
		await writeFile(join(cwd, "biome.json"), '{"linter":{"rules":{"recommended":true}}}');
		await writeFile(join(cwd, "source.ts"), "export const value: any = 1;\n");
		const monitor = new WorkspaceMonitor(cwd, () => {});
		monitors.push(monitor);
		await monitor.refresh();
		const quality = new WorkspaceQuality(() => {});
		quality.setBackend("local");
		try {
			quality.update(monitor.snapshot);
			await vi.waitFor(() => expect(quality.snapshot.strict).toBeGreaterThan(0), { timeout: 15000 });
			expect(quality.snapshot.core).toContain("Analytics off");
			await writeFile(join(cwd, "source.ts"), "export const value = 1;\n");
			await monitor.refresh();
			quality.update(monitor.snapshot);
			await vi.waitFor(() => expect(quality.snapshot.strict).toBe(0), { timeout: 15000 });
		} finally {
			quality.dispose();
		}
	});
	test("rule packs accept identifiers and reject command-like values", () => {
		expect(parseWorkspaceRules('{"version":1,"rules":["suspicious/noExplicitAny"]}')).toEqual([
			"suspicious/noExplicitAny",
		]);
		for (const rules of ['["--write"]', '["https://example.com/plugin.js"]', "[]"])
			expect(() => parseWorkspaceRules(`{"version":1,"rules":${rules}}`)).toThrow();
	});
	test("a pure rename does not inflate line totals", async () => {
		const cwd = await fixture();
		await writeFile(join(cwd, "old.ts"), "first\nsecond\n");
		git(cwd, "add", "old.ts");
		git(cwd, "commit", "--quiet", "-m", "fixture");
		git(cwd, "mv", "old.ts", "new name.ts");
		const monitor = new WorkspaceMonitor(cwd, () => {});
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.snapshot).toMatchObject({ changed: 1, added: 0, removed: 0 });
		expect(monitor.snapshot.entries.find((entry) => entry.path === "new name.ts")?.status).toBe("R ");
	});
	test("preserves porcelain rename destinations, spaces and staged state", () => {
		expect([...parseWorkspaceStatus("R  new name.ts\0old.ts\0?? added.ts\0")]).toEqual([
			["new name.ts", "R "],
			["added.ts", "??"],
		]);
	});
	test("counts combined staged and unstaged changes, excludes ignored/private untracked contents", async () => {
		const cwd = await fixture();
		await writeFile(join(cwd, "a.ts"), "one\ntwo\n");
		await writeFile(join(cwd, ".gitignore"), "cache/\n");
		git(cwd, "add", "a.ts", ".gitignore");
		git(cwd, "commit", "--quiet", "-m", "fixture");
		await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\n");
		git(cwd, "add", "a.ts");
		await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\nfour\n");
		await writeFile(join(cwd, "new.ts"), "new\nline");
		await writeFile(join(cwd, ".env"), "PRIVATE_FIXTURE=never-read\n");
		await mkdir(join(cwd, "cache"));
		await writeFile(join(cwd, "cache", "a.ts"), "ignored\n");
		const monitor = new WorkspaceMonitor(cwd, () => {});
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.snapshot.entries.find((entry) => entry.path === "a.ts")).toMatchObject({
			status: "MM",
			added: 2,
			removed: 0,
		});
		expect(monitor.snapshot).toMatchObject({ added: 4, removed: 0, changed: 3, uncounted: 1 });
		expect(monitor.snapshot.entries.find((entry) => entry.path === ".env")).toMatchObject({
			private: true,
			uncounted: true,
			added: 0,
		});
		expect(monitor.snapshot.entries.find((entry) => entry.path === "cache")).toMatchObject({
			ignored: true,
			directory: true,
		});
		expect(await monitor.changedLines("a.ts")).toBe("Changed: L3–4");
		expect(await monitor.changedLines(".env")).toContain("metadata only");
		await writeFile(join(cwd, "new.ts"), "one\ntwo\nthree\n");
		await monitor.refresh();
		expect(monitor.snapshot.activity.some((activity) => activity.path === "new.ts")).toBe(true);
	});
	test("handles unborn repos, subdirectory scope and symlink boundaries", async () => {
		const cwd = await fixture();
		await mkdir(join(cwd, "sub"));
		await writeFile(join(cwd, "outside.ts"), "outside\n");
		await writeFile(join(cwd, "sub", "new.ts"), "new\n");
		git(cwd, "add", "sub/new.ts");
		await symlink(join(cwd, "outside.ts"), join(cwd, "sub", "linked.ts"));
		const monitor = new WorkspaceMonitor(join(cwd, "sub"), () => {});
		monitors.push(monitor);
		await monitor.refresh();
		expect(monitor.snapshot.entries.map((entry) => entry.path)).not.toContain("outside.ts");
		expect(monitor.snapshot.entries.find((entry) => entry.path === "new.ts")).toMatchObject({
			status: "A ",
			added: 1,
		});
		expect(monitor.snapshot.entries.find((entry) => entry.path === "linked.ts")).toMatchObject({
			symlink: true,
			uncounted: true,
		});
	});
	test("classifies control/private names without treating every dotfile as secret", () => {
		expect(workspacePathFlags(".pioneer/auth.json")).toEqual({ hidden: true, control: true, private: true });
		expect(workspacePathFlags(".env.example").private).toBe(false);
		expect(workspacePathFlags("src/settings.ts").private).toBe(false);
	});
	test("identifies repeated blocks with original line locations", () => {
		const text = Array.from({ length: 8 }, (_, i) => `const value${i} = calculateSomething(${i});`).join("\n");
		expect(
			repeatedBlocks([
				{ path: "a.ts", text },
				{ path: "b.ts", text: `\n${text}` },
			]),
		).toEqual({ count: 1, findings: ["b.ts:2 repeats a.ts:1"] });
		expect(repeatedBlocks([{ path: "a.ts", text }]).count).toBe(0);
	});
});
