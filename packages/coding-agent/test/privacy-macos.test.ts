import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareGitPolicy } from "../src/core/privacy/git.ts";
import { privateEnvironment, vaultSandboxProfile } from "../src/core/privacy/launcher.ts";
import { PrivateMemoryStore } from "../src/core/privacy/memory.ts";
import { openVault, recoverVaultMount } from "../src/core/privacy/vault.ts";

/** Explicit local opt-in: mounts a disposable image, never reads user vaults, and makes no network requests. */
describe.skipIf(process.platform !== "darwin" || process.env.PI_TEST_NATIVE_VAULT !== "1")("native macOS vault", () => {
	it("encrypts project, Git, memory, sessions and scratch data; allows local Git; rejects remote and outside writes", async () => {
		const temporary = await realpath(await mkdtemp(join(tmpdir(), "pi-vault-native-")));
		const directory = join(temporary, "vault");
		const password = Buffer.from("native test password only");
		const sentinel = "PRIVATE-VAULT-CANARY-7d20e28c-file-and-memory";
		let cleanupSafe = false;
		try {
			const vault = await openVault({ directory, password, create: true });
			try {
				await prepareGitPolicy(vault.root, false);
				const env = {
					...privateEnvironment(vault.root, process.env),
					...(await prepareGitPolicy(vault.root, false)),
					GIT_AUTHOR_NAME: "Vault Test",
					GIT_AUTHOR_EMAIL: "vault@example.invalid",
					GIT_COMMITTER_NAME: "Vault Test",
					GIT_COMMITTER_EMAIL: "vault@example.invalid",
				};
				const run = (args: string[]) =>
					spawnSync("/usr/bin/sandbox-exec", ["-p", vaultSandboxProfile(vault.root), ...args], {
						cwd: vault.root,
						env,
						encoding: "utf8",
						timeout: 15_000,
					});
				await writeFile(join(vault.root, "project.txt"), sentinel);
				await writeFile(join(vault.root, "agent", "session.jsonl"), JSON.stringify({ text: sentinel }));
				await writeFile(join(vault.root, "tmp", "tool.log"), sentinel);
				await new PrivateMemoryStore(join(vault.root, "memory")).save({
					namespace: "test",
					key: "finding",
					text: sentinel,
					source: "test",
					author: "test",
				});
				const git = join(vault.root, "runtime", "bin", "git");
				for (const args of [
					["init"],
					["add", "project.txt"],
					["commit", "-m", "local encrypted commit"],
					["log", "-1", "--oneline"],
					["--no-optional-locks", "-c", "core.quotepath=false", "status", "--porcelain"],
				]) {
					const result = run([git, ...args]);
					expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
				}
				const remote = run([git, "remote", "add", "origin", "https://example.invalid/private.git"]);
				expect(remote.status).toBe(126);
				expect(remote.stderr).toContain("--allow-git-remotes");
				for (const args of [
					["push"],
					["fetch"],
					["pull"],
					["clone", "https://example.invalid/repo"],
					["config", "remote.origin.url", "https://example.invalid/repo"],
					["config", "REMOTE.origin.URL", "https://example.invalid/repo"],
				]) {
					expect(run([git, ...args]).status).toBe(126);
				}
				const outside = join(temporary, "escaped.txt");
				const escaped = run(["/bin/sh", "-c", 'printf secret > "$1"', "sh", outside]);
				expect(escaped.status).not.toBe(0);
				await expect(readFile(outside)).rejects.toThrow();
				const local = run(["/bin/sh", "-c", 'printf inside > "$1"', "sh", join(vault.root, "tmp", "inside.txt")]);
				expect(local.status, local.stderr).toBe(0);
			} finally {
				await vault.close();
			}

			// Scan physical encrypted image bands, not only filenames or a mocked encryption implementation.
			const bands = join(directory, "workspace.sparsebundle", "bands");
			for (const band of await readdir(bands)) {
				let tail = Buffer.alloc(0);
				for await (const chunk of createReadStream(join(bands, band))) {
					const bytes = Buffer.concat([tail, chunk]);
					expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
					tail = bytes.subarray(-sentinel.length);
				}
			}
			await expect(openVault({ directory, password: Buffer.from("wrong password") })).rejects.toThrow(
				"Incorrect password",
			);
			const reopened = await openVault({ directory, password });
			try {
				expect(await readFile(join(reopened.root, "project.txt"), "utf8")).toBe(sentinel);
				const history = spawnSync("/usr/bin/git", ["log", "-1", "--format=%s"], {
					cwd: reopened.root,
					encoding: "utf8",
					env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
				});
				expect(history.stdout.trim()).toBe("local encrypted commit");
				const policy = await prepareGitPolicy(reopened.root, true);
				expect(policy.PATH).toBeUndefined();
				const addRemote = spawnSync(
					"/usr/bin/git",
					["remote", "add", "origin", "https://example.invalid/opted-in.git"],
					{
						cwd: reopened.root,
						env: {
							...privateEnvironment(reopened.root, process.env),
							...policy,
							GIT_CONFIG_NOSYSTEM: "1",
							GIT_CONFIG_GLOBAL: "/dev/null",
						},
					},
				);
				expect(addRemote.status).toBe(0);
				expect(
					(await new PrivateMemoryStore(join(reopened.root, "memory")).search("test", sentinel)).items,
				).toHaveLength(1);
			} finally {
				await reopened.close();
			}
			cleanupSafe = true;
		} finally {
			password.fill(0);
			if (!cleanupSafe) {
				await recoverVaultMount(directory);
				cleanupSafe = true;
			}
			if (cleanupSafe) await rm(temporary, { recursive: true, force: true });
		}
	}, 120_000);
});
