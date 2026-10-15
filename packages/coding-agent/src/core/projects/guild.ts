import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runNative } from "../privacy/native.ts";

export interface GuildProject {
	name: string;
	purpose: string;
	success: string;
	kind: "service" | "cli" | "library";
	port?: number;
	production: boolean;
	milestone: string;
}

/** Derived from Pioneer Platform GUILD-SETUP-001 v1 and Planning Protocol v2. */
export function guildProjectFiles(project: GuildProject): Record<string, string> {
	const state = project.production ? "IN_PRODUCTION" : "NOT_IN_PRODUCTION";
	const direction = project.production
		? "Prod -> Feature -> Dev -> Docker -> Local"
		: "Local -> Docker -> Dev -> Feature -> Prod";
	const health =
		project.kind === "service"
			? `Implement /health on port ${project.port}: HTTP 200 only when healthy, within 500 ms, with status, version, timestamp, and env. Report actual subsystem status.`
			: "No network service is declared. Health endpoint and port requirements are not applicable until a service is added.";
	const protocol = `# Pioneer Guild project setup\n\nProtocol: GUILD-SETUP-001, version 1.0. Planning: State-Driven Architecture v2.\n\nSource: pioneer-platform/docs/guild/guild/PROJECT_SETUP_PROTOCOL.md, project-process-setup-guide.md, and docs/guild/guild-v2/planning-protocol.md. Spec lifecycle: docs/sop/SPEC-DRIVEN-DEVELOPMENT.md in Pioneer Platform.\n\nRead docs/planning/STATE.json first. Keep scope, acceptance tests, and handoff current. Work begins in PLANNING; scaffold generation is not deployment evidence.\n\nProject state: ${state}. Priority direction: ${direction}.\n\nBefore production, advance environments only with verified evidence. In production, protect production first and verify all environments before new feature work. Master Always Green Approach (MAGA) means status claims require passing checks.\n\n${health}\n\nRequired setup: architecture overview, port assignments, environment status dashboard, deployment and verification scripts, milestones, sprint acceptance criteria, and handoff. Unconfigured stages stay RED; pending checks stay YELLOW. Never report GREEN from a generated placeholder.\n\nDraft a spec, obtain review, write acceptance tests, implement, verify, and request review. Update STATE.json and HANDOFF.md with evidence. Local Git is the default; remote hosting, PR synchronization, and deployment require explicit user opt-in. No commits or pushes are performed by setup.\n`;
	const files: Record<string, string> = {
		"package.json": `${JSON.stringify(
			{
				name: project.name.toLowerCase(),
				version: "0.1.0",
				private: true,
				scripts: {
					"deploy:local": "node scripts/deploy/deploy-local.js",
					"deploy:docker": "node scripts/deploy/deploy-docker.js",
					"deploy:dev": "node scripts/deploy/deploy-dev.js",
					"deploy:feature": "node scripts/deploy/deploy-feature.js",
					"deploy:prod": "node scripts/deploy/deploy-prod.js",
					"verify:health": "node scripts/verify/verify-health.js",
					"verify:maga": "node scripts/verify/verify-maga.js",
					status: "node scripts/verify/verify-status.js",
					"status:report": "node scripts/util/generate-report.js",
				},
			},
			null,
			2,
		)}\n`,
		"README.md": `# ${project.name}\n\n${project.purpose}\n\n## Success criteria\n\n${project.success}\n\n## Architecture\n\n${project.kind} project. See [architecture](docs/architecture/overview.md).\n\n| Service | Port |\n| --- | --- |\n| ${project.kind === "service" ? `${project.name} | ${project.port} (proposed; verify availability)` : "None | Not applicable"} |\n\n## Setup and environments\n\nStart with docs/planning/STATE.json and docs/specs/SPEC-001-foundation.md. Environment priority: ${direction}. No application has been built or deployed. See docs/deployment/status-dashboard.md for each environment.\n\nRun node scripts/verify/verify-status.js to inspect setup status. Deployment scripts under scripts/deploy intentionally fail until implemented and verified. ${health}\n`,
		"AGENTS.md":
			"# Pioneer project workflow\n\nRead docs/planning/STATE.json first, then docs/guild/PROJECT_SETUP_PROTOCOL.md and docs/specs/SPEC-001-foundation.md. Follow the current planning phase. Write acceptance tests before implementation. Update HANDOFF.md and state with evidence. Do not claim a deployment or health check passed without executing it. Git remotes and deployments require explicit opt-in.\n",
		".gitignore": ".env\n.env.*\n!.env.example\nnode_modules/\n.DS_Store\n.pioneer/vault/\n",
		".pioneer/project.json": `${JSON.stringify({ version: 1, protocol: "GUILD-SETUP-001", ...project }, null, 2)}\n`,
		"docs/guild/PROJECT_SETUP_PROTOCOL.md": protocol,
		"docs/architecture/overview.md": `# Architecture\n\n## Purpose\n\n${project.purpose}\n\n## Components\n\nInitial component: ${project.name} (${project.kind}). Interfaces, dependencies, and service interactions remain to be designed in SPEC-001.\n\n## Success criteria\n\n${project.success}\n`,
		"docs/architecture/port-assignments.md": `# Port assignments\n\n${project.kind === "service" ? `| Service | Proposed local port | Health route |\n| --- | --- | --- |\n| ${project.name} | ${project.port} | /health |\n\nConfirm availability before starting; this wizard does not reserve ports.` : "No listening services declared. Add assignments before introducing network services."}\n`,
		"docs/deployment/status-dashboard.md": `# Environment status\n\nProject state: ${state}\nPriority direction: ${direction}\n\n| Environment | Status | Evidence |\n| --- | --- | --- |\n${["Local", "Docker", "Dev", "Feature", "Prod"].map((name) => `| ${name} | RED | Not configured or verified by setup |`).join("\n")}\n\nUpdate at sprint start and end. RED = unconfigured/failing; YELLOW = partial/pending tests; GREEN = tested and verified. Existing production status must be established from evidence before changes.\n`,
		"docs/planning/STATE.json": `${JSON.stringify({ current: "PLANNING", projectState: state, milestones: [{ rank: 1, name: project.milestone, status: "PLANNING", sprints: [{ rank: 1, status: "PLANNING", logs: ["Guided setup generated planning documents. No application tests or deployments have run."] }] }] }, null, 2)}\n`,
		"docs/planning/milestones/milestone-1.md": `# Milestone 1: ${project.milestone}\n\nStatus: PLANNING\n\nSuccess: ${project.success}\n\nDefine testable deliverables and dependencies in SPEC-001 before implementation.\n`,
		"docs/planning/sprints/sprint-1.md": `# Sprint 1: Foundation\n\nStatus: PLANNING\n\n- [ ] Review project scope and architecture.\n- [ ] Define acceptance tests for: ${project.success}\n- [ ] Implement the first milestone: ${project.milestone}\n- [ ] Implement applicable deploy and verification scripts.\n- [ ] Record test evidence and update environment status.\n- [ ] Request human review before marking complete.\n`,
		"docs/specs/SPEC-001-foundation.md": `---\nid: 001\ntitle: Project foundation\nstatus: draft\n---\n\n# ${project.name}: foundation\n\n## Problem and outcome\n\n${project.purpose}\n\n## M1: ${project.milestone}\n\nAcceptance criteria: ${project.success}\n\nAcceptance test files and commands: pending design review. Define tests before implementation.\n\n## Delivery gates\n\nArchitecture and port assignments reviewed; applicable health checks implemented; tests pass; environment dashboard supported by evidence. Scaffold generation alone does not satisfy these gates.\n`,
		"HANDOFF.md":
			"# Pioneer project handoff\n\nPhase: PLANNING\n\nDone: guided setup and local repository initialization.\nNext: review SPEC-001, define acceptance tests, then implement Milestone 1.\nBlockers: application and deployment commands are not configured.\nEvidence: no application tests, builds, or deployments have run.\n",
		"scripts/verify/verify-status.js":
			"const fs = require('node:fs');\nconst path = require('node:path');\nprocess.stdout.write(fs.readFileSync(path.join(__dirname, '../../docs/deployment/status-dashboard.md'), 'utf8'));\nprocess.exitCode = 1; // Setup has no verified GREEN environments.\n",
	};
	for (const environment of ["local", "docker", "dev", "feature", "prod"]) {
		files[`scripts/deploy/deploy-${environment}.js`] =
			`console.error(${JSON.stringify(`Deployment to ${environment} is not configured. Implement build, tests, service startup, health verification, and status reporting before use.`)});\nprocess.exitCode = 1;\n`;
	}
	for (const check of ["health", "maga"]) {
		files[`scripts/verify/verify-${check}.js`] =
			`console.error(${JSON.stringify(`${check} verification is not configured. See docs/guild/PROJECT_SETUP_PROTOCOL.md.`)});\nprocess.exitCode = 1;\n`;
	}
	files["scripts/util/generate-report.js"] =
		"console.error('Live status evidence is not configured; no report generated.');\nprocess.exitCode = 1;\n";
	files["scripts/util/log-utils.js"] =
		"// Implement structured deployment logs without credentials before enabling deployment.\n";
	return files;
}

/** Existing files are preserved. Symlinked destinations are refused rather than followed. */
export async function scaffoldGuildProject(root: string, project: GuildProject): Promise<string[]> {
	const files = guildProjectFiles(project);
	const skipped: string[] = [];
	for (const path of Object.keys(files)) {
		let current = root;
		for (const segment of path.split("/")) {
			current = join(current, segment);
			try {
				const info = await lstat(current);
				if (info.isSymbolicLink()) throw new Error(`Refusing setup through a symbolic link: ${path}`);
				if (current === join(root, path)) skipped.push(path);
				else if (!info.isDirectory()) throw new Error(`Setup parent is not a directory: ${current}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
	for (const [path, content] of Object.entries(files)) {
		if (skipped.includes(path)) continue;
		await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
		await writeFile(join(root, path), content, { flag: "wx", mode: 0o600 });
	}
	for (const name of ["standups", "research"]) await mkdir(join(root, "docs", name), { recursive: true });
	// An empty template prevents host Git templates from copying hooks or plaintext secrets into a new project.
	if (
		!(await lstat(join(root, ".git")).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		}))
	)
		await runNative("/usr/bin/git", ["-C", root, "init", "--template=", "--initial-branch=main"]);
	return skipped;
}
