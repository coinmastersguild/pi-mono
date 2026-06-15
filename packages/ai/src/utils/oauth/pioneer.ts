/**
 * Pioneer authentication.
 *
 * Pioneer uses `sk-pioneer-...` API keys issued at https://alpha.pioneers.dev/keys.
 * This module plugs into the OAuth provider registry so the `/login` flow can
 * open that page and intake the pasted key, while storing it alongside other
 * credentials in `~/.pi/agent/auth.json`.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

export const PIONEER_KEYS_URL = "https://alpha.pioneers.dev/keys";

/**
 * "Log in" to Pioneer by opening the keys page and prompting for a pasted key.
 * There is no token exchange — the key is stored verbatim.
 */
export async function loginPioneer(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onAuth({
		url: PIONEER_KEYS_URL,
		instructions: "Sign in with your wallet, create a key (starts with sk-pioneer-...), then paste it below.",
	});

	const key = (
		await callbacks.onPrompt({
			message: "Paste your Pioneer API key:",
			placeholder: "sk-pioneer-...",
		})
	).trim();

	if (!key) {
		throw new Error("No API key provided");
	}

	if (!key.startsWith("sk-pioneer-")) {
		throw new Error("Pioneer API keys start with 'sk-pioneer-'. Double-check and try again.");
	}

	// Pioneer keys do not expire from the client's perspective (revocation is
	// server-side). Set a far-future expiry so the refresh path is never taken.
	const FAR_FUTURE = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;
	return {
		refresh: "",
		access: key,
		expires: FAR_FUTURE,
	};
}

/**
 * Pioneer keys don't need refresh. Returning credentials unchanged is a safe
 * no-op; the framework will keep using the same `access` value.
 */
async function refreshPioneerToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return credentials;
}

export const pioneerOAuthProvider: OAuthProviderInterface = {
	id: "pioneer",
	name: "Pioneer (alpha.pioneers.dev)",

	login: loginPioneer,
	refreshToken: refreshPioneerToken,
	getApiKey: (credentials) => credentials.access,
};
