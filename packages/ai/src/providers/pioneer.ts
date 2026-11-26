import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { ApiKeyAuth, OAuthAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

export const PIONEER_KEYS_URL = "https://alpha.pioneers.dev/keys";
export const PIONEER_GLM53_MODEL_ID = "glm-5.3-flash-local";

export const PIONEER_MODEL: Model<"openai-completions"> = {
	id: "auto",
	name: "Pioneer Auto",
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
export function pioneerProvider(oauth?: OAuthAuth, apiKeyLogin?: ApiKeyAuth["login"]): Provider<"openai-completions"> {
	const apiKey = envApiKeyAuth("Pioneer API key", ["PIONEER_API_KEY"]);
	return createProvider({
		id: "pioneer",
		name: "Pioneer",
		baseUrl: PIONEER_MODEL.baseUrl,
		models: [PIONEER_MODEL],
		fetchModels: async ({ credential, signal }) => {
			const key = credential?.type === "oauth" ? credential.access : credential?.key;
			if (!key) return [];
			const response = await fetch(`${PIONEER_MODEL.baseUrl}/models`, {
				headers: { accept: "application/json", authorization: `Bearer ${key}` },
				redirect: "error",
				signal,
			});
			if (!response.ok) throw new Error(`Pioneer model discovery failed (HTTP ${response.status})`);
			const catalog = await response.json();
			const data = catalog && typeof catalog === "object" && "data" in catalog ? catalog.data : undefined;
			if (!Array.isArray(data)) throw new Error("Invalid Pioneer model catalog.");
			const glm = data.find((model) => model?.id === PIONEER_GLM53_MODEL_ID);
			const contextWindow = glm?.context_window;
			const maxTokens = glm?.max_output_tokens;
			if (
				typeof contextWindow !== "number" ||
				!Number.isSafeInteger(contextWindow) ||
				typeof maxTokens !== "number" ||
				!Number.isSafeInteger(maxTokens) ||
				maxTokens <= 0 ||
				maxTokens >= contextWindow
			)
				return [];
			return [
				{
					...PIONEER_MODEL,
					id: PIONEER_GLM53_MODEL_ID,
					name: "GLM-5.3 Flash (Beast)",
					input: ["text"],
					contextWindow,
					maxTokens,
					compat: {
						...PIONEER_MODEL.compat,
						supportsReasoningEffort: false,
						thinkingFormat: "qwen-chat-template",
					},
				},
			];
		},
		api: openAICompletionsApi(),
		auth: {
			apiKey: apiKeyLogin ? { ...apiKey, login: apiKeyLogin } : apiKey,
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
