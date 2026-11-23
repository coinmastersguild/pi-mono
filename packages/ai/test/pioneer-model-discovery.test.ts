import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "../src/models.ts";
import { PIONEER_GLM53_MODEL_ID, PIONEER_MODEL, pioneerProvider } from "../src/providers/pioneer.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Pioneer model discovery", () => {
	it("adds the explicit GLM route with its live window and removes it when unavailable", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => (name === "PIONEER_API_KEY" ? "synthetic-key" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider(pioneerProvider());
		const fetchCatalog = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchCatalog);
		fetchCatalog.mockImplementation(async (_url, init) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-key");
			return Response.json({
				data: [{ id: PIONEER_GLM53_MODEL_ID, context_window: 1048576, max_output_tokens: 16384 }],
			});
		});
		expect(models.getModel("pioneer", PIONEER_GLM53_MODEL_ID)).toBeUndefined();
		expect((await models.refresh()).errors.size).toBe(0);
		expect(fetchCatalog).toHaveBeenCalledWith(`${PIONEER_MODEL.baseUrl}/models`, expect.anything());
		expect(models.getModel("pioneer", PIONEER_GLM53_MODEL_ID)).toMatchObject({
			contextWindow: 1048576,
			maxTokens: 16384,
		});
		expect(models.getModel("pioneer", "auto")).toEqual(PIONEER_MODEL);

		fetchCatalog.mockImplementation(async () => Response.json({ data: [] }));
		expect((await models.refresh()).errors.size).toBe(0);
		expect(models.getModel("pioneer", PIONEER_GLM53_MODEL_ID)).toBeUndefined();
	});
});
