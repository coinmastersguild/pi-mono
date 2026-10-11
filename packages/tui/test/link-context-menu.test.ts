import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { getCapabilities, hyperlink, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("fullscreen links and context menu", () => {
	it("opens plain URLs at their visible columns and ignores punctuation and drags", async () => {
		const terminal = new VirtualTerminal(80, 6);
		const opened: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: (url) => opened.push(url) });
		tui.addChild(new Text("🙂 https://example.com/a(b).\nwww.example.com\nhttps://example.org", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;5;1M");
			terminal.sendInput("\x1b[<0;5;1m");
			terminal.sendInput("\x1b[<0;28;1M");
			terminal.sendInput("\x1b[<0;28;1m");
			terminal.sendInput("\x1b[<0;3;2M");
			terminal.sendInput("\x1b[<0;3;2m");
			terminal.sendInput("\x1b[<0;3;3M");
			terminal.sendInput("\x1b[<32;6;3M");
			terminal.sendInput("\x1b[<0;6;3m");
			assert.deepEqual(opened, ["https://example.com/a(b)", "https://www.example.com"]);
		} finally {
			tui.stop();
		}
	});

	it("copies a captured selection using a menu click and restores editor focus", async () => {
		const terminal = new VirtualTerminal(80, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const content = new Text("hello world", 0, 0);
		tui.addChild(content);
		tui.setFocus(content);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;5;1M");
			terminal.sendInput("\x1b[<0;5;1m");
			terminal.sendInput("\x1b[<2;10;3M");
			terminal.sendInput("\x1b[<2;10;3m");
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[2], /Copy selection/);
			terminal.sendInput("\x1b[<0;12;3M");
			terminal.sendInput("\x1b[<0;12;3m");
			await terminal.waitForRender();
			assert.deepEqual(copied, ["hello"]);
			assert.equal(tui.getFocusedComponent(), content);
		} finally {
			tui.stop();
		}
	});

	it("opens links, copies their addresses, and pastes through the menu", async () => {
		const terminal = new VirtualTerminal(80, 6);
		const opened: string[] = [];
		const copied: string[] = [];
		let pasted = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => opened.push(url),
			onRightClickPaste: () => {
				pasted++;
			},
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const url = "https://example.com/target";
		tui.addChild(new Text(hyperlink("label", url), 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			for (const index of [0, 1, 2]) {
				terminal.sendInput("\x1b[<2;2;1M");
				await terminal.waitForRender();
				for (let step = 0; step < index; step++) terminal.sendInput("\x1b[B");
				terminal.sendInput("\r");
				await terminal.waitForRender();
			}
			assert.deepEqual(opened, [url]);
			assert.deepEqual(copied, [url]);
			assert.equal(pasted, 1);
		} finally {
			tui.stop();
		}
	});

	it("dismisses the menu with Escape or an outside click without activating a link", async () => {
		const terminal = new VirtualTerminal(80, 6);
		const opened: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: (url) => opened.push(url) });
		tui.addChild(new Text("https://example.com", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<2;2;1M");
			await terminal.waitForRender();
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			assert.equal(tui.hasOverlay(), false);
			terminal.sendInput("\x1b[<2;2;1M");
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;60;5M");
			terminal.sendInput("\x1b[<0;60;5m");
			await terminal.waitForRender();
			assert.equal(tui.hasOverlay(), false);
			assert.deepEqual(opened, []);
		} finally {
			tui.stop();
		}
	});

	it("enables application-owned hyperlinks and restores capabilities on stop", () => {
		const original = getCapabilities();
		const capabilities = { images: null, hyperlinks: false, trueColor: false } as const;
		setCapabilities(capabilities);
		const tui = new TuiAltScreen(new VirtualTerminal(), undefined, undefined, { openUrl: () => {} });
		try {
			tui.start();
			assert.equal(getCapabilities().hyperlinks, true);
			tui.stop();
			assert.deepEqual(getCapabilities(), capabilities);
		} finally {
			tui.stop();
			setCapabilities(original);
		}
	});
});
