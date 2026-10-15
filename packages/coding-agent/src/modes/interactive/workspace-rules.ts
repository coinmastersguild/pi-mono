import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_WORKSPACE_RULES = ["suspicious/noExplicitAny", "complexity/noExcessiveCognitiveComplexity"];

/** Rule packs contain Biome rule identifiers only, never executable plugins or commands. */
export function parseWorkspaceRules(text: string): string[] {
	if (text.length > 16384) throw new Error("Rule pack exceeds 16 KiB");
	const value: unknown = JSON.parse(text);
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("rules" in value) ||
		!Array.isArray(value.rules) ||
		value.rules.length === 0 ||
		value.rules.length > 32 ||
		value.rules.some(
			(rule: unknown) =>
				typeof rule !== "string" ||
				!/^(?:a11y|complexity|correctness|performance|security|style|suspicious)\/[a-z][a-zA-Z0-9]+$/.test(rule),
		)
	)
		throw new Error("Expected version 1 and 1–32 Biome rule identifiers");
	return [...new Set(value.rules as string[])];
}

export async function loadWorkspaceRules(cwd: string): Promise<string[]> {
	const path = join(cwd, ".pi", "quality-rules.json");
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("Invalid rule pack file");
		return parseWorkspaceRules(await readFile(path, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return DEFAULT_WORKSPACE_RULES;
		throw error;
	}
}
