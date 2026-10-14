import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Writable } from "node:stream";
import { printHelp } from "../../cli/args.ts";
import { ENV_AGENT_DIR, ENV_SESSION_DIR, getAgentDir, isBunBinary, VERSION } from "../../config.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { createPioneerProject, findProjectProtection, setupPioneerProject } from "../projects/setup.ts";
import { getDefaultSessionDir } from "../session-manager.ts";
import { clearInheritedGitOverrides, prepareGitPolicy } from "./git.ts";
import { relocateImportedSessions } from "./migration.ts";
import { createVaultPassword, promptVaultPassword } from "./password.ts";
import { atomicPrivateJson, changeVaultPassword, openVault, recoverVaultMount, vaultExists } from "./vault.ts";
import { importAgentState, importWorkspace, isWithin, listWorkspaces } from "./workspace.ts";

const CHILD_FLAG = "--pioneer-private-child";

export interface PrivacyOptions {
	unencrypted: boolean;
	privateMode: boolean;
	encryptWorkspace: boolean;
	allowGitRemotes: boolean;
	vaultDirectory?: string;
	workspace?: string;
	args: string[];
}

/** Security opt-ins are prefix options so prompt text and extension flag values cannot enable them. */
export function parsePrivacyOptions(args: readonly string[]): PrivacyOptions {
	const options: PrivacyOptions = {
		unencrypted: false,
		privateMode: false,
		encryptWorkspace: false,
		allowGitRemotes: false,
		args: [],
	};
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--unencrypted" || arg === "--transparent") options.unencrypted = true;
		else if (arg === "--private") options.privateMode = true;
		else if (arg === "--encrypt-workspace") {
			options.privateMode = true;
			options.encryptWorkspace = true;
		} else if (arg === "--allow-git-remotes") options.allowGitRemotes = true;
		else if (arg === "--vault-dir" || arg === "--workspace") {
			const value = args[++index];
			if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value.`);
			if (arg === "--vault-dir") options.vaultDirectory = resolve(value);
			else options.workspace = value;
		} else break;
		index++;
	}
	options.args = args.slice(index);
	if (options.unencrypted && options.workspace) throw new Error("--workspace requires encrypted mode.");
	if (options.unencrypted && options.privateMode)
		throw new Error("--private cannot be combined with --transparent or --unencrypted.");
	return options;
}

/** Writes outside the encrypted volume fail in the kernel, including writes by tools and editors. */
export function vaultSandboxProfile(root: string, codeDirectory?: string): string {
	const escaped = JSON.stringify(root);
	const runtime = JSON.stringify(join(root, "runtime"));
	return `(version 1)
(allow default)
(deny file-write*
  (require-all
    (require-not (subpath ${escaped}))
    ${codeDirectory ? `(require-not (subpath ${JSON.stringify(codeDirectory)}))` : ""}
    (require-not (literal "/dev/null"))
    (require-not (literal "/dev/tty"))
    (require-not (regex #"^/dev/(ttys[0-9]+|pty[a-z0-9]+)$"))))
(deny file-write* (subpath ${runtime}))
`;
}

export function privateEnvironment(root: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment = { ...inherited };
	clearInheritedGitOverrides(environment);
	delete environment[ENV_SESSION_DIR];
	// Runtime injection could execute before the child has entered the application.
	delete environment.NODE_OPTIONS;
	delete environment.NODE_V8_COVERAGE;
	delete environment.DYLD_INSERT_LIBRARIES;
	delete environment.DYLD_LIBRARY_PATH;
	delete environment.PIONEER_PRIVATE_CODE_DIR;
	return {
		...environment,
		[ENV_AGENT_DIR]: join(root, "agent"),
		PIONEER_VAULT_ROOT: root,
		TMPDIR: join(root, "tmp"),
		TMP: join(root, "tmp"),
		TEMP: join(root, "tmp"),
		XDG_CACHE_HOME: join(root, "cache"),
		npm_config_cache: join(root, "cache", "npm"),
		PIP_CACHE_DIR: join(root, "cache", "pip"),
		UV_CACHE_DIR: join(root, "cache", "uv"),
		HISTFILE: "/dev/null",
	};
}

interface ChildRequest {
	args: string[];
	root?: string;
	codeDirectory?: string;
}

async function runChild(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	root?: string,
	codeDirectory?: string,
): Promise<number> {
	const executableArgs = isBunBinary
		? [process.execPath, CHILD_FLAG]
		: [process.execPath, ...process.execArgv, process.argv[1], CHILD_FLAG];
	const command = root ? "/usr/bin/sandbox-exec" : executableArgs[0];
	const commandArgs = root
		? ["-p", vaultSandboxProfile(root, codeDirectory), ...executableArgs]
		: executableArgs.slice(1);
	const child = spawn(command, commandArgs, {
		cwd,
		env,
		stdio: ["inherit", "inherit", "inherit", "pipe"],
	});
	const request: ChildRequest = { args, root, codeDirectory };
	const control = child.stdio[3] as Writable;
	control.on("error", () => {});
	control.end(JSON.stringify(request));
	return new Promise((resolveExit, reject) => {
		let killTimer: NodeJS.Timeout | undefined;
		const stop = (): void => {
			child.kill("SIGTERM");
			killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
		};
		// The foreground process also receives SIGINT directly. Do not send it twice.
		const interrupt = (): void => {};
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", stop);
		process.on("SIGHUP", stop);
		const cleanup = (): void => {
			if (killTimer) clearTimeout(killTimer);
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", stop);
			process.off("SIGHUP", stop);
		};
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", (code, signal) => {
			cleanup();
			resolveExit(code ?? (signal === "SIGINT" ? 130 : 1));
		});
	});
}

function printVaultHelp(): void {
	console.log(`Pioneer private workspace (macOS)

  pioneer                         Start normally; encryption is off by default
  pioneer --private               Encrypt history, logs, and memory; write code normally
  pioneer --private --encrypt-workspace Encrypt the project too (macOS)
  pioneer create <name>           Create a project with guided Pioneer Guild setup
  pioneer setup                   Guide setup of the current project; preserve existing files
  pioneer vault init              Create a password-protected vault
  pioneer vault import [dir]      Verify and import a project, including local Git
  pioneer vault import-state [dir] Import existing Pioneer state into an empty vault
  pioneer vault list              Unlock and list imported projects
  pioneer vault password          Change the vault password
  pioneer vault lock              Recover an abandoned mount after a crash
  pioneer --workspace <id>        Open an imported project from any directory

Prefix options (before other options):
  --private                       Encrypt agent state using a startup password
  --encrypt-workspace             Also encrypt project files and local Git
  --unencrypted                   Opt into plaintext storage for this invocation
  --transparent                   Opt into a transparent (unencrypted) workspace
  --allow-git-remotes              Opt into Git remotes for this invocation
  --vault-dir <directory>          Choose a vault location

Encryption is opt-in. --private stores sessions, logs, credentials, and local
memory on an AES-256 encrypted disk image while code stays in the normal directory.
--encrypt-workspace also encrypts project files and Git history. Imports preserve
their source files. There is no password reset or recovery key.
One pi process owns the vault at a time. Protection is encryption at rest:
normal exit locks the vault; processes with the same OS identity can read it
while unlocked. No separate account or VM is required.`);
}

/** Wrap every CLI entry, including RPC and experimental launchers, before any user resources load. */
export async function launchPrivateCli(args: string[], run: (args: string[]) => Promise<void>): Promise<void> {
	try {
		if (args[0] === CHILD_FLAG) {
			// The supervisor owns the mount and sends only paths/options, never the disk key.
			const request: unknown = JSON.parse(readFileSync(3, "utf8"));
			if (
				!request ||
				typeof request !== "object" ||
				!("args" in request) ||
				!Array.isArray(request.args) ||
				!request.args.every((arg: unknown) => typeof arg === "string")
			)
				throw new Error("Invalid vault launch.");
			const frame = request as ChildRequest;
			if (
				frame.root &&
				(process.env.PIONEER_VAULT_ROOT !== frame.root ||
					!(
						isWithin(frame.root, await realpath(process.cwd())) ||
						(frame.codeDirectory === (await realpath(process.cwd())) &&
							process.env.PIONEER_PRIVATE_CODE_DIR === frame.codeDirectory)
					))
			) {
				throw new Error("Private workspace launch escaped its vault.");
			}
			if (frame.root) {
				process.env[ENV_SESSION_DIR] = getDefaultSessionDir(process.cwd(), join(frame.root, "agent"));
				process.once("exit", killTrackedDetachedChildren);
			}
			try {
				if (frame.args.length === 1 && frame.args[0] === "setup") await setupPioneerProject();
				else await run(frame.args);
			} finally {
				if (frame.root) killTrackedDetachedChildren();
			}
			return;
		}
		const options = parsePrivacyOptions(args);
		if (options.args[0] === "create") {
			if (options.args[1] === "--help" || options.args[1] === "-h") {
				console.log(
					"pioneer create [--private] [--encrypt-workspace] <name>\nPlaintext code by default; --private encrypts agent history. Creates local Git without a remote.",
				);
				return;
			}
			let name: string | undefined;
			for (const arg of options.args.slice(1)) {
				if (arg === "--private") options.privateMode = true;
				else if (arg === "--encrypt-workspace") {
					options.privateMode = true;
					options.encryptWorkspace = true;
				} else if (arg === "--transparent" || arg === "--unencrypted") options.unencrypted = true;
				else if (!name && !arg.startsWith("-")) name = arg;
				else throw new Error(`Unknown create option: ${arg}`);
			}
			if (!name) throw new Error("Usage: pioneer create [--private] [--encrypt-workspace] <name>");
			if (options.unencrypted && options.privateMode) throw new Error("Choose private or plaintext storage.");
			if (options.vaultDirectory || options.workspace)
				throw new Error("Create uses a new project-local vault; omit --vault-dir and --workspace.");
			await createPioneerProject(name, options.privateMode, options.encryptWorkspace);
			return;
		}
		if (options.args[0] === "setup" && options.args.length !== 1)
			throw new Error("Usage: pioneer [--transparent] setup");
		const command = options.args[0] === "vault" ? options.args[1] : undefined;
		if (options.args.length === 1 && (options.args[0] === "--version" || options.args[0] === "-v")) {
			console.log(VERSION);
			return;
		}
		if (command === "help" || (options.args[0] === "vault" && !command)) {
			printVaultHelp();
			return;
		}
		if (options.args.length === 1 && (options.args[0] === "--help" || options.args[0] === "-h")) {
			printVaultHelp();
			printHelp();
			return;
		}
		const protection = options.unencrypted ? undefined : await findProjectProtection(process.cwd());
		if (protection) {
			options.privateMode = true;
			options.encryptWorkspace = protection.encryptWorkspace;
		}
		if (options.workspace) {
			options.privateMode = true;
			options.encryptWorkspace = true;
		}
		const directory =
			options.vaultDirectory ??
			protection?.directory ??
			join(
				dirname(getAgentDir()),
				options.privateMode && !options.encryptWorkspace ? "private-history-vault" : "vault",
			);
		const existing = !options.unencrypted && (await vaultExists(directory));
		if (options.unencrypted || (!options.privateMode && !command && !options.workspace)) {
			if (command) throw new Error("Vault commands require encrypted mode.");
			if (options.unencrypted) process.stderr.write("Pioneer: plaintext storage selected.\n");
			const policyRoot = await mkdtemp(join(tmpdir(), "pi-git-policy-"));
			try {
				const env = { ...process.env };
				delete env.PIONEER_VAULT_ROOT;
				delete env.PIONEER_VAULT_PROJECT;
				delete env.PIONEER_PRIVATE_CODE_DIR;
				clearInheritedGitOverrides(env);
				Object.assign(env, await prepareGitPolicy(policyRoot, options.allowGitRemotes));
				process.exitCode = await runChild(options.args, process.cwd(), env);
			} finally {
				await rm(policyRoot, { recursive: true, force: true });
			}
			return;
		}
		if (process.platform !== "darwin") {
			throw new Error("Encrypted workspaces currently require macOS. --unencrypted explicitly opts into plaintext.");
		}
		if (command === "lock") {
			await recoverVaultMount(directory);
			console.log("Vault locked.");
			return;
		}
		if (command && !["init", "import", "import-state", "list", "password"].includes(command)) {
			throw new Error(`Unknown vault command: ${command}. Run pioneer vault help.`);
		}
		if (!existing && (options.workspace || (command && command !== "init" && command !== "import"))) {
			throw new Error("No protected space exists. Run pioneer in the project directory to set one up.");
		}
		const password = existing ? await promptVaultPassword("Unlock password", true) : await createVaultPassword();
		try {
			if (command === "password") {
				const next = await createVaultPassword();
				try {
					await changeVaultPassword(directory, password, next);
					console.log("Vault password changed. Older key-file backups still use the old password.");
				} finally {
					next.fill(0);
				}
				return;
			}
			const vault = await openVault({ directory, password, create: !existing });
			password.fill(0);
			try {
				if (options.privateMode && !options.encryptWorkspace && !command && !options.workspace) {
					if (
						options.args.some(
							(arg) =>
								arg === "--session-dir" ||
								arg.startsWith("--session-dir=") ||
								arg === "--session" ||
								arg.startsWith("--session="),
						)
					)
						throw new Error(
							"Private history uses its encrypted session directory; omit --session and --session-dir. Use --resume or --continue.",
						);
					const cwd = await realpath(process.cwd());
					const projects = await listWorkspaces(vault.root);
					let project = projects.find((entry) => entry.source === cwd);
					if (!project) {
						project = { id: randomUUID(), source: cwd, name: basename(cwd) };
						await atomicPrivateJson(join(vault.root, "projects.json"), [...projects, project]);
					}
					const env = privateEnvironment(vault.root, process.env);
					env.PIONEER_VAULT_PROJECT = project.id;
					env.PIONEER_PRIVATE_CODE_DIR = cwd;
					Object.assign(env, await prepareGitPolicy(vault.root, options.allowGitRemotes));
					process.stderr.write(
						"Pioneer: history, logs, and local memory encrypted; code files remain plaintext.\n",
					);
					process.exitCode = await runChild(options.args, cwd, env, vault.root, cwd);
					return;
				}
				if (command === "init") {
					console.log("Protected space ready. Run pioneer in a project directory to add it.");
					return;
				}
				if (command === "import") {
					const project = await importWorkspace(
						vault.root,
						options.args[2] ?? process.cwd(),
						options.allowGitRemotes,
					);
					await relocateImportedSessions(vault.root, await listWorkspaces(vault.root));
					console.log(
						`Imported and verified ${project.name}. Workspace ID: ${project.id}\nOriginal files remain unencrypted at ${project.source}.`,
					);
					return;
				}
				if (command === "import-state") {
					await importAgentState(vault.root, options.args[2] ?? getAgentDir());
					await relocateImportedSessions(vault.root, await listWorkspaces(vault.root));
					console.log(
						"Agent state imported and verified. Original state remains unencrypted; preserve it until recovery is verified.",
					);
					return;
				}
				const projects = await listWorkspaces(vault.root);
				if (command === "list") {
					for (const project of projects) console.log(`${project.id}\t${project.name}`);
					return;
				}
				const source = await realpath(process.cwd());
				let project = options.workspace
					? projects.find((entry) => entry.id === options.workspace)
					: projects
							.filter((entry) => isWithin(entry.source, source))
							.sort((a, b) => b.source.length - a.source.length)[0];
				if (!project && options.workspace)
					throw new Error("Unknown protected workspace ID. Run pioneer vault list.");
				if (!project) {
					project = await importWorkspace(vault.root, source, options.allowGitRemotes);
					await relocateImportedSessions(vault.root, await listWorkspaces(vault.root));
					process.stderr.write(
						`Pioneer: protected space ready. Original files remain unencrypted at ${source}.\n`,
					);
				}
				const cwd = join(
					vault.root,
					"projects",
					project.id,
					options.workspace ? "" : relative(project.source, source),
				);
				const env = privateEnvironment(vault.root, process.env);
				env.PIONEER_VAULT_PROJECT = project.id;
				Object.assign(env, await prepareGitPolicy(vault.root, options.allowGitRemotes));
				await mkdir(join(vault.root, "cache", "npm"), { recursive: true });
				await writeFile(join(vault.root, "runtime", "session.json"), JSON.stringify({ project: project.id }), {
					mode: 0o600,
				});
				process.stderr.write(
					`Unlocked ${project.name}. Git remotes ${options.allowGitRemotes ? "enabled by opt-in" : "disabled"}.\n`,
				);
				process.exitCode = await runChild(options.args, cwd, env, vault.root);
			} finally {
				await vault.close();
			}
		} finally {
			password.fill(0);
		}
	} catch (error) {
		process.stderr.write(`Pioneer privacy: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
