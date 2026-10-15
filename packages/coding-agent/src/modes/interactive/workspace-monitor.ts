import { execFile } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseWorkspaceDiff, type WorkspaceDiff } from "./workspace-diff.ts";
import { readWorkspaceFile } from "./workspace-read.ts";

const exec = promisify(execFile);
const MAX_ENTRIES = 12000;
const MAX_COUNT_BYTES = 1024 * 1024;

export interface WorkspaceEntry {
	path: string;
	directory: boolean;
	symlink: boolean;
	status: string;
	hidden: boolean;
	ignored: boolean;
	private: boolean;
	control: boolean;
	added: number;
	removed: number;
	uncounted: boolean;
}

export interface WorkspaceActivity {
	path: string;
	at: number;
	kind: "created" | "modified" | "deleted" | "status";
	agentActive: boolean;
	added: number;
	removed: number;
}

export interface WorkspaceSnapshot {
	cwd: string;
	branch: string;
	git: boolean;
	entries: WorkspaceEntry[];
	activity: WorkspaceActivity[];
	added: number;
	removed: number;
	changed: number;
	uncounted: number;
	limited: boolean;
	error?: string;
	updatedAt: number;
}

/** A location/name hint, not a claim to detect every secret. Contents are never used for classification. */
export function workspacePathFlags(path: string): Pick<WorkspaceEntry, "hidden" | "private" | "control"> {
	const parts = path.split("/");
	const name = parts.at(-1) ?? path;
	return {
		hidden: parts.some((part) => part.startsWith(".")),
		control: parts.some((part) => part === ".pi" || part === ".pioneer") || /^(AGENTS|CLAUDE|SYSTEM)\.md$/.test(name),
		private:
			parts.some((part) => /^(\.ssh|\.aws|\.gnupg|secrets?|private|credentials?|sessions)$/i.test(part)) ||
			(/^\.env(?:\.|$)/i.test(name) && !/\.(example|sample|template)$/i.test(name)) ||
			/^(auth|credentials?|secrets?|tokens?)\.(json|ya?ml|toml)$/i.test(name) ||
			/^(id_rsa|id_ed25519|\.npmrc|\.netrc)$/.test(name) ||
			/\.(pem|key|p12|pfx)$/i.test(name),
	};
}

export function parseWorkspaceStatus(output: string): Map<string, string> {
	const result = new Map<string, string>();
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) continue;
		const status = record.slice(0, 2);
		result.set(record.slice(3).replace(/\/$/, ""), status);
		if (/[RC]/.test(status)) i++; // porcelain -z emits the old name as a separate record.
	}
	return result;
}

export function parseWorkspaceNumstat(
	output: string,
): Map<string, { added: number; removed: number; uncounted: boolean }> {
	const result = new Map<string, { added: number; removed: number; uncounted: boolean }>();
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
		if (match) {
			if (!match[3]) i += 2;
			result.set(match[3] || records[i], {
				added: Number(match[1]) || 0,
				removed: Number(match[2]) || 0,
				uncounted: match[1] === "-",
			});
		}
	}
	return result;
}

export class WorkspaceMonitor {
	readonly cwd: string;
	snapshot: WorkspaceSnapshot;
	agentActive = false;
	private readonly onChange: () => void;
	private readonly controller = new AbortController();
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly pending = new Set<string>();
	private readonly expanded = new Set<string>(["", ".pi", ".pioneer"]);
	private readonly counts = new Map<string, { stamp: string; lines: number | undefined }>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private running: Promise<void> | undefined;
	private again = false;
	private disposed = false;
	private initialized = false;
	private root = "";
	private prefix = "";
	private discovered = false;
	private unborn = false;
	private renameSources = new Map<string, string>();

	constructor(cwd: string, onChange: () => void) {
		this.cwd = resolve(cwd);
		this.onChange = onChange;
		this.snapshot = {
			cwd: this.cwd,
			branch: "Scanning workspace",
			git: false,
			entries: [],
			activity: [],
			added: 0,
			removed: 0,
			changed: 0,
			uncounted: 0,
			limited: false,
			updatedAt: 0,
		};
	}

	start(): void {
		if (this.timer || this.disposed) return;
		void this.refresh();
		// Git polling also catches index/branch updates, missed watch events, and collapsed directories.
		this.timer = setInterval(() => {
			void this.refresh();
		}, 2500);
		this.timer.unref();
	}

