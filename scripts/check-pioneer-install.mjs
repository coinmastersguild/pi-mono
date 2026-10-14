#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pioneerPackageName } from "./pioneer-package-manifest.mjs";
import { verifyPioneerArtifact } from "./verify-pioneer-artifact.mjs";

const artifactDirectory = resolve(process.argv[2] ?? ".artifacts/pioneer");
const artifact = JSON.parse(readFileSync(join(artifactDirectory, "artifact.json"), "utf8"));
if (artifact.name !== pioneerPackageName) throw new Error("Unexpected Pioneer artifact");
const tarball = verifyPioneerArtifact(artifactDirectory);
const directory = mkdtempSync(join(tmpdir(), "pioneer-npm-consumer-"));
try {
	writeFileSync(join(directory, "package.json"), '{"private":true,"type":"module"}\n');
	execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: directory, stdio: "inherit" });
	const pkg = join(directory, "node_modules", "@pioneer-platform", "pioneer-cli");
	const env = { ...process.env, PI_OFFLINE: "1", PIONEER_CODING_AGENT_DIR: join(directory, "state"), PI_CODING_AGENT_DIR: join(directory, "state") };
	const cli = join(pkg, "dist/bundle/cli.js");
	const version = execFileSync(process.execPath, [cli, "--version"], { cwd: directory, env, encoding: "utf8" });
	if (version.trim() !== artifact.version) throw new Error("Wrong installed version");
	const help = execFileSync(process.execPath, [cli, "--help"], { cwd: directory, env, encoding: "utf8" });
	if (!help.includes("--private") || !help.includes("encryption is off")) throw new Error("Privacy help missing");
	writeFileSync(join(directory, "sdk-smoke.mjs"), `import assert from 'node:assert/strict';\nimport { createAgentSession, PioneerCoreClient, createPioneerCoreExtension, createPioneerAnalyticExtension, createPioneerGoalExtension, readPioneerGoal } from '${pioneerPackageName}';\nassert.equal(typeof createAgentSession, 'function');\nassert.equal(typeof PioneerCoreClient, 'function');\nassert.equal(typeof createPioneerCoreExtension, 'function');\nassert.equal(typeof createPioneerAnalyticExtension, 'function');\nassert.equal(typeof createPioneerGoalExtension, 'function');\nassert.equal(typeof readPioneerGoal, 'function');\n`);
	execFileSync(process.execPath, [join(directory, "sdk-smoke.mjs")], { cwd: directory, env, stdio: "inherit" });
	writeFileSync(join(directory, "context-smoke.mjs"), `import assert from 'node:assert/strict';\nimport { SettingsManager } from '${pioneerPackageName}';\nassert.deepEqual(SettingsManager.inMemory().getCompactionSettings(), { enabled: true, maxContextTokens: 32768, reserveTokens: 8192, keepRecentTokens: 8192 });\n`);
	execFileSync(process.execPath, [join(directory, "context-smoke.mjs")], { cwd: directory, env, stdio: "inherit" });
	const root = fileURLToPath(new URL("..", import.meta.url));
	execFileSync(process.execPath, [join(root, "scripts/smoke-test-codemode-binary.mjs"), cli], { cwd: directory, env, stdio: "inherit" });
	execFileSync(process.execPath, [join(root, "scripts/smoke-test-pioneer-goal.mjs"), cli], { cwd: directory, env, stdio: "inherit" });
	if (process.argv.includes("--live")) {
		const envFile = join(root, ".env");
		const args = [...(existsSync(envFile) ? ["--env-file", envFile] : []), cli,
			"--provider", "pioneer", "--model", "auto", "--print", "--no-session", "--no-extensions",
			"--no-context-files", "--no-skills", "--no-prompt-templates", "Say exactly: ok"];
		const response = execFileSync(process.execPath, args, {
			cwd: directory, env: { ...env, PI_OFFLINE: "0", PIONEER_ANALYTIC_ENABLED: "0" }, encoding: "utf8", timeout: 60_000,
		});
		if (response.trim() !== "ok") throw new Error("Live Pioneer prompt did not return the expected response");
		console.log("Live Pioneer auto prompt passed.");
	}
	console.log(`Installed ${artifact.name}@${artifact.version}: CLI, SDK, Core/analytics/goal exports, offline codemode, and goal execution passed.`);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
