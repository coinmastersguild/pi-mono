import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promptVaultPassword } from "./password.ts";

export type WorkspaceMode = "protected" | "transparent";

/** Inspect only this workspace's state. Detection must not create plaintext session directories. */
export async function hasPreviousPioneerRun(cwd: string, agentDir: string): Promise<boolean> {
	for (const name of [".pioneer", ".pi"]) {
		try {
			if ((await stat(join(cwd, name))).isDirectory()) return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const resolved = resolve(cwd);
	const encoded = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const directory = join(agentDir, "sessions", encoded);
	let files: Dirent[];
	try {
		files = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	for (const file of files) {
		if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
		const handle = await open(join(directory, file.name), "r");
		try {
			const buffer = Buffer.alloc(16384);
			const { bytesRead } = await handle.read(buffer);
			const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
			try {
				const header: unknown = JSON.parse(line);
				if (
					header &&
					typeof header === "object" &&
					"type" in header &&
					header.type === "session" &&
					"cwd" in header &&
					typeof header.cwd === "string" &&
					resolve(header.cwd) === resolved
				)
					return true;
			} catch {
				/* Ignore incomplete session headers. */
			}
		} finally {
			await handle.close();
		}
	}
	return false;
}

export async function chooseWorkspaceMode(previousRun: boolean): Promise<WorkspaceMode> {
	if (!previousRun) {
		process.stderr.write("Pioneer: new workspace. Setting up a protected space (encrypted at rest).\n");
		return "protected";
	}
	process.stderr.write(
		"Pioneer: previous workspace state found.\n" +
			"  [P] Protected space (default): work in an encrypted copy; originals are preserved.\n" +
			"  [T] Transparent workspace: work here with unencrypted files, sessions, and memory.\n",
	);
	while (true) {
		const answer = await promptVaultPassword("Choose [P/t], then Enter", false, false);
		const choice = answer.toString("utf8").trim().toLowerCase();
		answer.fill(0);
		if (choice === "" || choice === "p" || choice === "protected") return "protected";
		if (choice === "t" || choice === "transparent") return "transparent";
		process.stderr.write("Enter P for protected or T to explicitly opt into transparent storage.\n");
	}
}
