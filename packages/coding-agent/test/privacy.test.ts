import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";
import { unwrapVaultKey, wrapVaultKey } from "../src/core/privacy/crypto.ts";
import { parsePrivacyOptions, privateEnvironment, vaultSandboxProfile } from "../src/core/privacy/launcher.ts";
import { PrivateMemoryStore } from "../src/core/privacy/memory.ts";
import { relocateImportedSessions } from "../src/core/privacy/migration.ts";
import { MacVaultDisk, type NativeCommand } from "../src/core/privacy/native.ts";
import { changeVaultPassword, openVault, type VaultDisk } from "../src/core/privacy/vault.ts";
import {
	importAgentState,
	importWorkspace,
	listWorkspaces,
	verifiedPrivateCopy,
} from "../src/core/privacy/workspace.ts";
import { getDefaultSessionDir } from "../src/core/session-manager.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-private-test-"));
	directories.push(path);
	return path;
}

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("vault encryption", () => {
	it("wraps a random disk key with a password, random salt and nonce", async () => {
		const password = Buffer.from("correct horse battery staple");
		const key = randomBytes(32);
		const first = await wrapVaultKey(password, key);
		const second = await wrapVaultKey(password, key);
		expect(first.salt).not.toBe(second.salt);
		expect(first.nonce).not.toBe(second.nonce);
		expect(first.ciphertext).not.toBe(second.ciphertext);
		expect(JSON.stringify(first)).not.toContain(password.toString());
		expect(JSON.stringify(first)).not.toContain(key.toString("hex"));
		expect(await unwrapVaultKey(password, first)).toEqual(key);
	});

	it("fails closed for incorrect passwords and altered ciphertext", async () => {
		const password = Buffer.from("correct horse battery staple");
		const envelope = await wrapVaultKey(password, randomBytes(32));
		await expect(unwrapVaultKey(Buffer.from("incorrect password"), envelope)).rejects.toThrow("Incorrect password");
		const tampered = {
			...envelope,
			ciphertext: `${envelope.ciphertext[0] === "0" ? "1" : "0"}${envelope.ciphertext.slice(1)}`,
		};
		await expect(unwrapVaultKey(password, tampered)).rejects.toThrow("damaged");
		await expect(unwrapVaultKey(password, { ...envelope, kdf: "scrypt-N999999999" })).rejects.toThrow("parameters");
	});

	it("rejects malformed envelopes and short creation passwords", async () => {
		await expect(wrapVaultKey(Buffer.from("short"), randomBytes(32))).rejects.toThrow("12");
		await expect(unwrapVaultKey(Buffer.from("password"), {})).rejects.toThrow("format");
		await expect(
			unwrapVaultKey(Buffer.from("password"), { version: 1, kdf: "scrypt-N131072-r8-p1", salt: "ff" }),
		).rejects.toThrow("envelope");
	});
});

describe("native disk command boundary", () => {
	it("passes only the random disk key via stdin and clears the input buffers", async () => {
		const key = randomBytes(32);
		const seen: Array<{ command: string; args: string[]; input?: Buffer; snapshot?: string }> = [];
		const run: NativeCommand = async (command, args, input) => {
			seen.push({ command, args, input, snapshot: input?.toString() });
			if (command === "/usr/bin/plutil") return Buffer.from('{"encrypted":true}');
			return Buffer.alloc(0);
		};
		const disk = new MacVaultDisk(run);
		await disk.create("/vault/workspace.sparsebundle", key);
		await disk.attach("/vault/workspace.sparsebundle", "/vault/mount", key);
		await disk.detach("/vault/mount");
		expect(seen[0].args).toContain("AES-256");
		for (const call of seen.filter((call) => ["create", "attach"].includes(call.args[0]))) {
			expect(call.args.join(" ")).not.toContain(key.toString("hex"));
			expect(call.snapshot).toBe(`${key.toString("hex")}\0`);
			expect(call.input?.every((byte) => byte === 0)).toBe(true);
		}
		expect(seen.at(-1)?.args).toEqual(["detach", "/vault/mount"]);
	});

	it("refuses a replacement plaintext image before attaching", async () => {
		const run = vi.fn<NativeCommand>(async () => Buffer.from('{"encrypted":false}'));
		await expect(new MacVaultDisk(run).attach("/vault/image", "/vault/mount", randomBytes(32))).rejects.toThrow(
			"unencrypted",
		);
		expect(run.mock.calls.some((call) => call[1][0] === "attach")).toBe(false);
	});
});

