import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { launchPrivateCli } from "../src/core/privacy/launcher.ts";
import * as password from "../src/core/privacy/password.ts";
import * as vault from "../src/core/privacy/vault.ts";
import { type GuildProject, scaffoldGuildProject } from "../src/core/projects/guild.ts";
import { createPioneerProject, findProjectProtection, findProjectVault } from "../src/core/projects/setup.ts";
import * as wizard from "../src/core/projects/wizard.ts";

const directories: string[] = [];
const exitCode = process.exitCode;
const project: GuildProject = {
	name: "test-workspace",
	purpose: "Track local experiments",
	success: "A saved experiment can be retrieved",
	kind: "service",
	port: 3100,
	production: false,
	milestone: "Persist one experiment",
};

afterEach(async () => {
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporary() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pioneer-create-test-")));
	directories.push(directory);
	vi.spyOn(process, "cwd").mockReturnValue(directory);
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	return directory;
}

it("routes create before any unrelated vault lookup and creates a named local Git project", async () => {
	const directory = await temporary();
	vi.spyOn(wizard, "promptProjectSetup").mockResolvedValue({ project, transparent: true });
	const lookup = vi.spyOn(vault, "vaultExists").mockRejectedValue(new Error("unrelated vault busy"));
	const run = vi.fn();
	await launchPrivateCli(["create", "test-workspace", "--transparent"], run);
	expect(process.exitCode).not.toBe(1);
	expect(lookup).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
	const target = join(directory, project.name);
	expect((await lstat(join(target, ".git"))).isDirectory()).toBe(true);
	expect(JSON.parse(await readFile(join(target, "docs/planning/STATE.json"), "utf8")).current).toBe("PLANNING");
	expect(await readFile(join(target, "docs/architecture/port-assignments.md"), "utf8")).toContain("3100");
	expect(spawnSync("/usr/bin/git", ["-C", target, "remote"], { encoding: "utf8" }).stdout).toBe("");
	expect(spawnSync(process.execPath, [join(target, "scripts/deploy/deploy-prod.js")]).status).toBe(1);
});

it("creates protected content only inside its own vault and discovers it on reopen", async () => {
	const directory = await temporary();
	vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	vi.spyOn(wizard, "promptProjectSetup").mockResolvedValue({ project, transparent: false });
	const secret = Buffer.from("project test password");
	vi.spyOn(password, "createVaultPassword").mockResolvedValue(secret);
	const close = vi.fn(async () => {});
	const open = vi.spyOn(vault, "openVault").mockImplementation(async (options) => {
		const root = join(options.directory, "mount");
		await mkdir(join(root, "projects"), { recursive: true });
		return { root, directory: options.directory, close };
	});
	await createPioneerProject(project.name, true, true);
	const target = join(directory, project.name);
	const localVault = join(target, ".pioneer", "vault");
	expect(open.mock.calls[0][0].directory).toBe(localVault);
	expect(open.mock.calls[0][0].create).toBe(true);
	expect(secret.every((byte) => byte === 0)).toBe(true);
	expect(close).toHaveBeenCalledOnce();
	expect(await readdir(target)).toEqual([".pioneer", "PIONEER.txt"]);
	const [index] = JSON.parse(await readFile(join(localVault, "mount/projects.json"), "utf8"));
	expect(await readFile(join(localVault, "mount/projects", index.id, "README.md"), "utf8")).toContain(project.purpose);
	expect(await findProjectVault(target)).toBe(localVault);
});

it("create --private keeps project code outside the vault and remembers private history", async () => {
	const directory = await temporary();
	vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	vi.spyOn(wizard, "promptProjectSetup").mockResolvedValue({ project, transparent: true });
	vi.spyOn(password, "createVaultPassword").mockResolvedValue(Buffer.from("test project password"));
	vi.spyOn(vault, "openVault").mockImplementation(async (options) => {
		const root = join(options.directory, "mount");
		await mkdir(join(root, "projects"), { recursive: true });
		return { root, directory: options.directory, close: async () => {} };
	});
	await launchPrivateCli(["create", "--private", project.name], vi.fn());
	const target = join(directory, project.name);
	expect(await readFile(join(target, "README.md"), "utf8")).toContain(project.purpose);
	expect((await lstat(join(target, ".git"))).isDirectory()).toBe(true);
	expect(await findProjectProtection(target)).toEqual({
		directory: join(target, ".pioneer", "vault"),
		encryptWorkspace: false,
	});
	expect(await readdir(join(target, ".pioneer", "vault", "mount", "projects"))).toEqual([]);
});

it("rejects traversal and existing destinations before asking questions or unlocking", async () => {
	const directory = await temporary();
	const prompt = vi.spyOn(wizard, "promptProjectSetup");
	await expect(createPioneerProject("../escape", false)).rejects.toThrow("project name");
	await mkdir(join(directory, project.name));
	await writeFile(join(directory, project.name, "keep.txt"), "keep");
	await expect(createPioneerProject(project.name, false)).rejects.toThrow("already exists");
	expect(prompt).not.toHaveBeenCalled();
	expect(await readFile(join(directory, project.name, "keep.txt"), "utf8")).toBe("keep");
});

it("leaves no directory after cancellation", async () => {
	const directory = await temporary();
	vi.spyOn(wizard, "promptProjectSetup").mockRejectedValue(new Error("cancelled"));
	await expect(createPioneerProject(project.name, false)).rejects.toThrow("cancelled");
	expect(await readdir(directory)).toEqual([]);
});

it("preserves existing project files and state when applying Guild setup", async () => {
	const directory = await temporary();
	await writeFile(join(directory, "README.md"), "existing readme");
	await writeFile(join(directory, "package.json"), '{"name":"existing"}');
	const skipped = await scaffoldGuildProject(directory, { ...project, production: true });
	expect(skipped).toContain("README.md");
	expect(skipped).toContain("package.json");
	expect(await readFile(join(directory, "README.md"), "utf8")).toBe("existing readme");
	expect(await readFile(join(directory, "docs/deployment/status-dashboard.md"), "utf8")).toContain(
		"Prod -> Feature -> Dev -> Docker -> Local",
	);
	const state = await readFile(join(directory, "docs/planning/STATE.json"), "utf8");
	await scaffoldGuildProject(directory, project);
	expect(await readFile(join(directory, "docs/planning/STATE.json"), "utf8")).toBe(state);
});

it("refuses symlinked document destinations before writing anything", async () => {
	const directory = await temporary();
	const outside = join(directory, "outside");
	const target = join(directory, "target");
	await mkdir(outside);
	await mkdir(target);
	await symlink(outside, join(target, "docs"));
	await expect(scaffoldGuildProject(target, project)).rejects.toThrow("symbolic link");
	expect(await readdir(outside)).toEqual([]);
	expect(await readdir(target)).toEqual(["docs"]);
});
