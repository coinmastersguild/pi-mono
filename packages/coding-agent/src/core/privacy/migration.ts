import type { Dirent } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { type FileEntry, getDefaultSessionDir } from "../session-manager.ts";
import { isWithin, type PrivateWorkspace } from "./workspace.ts";

/** Retarget imported JSONL sessions without leaving a working-directory reference to the plaintext project. */
export async function relocateImportedSessions(root: string, projects: PrivateWorkspace[]): Promise<void> {
	const agent = join(root, "agent");
	const sessions = join(agent, "sessions");
	let directories: Dirent[];
	try {
		directories = await readdir(sessions, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const changes: Array<{ oldPath: string; newPath: string; entries: FileEntry[] }> = [];
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		const from = join(sessions, directory.name);
		for (const file of await readdir(from, { withFileTypes: true })) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
			const path = join(from, file.name);
			const text = await readFile(path, "utf8");
			let entries: FileEntry[];
			try {
				entries = text
					.split("\n")
					.filter((line) => line.trim())
					.map((line) => JSON.parse(line) as FileEntry);
			} catch {
				throw new Error(`Imported session is malformed; preserved without rewriting: ${file.name}`);
			}
			const header = entries[0];
			if (header?.type !== "session" || typeof header.cwd !== "string") continue;
			const project = projects
				.filter((entry) => isWithin(entry.source, header.cwd))
				.sort((a, b) => b.source.length - a.source.length)[0];
			if (!project) continue;
			const cwd = join(root, "projects", project.id, relative(project.source, header.cwd));
			header.cwd = cwd;
			changes.push({ oldPath: path, newPath: join(getDefaultSessionDir(cwd, agent), basename(path)), entries });
		}
	}
	for (const change of changes) {
		const header = change.entries[0];
		if (header.type === "session" && header.parentSession) {
			const parentName = basename(header.parentSession);
			const candidates = changes.filter((other) => basename(other.oldPath) === parentName);
			if (candidates.length === 1) header.parentSession = candidates[0].newPath;
		}
		// Stage on the encrypted filesystem. Exclusive destination creation prevents overwriting a newer session.
		if (change.newPath !== change.oldPath) {
			await writeFile(change.newPath, `${change.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
				flag: "wx",
				mode: 0o600,
			});
			// Keep the imported bytes as an encrypted backup, outside session discovery.
			await rename(change.oldPath, `${change.oldPath}.imported`);
		}
	}
}
