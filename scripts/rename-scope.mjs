#!/usr/bin/env node
/**
 * Rename pi-ai and pi-coding-agent to the @pioneer-platform scope for
 * publishing.
 *
 * Also rewrites pi-ai references inside sibling workspace packages so the
 * monorepo resolves to a single pi-ai in node_modules (avoids type-identity
 * clashes from two copies). Siblings keep their @mariozechner/* names —
 * we don't publish them; end users pull them unchanged from upstream npm.
 *
 * Idempotent.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RENAMES = [
	["@mariozechner/pi-ai", "@pioneer-platform/pi-ai"],
	["@mariozechner/pi-coding-agent", "@pioneer-platform/pi-coding-agent"],
];

const PATH_PREFIXES = [
	"packages/ai/",
	"packages/coding-agent/",
	"packages/agent/",
	"packages/tui/",
	"packages/web-ui/",
	"packages/mom/",
	"packages/pods/",
	"scripts/",
	"tsconfig.json",
	"package.json",
];

const EXCLUDE = /node_modules|\/dist\/|\.git\/|package-lock\.json|test\/fixtures\//;
const INCLUDE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md)$/;

const files = execSync("git ls-files", { encoding: "utf8" })
	.split("\n")
	.filter(Boolean)
	.filter((p) => PATH_PREFIXES.some((prefix) => p.startsWith(prefix)))
	.filter((p) => INCLUDE.test(p) && !EXCLUDE.test(p));

let changed = 0;
for (const file of files) {
	const before = readFileSync(file, "utf8");
	let after = before;
	for (const [from, to] of RENAMES) after = after.replaceAll(from, to);
	if (after === before) continue;
	writeFileSync(file, after);
	changed++;
	console.log(`  ${file}`);
}

console.log(`\nRewrote ${changed} file(s).`);
