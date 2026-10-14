import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PioneerCoreClient } from "../src/core/pioneer-core.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(url = "http://127.0.0.1:19713") {
	const path = await mkdtemp(join(tmpdir(), "pioneer-core-test-"));
	directories.push(path);
	const discoveryPath = join(path, "discovery.json"),
		tokenPath = join(path, "token");
	await writeFile(discoveryPath, JSON.stringify({ url, token: "discovery-must-not-be-used" }));
	await writeFile(tokenPath, "scoped-test-token", { mode: 0o600 });
	return { discoveryPath, tokenPath };
}
const questions = { review: { type: "noul" as const, instructions: "Review needed?" } };
test("uses scoped credentials, loopback, bounded typed requests and denies redirects", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ answers: { review: 0.75 } }));
	const client = new PioneerCoreClient({ ...(await fixture()), fetch: request });
	await expect(client.evaluate("numeric metrics", questions)).resolves.toEqual({ review: 0.75 });
	expect(request).toHaveBeenCalledWith(
		"http://127.0.0.1:19713/v1/analytic/evaluate",
		expect.objectContaining({
			redirect: "error",
			headers: expect.objectContaining({ Authorization: "Bearer scoped-test-token" }),
			body: JSON.stringify({ text: "numeric metrics", questions }),
		}),
	);
	await expect(client.evaluate("x".repeat(2001), questions)).rejects.toThrow("limits");
	expect(request).toHaveBeenCalledTimes(1);
});
test("rejects nonlocal discovery before sending credentials", async () => {
	const request = vi.fn<typeof fetch>();
	const client = new PioneerCoreClient({ ...(await fixture("https://example.com")), fetch: request });
	await expect(client.evaluate("metrics", questions)).rejects.toThrow("loopback");
	expect(request).not.toHaveBeenCalled();
});
test("reports locked vault and invalid probabilities without exposing server messages", async () => {
	const request = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(Response.json({ error: "sensitive server detail" }, { status: 423 }))
		.mockResolvedValueOnce(Response.json({ answers: { review: 4 } }));
	const client = new PioneerCoreClient({ ...(await fixture()), fetch: request });
	await expect(client.evaluate("metrics", questions)).rejects.toThrow("unlock vault");
	await expect(client.evaluate("metrics", questions)).rejects.toThrow("Invalid Core probability");
});
