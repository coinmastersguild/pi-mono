import { type Component, HStack, ScrollView, type ScrollViewScrollbar, VStack } from "@earendil-works/pi-tui";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly navigation?: Component;
	readonly footer: Component;
	readonly sidebar?: Component;
	readonly sidebarEnabled?: () => boolean;
	readonly sidebarViewport?: (width: number, height: number) => void;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
}

class WorkspaceSplit extends HStack {
	constructor(chat: Component, sidebar: Component, options: ChatViewportOptions) {
		super([
			{ component: chat, basis: 0 },
			{ component: sidebar, basis: 0 },
		]);
		const [left, right] = this.entries;
		// Visibility runs before allocation; update the stack's own entries for exact halves.
		left.visible = ({ width, height }) => {
			const split = width >= 100 && (options.sidebarEnabled?.() ?? true);
			left.basis = split ? Math.floor(width / 2) : width;
			right.basis = split ? width - left.basis : 0;
			options.sidebarViewport?.(right.basis, Math.min(height, 1000));
			return true;
		};
		right.visible = () => Number(right.basis) > 0;
	}
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcript = new ScrollView(options.document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		...(options.navigation === undefined ? [] : [{ component: options.navigation, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	const chat = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	if (!options.sidebar) return { transcript, root: chat };
	return { transcript, root: new WorkspaceSplit(chat, options.sidebar, options) };
}
