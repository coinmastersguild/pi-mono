import { describe, expect, it } from "vitest";
import { DialogueTabs } from "../src/modes/interactive/components/dialogue-tabs.ts";

describe("dialogue tabs", () => {
	it("renders only the selected transcript and preserves separate drafts", () => {
		const tabs = new DialogueTabs(
			{ render: () => ["conversation"], invalidate() {} },
			{ render: () => ["reasoning"], invalidate() {} },
		);
		expect(tabs.render(80)).toEqual(["conversation"]);
		expect(tabs.select("thinking", "chat draft")).toBe("");
		expect(tabs.render(80)).toEqual(["reasoning"]);
		tabs.notify();
		expect(tabs.unread).toBe(1);
		expect(tabs.select("conversation", "work draft")).toBe("chat draft");
		expect(tabs.unread).toBe(0);
		expect(tabs.select("thinking", "edited chat")).toBe("work draft");
		tabs.reset();
		expect(tabs.select("conversation", "")).toBe("");
	});
});
