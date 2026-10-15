import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createVaultPassword } from "../privacy/password.ts";
import { atomicPrivateJson, openVault } from "../privacy/vault.ts";
import { listWorkspaces } from "../privacy/workspace.ts";
import { scaffoldGuildProject } from "./guild.ts";
import { promptProjectSetup, validateProjectName } from "./wizard.ts";

/** Project-local vault discovery also works from subdirectories. No project content is stored in this locator. */
export async function findProjectProtection(
	cwd: string,
): Promise<{ directory: string; encryptWorkspace: boolean } | undefined> {
	let current = await realpath(cwd);
	while (true) {
		try {
			const data: unknown = JSON.parse(await readFile(join(current, ".pioneer", "workspace.json"), "utf8"));
			if (
				!data ||
				typeof data !== "object" ||
				!("version" in data) ||
				data.version !== 1 ||
				!("storage" in data) ||
				(data.storage !== "protected" && data.storage !== "history")
			) {
				throw new Error("Invalid Pioneer workspace locator. Preserve it and repair setup before launching.");
			}
			return { directory: join(current, ".pioneer", "vault"), encryptWorkspace: data.storage === "protected" };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export async function findProjectVault(cwd: string): Promise<string | undefined> {
	return (await findProjectProtection(cwd))?.directory;
}

/** Route create before ordinary startup so it cannot acquire an unrelated, already-running vault. */
export async function createPioneerProject(name: string, privateMode = false, encryptWorkspace = false): Promise<void> {
	validateProjectName(name);
	const target = join(await realpath(process.cwd()), name);
	try {
		await lstat(target);
		throw new Error(`Project path already exists: ${target}. Run pioneer setup from that directory instead.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const setup = await promptProjectSetup(name, !encryptWorkspace, false, privateMode);
	if (!setup.transparent && process.platform !== "darwin")
		throw new Error(
			"Protected project creation currently requires macOS. Choose transparent explicitly on this platform.",
		);
	const password = privateMode || !setup.transparent ? await createVaultPassword() : undefined;
	try {
		// Exclusive reservation: a concurrent create can never overwrite an existing project.
		await mkdir(target, { mode: 0o700 });
		if (setup.transparent) {
			await scaffoldGuildProject(target, setup.project);
		}
		if (password) {
			await mkdir(join(target, ".pioneer"), { recursive: true, mode: 0o700 });
			await atomicPrivateJson(join(target, ".pioneer", "workspace.json"), {
				version: 1,
				storage: setup.transparent ? "history" : "protected",
			});
			const vault = await openVault({
				directory: join(target, ".pioneer", "vault"),
				password,
				create: true,
			});
			try {
				const project = { id: randomUUID(), source: target, name };
				// Publish first so interrupted setup can be resumed with pioneer setup without importing the image itself.
				await atomicPrivateJson(join(vault.root, "projects.json"), [project]);
				if (!setup.transparent) {
					const workspace = join(vault.root, "projects", project.id);
					await mkdir(workspace, { mode: 0o700 });
					await scaffoldGuildProject(workspace, setup.project);
				}
			} finally {
				await vault.close();
			}
			if (!setup.transparent)
				await writeFile(
					join(target, "PIONEER.txt"),
					"Protected Pioneer project. Source files and local Git live in .pioneer/vault. Run pioneer here to unlock.\n",
					{ flag: "wx", mode: 0o600 },
				);
		}
		process.stdout.write(
			`Created ${name} with Pioneer Guild planning and local Git.\nNext: cd ${name}\nThen: pioneer\n`,
		);
	} catch (error) {
		throw new Error(
			`Project setup did not complete: ${error instanceof Error ? error.message : String(error)}. Any files already written are preserved at ${target}.`,
		);
	} finally {
		password?.fill(0);
	}
}

export async function setupPioneerProject(): Promise<void> {
	const cwd = resolve(process.cwd());
	const root = process.env.PIONEER_VAULT_ROOT;
	const name = root
		? (await listWorkspaces(root)).find((project) => project.id === process.env.PIONEER_VAULT_PROJECT)?.name
		: undefined;
	const setup = await promptProjectSetup(
		name ?? basename(cwd),
		!root || Boolean(process.env.PIONEER_PRIVATE_CODE_DIR),
		true,
		Boolean(root),
	);
	const skipped = await scaffoldGuildProject(cwd, setup.project);
	process.stdout.write(
		`Pioneer Guild setup written. ${skipped.length ? `Preserved existing files: ${skipped.join(", ")}. Review them against docs/guild/PROJECT_SETUP_PROTOCOL.md.` : "Review docs/planning/STATE.json and the draft spec next."}\n`,
	);
}
