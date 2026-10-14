import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AnalyticClient } from "../../core/pioneer-analytic/client.ts";
import { PioneerCoreClient, PioneerCoreError } from "../../core/pioneer-core.ts";
import type { WorkspaceSnapshot } from "./workspace-monitor.ts";
import { readWorkspaceFile } from "./workspace-read.ts";
import { loadWorkspaceRules } from "./workspace-rules.ts";

const exec = promisify(execFile);
export interface QualitySnapshot {
	state: string;
	files: number;
	excluded: number;
	duplicateBlocks: number;
	strict?: number;
	findings: string[];
	core: string;
	reviewProbability?: number;
}

/** Exact, whitespace-normalized runs of eight nonempty lines; overlapping repeats count once. */
export function repeatedBlocks(files: { path: string; text: string }[]): { count: number; findings: string[] } {
	const seen = new Map<string, { path: string; line: number }>();
	const findings: string[] = [];
	let count = 0;
	for (const file of files) {
		const lines = file.text
			.split("\n")
			.map((text, index) => ({ text: text.trim(), line: index + 1 }))
			.filter((line) => line.text.length > 0);
		for (let i = 0; i <= lines.length - 8; i++) {
			const block = lines
				.slice(i, i + 8)
				.map((line) => line.text)
				.join("\n");
			if (block.length < 180) continue;
			const hash = createHash("sha256").update(block).digest("hex");
			const previous = seen.get(hash);
			if (previous && (previous.path !== file.path || lines[i].line >= previous.line + 8)) {
				count++;
				if (findings.length < 6)
					findings.push(`${file.path}:${lines[i].line} repeats ${previous.path}:${previous.line}`);
				i += 7;
			} else if (!previous) seen.set(hash, { path: file.path, line: lines[i].line });
		}
	}
	return { count, findings };
}