describe("vault lifecycle", () => {
	it("reopens persisted data, excludes simultaneous owners, and changes passwords", async () => {
		const directory = await temporary();
		const backing = join(directory, "data");
		const vaultDirectory = join(directory, "vault");
		let attached = false;
		const disk: VaultDisk = {
			create: async () => {
				await mkdir(backing);
			},
			attach: async (_path, mount) => {
				await rmdir(mount);
				await rename(backing, mount);
				attached = true;
			},
			detach: async (mount) => {
				await rename(mount, backing);
				await mkdir(mount);
				attached = false;
			},
			isAttached: async () => attached,
		};
		const password = Buffer.from("correct horse battery staple");
		const vault = await openVault({ directory: vaultDirectory, password, create: true, disk });
		await writeFile(join(vault.root, "agent", "session.jsonl"), "private transcript");
		await expect(openVault({ directory: vaultDirectory, password, disk })).rejects.toThrow("in use");
		await vault.close();
		await vault.close();
		const next = Buffer.from("another secure password");
		await changeVaultPassword(vaultDirectory, password, next);
		await expect(openVault({ directory: vaultDirectory, password, disk })).rejects.toThrow("Incorrect password");
		const reopened = await openVault({ directory: vaultDirectory, password: next, disk });
		try {
			expect(await readFile(join(reopened.root, "agent", "session.jsonl"), "utf8")).toBe("private transcript");
		} finally {
			await reopened.close();
		}
	});

	it("preserves an existing key file when unlock fails", async () => {
		const directory = await temporary();
		await writeFile(
			join(directory, "key.json"),
			JSON.stringify(await wrapVaultKey(Buffer.from("a secure password"), randomBytes(32))),
		);
		const before = await readFile(join(directory, "key.json"));
		const disk: VaultDisk = { create: vi.fn(), attach: vi.fn(), detach: vi.fn(), isAttached: async () => false };
		await expect(openVault({ directory, password: Buffer.from("wrong"), disk })).rejects.toThrow(
			"Incorrect password",
		);
		expect(await readFile(join(directory, "key.json"))).toEqual(before);
		expect(disk.attach).not.toHaveBeenCalled();
	});
});

describe("private project imports", () => {
	it("verifies files and modes, preserves relative symlinks, and leaves source unchanged", async () => {
		const directory = await temporary();
		const source = join(directory, "source");
		await mkdir(join(source, "nested"), { recursive: true });
		await writeFile(join(source, "nested", "café.txt"), "Private 日本語\n");
		await chmod(join(source, "nested", "café.txt"), 0o700);
		await symlink("nested/café.txt", join(source, "relative-link"));
		const destination = join(directory, "copy");
		await verifiedPrivateCopy(source, destination);
		expect(await readFile(join(destination, "relative-link"), "utf8")).toBe("Private 日本語\n");
		expect(await readFile(join(source, "nested", "café.txt"), "utf8")).toBe("Private 日本語\n");
	});

	it("rejects external symlinks and linked Git worktrees", async () => {
		const directory = await temporary();
		const source = join(directory, "source");
		await mkdir(source);
		await symlink("/etc/passwd", join(source, "escape"));
		await expect(verifiedPrivateCopy(source, join(directory, "copy"))).rejects.toThrow("symlink");
		await rm(join(source, "escape"));
		await writeFile(join(source, ".git"), "gitdir: /outside/repository");
		await expect(verifiedPrivateCopy(source, join(directory, "copy"))).rejects.toThrow("worktrees");
	});

	it("publishes an opaque project ID and prevents accidental reimport", async () => {
		const directory = await temporary();
		const root = join(directory, "vault");
		const source = join(directory, "source");
		await mkdir(join(root, "projects"), { recursive: true });
		await mkdir(source);
		await writeFile(join(source, "file.txt"), "secret");
		const project = await importWorkspace(root, source, false);
		expect(project.id).toMatch(/^[a-f0-9-]{36}$/);
		expect(await listWorkspaces(root)).toEqual([project]);
		expect(await readFile(join(root, "projects", project.id, "file.txt"), "utf8")).toBe("secret");
		await expect(importWorkspace(root, source, false)).rejects.toThrow("already imported");
	});

	it("imports existing agent state only into an empty destination", async () => {
		const directory = await temporary();
		const root = join(directory, "vault");
		const source = join(directory, "old-agent");
		await mkdir(join(root, "agent"), { recursive: true });
		await mkdir(source);
		await writeFile(join(source, "crashes.json"), "[]");
		await importAgentState(root, source);
		expect(await readFile(join(root, "agent", "crashes.json"), "utf8")).toBe("[]");
		await expect(importAgentState(root, source)).rejects.toThrow("refusing to overwrite");
	});
});

