import { join } from "node:path";
import { PIONEER_KEYS_URL } from "@earendil-works/pi-ai/providers/pioneer";
import { APP_NAME, getDocsPath, IS_PIONEER_DISTRIBUTION } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	if (IS_PIONEER_DISTRIBUTION) {
		return `Get a Pioneer API key at ${PIONEER_KEYS_URL}, then use /login in ${APP_NAME} or set PIONEER_API_KEY.`;
	}
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
