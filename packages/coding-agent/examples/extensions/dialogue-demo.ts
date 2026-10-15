/** Offline dual-loop demo. Explicitly load with --no-tools; never calls a provider API. */
import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function dialogueDemo(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "dialogue-demo",
		models: [{ id: "local", name: "Offline dialogue demo", reasoning: true }],
		tokensPerSecond: 12,
	});
	const model = faux.getModel();
	const api = getApiProvider(faux.api);
	if (!api) throw new Error("Local demo provider was not registered");
	pi.registerProvider(model.provider, {
		api: faux.api,
		apiKey: "local-demo-only",
		baseUrl: model.baseUrl,
		models: [model],
		streamSimple: api.streamSimple,
	});
	const response = () =>
		fauxAssistantMessage([
			{
				type: "thinking",
				thinking:
					"This is a simulated background run. Try hello or status in Conversation while this text streams in Thinking. Queue another task, or interrupt with a replacement.",
			},
			{
				type: "text",
				text: "Demo task finished. This response was pushed from Thinking into Conversation. No tools or provider APIs were called.",
			},
		]);
	faux.setResponses(Array.from({ length: 100 }, response));
	pi.on("session_shutdown", () => {
		faux.unregister();
	});
}
