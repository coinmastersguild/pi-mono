import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runNative } from "./native.ts";
import { atomicPrivateJson } from "./vault.ts";

export interface PrivateWorkspace {
	id: string;
	source: string;
	name: string;
}

export function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function listWorkspaces(root: string): Promise<PrivateWorkspace[]> {
	let data: unknown;
	try {
		data = JSON.parse(await readFile(join(root, "projects.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (
		!Array.isArray(data) ||
		!data.every((item: unknown) => {
			if (!item || typeof item !== "object") return false;
			const entry = item as Partial<PrivateWorkspace>;
			return (
				typeof entry.id === "string" &&
				/^[a-f0-9-]{36}$/.test(entry.id) &&
				typeof entry.source === "string" &&
				isAbsolute(entry.source) &&
				typeof entry.name === "string"
			);
		})
	)
		throw new Error("Invalid encrypted project index. Preserve the vault for recovery.");
	return data as PrivateWorkspace[];
}

async function fileDigest(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

/** Validate first; external symlinks and Git worktrees/alternates would leave history outside the vault. */
async function inventory(root: string, directory = root): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for (const name of (await readdir(directory)).sort()) {
		const path = join(directory, name);
		const rel = relative(root, path);
		const info = await lstat(path);
		if (name === ".git" && !info.isDirectory()) {
			throw new Error("Git worktrees and external Git directories must be made self-contained before import.");
		}
		if (rel.endsWith(`${sep}objects${sep}info${sep}alternates`)) {
			throw new Error("Git object alternates must be made self-contained before import.");
		}
		if (info.isSymbolicLink()) {
			const target = await readlink(path);
			if (isAbsolute(target) || !isWithin(root, resolve(dirname(path), target))) {
				throw new Error(`External or absolute symlink cannot be imported: ${rel}`);
			}
			files.set(rel, `link:${target}`);
		} else if (info.isDirectory()) {
			files.set(rel, "directory");
			for (const entry of await inventory(root, path)) files.set(...entry);
		} else if (info.isFile()) {
			files.set(rel, `${info.mode & 0o777}:${info.size}:${await fileDigest(path)}`);
		} else {
			throw new Error(`Unsupported file type in import: ${rel}`);
		}
	}
	return files;
}

/** Copy into an encrypted staging directory, verify every file, then publish. Originals are never deleted. */
export async function verifiedPrivateCopy(source: string, destination: string): Promise<void> {
	const before = await inventory(source);
	const staging = `${destination}.${randomUUID()}.importing`;
	try {
		await cp(source, staging, {
			recursive: true,
			verbatimSymlinks: true,
			preserveTimestamps: true,
			errorOnExist: true,
		});
		const copied = await inventory(staging);
		const after = await inventory(source);
		if (
			before.size !== copied.size ||
			before.size !== after.size ||
			[...before].some(([name, digest]) => copied.get(name) !== digest || after.get(name) !== digest)
		) {
			throw new Error("Import verification failed or the source changed. Stop other writers and retry.");
		}
		await rename(staging, destination);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

export async function importWorkspace(
	root: string,
	sourcePath: string,
	allowRemotes: boolean,
): Promise<PrivateWorkspace> {
	const source = await realpath(sourcePath);
	if (isWithin(source, root) || isWithin(root, source)) throw new Error("Cannot import the vault or its parent.");
	if (!(await stat(source)).isDirectory()) throw new Error("Project source must be a directory.");
	const projects = await listWorkspaces(root);
	if (projects.some((project) => project.source === source)) throw new Error("Project is already imported.");
	const project: PrivateWorkspace = { id: randomUUID(), source, name: basename(source) };
	const destination = join(root, "projects", project.id);
	await verifiedPrivateCopy(source, destination);
	if (!allowRemotes) {
		// Preserve the imported Git configuration in encrypted metadata before removing remotes from the copy.
		const config = join(destination, ".git", "config");
		try {
			const original = await readFile(config, "utf8");
			await atomicPrivateJson(join(root, "projects", `${project.id}.git-config.json`), { original });
			const output = await runNative("/usr/bin/git", ["config", "--file", config, "--null", "--list"]);
			const sections = new Set(
				output
					.toString("utf8")
					.split("\0")
					.flatMap((entry) => {
						const key = entry.split("\n", 1)[0];
						return key.startsWith("remote.") ? [key.slice(0, key.lastIndexOf("."))] : [];
					}),
			);
			for (const section of sections)
				await runNative("/usr/bin/git", ["config", "--file", config, "--remove-section", section]);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await atomicPrivateJson(join(root, "projects.json"), [...projects, project]);
	return project;
}

export async function importAgentState(root: string, source: string): Promise<void> {
	const canonical = await realpath(source);
	if (isWithin(canonical, root) || isWithin(root, canonical))
		throw new Error("Cannot import the vault or its parent.");
	const destination = join(root, "agent");
	if ((await readdir(destination)).length)
		throw new Error("Encrypted agent state is not empty; refusing to overwrite it.");
	const imported = join(root, `agent-${randomUUID()}.importing`);
	await verifiedPrivateCopy(canonical, imported);
	// Both directories are encrypted. Keep a completed import recoverable if publication fails.
	await rm(destination, { recursive: true });
	await rename(imported, destination);
	await mkdir(join(root, "agent"), { recursive: true, mode: 0o700 });
}
