import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { OAuthAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

export const PIONEER_KEYS_URL = "https://alpha.pioneers.dev/keys";

export const PIONEER_MODEL: Model<"openai-completions"> = {
	id: "auto",
	name: "Pioneer Auto (GLM)",
	api: "openai-completions",
	provider: "pioneer",
	baseUrl: "https://alpha.pioneers.dev/api/v1/code",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 524288,
	maxTokens: 16384,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		maxTokensField: "max_tokens",
	},
};

/** The CLI supplies browser login; browser/SDK callers can still enter a key. */
export function pioneerProvider(oauth?: OAuthAuth): Provider<"openai-completions"> {
	return createProvider({
		id: "pioneer",
		name: "Pioneer",
		baseUrl: PIONEER_MODEL.baseUrl,
		models: [PIONEER_MODEL],
		api: openAICompletionsApi(),
		auth: {
			apiKey: envApiKeyAuth("Pioneer API key", ["PIONEER_API_KEY"]),
			oauth: oauth ?? {
				name: "Pioneer browser sign-in",
				login: async (interaction) => {
					interaction.notify({ type: "auth_url", url: PIONEER_KEYS_URL });
					const key = await interaction.prompt({ type: "secret", message: "Paste your Pioneer API key:" });
					interaction.signal.throwIfAborted();
					if (!/^sk-pioneer-[a-f0-9]{64}$/.test(key.trim())) throw new Error("Invalid Pioneer API key.");
					return { type: "oauth", access: key.trim(), refresh: "", expires: Date.now() + 90 * 86400000 };
				},
				refresh: async () => {
					throw new Error("Pioneer API key expired. Sign in to Pioneer again.");
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
	});
}
