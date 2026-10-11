import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { PioneerIntroComponent } from "../modes/interactive/components/pioneer-intro.ts";
import type { PioneerIntroStyle } from "../modes/interactive/components/pioneer-intro-scene.ts";

export default function pioneerIntroExtension(pi: ExtensionAPI): void {
	let shown = false;
	let active: PioneerIntroComponent | undefined;
	pi.registerFlag("no-intro", { type: "boolean", default: false, description: "Skip the Pioneer trail intro" });
	const play = async (ctx: ExtensionContext, style: PioneerIntroStyle) => {
		if (ctx.mode !== "tui" || active) return;
		try {
			await ctx.ui.custom(
				(tui, _theme, keybindings, done) => {
					active = new PioneerIntroComponent(tui, keybindings, () => done(undefined), style);
					return active;
				},
				{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
			);
		} finally {
			active = undefined;
		}
	};
	pi.registerCommand("intro", {
		description: "Replay the Pioneer 3D ASCII trail intro: /intro [ascii|pixel]",
		handler: async (args, ctx) => {
			const style = args.trim() || "ascii";
			if (style !== "pixel" && style !== "ascii") {
				ctx.ui.notify("Usage: /intro [pixel|ascii]", "warning");
				return;
			}
			await play(ctx, style);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		if (shown) return;
		shown = true;
		if (
			ctx.mode !== "tui" ||
			!process.stdout.isTTY ||
			process.env.CI ||
			process.env.TERM === "dumb" ||
			pi.getFlag("no-intro")
		)
			return;
		await play(ctx, "ascii");
	});
	pi.on("session_shutdown", async () => active?.dispose());
}
