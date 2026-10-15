import type { AuthEvent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { loginPioneerInBrowser } from "../src/core/pioneer-login.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";

type OAuthAuthInfo = Extract<AuthEvent, { type: "auth_url" }>;

const KEY = `sk-pioneer-${"a".repeat(64)}`;
const ORIGIN = "https://alpha.pioneers.dev";
const realFetch = globalThis.fetch;

function startLogin() {
	const controller = new AbortController();
	let opened!: (info: OAuthAuthInfo) => void;
	const browser = new Promise<OAuthAuthInfo>((resolve) => {
		opened = resolve;
	});
	const result = loginPioneerInBrowser({
		notify: (event) => {
			if (event.type === "auth_url") opened(event);
		},
		prompt: () => new Promise<string>(() => {}),
		signal: controller.signal,
	});
	return { browser, result, controller };
}

async function callback(info: OAuthAuthInfo, fields: Record<string, string> = {}, origin = ORIGIN) {
	const url = new URL(info.url);
	return realFetch(url.searchParams.get("cli_callback")!, {
		method: "POST",
		headers: { Origin: origin },
		body: new URLSearchParams({
			state: url.searchParams.get("state")!,
			key: KEY,
			expires_at: String(Date.now() + 60000),
			...fields,
		}),
	});
}

describe("Pioneer browser sign-in", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("receives and verifies a browser credential without manual input", async () => {
		const verify = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", verify);
		const login = startLogin();
		const info = await login.browser;
		expect(info.url).toMatch(/^https:\/\/alpha\.pioneers\.dev\/keys\?/);
		const response = await callback(info);
		expect(response.status).toBe(200);
		expect(await response.text()).not.toContain(KEY);
		expect(await login.result).toMatchObject({ access: KEY, refresh: "" });
		expect(verify).toHaveBeenCalledWith(
			`${ORIGIN}/api/v1/account`,
			expect.objectContaining({
				headers: { Authorization: `Bearer ${KEY}` },
				redirect: "error",
			}),
		);
		await expect(callback(info)).rejects.toThrow();
	});

	it("rejects another origin, wrong state, expired keys, and invalid keys without consuming the login", async () => {
		const verify = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", verify);
		const login = startLogin();
		const info = await login.browser;
		try {
			for (const [fields, origin] of [
				[{}, "https://attacker.invalid"],
				[{ state: "wrong" }, ORIGIN],
				[{ expires_at: "1" }, ORIGIN],
				[{ key: "not-a-key" }, ORIGIN],
			] as const) {
				const response = await callback(info, fields, origin);
				expect(response.status).toBe(400);
				await response.text();
			}
			expect(verify).not.toHaveBeenCalled();
			const response = await callback(info);
			await response.text();
			expect((await login.result).access).toBe(KEY);
		} finally {
			login.controller.abort();
			await login.result.catch(() => {});
		}
	});

	it("does not save a credential rejected by Alpha", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 401 })),
		);
		const login = startLogin();
		const rejection = expect(login.result).rejects.toThrow("Login cancelled");
		const info = await login.browser;
		const response = await callback(info);
		expect(response.status).toBe(400);
		await response.text();
		login.controller.abort();
		await rejection;
		await expect(callback(info)).rejects.toThrow();
	});

	it("cancels before opening a browser", async () => {
		const onAuth = vi.fn();
		await expect(
			loginPioneerInBrowser({
				notify: onAuth,
				prompt: async () => "",
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow("Login cancelled");
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("retains manual sign-in for remote terminals", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}")),
		);
		const credentials = await loginPioneerInBrowser({ notify: () => {}, prompt: async () => KEY });
		expect(credentials.access).toBe(KEY);
	});

	it("prefers explicit Pioneer environment auth while keeping CLI overrides highest", async () => {
		vi.stubEnv("PIONEER_API_KEY", KEY);
		const auth = AuthStorage.inMemory({
			pioneer: { type: "oauth", access: "stale", refresh: "", expires: Date.now() + 60000 },
		});
		const credentials = new RuntimeCredentials(auth);
		expect(await credentials.read("pioneer")).toEqual({ type: "api_key", key: KEY });
		expect(await auth.read("pioneer")).toMatchObject({ access: "stale" });
		credentials.setRuntimeApiKey("pioneer", "explicit");
		expect(await credentials.read("pioneer")).toEqual({ type: "api_key", key: "explicit" });
	});

	it("persists browser login through Pi 1.1 and restores GLM authentication", async () => {
		vi.stubEnv("PIONEER_API_KEY", "");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}")),
		);
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		const controller = new AbortController();
		let opened!: (event: OAuthAuthInfo) => void;
		const browser = new Promise<OAuthAuthInfo>((resolve) => {
			opened = resolve;
		});
		const result = runtime.login("pioneer", "oauth", {
			notify: (event) => {
				if (event.type === "auth_url") opened(event);
			},
			prompt: () => new Promise<string>(() => {}),
			signal: controller.signal,
		});
		try {
			const response = await callback(await browser, { expires_at: String(Date.now() + 3600000) });
			expect(response.status).toBe(200);
			await response.text();
			await result;
			expect(await credentials.read("pioneer")).toMatchObject({ type: "oauth", access: KEY });
			const restored = await ModelRuntime.create({ credentials, modelsPath: null });
			expect(restored.getModel("pioneer", "auto")).toMatchObject({
				baseUrl: `${ORIGIN}/api/v1/code`,
				contextWindow: 524288,
				maxTokens: 16384,
			});
			expect((await restored.getAuth("pioneer"))?.auth.apiKey).toBe(KEY);
			expect((await restored.getAvailable("pioneer")).map((model) => model.id)).toEqual(["auto"]);
		} finally {
			controller.abort();
			await result.catch(() => {});
		}
	});

	it("defaults to Pioneer with environment auth and respects explicit provider selection", async () => {
		vi.stubEnv("PIONEER_API_KEY", KEY);
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				pioneer: { type: "oauth", access: "stale", refresh: "", expires: 1 },
				anthropic: { type: "api_key", key: "test-key" },
			}),
			modelsPath: null,
		});
		const options = { modelRuntime, scopedModels: [], isContinuing: false };
		expect((await findInitialModel(options)).model).toMatchObject({ provider: "pioneer", id: "auto" });
		expect((await modelRuntime.getAuth("pioneer"))?.auth.apiKey).toBe(KEY);
		expect(
			(await findInitialModel({ ...options, cliProvider: "anthropic", cliModel: "claude-opus-4-8" })).model,
		).toMatchObject({ provider: "anthropic", id: "claude-opus-4-8" });
	});
});
