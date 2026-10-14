import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { DialogueTabs } from "../src/modes/interactive/components/dialogue-tabs.ts";

describe("chat viewport", () => {
	test("keeps the explorer and fixed controls visible across Conversation and Thinking", () => {
		const tabs = new DialogueTabs(
			{ render: () => ["CONVERSATION"], invalidate() {} },
			{ render: () => Array.from({ length: 100 }, (_, i) => `WORK ${i}`), invalidate() {} },
		);
		const viewport = createChatViewport({
			document: tabs,
			pendingMessages: new Container(),
			status: new Container(),
			navigation: { render: () => ["Conversation / Thinking F6"], invalidate() {} },
			editor: { render: () => ["INPUT"], invalidate() {} },
			footer: new Container(),
			sidebar: { render: () => ["EXPLORER", "DIFF"], invalidate() {} },
		});
		const render = () => renderLayoutFrame(viewport.root, 128, 30, () => {}).lines.map(stripTerminalSequences);
		expect(render().join("\n")).toContain("CONVERSATION");
		tabs.select("thinking", "chat draft");
		const working = render();
		expect(working.join("\n")).toContain("WORK 99");
		expect(working.join("\n")).not.toContain("CONVERSATION");
		expect(working.some((line) => line.indexOf("EXPLORER") === 64)).toBe(true);
		expect(working.join("\n")).toContain("Conversation / Thinking F6");
		expect(working.join("\n")).toContain("INPUT");
		expect(tabs.select("conversation", "work draft")).toBe("chat draft");
		const talking = render();
		expect(talking.join("\n")).toContain("CONVERSATION");
		expect(talking.some((line) => line.indexOf("EXPLORER") === 64)).toBe(true);
		expect(talking.join("\n")).toContain("DIFF");
	});
	test("splits evenly, restores narrow chat and keeps the sidebar out of primary scroll", () => {
		let enabled = true;
		let size = [0, 0];
		const viewport = createChatViewport({
			document: { render: () => ["CHAT"], invalidate() {} },
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			sidebar: { render: () => ["FILES"], invalidate() {} },
			sidebarEnabled: () => enabled,
			sidebarViewport: (width, height) => {
				size = [width, height];
			},
		});
		const wide = renderLayoutFrame(viewport.root, 160, 40, () => {});
		expect(size).toEqual([80, 40]);
		expect(wide.lines.some((line) => stripTerminalSequences(line).indexOf("FILES") === 80)).toBe(true);
		renderLayoutFrame(viewport.root, 80, 24, () => {});
		expect(size).toEqual([0, 24]);
		enabled = false;
		expect(renderLayoutFrame(viewport.root, 160, 40, () => {}).lines.join("\n")).not.toContain("FILES");
	});
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});
});
