import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { PIONEER_KEYS_URL } from "@earendil-works/pi-ai/providers/pioneer";

const PIONEER_ORIGIN = new URL(PIONEER_KEYS_URL).origin;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

async function validateCredential(key: string, expires: number, signal: AbortSignal): Promise<OAuthCredential> {
	if (!/^sk-pioneer-[a-f0-9]{64}$/.test(key)) {
		throw new Error("Invalid Pioneer API key.");
	}
	if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + KEY_LIFETIME_MS) {
		throw new Error("Invalid or expired Pioneer credential. Start sign-in again.");
	}
	const response = await fetch(`${PIONEER_ORIGIN}/api/v1/account`, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		redirect: "error",
	});
	await response.body?.cancel();
	if (!response.ok) {
		throw new Error(`Pioneer rejected the credential (HTTP ${response.status}). Start sign-in again.`);
	}
	return { type: "oauth", access: key, refresh: "", expires };
}

/** Browser sign-in for the CLI; Node-only code stays out of pi-ai's browser exports. */
export function loginPioneerInBrowser(callbacks: AuthInteraction): Promise<OAuthCredential> {
	if (callbacks.signal?.aborted) return Promise.reject(new Error("Login cancelled"));
	return new Promise((resolve, reject) => {
		const state = randomBytes(32).toString("hex");
		const controller = new AbortController();
		let settled = false;
		let receiving = false;
		let callbackUrl: URL;
		const finish = (error?: Error, credentials?: OAuthCredential) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			callbacks.signal?.removeEventListener("abort", cancel);
			controller.abort();
			server.close();
			if (error) server.closeAllConnections();
			if (error) reject(error);
			else if (credentials) resolve(credentials);
		};
		const cancel = () => finish(new Error("Login cancelled"));
		const timeout = setTimeout(
			() => finish(new Error("Pioneer sign-in timed out. Run /login to try again.")),
			LOGIN_TIMEOUT_MS,
		);
		const server = createServer(async (request, response) => {
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("Referrer-Policy", "no-referrer");
			response.setHeader("Content-Type", "text/plain; charset=utf-8");
			if (
				request.method !== "POST" ||
				request.url !== "/callback" ||
				request.headers.host !== callbackUrl.host ||
				request.headers.origin !== PIONEER_ORIGIN ||
				request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded"
			) {
				response.writeHead(400).end("Invalid sign-in callback.");
				return;
			}
			try {
				let body = "";
				for await (const chunk of request) {
					body += String(chunk);
					if (body.length > 4096) {
						response.writeHead(413).end("Sign-in callback is too large.");
						return;
					}
				}
				const params = new URLSearchParams(body);
				if (params.get("state") !== state || settled || receiving) {
					response.writeHead(400).end("Invalid or already used sign-in request.");
					return;
				}
				receiving = true;
				const credentials = await validateCredential(
					params.get("key") ?? "",
					Number(params.get("expires_at")),
					controller.signal,
				);
				response.end("Pioneer is connected. Return to Pi in your terminal. You can close this tab.");
				finish(undefined, credentials);
			} catch {
				receiving = false;
				response
					.writeHead(400)
					.end("Could not verify the Pioneer credential. Return to Pi and try signing in again.");
			}
		});
		server.requestTimeout = 15000;
		server.headersTimeout = 10000;
		server.on("error", () => finish(new Error("Could not start the local Pioneer sign-in receiver.")));
		callbacks.signal?.addEventListener("abort", cancel, { once: true });
		server.listen(0, "127.0.0.1", () => {
			if (settled) {
				server.close();
				return;
			}
			const address = server.address();
			if (!address || typeof address === "string") {
				finish(new Error("Could not start the local Pioneer sign-in receiver."));
				return;
			}
			callbackUrl = new URL(`http://127.0.0.1:${address.port}/callback`);
			const url = new URL(PIONEER_KEYS_URL);
			url.searchParams.set("cli_callback", callbackUrl.href);
			url.searchParams.set("state", state);
			try {
				callbacks.notify({
					type: "auth_url",
					url: url.href,
					instructions:
						"Sign in with your wallet, then select Connect Pi. This terminal will continue automatically.",
				});
				// Manual entry also supports remote terminals and servers without the browser handoff page yet.
				void callbacks
					.prompt({
						type: "secret",
						signal: controller.signal,
						message: "Waiting for browser sign-in. Alternatively, paste a Pioneer API key:",
					})
					.then(async (key) => {
						if (settled) return;
						const credentials = await validateCredential(
							key.trim(),
							Date.now() + KEY_LIFETIME_MS,
							controller.signal,
						);
						finish(undefined, credentials);
					})
					.catch((error: unknown) =>
						finish(error instanceof Error ? error : new Error("Pioneer sign-in failed.")),
					);
			} catch {
				finish(new Error("Could not open Pioneer sign-in."));
			}
		});
	});
}
