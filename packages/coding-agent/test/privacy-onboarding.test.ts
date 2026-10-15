import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { launchPrivateCli } from "../src/core/privacy/launcher.ts";
import { chooseWorkspaceMode, hasPreviousPioneerRun } from "../src/core/privacy/onboarding.ts";
import * as password from "../src/core/privacy/password.ts";
import * as vault from "../src/core/privacy/vault.ts";
import { listWorkspaces } from "../src/core/privacy/workspace.ts";
import { getDefaultSessionDir } from "../src/core/session-manager.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
const temporary: string[] = [];
const originalExitCode = process.exitCode;

afterEach(async () => {
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	spawn.mockReset();
	for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function setup() {
	const path = await realpath(await mkdtemp(join(tmpdir(), "pioneer-onboarding-")));
	temporary.push(path);
	const source = join(path, "project");
	const agent = join(path, "agent");
	const root = join(path, "mounted");
	const directory = join(path, "vault");
	for (const dir of [
		source,
		agent,
		directory,
		...["agent", "projects", "runtime", "cache"].map((name) => join(root, name)),
	]) {
		await mkdir(dir, { recursive: true });
	}
	vi.stubEnv(ENV_AGENT_DIR, agent);
	vi.spyOn(process, "cwd").mockReturnValue(source);
	vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const close = vi.fn(async () => {});
	vi.spyOn(vault, "openVault").mockResolvedValue({ root, directory, close });
	vi.spyOn(password, "createVaultPassword").mockImplementation(async () => Buffer.from("test password only"));
	vi.spyOn(password, "promptVaultPassword").mockImplementation(async () => Buffer.from("test password only"));
	spawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, new PassThrough()], kill: vi.fn() });
		queueMicrotask(() => child.emit("close", 0, null));
		return child;
	});
	return { source, agent, root, directory, close };
}

it("detects only matching previous sessions without creating state in a fresh directory", async () => {
	const { source, agent } = await setup();
	expect(await hasPreviousPioneerRun(source, agent)).toBe(false);
	expect(await readdir(agent)).toEqual([]);
	const sessions = getDefaultSessionDir(source, agent);
	await writeFile(join(sessions, "old.jsonl"), `${JSON.stringify({ type: "session", cwd: "/unrelated" })}\n`);
	expect(await hasPreviousPioneerRun(source, agent)).toBe(false);
	await writeFile(join(sessions, "old.jsonl"), `${JSON.stringify({ type: "session", cwd: source })}\n`);
	expect(await hasPreviousPioneerRun(source, agent)).toBe(true);
});

it("requires an explicit transparent choice and defaults Enter to protected", async () => {
	await setup();
	const prompt = vi.mocked(password.promptVaultPassword);
	prompt.mockResolvedValueOnce(Buffer.from("invalid")).mockResolvedValueOnce(Buffer.from(""));
	expect(await chooseWorkspaceMode(true)).toBe("protected");
	prompt.mockResolvedValueOnce(Buffer.from("T"));
	expect(await chooseWorkspaceMode(true)).toBe("transparent");
});

it("starts normally without a password or copying project files", async () => {
	const { source, directory } = await setup();
	await launchPrivateCli(["--vault-dir", directory], vi.fn());
	expect(vault.openVault).not.toHaveBeenCalled();
	expect(password.createVaultPassword).not.toHaveBeenCalled();
	expect(password.promptVaultPassword).not.toHaveBeenCalled();
	expect(spawn.mock.calls[0][2].cwd).toBe(source);
});

it("private history keeps code in place and directs state to the encrypted vault", async () => {
	const { source, root, directory, close } = await setup();
	await writeFile(join(source, "file.txt"), "normal code");
	await launchPrivateCli(["--private", "--vault-dir", directory], vi.fn());
	expect(password.createVaultPassword).toHaveBeenCalledOnce();
	expect(spawn.mock.calls[0][2].cwd).toBe(source);
	expect(spawn.mock.calls[0][2].env[ENV_AGENT_DIR]).toBe(join(root, "agent"));
	expect(spawn.mock.calls[0][2].env.PIONEER_PRIVATE_CODE_DIR).toBe(source);
	expect(await readdir(join(root, "projects"))).toEqual([]);
	expect(await readFile(join(source, "file.txt"), "utf8")).toBe("normal code");
	expect(close).toHaveBeenCalledOnce();
});

it("explicit encrypted workspace imports the project and uses its encrypted copy", async () => {
	const { source, root, directory } = await setup();
	await writeFile(join(source, "file.txt"), "code");
	await launchPrivateCli(["--private", "--encrypt-workspace", "--vault-dir", directory], vi.fn());
	const [project] = await listWorkspaces(root);
	expect(spawn.mock.calls[0][2].cwd).toBe(join(root, "projects", project.id));
	expect(await readFile(join(root, "projects", project.id, "file.txt"), "utf8")).toBe("code");
});
