import { sliceByColumn, stripTerminalSequences, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { theme } from "./theme/theme.ts";

export interface DiffLine {
	kind: "context" | "add" | "delete" | "meta";
	text: string;
	oldLine?: number;
	newLine?: number;
}
export interface WorkspaceDiff {
	lines: DiffLine[];
	message: string;
}
export type DiffRow = DiffLine | { kind: "fold"; text: string; id: number };

export function parseWorkspaceDiff(patch: string): DiffLine[] {
	const lines: DiffLine[] = [];
	let oldLine = 0,
		newLine = 0,
		inHunk = false;
	for (const text of patch.split("\n")) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (text.startsWith("diff --git")) {
			inHunk = false;
			continue;
		}
		if (text.startsWith("+")) lines.push({ kind: "add", text: text.slice(1), newLine: newLine++ });
		else if (text.startsWith("-")) lines.push({ kind: "delete", text: text.slice(1), oldLine: oldLine++ });
		else if (text.startsWith(" "))
			lines.push({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
		else if (text.startsWith("\\")) lines.push({ kind: "meta", text: text.slice(2) });
	}
	return lines;
}

/** Keep three unchanged lines beside edits; folded context remains available on demand. */
export function foldWorkspaceDiff(lines: DiffLine[], expanded: ReadonlySet<number>): DiffRow[] {
	if (!lines.some((line) => line.kind === "add" || line.kind === "delete")) return lines;
	const result: DiffRow[] = [];
	for (let start = 0; start < lines.length; ) {
		if (lines[start].kind !== "context") {
			result.push(lines[start++]);
			continue;
		}
		let end = start;
		while (end < lines.length && lines[end].kind === "context") end++;
		const before = start > 0 ? 3 : 0,
			after = end < lines.length ? 3 : 0;
		if (end - start <= before + after + 1) result.push(...lines.slice(start, end));
		else {
			result.push(...lines.slice(start, start + before));
			const count = end - start - before - after;
			result.push({
				kind: "fold",
				id: start,
				text: `... ${count} unchanged lines ... [${expanded.has(start) ? "collapse" : "expand"}]`,
			});
			if (expanded.has(start)) result.push(...lines.slice(start + before, end - after));
			result.push(...lines.slice(end - after, end));
		}
		start = end;
	}
	return result;
}

function safeDiffText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x1f\x7f]/g, " ");
}