	expand(path: string): void {
		if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return;
		this.expanded.add(path);
		void this.refresh();
	}

	private async git(args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
		const { stdout } = await exec("git", ["--no-optional-locks", "-c", "core.quotepath=false", ...args], {
			cwd: this.root || this.cwd,
			encoding: "utf8",
			timeout: 5000,
			maxBuffer,
			signal: this.controller.signal,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
		return stdout;
	}

	private localPath(path: string): string | undefined {
		if (this.prefix && !path.startsWith(this.prefix)) return undefined;
		const local = path.slice(this.prefix.length);
		if (!local || isAbsolute(local) || local.split("/").includes("..")) return undefined;
		return local;
	}

	private async countLines(path: string): Promise<number | undefined> {
		try {
			const absolute = resolve(this.cwd, path);
			const stat = await lstat(absolute);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COUNT_BYTES) return undefined;
			const resolved = await realpath(absolute);
			const inside = relative(await realpath(this.cwd), resolved);
			if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) return undefined;
			const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
			const cached = this.counts.get(path);
			if (cached?.stamp === stamp) return cached.lines;
			const bytes = await readWorkspaceFile(this.cwd, path, MAX_COUNT_BYTES);
			let lines: number | undefined;
			if (bytes && !bytes.includes(0)) {
				lines = bytes.length && bytes.at(-1) !== 10 ? 1 : 0;
				for (const byte of bytes) if (byte === 10) lines++;
			}
			this.counts.set(path, { stamp, lines });
			return lines;
		} catch {
			return undefined;
		}
	}

	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = this.scan()
			.catch(() => {
				if (!this.disposed) {
					this.snapshot = { ...this.snapshot, error: "Refresh unavailable; retrying", updatedAt: Date.now() };
					this.onChange();
				}
			})
			.finally(() => {
				this.running = undefined;
				if (this.again && !this.disposed) {
					this.again = false;
					void this.refresh();
				}
			});
		return this.running;
	}

	private async scan(): Promise<void> {
		if (!this.discovered || !this.root) {
			try {
				this.root = (await this.git(["rev-parse", "--show-toplevel"])).trim();
				this.prefix = relative(this.root, await realpath(this.cwd))
					.split(sep)
					.join("/");
				if (this.prefix) this.prefix += "/";
			} catch {
				this.root = "";
			}
			this.discovered = true;
		}
		const entries = new Map<string, WorkspaceEntry>();
		let limited = false;
		const add = (path: string, directory = false, status = "  "): WorkspaceEntry | undefined => {
			if (!path || path.split("/").some((part) => part === ".." || part === ".git")) return undefined;
			const existing = entries.get(path);
			if (existing) {
				existing.directory ||= directory;
				if (existing.status === "  ") existing.status = status;
				return existing;
			}
			if (entries.size >= MAX_ENTRIES) {
				limited = true;
				return undefined;
			}
			const entry: WorkspaceEntry = {
				path,
				directory,
				symlink: false,
				status,
				...workspacePathFlags(path),
				ignored: status === "!!",
				added: 0,
				removed: 0,
				uncounted: false,
			};
			entries.set(path, entry);
			const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			if (parent) add(parent, true);
			return entry;
		};
		let branch = "Local workspace";
		let unborn = false;
		if (this.root) {
			const [status, files, head] = await Promise.all([
				this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]),
				this.git(["ls-files", "--cached", "-z"]),
				this.git(["rev-parse", "--verify", "HEAD"]).catch(() => ""),
			]);
			unborn = !head;
			this.unborn = unborn;
			this.renameSources.clear();
			const records = status.split("\0");
			for (let i = 0; i < records.length; i++) {
				if (!/[RC]/.test(records[i].slice(0, 2))) continue;
				const destination = this.localPath(records[i].slice(3));
				const source = records[++i];
				if (destination && source) this.renameSources.set(destination, source);
			}
			branch =
				(await this.git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => head.slice(0, 8))).trim() ||
				"New repository";
			// Changed paths first: large repositories must not crowd changes out of the bounded tree.
			for (const [path, state] of parseWorkspaceStatus(status)) {
				const local = this.localPath(path);
				if (local) add(local, false, state);
			}
			for (const path of files.split("\0")) {
				const local = this.localPath(path);
				if (local) add(local);
			}
			const numstat = unborn
				? ""
				: await this.git([
						"diff",
						"HEAD",
						"--numstat",
						"-z",
						"--find-renames",
						"--no-ext-diff",
						"--no-textconv",
						"--",
						this.prefix || ".",
					]);
			for (const [path, counts] of parseWorkspaceNumstat(numstat)) {
				const local = this.localPath(path);
				if (!local) continue;
				const entry = add(local, false, " M");
				if (entry) Object.assign(entry, counts);
			}
		}
		for (const path of this.expanded) {
			if (this.disposed) return;
			try {
				const directory = resolve(this.cwd, path);
				if ((await lstat(directory)).isSymbolicLink()) continue;
				const inside = relative(await realpath(this.cwd), await realpath(directory));
				if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
				for (const item of await readdir(directory, { withFileTypes: true })) {
					const local = path ? `${path}/${item.name}` : item.name;
					const entry = add(local, item.isDirectory());
					if (entry) entry.symlink = item.isSymbolicLink();
				}
			} catch {
				/* Missing, private, or removed directories remain metadata-only. */
			}
		}
		const ignored = [...entries.values()].filter((entry) => entry.status === "!!").map((entry) => entry.path);
		let readBudget = 128;
		for (const entry of entries.values()) {
			entry.ignored ||= ignored.some((path) => entry.path.startsWith(`${path}/`));
			if (entry.status === "!!") {
				try {
					entry.directory = (await lstat(resolve(this.cwd, entry.path))).isDirectory();
				} catch {}
			}
			if (!entry.directory && (entry.status === "??" || (unborn && entry.status.includes("A")))) {
				const lines =
					entry.private || entry.ignored || readBudget-- <= 0 ? undefined : await this.countLines(entry.path);
				entry.added = lines ?? 0;
				entry.uncounted = lines === undefined;
			}
		}
		const previous = new Map(this.snapshot.entries.map((entry) => [entry.path, entry]));
		const activity = [...this.snapshot.activity];
		const touched = new Set(this.pending);
		this.pending.clear();
		if (this.initialized) {
			const paths = new Set([...entries.keys(), ...previous.keys(), ...touched]);
			for (const path of paths) {
				const before = previous.get(path),
					after = entries.get(path);
				if ((after ?? before)?.directory) continue;
				if (
					!touched.has(path) &&
					before &&
					after &&
					before.status === after.status &&
					before.added === after.added &&
					before.removed === after.removed
				)
					continue;
				if (!before && !after) continue;
				activity.unshift({
					path,
					at: Date.now(),
					kind:
						!after || after.status.includes("D")
							? "deleted"
							: !before
								? "created"
								: touched.has(path)
									? "modified"
									: "status",
					agentActive: this.agentActive,
					added: after?.added ?? 0,
					removed: after?.removed ?? 0,
				});
			}
		}
		const changed = [...entries.values()].filter(
			(entry) => !entry.directory && entry.status !== "  " && !entry.ignored,
		);
		if (this.disposed) return;
		this.snapshot = {
			cwd: this.cwd,
			branch,
			git: !!this.root,
			entries: [...entries.values()],
			activity: activity.slice(0, 60),
			added: changed.reduce((sum, entry) => sum + entry.added, 0),
			removed: changed.reduce((sum, entry) => sum + entry.removed, 0),
			changed: changed.length,
			uncounted: changed.filter((entry) => entry.uncounted).length,
			limited,
			updatedAt: Date.now(),
		};
		this.initialized = true;
		// Watch directory metadata only. No recursive watch of node_modules/build caches.
		const directories = new Set(["", ...this.expanded]);
		for (const entry of changed)
			directories.add(entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "");
		for (const entry of entries.values())
			if (entry.directory && !entry.ignored && !entry.private && !entry.symlink) directories.add(entry.path);
		const watched = new Set([...directories].slice(0, 128));
		for (const [path, watcher] of this.watchers)
			if (!watched.has(path)) {
				watcher.close();
				this.watchers.delete(path);
			}
		for (const directory of watched) this.watchDirectory(directory);
		for (const key of this.counts.keys()) if (!entries.has(key)) this.counts.delete(key);
		this.onChange();
	}

	private watchDirectory(directory: string): void {
		if (this.watchers.has(directory) || this.watchers.size >= 128 || this.disposed) return;
		try {
			const watcher = watch(resolve(this.cwd, directory), { persistent: false }, (_event, name) => {
				if (name === ".git" || name?.endsWith(".lock")) return;
				if (name && this.pending.size < 256) this.pending.add(directory ? `${directory}/${name}` : name);
				if (this.debounce) return;
				this.debounce = setTimeout(() => {
					this.debounce = undefined;
					void this.refresh();
				}, 180);
				this.debounce.unref();
			});
			watcher.on("error", () => {
				watcher.close();
				this.watchers.delete(directory);
			});
			this.watchers.set(directory, watcher);
		} catch {
			/* Polling remains available if watching is unsupported or exhausted. */
		}
	}

	async fileDiff(path: string): Promise<WorkspaceDiff> {
		const entry = this.snapshot.entries.find((item) => item.path === path);
		const empty = (message: string): WorkspaceDiff => ({ lines: [], message });
		if (!entry || entry.directory) return empty("File no longer available");
		if (entry.private) return empty("PRIVATE · metadata only; contents are not previewed");
		if (entry.ignored) return empty("IGNORED · contents are not previewed");
		if (entry.symlink) return empty("SYMLINK · target is not followed");
		const source = this.renameSources.get(path);
		if (source && (!this.localPath(source) || workspacePathFlags(source).private))
			return empty("Rename source is private or outside this workspace");
		const bytes = await readWorkspaceFile(this.cwd, path, 256 * 1024);
		if (!bytes && !entry.status.includes("D"))
			return empty("Preview unavailable: large, unreadable, or linked file (256 KiB limit)");
		if (bytes?.includes(0)) return empty("Binary file · no text diff");
		try {
			if (this.root && !this.unborn && entry.status !== "??" && entry.status !== "  ") {
				const paths = [this.prefix + path, ...(source ? [source] : [])].map((name) => `:(literal)${name}`);
				const patch = await this.git(
					[
						"diff",
						"HEAD",
						"--color=never",
						"--unified=100000",
						"--find-renames",
						"--no-ext-diff",
						"--no-textconv",
						"--",
						...paths,
					],
					1024 * 1024,
				);
				const lines = parseWorkspaceDiff(patch);
				if (lines.length)
					return {
						lines: lines.slice(0, 20000),
						message: `Working tree vs HEAD · +${entry.added} −${entry.removed}${lines.length > 20000 ? " · first 20,000 rows" : ""}`,
					};
				if (/^Binary files /m.test(patch)) return empty("Binary file · no text diff");
			}
			const text = bytes?.toString("utf8") ?? "";
			const lines = text ? text.split("\n") : [];
			if (text.endsWith("\n")) lines.pop();
			const added = entry.status === "??" || (this.unborn && entry.status.includes("A"));
			return {
				lines: lines.slice(0, 20000).map((text, index) => ({
					kind: added ? "add" : "context",
					text,
					oldLine: added ? undefined : index + 1,
					newLine: index + 1,
				})),
				message: `${added ? "New file · all lines added" : "No content changes · file preview"}${lines.length > 20000 ? " · first 20,000 rows" : ""}`,
			};
		} catch {
			return empty("Diff unavailable or exceeds 1 MiB preview limit");
		}
	}

	async changedLines(path: string): Promise<string> {
		const entry = this.snapshot.entries.find((item) => item.path === path);
		if (!entry || entry.directory) return "Select a file to inspect its changed line ranges";
		if (entry.private) return "PRIVATE · metadata only; contents are not previewed";
		if (entry.ignored) return "IGNORED · excluded from Git totals";
		if (entry.symlink) return "SYMLINK · target is not followed";
		if (entry.status === "??")
			return entry.uncounted ? "New file · binary, large, or unreadable" : `New file · ${entry.added} lines`;
		if (!this.root || entry.status === "  ") return "No uncommitted line changes";
		try {
			const diff = await this.git([
				"diff",
				"HEAD",
				"--unified=0",
				"--no-ext-diff",
				"--no-textconv",
				"--",
				this.prefix + path,
			]);
			const ranges = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].slice(0, 8).map((match) => {
				const start = Number(match[1]),
					count = match[2] === undefined ? 1 : Number(match[2]);
				return count === 0
					? `after L${start} (removed)`
					: count === 1
						? `L${start}`
						: `L${start}–${start + count - 1}`;
			});
			return ranges.length
				? `Changed: ${ranges.join(" · ")}`
				: entry.uncounted
					? "Binary change · no line count"
					: "Metadata or staged-only change";
		} catch {
			return "Line ranges unavailable";
		}
	}

	dispose(): void {
		this.disposed = true;
		this.controller.abort();
		clearInterval(this.timer);
		clearTimeout(this.debounce);
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
	}
}
