import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface PrivateMemory {
	namespace: string;
	key: string;
	text: string;
	source: string;
	author: string;
}

/** Private memory is outside the project Git tree, on the same encrypted volume. */
export function privateMemoryDirectory(): string | undefined {
	const root = process.env.PIONEER_VAULT_ROOT;
	const project = process.env.PIONEER_VAULT_PROJECT;
	if (!root || !project) return undefined;
	if (!/^[a-f0-9-]{36}$/.test(project)) throw new Error("Invalid private project identity.");
	return join(root, "memory", project);
}

export class PrivateMemoryStore {
	private readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
	}

	async save(memory: PrivateMemory): Promise<{ saved: true }> {
		if (
			![memory.namespace, memory.key, memory.text, memory.source, memory.author].every(
				(value) => typeof value === "string" && value.length > 0 && value.length <= 16000,
			)
		)
			throw new Error("Invalid private memory.");
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const id = createHash("sha256")
			.update(JSON.stringify([memory.namespace, memory.key]))
			.digest("hex");
		const temporary = join(this.directory, `${randomUUID()}.tmp`);
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(memory));
				await file.sync();
			} finally {
				await file.close();
			}
			try {
				await link(temporary, join(this.directory, `${id}.json`));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST")
					throw new Error("Private memory key already exists; review the conflict.");
				throw error;
			}
			return { saved: true };
		} finally {
			await rm(temporary, { force: true });
		}
	}

	async search(namespace: string, query: string): Promise<{ items: PrivateMemory[] }> {
		const entries = await readdir(this.directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
		const matches: Array<{ memory: PrivateMemory; score: number }> = [];
		for (const entry of entries) {
			if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
			const value: unknown = JSON.parse(await readFile(join(this.directory, entry.name), "utf8"));
			if (!value || typeof value !== "object") throw new Error("Invalid private memory record.");
			const memory = value as PrivateMemory;
			if (
				![memory.namespace, memory.key, memory.text, memory.source, memory.author].every(
					(part) => typeof part === "string",
				)
			) {
				throw new Error("Invalid private memory record.");
			}
			if (memory.namespace !== namespace) continue;
			const text = `${memory.key}\n${memory.text}`.toLowerCase();
			const score = terms.filter((term) => text.includes(term)).length;
			if (score > 0 || terms.length === 0) matches.push({ memory, score });
		}
		return {
			items: matches
				.sort((a, b) => b.score - a.score || a.memory.key.localeCompare(b.memory.key))
				.slice(0, 10)
				.map((entry) => entry.memory),
		};
	}
}
