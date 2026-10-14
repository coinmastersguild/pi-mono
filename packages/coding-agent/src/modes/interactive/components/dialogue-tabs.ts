import { type Component, Container } from "@earendil-works/pi-tui";

export type DialogueTab = "conversation" | "thinking";

/** Both transcripts stay mounted; only the selected transcript renders. */
export class DialogueTabs extends Container {
	selected: DialogueTab = "conversation";
	unread = 0;
	private drafts: Record<DialogueTab, string> = { conversation: "", thinking: "" };

	private readonly conversation: Component;
	private readonly thinking: Component;
	constructor(conversation: Component, thinking: Component) {
		super();
		this.conversation = conversation;
		this.thinking = thinking;
		this.addChild(conversation);
	}

	select(tab: DialogueTab, draft: string): string {
		this.drafts[this.selected] = draft;
		this.selected = tab;
		this.clear();
		this.addChild(tab === "conversation" ? this.conversation : this.thinking);
		if (tab === "conversation") this.unread = 0;
		return this.drafts[tab];
	}

	notify(): void {
		if (this.selected !== "conversation") this.unread++;
	}

	reset(): void {
		this.drafts = { conversation: "", thinking: "" };
		this.unread = 0;
	}

	invalidate(): void {
		this.conversation.invalidate?.();
		this.thinking.invalidate?.();
	}
}
