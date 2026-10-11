import { isKeyRelease, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import {
	PIONEER_INTRO_DURATION_MS,
	PioneerIntroScene,
	type PioneerIntroStyle,
	pioneerIntroLines,
} from "./pioneer-intro-scene.ts";

const WORDMARK = [
	"█████  █  ███  █   █ █████ █████ ████ ",
	"█   █  █ █   █ ██  █ █     █     █   █",
	"█████  █ █   █ █ █ █ ████  ████  ████ ",
	"█      █ █   █ █  ██ █     █     █  █ ",
	"█      █  ███  █   █ █████ █████ █   █",
];
const ASCII_WORDMARK = WORDMARK.map((line) => line.replaceAll("█", "#"));

export class PioneerIntroComponent {
	private readonly scene = new PioneerIntroScene();
	private readonly started = performance.now();
	private readonly tui: { terminal: Pick<TUI["terminal"], "rows">; requestRender: TUI["requestRender"] };
	private readonly keybindings: KeybindingsManager;
	private readonly onClose: () => void;
	private readonly style: PioneerIntroStyle;
	private readonly timer: ReturnType<typeof setInterval>;
	private closed = false;
	private cachedTick = -1;
	private cachedWidth = -1;
	private cachedRows = -1;
	private cachedLines: string[] = [];

	constructor(
		tui: { terminal: Pick<TUI["terminal"], "rows">; requestRender: TUI["requestRender"] },
		keybindings: KeybindingsManager,
		onClose: () => void,
		style: PioneerIntroStyle = "ascii",
	) {
		this.tui = tui;
		this.keybindings = keybindings;
		this.onClose = onClose;
		this.style = style;
		this.timer = setInterval(() => {
			if (performance.now() - this.started >= PIONEER_INTRO_DURATION_MS) this.close();
			else this.tui.requestRender();
		}, 1000 / 15);
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.onClose();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (
			this.keybindings.matches(data, "tui.select.cancel") ||
			this.keybindings.matches(data, "tui.input.submit") ||
			this.keybindings.matches(data, "app.clear")
		)
			this.close();
	}

	invalidate(): void {
		this.cachedTick = -1;
	}

	render(width: number): string[] {
		const rows = Math.max(1, this.tui.terminal.rows);
		const elapsed = performance.now() - this.started;
		const tick = Math.floor(elapsed / (1000 / 15));
		if (tick === this.cachedTick && width === this.cachedWidth && rows === this.cachedRows) return this.cachedLines;
		const title =
			width >= 40 && rows >= 20 ? (this.style === "ascii" ? ASCII_WORDMARK : WORDMARK) : ["P I O N E E R"];
		const available = Math.max(1, rows - title.length - 2);
		const lines = pioneerIntroLines(this.scene.render(width, available, elapsed), this.style);
		lines.push("");
		for (const line of title)
			lines.push(
				`\x1b[38;2;66;220;126m${" ".repeat(Math.max(0, Math.floor((Math.min(width, 320) - visibleWidth(line)) / 2)))}${truncateToWidth(line, width)}\x1b[0m`,
			);
		const skip = [
			...this.keybindings.getKeys("tui.select.cancel"),
			...this.keybindings.getKeys("tui.input.submit"),
		].join(" / ");
		lines.push(truncateToWidth(`  Follow your own path.   ${skip} to skip   /intro to replay`, width));
		this.cachedTick = tick;
		this.cachedWidth = width;
		this.cachedRows = rows;
		this.cachedLines = lines.slice(0, rows);
		return this.cachedLines;
	}

	dispose(): void {
		this.closed = true;
		clearInterval(this.timer);
	}
}