export class WorkspaceDiffView {
	path = "";
	private data: WorkspaceDiff = { lines: [], message: "Loading diff…" };
	private rows: DiffRow[] = [];
	private expanded = new Set<number>();
	private offset = 0;
	private horizontal = 0;
	private cursor = 0;
	private page = 1;
	private loading = false;
	private again = false;
	private revision = 0;
	private readonly keys: KeybindingsManager;
	private readonly read: (path: string) => Promise<WorkspaceDiff>;
	private readonly redraw: () => void;
	private readonly back: () => void;
	constructor(
		keys: KeybindingsManager,
		read: (path: string) => Promise<WorkspaceDiff>,
		redraw: () => void,
		back: () => void,
	) {
		this.keys = keys;
		this.read = read;
		this.redraw = redraw;
		this.back = back;
	}
	open(path: string): void {
		this.close();
		this.path = path;
		this.offset = 0;
		this.horizontal = 0;
		this.cursor = 0;
		this.data = { lines: [], message: "Loading diff…" };
		this.rows = [];
		this.expanded.clear();
		void this.refresh();
		this.redraw();
	}
	close(): void {
		this.path = "";
		this.revision++;
		this.rows = [];
		this.data = { lines: [], message: "" };
	}
	async refresh(): Promise<void> {
		if (!this.path) return;
		if (this.loading) {
			this.again = true;
			return;
		}
		this.loading = true;
		const path = this.path,
			revision = this.revision;
		try {
			const data = await this.read(path);
			if (revision !== this.revision || path !== this.path) return;
			if (JSON.stringify(data) !== JSON.stringify(this.data)) {
				this.data = data;
				this.expanded.clear();
				this.rows = foldWorkspaceDiff(data.lines, this.expanded);
				this.cursor = Math.min(this.cursor, Math.max(0, this.rows.length - 1));
				this.redraw();
			}
		} catch {
			if (revision === this.revision) {
				this.data = { lines: [], message: "Diff unavailable; retrying on the next disk update" };
				this.rows = [];
				this.redraw();
			}
		} finally {
			this.loading = false;
			if (this.again) {
				this.again = false;
				void this.refresh();
			}
		}
	}
	private toggle(): void {
		const row = this.rows[this.cursor];
		if (row?.kind !== "fold") return;
		if (this.expanded.has(row.id)) this.expanded.delete(row.id);
		else this.expanded.add(row.id);
		this.rows = foldWorkspaceDiff(this.data.lines, this.expanded);
		this.redraw();
	}
	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.back();
			return;
		}
		if (this.keys.matches(data, "tui.select.up")) this.cursor--;
		else if (this.keys.matches(data, "tui.select.down")) this.cursor++;
		else if (this.keys.matches(data, "tui.select.pageUp")) this.cursor -= this.page;
		else if (this.keys.matches(data, "tui.select.pageDown")) this.cursor += this.page;
		else if (this.keys.matches(data, "tui.editor.cursorLeft")) this.horizontal = Math.max(0, this.horizontal - 8);
		else if (this.keys.matches(data, "tui.editor.cursorRight"))
			this.horizontal = Math.min(32768, this.horizontal + 8);
		else if (this.keys.matches(data, "tui.select.confirm")) {
			this.toggle();
			return;
		} else return;
		this.cursor = Math.max(0, Math.min(Math.max(0, this.rows.length - 1), this.cursor));
		this.offset = Math.max(0, Math.min(this.cursor, Math.max(this.offset, this.cursor - this.page + 1)));
		this.redraw();
	}
	handleMouse(event: TuiMouseEvent): void {
		if (event.type === "wheel") {
			this.offset = Math.max(
				0,
				Math.min(Math.max(0, this.rows.length - this.page), this.offset + (event.wheelDelta ?? 0)),
			);
			this.cursor = Math.max(this.offset, Math.min(this.cursor, this.offset + this.page - 1));
		} else if (event.type === "click" && event.button === "left") {
			if (event.y === 0) {
				this.back();
				return;
			}
			if (event.y >= 4 && event.y < 4 + this.page) {
				this.cursor = this.offset + event.y - 4;
				this.toggle();
			}
		}
		this.redraw();
	}
	render(width: number, height: number): string[] {
		this.page = Math.max(1, height - 5);
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - this.page)));
		const lines: string[] = [];
		const push = (text: string) => lines.push(theme.fg("dim", "│ ") + truncateToWidth(text, Math.max(0, width - 3)));
		push(theme.bold(theme.fg("accent", "‹ Files   DIFF")));
		push(theme.fg("muted", safeDiffText(this.path)));
		push(theme.fg("dim", this.data.message));
		push(theme.fg("dim", "   old    new │ − removed / + added"));
		for (let index = this.offset; index < Math.min(this.rows.length, this.offset + this.page); index++) {
			const row = this.rows[index];
			if (row.kind === "fold") {
				push(theme.fg("accent", `${index === this.cursor ? ">" : " "} ${row.text}`));
				continue;
			}
			const gutter = `${index === this.cursor ? ">" : " "}${String(row.oldLine ?? "").padStart(5)} ${String(row.newLine ?? "").padStart(5)} │${row.kind === "add" ? "+" : row.kind === "delete" ? "−" : " "} `;
			const text =
				gutter + sliceByColumn(safeDiffText(row.text), this.horizontal, Math.max(0, width - gutter.length - 3));
			push(
				theme.fg(
					row.kind === "add" ? "success" : row.kind === "delete" ? "error" : row.kind === "meta" ? "dim" : "text",
					text,
				),
			);
		}
		while (lines.length < height - 1) push("");
		push(
			theme.fg(
				"dim",
				`Esc files · wheel/↑↓ scroll · ←→ pan · ${this.rows.length ? this.offset + 1 : 0}–${Math.min(this.rows.length, this.offset + this.page)}/${this.rows.length}`,
			),
		);
		return lines.slice(0, height);
	}
}
