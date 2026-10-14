import {
	type Component,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { theme } from "./theme/theme.ts";
import { WorkspaceDiffView } from "./workspace-diff.ts";
import { type WorkspaceEntry, WorkspaceMonitor } from "./workspace-monitor.ts";
import { WorkspaceQuality } from "./workspace-quality.ts";

function safe(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ");
}
type Filter = "all" | "changes" | "hidden" | "ignored";

/** A bounded leaf viewport: tree scroll and selection are independent of chat scrollback. */
export class WorkspacePanel implements Component {
	enabled = true;
	focused = false;
	width = 0;
	height = 24;
	monitor: WorkspaceMonitor;
	private quality: WorkspaceQuality;
	private readonly redraw: () => void;
	private readonly leave: () => void;
	private readonly keys: KeybindingsManager;
	private readonly alphaKey: ((signal: AbortSignal) => Promise<string | undefined>) | undefined;
	private qualityExpanded = false;
	private qualityTitleRow = -1;
	private filter: Filter = "changes";
	private expanded = new Set<string>();
	private collapsed = new Set<string>();
	private selection = "";
	private offset = 0;
	private detail = "Select a file for changed line ranges";
	private rows = new Map<number, WorkspaceEntry>();
	private visible: WorkspaceEntry[] = [];
	private treeCacheKey = "";
	private treeEntries: WorkspaceEntry[] | undefined;
	private treeHeight = 1;
	private disposed = false;
	private readonly diff: WorkspaceDiffView;

	constructor(
		cwd: string,
		keys: KeybindingsManager,
		redraw: () => void,
		leave: () => void,
		alphaKey?: (signal: AbortSignal) => Promise<string | undefined>,
	) {
		this.keys = keys;
		this.redraw = redraw;
		this.leave = leave;
		this.alphaKey = alphaKey;
		this.quality = new WorkspaceQuality(redraw, alphaKey);
		this.monitor = this.createMonitor(cwd);
		this.diff = new WorkspaceDiffView(
			keys,
			(path) => this.monitor.fileDiff(path),
			redraw,
			() => {
				this.diff.close();
				this.redraw();
			},
		);
	}
	private createMonitor(cwd: string): WorkspaceMonitor {
		const monitor = new WorkspaceMonitor(cwd, () => {
			if (this.disposed) return;
			this.quality.update(monitor.snapshot);
			if (this.diff.path) void this.diff.refresh();
			else if (this.selection) void this.inspect(this.selection);
			this.redraw();
		});
		return monitor;
	}
	setCwd(cwd: string): void {
		if (cwd === this.monitor.cwd) return;
		this.monitor.dispose();
		this.diff.close();
		this.quality.dispose();
		this.quality = new WorkspaceQuality(this.redraw, this.alphaKey);
		this.monitor = this.createMonitor(cwd);
		this.selection = "";
		this.offset = 0;
		this.expanded = new Set<string>();
		this.collapsed.clear();
		this.monitor.start();
	}
	command(argument: string): string | undefined {
		if (["all", "changes", "hidden", "ignored", "quality"].includes(argument)) this.diff.close();
		if (argument === "off") {
			this.enabled = false;
			this.leave();
		} else if (argument === "refresh") {
			this.quality.retry();
			void this.monitor.refresh();
		} else if (argument === "quality") this.qualityExpanded = !this.qualityExpanded;
		else if (["core", "alpha", "local"].includes(argument))
			this.quality.setBackend(argument as "core" | "alpha" | "local");
		else if (["all", "changes", "hidden", "ignored"].includes(argument)) {
			this.filter = argument as Filter;
			this.offset = 0;
			this.enabled = true;
		} else if (argument === "" || argument === "on") this.enabled = true;
		else return "Usage: /files [on|off|all|changes|hidden|ignored|quality|refresh|core|alpha|local]";
		this.redraw();
		return undefined;
	}
	invalidate(): void {}
	private async inspect(path: string): Promise<void> {
		const monitor = this.monitor;
		const detail = await monitor.changedLines(path);
		if (this.selection === path && this.monitor === monitor && !this.disposed) {
			this.detail = detail;
			this.redraw();
		}
	}
	private choose(entry: WorkspaceEntry, toggle = false): void {
		this.selection = entry.path;
		if (!entry.directory && toggle) {
			this.diff.open(entry.path);
			return;
		}
		if (entry.directory && toggle) {
			if (this.isExpanded(entry.path)) {
				this.expanded.delete(entry.path);
				this.collapsed.add(entry.path);
			} else {
				this.collapsed.delete(entry.path);
				this.expanded.add(entry.path);
				this.monitor.expand(entry.path);
			}
		}
		void this.inspect(entry.path);
		this.redraw();
	}
	private isExpanded(path: string): boolean {
		return (
			!this.collapsed.has(path) &&
			((this.filter !== "all" && path !== ".pi" && path !== ".pioneer") || this.expanded.has(path))
		);
	}
	handleViewportKey(data: string): boolean {
		if (!this.keys.matches(data, "tui.select.pageUp") && !this.keys.matches(data, "tui.select.pageDown"))
			return false;
		this.handleInput(data);
		return true;
	}
	handleInput(data: string): void {
		if (
			this.diff.path &&
			!this.keys.matches(data, "app.workspace.focus") &&
			!this.keys.matches(data, "app.workspace.toggle")
		) {
			this.diff.handleInput(data);
			return;
		}
		if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "app.workspace.focus")) {
			this.leave();
			return;
		}
		if (this.keys.matches(data, "app.workspace.toggle")) {
			this.enabled = false;
			this.leave();
			this.redraw();
			return;
		}
		let index = Math.max(
			0,
			this.visible.findIndex((entry) => entry.path === this.selection),
		);
		if (this.keys.matches(data, "tui.select.up")) index--;
		else if (this.keys.matches(data, "tui.select.down")) index++;
		else if (this.keys.matches(data, "tui.select.pageUp")) index -= this.treeHeight;
		else if (this.keys.matches(data, "tui.select.pageDown")) index += this.treeHeight;
		else if (this.keys.matches(data, "tui.select.confirm")) {
			const entry = this.visible[index];
			if (entry) this.choose(entry, true);
			return;
		} else if (this.keys.matches(data, "tui.editor.cursorRight")) {
			const entry = this.visible[index];
			if (entry?.directory && !this.isExpanded(entry.path)) this.choose(entry, true);
			return;
		} else if (this.keys.matches(data, "tui.editor.cursorLeft")) {
			const entry = this.visible[index];
			if (entry?.directory && this.isExpanded(entry.path)) this.choose(entry, true);
			return;
		} else return;
		index = Math.max(0, Math.min(this.visible.length - 1, index));
		if (index < this.offset) this.offset = index;
		if (index >= this.offset + this.treeHeight) this.offset = index - this.treeHeight + 1;
		if (this.visible[index]) this.choose(this.visible[index]);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.diff.path) {
			if (event.type !== "wheel" && (event.type !== "click" || event.button !== "left")) return undefined;
			this.diff.handleMouse(event);
			return { handled: true, focus: event.type === "click", render: true };
		}
		if (event.type === "wheel") {
			this.offset = Math.max(
				0,
				Math.min(Math.max(0, this.visible.length - this.treeHeight), this.offset + (event.wheelDelta ?? 0) * 3),
			);
			this.redraw();
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y === this.qualityTitleRow) this.qualityExpanded = !this.qualityExpanded;
		else if (event.y === 4) {
			const filters: Filter[] = ["all", "changes", "hidden", "ignored"];
			this.filter = filters[Math.min(3, Math.max(0, Math.floor((event.x - 2) / 10)))];
			this.offset = 0;
		} else {
			const entry = this.rows.get(event.y);
			if (entry) this.choose(entry, true);
		}
		this.redraw();
		return { handled: true, focus: true, render: true };
	}
	render(width: number): string[] {
		if (this.diff.path) return this.diff.render(width, this.height);
		const snapshot = this.monitor.snapshot;
		const quality = this.quality.snapshot;
		const lines: string[] = [];
		const line = (text = "") => lines.push(theme.fg("dim", "│ ") + truncateToWidth(text, Math.max(0, width - 3)));
		line(theme.bold(theme.fg("accent", `WORKSPACE  ${this.monitor.agentActive ? "AGENT ACTIVE" : "LIVE"}`)));
		line(theme.fg("muted", safe(snapshot.cwd)));
		line(
			`${theme.fg("accent", safe(snapshot.branch))} · ${snapshot.changed} changed  ${theme.fg("success", `+${snapshot.added}`)} ${theme.fg("error", `−${snapshot.removed}`)}`,
		);
		line(
			theme.fg(
				"dim",
				snapshot.error ??
					`${snapshot.uncounted ? `${snapshot.uncounted} uncounted · ` : ""}${snapshot.limited ? "tree capped · " : ""}Git totals vs HEAD${snapshot.git ? "" : " unavailable"}`,
			),
		);
		line(
			(["all", "changes", "hidden", "ignored"] as Filter[])
				.map((filter) => {
					const label = (filter === this.filter ? `[${filter}]` : ` ${filter} `).padEnd(10);
					return theme.fg(filter === this.filter ? "accent" : "dim", label);
				})
				.join(""),
		);
		const treeKey = JSON.stringify([this.filter, [...this.expanded], [...this.collapsed]]);
		if (this.treeEntries !== snapshot.entries || this.treeCacheKey !== treeKey) {
			this.treeEntries = snapshot.entries;
			this.treeCacheKey = treeKey;
			const paths = new Set<string>();
			for (const entry of snapshot.entries) {
				if (
					entry.control ||
					this.filter === "all" ||
					(this.filter === "changes" && entry.status.trim() && !entry.ignored) ||
					(this.filter === "hidden" && entry.hidden) ||
					(this.filter === "ignored" && entry.ignored)
				) {
					let path = entry.path;
					while (path) {
						paths.add(path);
						const slash = path.lastIndexOf("/");
						path = slash < 0 ? "" : path.slice(0, slash);
					}
				}
			}
			const children = new Map<string, WorkspaceEntry[]>();
			for (const entry of snapshot.entries) {
				if (!paths.has(entry.path)) continue;
				const slash = entry.path.lastIndexOf("/");
				const parent = slash < 0 ? "" : entry.path.slice(0, slash);
				const list = children.get(parent) ?? [];
				list.push(entry);
				children.set(parent, list);
			}
			this.visible = [];
			const walk = (parent: string) => {
				for (const entry of (children.get(parent) ?? []).sort(
					(a, b) =>
						Number(b.control) - Number(a.control) ||
						Number(b.directory) - Number(a.directory) ||
						a.path.localeCompare(b.path),
				)) {
					this.visible.push(entry);
					if (entry.directory && this.isExpanded(entry.path)) walk(entry.path);
				}
			};
			walk("");
		}
		const findingRows = this.qualityExpanded ? Math.max(1, Math.min(6, quality.findings.length)) : 1;
		this.treeHeight = Math.max(1, this.height - 17 - findingRows);
		this.offset = Math.min(this.offset, Math.max(0, this.visible.length - this.treeHeight));
		this.rows.clear();
		for (const entry of this.visible.slice(this.offset, this.offset + this.treeHeight)) {
			this.rows.set(lines.length, entry);
			const depth = entry.path.split("/").length - 1;
			const name = safe(entry.path.split("/").at(-1) ?? entry.path);
			const state = entry.ignored ? "!!" : entry.status.trim() || "·";
			const badges = `${entry.private ? " private" : ""}${entry.control ? " control" : ""}${entry.hidden ? " hidden" : ""}${entry.symlink ? " link" : ""}`;
			const counts =
				entry.added || entry.removed ? ` +${entry.added} −${entry.removed}` : entry.uncounted ? " ?lines" : "";
			const color = entry.private
				? "warning"
				: entry.ignored
					? "dim"
					: entry.status.includes("D")
						? "error"
						: entry.status === "??"
							? "success"
							: entry.control || entry.status.trim()
								? "accent"
								: "muted";
			line(
				theme.fg(
					color,
					`${entry.path === this.selection ? ">" : " "}${"  ".repeat(Math.min(depth, 12))}${entry.directory ? (this.isExpanded(entry.path) ? "▾" : "▸") : " "} ${state.padEnd(2)} ${name}${counts}${badges}`,
				),
			);
		}
		while (lines.length < 5 + this.treeHeight) line();
		line(theme.fg("dim", `${this.visible.length} entries · ?? untracked · !! ignored`));
		line(theme.fg("muted", safe(this.selection || ".pi / .pioneer appear when present")));
		line(theme.fg("dim", safe(this.detail)));
		this.qualityTitleRow = lines.length;
		line(theme.bold(theme.fg("accent", "QUALITY  /files quality · click to expand")));
		line(theme.fg("muted", `${quality.state}${quality.strict === undefined ? "" : ` · strict ${quality.strict}`}`));
		line(
			theme.fg(
				"dim",
				`${quality.files} files · ${quality.excluded} excluded · ${quality.duplicateBlocks} repeated blocks`,
			),
		);
		line(
			theme.fg(
				"muted",
				`${quality.core}${quality.reviewProbability === undefined ? "" : ` · review ${Math.round(quality.reviewProbability * 100)}% (advisory)`}`,
			),
		);
		for (const finding of quality.findings.length
			? quality.findings.slice(0, findingRows)
			: ["Rules: workspace Biome + strict profile"])
			line(theme.fg("warning", safe(finding)));
		line(theme.bold(theme.fg("accent", "RECENT DISK ACTIVITY")));
		for (const activity of snapshot.activity.slice(0, 2))
			line(
				theme.fg(
					"muted",
					`${new Date(activity.at).toLocaleTimeString()} ${activity.kind} ${safe(activity.path)}${activity.agentActive ? " · during agent run" : ""}`,
				),
			);
		if (!snapshot.activity.length) line(theme.fg("dim", "Watching for writes, creates, renames and deletes"));
		while (lines.length < this.height - 1) line();
		line(
			theme.fg(
				"dim",
				`${this.focused ? "Esc chat · arrows browse · Enter expand" : `${this.keys.getKeys("app.workspace.focus").join("/")} focus · click to inspect`}`,
			),
		);
		return lines.slice(0, Math.max(1, this.height));
	}
	dispose(): void {
		this.disposed = true;
		this.diff.close();
		this.monitor.dispose();
		this.quality.dispose();
	}
}
