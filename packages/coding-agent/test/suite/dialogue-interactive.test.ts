import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { DialogueLoop } from "../../src/core/dialogue/loop.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import type { DialogueTabs } from "../../src/modes/interactive/components/dialogue-tabs.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

import { createHarness, getUserTexts, type Harness } from "./harness.ts";

// Access the actual UI wiring without starting ProcessTerminal or a real model.
interface DialogueUI {
	ui: TUI;
	defaultEditor: CustomEditor;
	conversationContainer: Container;
	dialogueLoop: DialogueLoop;
	dialogueTabs: DialogueTabs;
	startupBusy: boolean;
	isInitialized: boolean;
	setupEditorSubmitHandler(): void;
	setupKeyHandlers(): void;
	subscribeToAgent(): void;
}

describe("interactive dialogue wiring", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
		vi.unstubAllEnvs();
	});

	async function setup(h?: Harness) {
		const harness = h ?? (await createHarness());
		cleanups.push(() => harness.cleanup());
		vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);
		const host = { session: harness.session, setBeforeSessionInvalidate() {}, setRebindSession() {} };
		const mode = new InteractiveMode(host as unknown as AgentSessionRuntime);
		const ui = mode as unknown as DialogueUI;
		vi.spyOn(ui.ui, "requestRender").mockImplementation(() => {});
		vi.spyOn(ui.ui, "stop").mockImplementation(() => {});
		ui.isInitialized = true;
		mode.renderInitialMessages();
		ui.setupEditorSubmitHandler();
		ui.setupKeyHandlers();
		ui.subscribeToAgent();
		ui.startupBusy = false;
		cleanups.push(() => mode.stop());
		return {
			harness,
			host,
			mode,
			ui,
			submit: async (text: string) => {
				await ui.defaultEditor.onSubmit?.(text);
			},
		};
	}

	it("keeps chat responsive, forwards one final response, and preserves drafts across tab keys", async () => {
		let finish!: () => void;
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const { harness, ui, submit } = await setup();
		harness.setResponses([
			async () => {
				await blocked;
				return fauxAssistantMessage("Result from Thinking");
			},
		]);
		await submit("/work slow task");
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["slow task"]));
		await submit("hello");
		expect(ui.conversationContainer.render(100).join("\n")).toContain("Hello.");
		expect(getUserTexts(harness)).toEqual(["slow task"]);
		ui.defaultEditor.setText("conversation draft");
		ui.defaultEditor.actionHandlers.get("app.dialogue.toggle")?.();
		expect(ui.defaultEditor.getText()).toBe("");
		ui.defaultEditor.setText("thinking draft");
		finish();
		await vi.waitFor(() => expect(ui.dialogueLoop.state.active).toBeUndefined());
		expect(ui.dialogueTabs.selected).toBe("thinking");
		expect(ui.dialogueTabs.unread).toBe(1);
		expect(
			ui.conversationContainer
				.render(100)
				.join("\n")
				.match(/Result from Thinking/g),
		).toHaveLength(1);
		ui.defaultEditor.actionHandlers.get("app.dialogue.toggle")?.();
		expect(ui.defaultEditor.getText()).toBe("conversation draft");
		expect(ui.dialogueTabs.unread).toBe(0);
	});

	it("interrupt while idle does not abort its own replacement", async () => {
		const { harness, ui, submit } = await setup();
		harness.setResponses([fauxAssistantMessage("replacement done")]);
		const abort = vi.spyOn(harness.session, "abort");
		await submit("/interrupt new task");
		await vi.waitFor(() => expect(ui.dialogueLoop.state.active).toBeUndefined());
		expect(abort).not.toHaveBeenCalled();
		expect(ui.conversationContainer.render(100).join("\n")).toContain("replacement done");
	});

	it("force chat stays local and session changes clear drafts and old conversation", async () => {
		const { harness, ui, host, mode, submit } = await setup();
		await submit("/dialog chat");
		await submit("build a website");
		expect(harness.session.messages).toHaveLength(0);
		ui.defaultEditor.setText("old private draft");
		ui.defaultEditor.actionHandlers.get("app.dialogue.toggle")?.();
		const other = await createHarness();
		cleanups.push(() => other.cleanup());
		host.session = other.session;
		mode.renderInitialMessages();
		ui.defaultEditor.actionHandlers.get("app.dialogue.toggle")?.();
		expect(ui.defaultEditor.getText()).toBe("");
		expect(ui.conversationContainer.render(100).join("\n")).not.toContain("build a website");
	});

	it("restores conversation metadata without inserting scripted replies into model context", async () => {
		const { harness, ui, mode, submit } = await setup();
		await submit("hello");
		mode.renderInitialMessages();
		expect(ui.conversationContainer.render(100).join("\n")).toContain("Hello.");
		expect(harness.sessionManager.buildSessionContext().messages).toHaveLength(0);
	});

	it("also forwards successful responses from startup or extension-owned runs", async () => {
		const { harness, ui } = await setup();
		harness.setResponses([fauxAssistantMessage("External run result")]);
		await harness.session.prompt("external prompt");
		await vi.waitFor(() => expect(ui.conversationContainer.render(100).join("\n")).toContain("External run result"));
	});
});
