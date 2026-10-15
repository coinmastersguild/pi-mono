#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pioneerPackageManifest } from "./pioneer-package-manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" }, "skip-build": { type: "boolean", default: false } } });
const out = resolve(values.out ?? join(root, ".artifacts", "pioneer"));
if (existsSync(out)) throw new Error(`Output already exists: ${out}. Choose a new --out directory.`);
if (!values["skip-build"]) execFileSync("npm", ["run", "build:offline"], { cwd: root, stdio: "inherit" });
const source = join(root, "packages", "coding-agent");
const manifest = pioneerPackageManifest(JSON.parse(readFileSync(join(source, "package.json"), "utf8")));
const stage = join(out, "package");
mkdirSync(stage, { recursive: true });
for (const name of ["dist", "docs", "examples", "schemas", "containerization.md", "CHANGELOG.md"]) {
	if (existsSync(join(source, name))) cpSync(join(source, name), join(stage, name), { recursive: true });
}
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
cpSync(join(root, "docs", `pioneer-release-${manifest.version}.md`), join(stage, "docs", "pioneer-release.md"));
function adaptPublicExamples(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) adaptPublicExamples(path);
		else if (entry.isFile() && [".md", ".ts", ".js", ".json", ".sh"].includes(extname(path))) {
			const text = readFileSync(path, "utf8");
			writeFileSync(path, text.replaceAll("@earendil-works/pi-coding-agent", manifest.name)
				.replaceAll("PI_CODING_AGENT_SESSION_DIR", "PIONEER_CODING_AGENT_SESSION_DIR")
				.replaceAll("PI_CODING_AGENT_DIR", "PIONEER_CODING_AGENT_DIR").replaceAll("~/.pi", "~/.pioneer"));
		}
	}
}
adaptPublicExamples(join(stage, "docs"));
adaptPublicExamples(join(stage, "examples"));
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
writeFileSync(join(stage, "README.md"), `# Pioneer CLI\n\nRequires Node.js 22.19 or newer for CLI and SDK use. Direct Bun execution is currently unsupported by the HTTP dependency; use Node even when installing with Bun.\n\nInstall: npm install -g --ignore-scripts ${manifest.name}\n\nRun pioneer in your project. Encryption is off by default.\n\nUse pioneer --private to encrypt history, logs, credentials, and local memory while writing code normally. Use pioneer create --private my-project for a guided project with private agent state, or add --encrypt-workspace to encrypt the project too. Encryption currently requires macOS and a controlling terminal.\n\nPioneer Core supplies explicitly granted local long-term memory and analytics. Alpha analytics uses https://alpha.pioneers.dev/api/v1/analytic with your Pioneer credential; PIONEER_ANALYTIC_ENABLED=0 disables it. Run /core and /analytic-status to inspect integration status. Private memory stays in the local vault; cloud model/analytics requests can transmit context.\n\nSee [privacy modes](docs/privacy.md) for migration, recovery, and encryption limits.\n`);
writeFileSync(join(stage, "README.md"), `${readFileSync(join(stage, "README.md"), "utf8")}\n## Goal mode\n\nUse /goal <objective> to keep working toward a saved goal. /goal status, /goal pause, /goal resume, and /goal cancel control it. Runs default to 20 model turns; use /goal start --turns 40 <objective> for a different limit. Completion requires recorded verification evidence. Goals restore paused after restarting and follow session encryption. See [goals](docs/goals.md).\n\nPioneer Office receives assignments and messages when configured with a scoped agent credential. /office inbox reviews them; /office accept <cursor> explicitly starts an assignment. Automatic maintenance mode is not included in this release.\n`);
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], { cwd: stage, encoding: "utf8" }));
if (packed.length !== 1 || packed[0].name !== manifest.name) throw new Error("Unexpected npm artifact identity");
for (const path of ["dist/core/privacy/launcher.js", "dist/core/pioneer-goal.js", "dist/extensions/pioneer-goal.js", "docs/goals.md"]) {
	if (!packed[0].files.some((file) => file.path === path)) throw new Error(`Required Pioneer file missing from tarball: ${path}`);
}
writeFileSync(join(out, "artifact.json"), `${JSON.stringify({ name: manifest.name, version: manifest.version, tarball: packed[0].filename, integrity: packed[0].integrity }, null, 2)}\n`);
console.log(`Pioneer npm artifact: ${join(out, packed[0].filename)}`);