describe("session migration", () => {
	it("retargets resumed sessions and fork parents while preserving original bytes", async () => {
		const root = await temporary();
		const project = { id: "00000000-0000-4000-8000-000000000001", name: "app", source: "/original/app" };
		const agent = join(root, "agent");
		const old = getDefaultSessionDir(project.source, agent);
		const parent = join(old, "parent.jsonl");
		const original = `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-01-01", cwd: project.source })}\n`;
		await writeFile(parent, original);
		await writeFile(
			join(old, "child.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-01-01", cwd: project.source, parentSession: parent })}\n`,
		);
		await relocateImportedSessions(root, [project]);
		const cwd = join(root, "projects", project.id);
		const destination = getDefaultSessionDir(cwd, agent);
		expect(JSON.parse(await readFile(join(destination, "child.jsonl"), "utf8"))).toMatchObject({
			cwd,
			parentSession: join(destination, "parent.jsonl"),
		});
		expect(await readFile(`${parent}.imported`, "utf8")).toBe(original);
		await expect(readFile(parent)).rejects.toThrow();
		await relocateImportedSessions(root, [project]);
	});
});

describe("private memory", () => {
	it("persists findings locally, separates namespaces, and rejects overwrites", async () => {
		const directory = await temporary();
		const store = new PrivateMemoryStore(directory);
		const memory = {
			namespace: "app",
			key: "decision",
			text: "Use encrypted storage",
			source: "design",
			author: "user",
		};
		await store.save(memory);
		expect(await new PrivateMemoryStore(directory).search("app", "encrypted")).toEqual({ items: [memory] });
		expect(await store.search("other", "encrypted")).toEqual({ items: [] });
		await expect(store.save({ ...memory, text: "overwrite" })).rejects.toThrow("already exists");
		expect((await readdir(directory)).every((name) => name.endsWith(".json"))).toBe(true);
	});
});

describe("privacy defaults", () => {
	it("requires explicit prefix opt-ins and never treats prompt text as an opt-in", () => {
		expect(parsePrivacyOptions([])).toEqual({
			unencrypted: false,
			privateMode: false,
			encryptWorkspace: false,
			allowGitRemotes: false,
			args: [],
		});
		expect(parsePrivacyOptions(["--unencrypted", "--allow-git-remotes", "-p", "hello"])).toMatchObject({
			unencrypted: true,
			allowGitRemotes: true,
			args: ["-p", "hello"],
		});
		for (const args of [
			["--", "--unencrypted"],
			["-p", "--unencrypted"],
			["--system-prompt", "--allow-git-remotes"],
		]) {
			expect(parsePrivacyOptions(args)).toMatchObject({ unencrypted: false, allowGitRemotes: false, args });
		}
		expect(() => parsePrivacyOptions(["--workspace"])).toThrow("requires a value");
	});

	it("routes state and scratch output into the vault and removes inherited overrides", () => {
		const env = privateEnvironment("/private/vault", {
			[ENV_AGENT_DIR]: "/old-agent",
			[ENV_SESSION_DIR]: "/old-sessions",
			TMPDIR: "/tmp",
			NODE_OPTIONS: "--require malicious.js",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "protocol.allow",
			GIT_CONFIG_VALUE_0: "always",
			PIONEER_API_KEY: "test-provider-key",
		});
		expect(env[ENV_AGENT_DIR]).toBe("/private/vault/agent");
		expect(env.TMPDIR).toBe("/private/vault/tmp");
		expect(env[ENV_SESSION_DIR]).toBeUndefined();
		expect(env.NODE_OPTIONS).toBeUndefined();
		expect(env.GIT_CONFIG_COUNT).toBeUndefined();
		expect(env.PIONEER_API_KEY).toBe("test-provider-key");
		expect(vaultSandboxProfile('/private/vault"quoted')).toContain('vault\\"quoted');
	});
});
