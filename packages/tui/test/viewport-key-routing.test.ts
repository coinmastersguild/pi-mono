import assert from "node:assert/strict";
import { it } from "node:test";
import { Text } from "../src/components/text.ts";
import { getKeybindings } from "../src/keybindings.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

it("routes claimed paging to the focused pane and preserves transcript and overlay navigation", async () => {
	const terminal = new VirtualTerminal(40, 8);
	const tui = new TuiAltScreen(terminal);
	const pages: string[] = [];
	const pane = {
		focused: false,
		render: () => ["pane"],
		invalidate: () => {},
		handleViewportKey: (data: string): boolean => {
			if (!getKeybindings().matches(data, "tui.select.pageUp")) return false;
			pages.push(data);
			return true;
		},
	};
	tui.addChild(new Text(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"), 0, 0));
	tui.setFocus(pane);
	tui.start();
	try {
		await terminal.waitForRender();
		const initial = tui.viewportTop;
		terminal.sendInput("\x1b[5~");
		assert.equal(pages.length, 1);
		assert.equal(tui.viewportTop, initial);
		// Kitty key releases must not page a second time.
		terminal.sendInput("\x1b[5;1:3~");
		assert.equal(pages.length, 1);
		assert.equal(tui.viewportTop, initial);

		tui.scrollToTop();
		terminal.sendInput("\x1b[6~");
		assert.ok(tui.viewportTop > 0, "unclaimed navigation still scrolls the transcript");
		assert.equal(pages.length, 1);

		const overlayInputs: string[] = [];
		const overlay = tui.showOverlay({
			render: () => ["overlay"],
			invalidate: () => {},
			handleInput: (data: string) => overlayInputs.push(data),
		});
		terminal.sendInput("\x1b[5~");
		assert.deepEqual(overlayInputs, ["\x1b[5~"]);
		assert.equal(pages.length, 1);
		overlay.hide();
		tui.setFocus(null);
		terminal.sendInput("\x1b[5~");
		assert.equal(tui.viewportTop, 0, "without pane focus, Page Up returns to transcript navigation");
	} finally {
		tui.stop();
	}
});