export class WorkspaceQuality {
	snapshot: QualitySnapshot = {
		state: "Waiting for disk scan",
		files: 0,
		excluded: 0,
		duplicateBlocks: 0,
		findings: [],
		core: "Core: waiting",
	};
	private readonly client = new PioneerCoreClient();
	private readonly controller = new AbortController();
	private readonly onChange: () => void;
	private readonly alphaKey: ((signal: AbortSignal) => Promise<string | undefined>) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private latest: WorkspaceSnapshot | undefined;
	private signature = "";
	private busy = false;
	private repeat = false;
	private coreBlocked = false;
	private backend: "core" | "alpha" | "local" =
		process.env.PIONEER_QUALITY_BACKEND === "alpha"
			? "alpha"
			: process.env.PIONEER_QUALITY_BACKEND === "local"
				? "local"
				: "core";
	constructor(onChange: () => void, alphaKey?: (signal: AbortSignal) => Promise<string | undefined>) {
		this.onChange = onChange;
		this.alphaKey = alphaKey;
	}
	setBackend(backend: "core" | "alpha" | "local"): void {
		this.backend = backend;
		this.snapshot = { ...this.snapshot, core: `${backend}: waiting`, reviewProbability: undefined };
		this.retry();
	}
	update(snapshot: WorkspaceSnapshot): void {
		this.latest = snapshot;
		if (this.busy || this.timer || this.controller.signal.aborted) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.run();
		}, 1000);
		this.timer.unref();
	}
	retry(): void {
		this.coreBlocked = false;
		this.signature = "";
		this.repeat = this.busy;
		if (this.latest) this.update(this.latest);
	}
	private async run(): Promise<void> {
		const snapshot = this.latest;
		const backend = this.backend;
		if (!snapshot || this.controller.signal.aborted) return;
		this.busy = true;
		try {
			const candidates = snapshot.entries.filter(
				(entry) => !entry.directory && entry.status.trim() && !entry.status.includes("D"),
			);
			const eligible = candidates.filter(
				(entry) =>
					!entry.private &&
					!entry.ignored &&
					!entry.symlink &&
					/\.(?:[cm]?[jt]sx?|jsonc?)$/.test(entry.path) &&
					!/(?:\.generated\.|\.min\.|package-lock\.json)/.test(entry.path),
			);
			const recent = new Map(snapshot.activity.toReversed().map((event) => [event.path, event.at]));
			eligible.sort((a, b) => (recent.get(b.path) ?? 0) - (recent.get(a.path) ?? 0) || a.path.localeCompare(b.path));
			const root = await realpath(snapshot.cwd);
			const files: { path: string; text: string }[] = [];
			const paths: string[] = [];
			const stamps: string[] = [];
			for (const entry of eligible.slice(0, 32)) {
				try {
					const path = resolve(root, entry.path);
					const stat = await lstat(path);
					if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) continue;
					const inside = relative(root, await realpath(path));
					if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
					stamps.push(`${entry.path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
					paths.push(entry.path);
				} catch {
					/* A save/rename may remove a candidate between scans. */
				}
			}
			for (const config of ["biome.json", "biome.jsonc", ".pi/quality-rules.json"]) {
				try {
					const stat = await lstat(join(root, config));
					stamps.push(`${config}:${stat.mtimeMs}:${stat.size}`);
				} catch {}
			}
			const signature = JSON.stringify([root, backend, stamps, candidates.length]);
			if (signature === this.signature) return;
			this.signature = signature;
			for (const path of paths) {
				try {
					const bytes = await readWorkspaceFile(root, path, 128 * 1024);
					if (bytes && !bytes.includes(0)) files.push({ path, text: bytes.toString("utf8") });
				} catch {}
			}
			const duplicates = repeatedBlocks(files);
			let state = files.length ? "Biome unavailable in workspace" : "No changed source files";
			const findings = [...duplicates.findings];
			let errors = 0,
				warnings = 0;
			let strict: number | undefined;
			if (files.length) {
				let directory = root;
				let executable: string | undefined;
				while (true) {
					const candidate = join(
						directory,
						"node_modules",
						".bin",
						process.platform === "win32" ? "biome.cmd" : "biome",
					);
					try {
						await access(candidate);
						executable = candidate;
						break;
					} catch {}
					const parent = dirname(directory);
					if (parent === directory) break;
					directory = parent;
				}
				if (executable) {
					try {
						const rules = await loadWorkspaceRules(root);
						const result = await exec(
							executable,
							[
								"lint",
								"--reporter=json",
								"--max-diagnostics=20",
								"--error-on-warnings",
								"--no-errors-on-unmatched",
								...rules.map((rule) => `--only=${rule}`),
								...files.map((file) => resolve(root, file.path)),
							],
							{
								cwd: root,
								encoding: "utf8",
								timeout: 10000,
								maxBuffer: 2 * 1024 * 1024,
								signal: this.controller.signal,
							},
						).catch((error: unknown) => {
							if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string")
								return { stdout: error.stdout };
							throw error;
						});
						const report = JSON.parse(result.stdout) as {
							summary: { errors: number; warnings: number };
							diagnostics: { category?: string; location?: { path?: { file?: string }; span?: number[] } }[];
						};
						if (!Number.isFinite(report.summary.errors) || !Number.isFinite(report.summary.warnings))
							throw new Error("Invalid strict report");
						strict = report.summary.errors + report.summary.warnings;
						for (const item of report.diagnostics.slice(0, 4))
							findings.push(
								`strict ${item.category ?? "diagnostic"} · ${item.location?.path?.file ?? "workspace"}`,
							);
					} catch {
						findings.push("Strict rules unavailable: check .pi/quality-rules.json and Biome version");
					}
					let output = "";
					try {
						const result = await exec(
							executable,
							[
								"lint",
								"--reporter=json",
								"--max-diagnostics=20",
								"--no-errors-on-unmatched",
								...files.map((file) => resolve(root, file.path)),
							],
							{
								cwd: root,
								encoding: "utf8",
								timeout: 10000,
								maxBuffer: 2 * 1024 * 1024,
								signal: this.controller.signal,
							},
						);
						output = result.stdout;
					} catch (error) {
						if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string")
							output = error.stdout;
					}
					try {
						const report = JSON.parse(output) as {
							summary: { errors: number; warnings: number; unchanged: number };
							diagnostics: {
								category?: string;
								severity?: string;
								location?: { path?: { file?: string }; span?: number[] };
							}[];
						};
						if (!Number.isFinite(report.summary.errors) || !Number.isFinite(report.summary.warnings))
							throw new Error("Invalid lint report");
						errors = report.summary.errors;
						warnings = report.summary.warnings;
						state = `Biome: ${errors} errors · ${warnings} warnings · ${report.summary.unchanged} checked`;
						for (const diagnostic of report.diagnostics.slice(0, 6)) {
							const path = diagnostic.location?.path?.file;
							findings.push(
								`${diagnostic.severity ?? "lint"} ${diagnostic.category ?? "diagnostic"}${path ? ` · ${relative(root, path)}` : ""}`,
							);
						}
					} catch {
						state = "Biome: check failed; no valid report";
					}
				}
			}
			this.snapshot = {
				state,
				files: files.length,
				excluded: candidates.length - files.length,
				duplicateBlocks: duplicates.count,
				strict,
				findings,
				core: this.snapshot.core,
			};
			if (!this.controller.signal.aborted) this.onChange();
			if (this.backend !== backend || this.controller.signal.aborted) return;
			if (backend === "local") this.snapshot.core = "Analytics off · local checks only";
			if (!this.coreBlocked && files.length && backend !== "local") {
				try {
					// Only numeric evidence and fixed labels cross into Core: no source, paths, comments, or prompts.
					const text = JSON.stringify({
						scope: "bounded changed source files",
						files: files.length,
						lintAvailable: state.startsWith("Biome:") && !state.includes("failed"),
						errors,
						warnings,
						strictViolations: strict ?? null,
						repeatedEightLineBlocks: duplicates.count,
					});
					const questions = {
						review: {
							type: "noul" as const,
							instructions:
								"Does this measured code-quality summary warrant human review? Treat unavailable lint as unknown. Assess only the supplied metrics; this is advisory, not a code correctness score.",
						},
					};
					let probability: number | undefined;
					if (backend === "alpha") {
						const apiKey =
							process.env.PIONEER_API_KEY ||
							process.env.PIONEER_JWT ||
							(await this.alphaKey?.(this.controller.signal));
						if (!apiKey) throw new PioneerCoreError(401, "Alpha: configure Pioneer credentials");
						const client = new AnalyticClient({ apiKey, timeoutMs: 8000 });
						const result = await client.evaluate(
							[{ role: "user", content: text }],
							questions,
							this.controller.signal,
						);
						const answer = result.answers.review;
						if (answer.type === "noul") probability = answer.noul;
					} else probability = (await this.client.evaluate(text, questions, this.controller.signal)).review;
					if (this.backend !== backend) return;
					this.snapshot = {
						...this.snapshot,
						core: backend === "alpha" ? "Alpha: remote advisory" : "Core: local advisory",
						reviewProbability: probability,
					};
				} catch (error) {
					if (this.backend !== backend) return;
					if (error instanceof PioneerCoreError && [401, 403, 423].includes(error.status)) this.coreBlocked = true;
					this.snapshot = {
						...this.snapshot,
						core:
							error instanceof PioneerCoreError
								? error.message
								: `${this.backend}: unavailable or invalid response`,
					};
				}
			}
		} catch {
			this.snapshot = { ...this.snapshot, state: "Quality scan unavailable" };
		} finally {
			this.busy = false;
			if (!this.controller.signal.aborted) this.onChange();
			if (this.repeat) this.signature = "";
			if ((this.repeat || this.latest !== snapshot || this.backend !== backend) && this.latest)
				this.update(this.latest);
			this.repeat = false;
		}
	}
	dispose(): void {
		clearTimeout(this.timer);
		this.controller.abort();
	}
}
