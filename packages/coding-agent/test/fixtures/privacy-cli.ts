import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { launchPrivateCli } from "../../src/core/privacy/launcher.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import pioneerCoreExtension from "../../src/extensions/pioneer-core.ts";
import { createHarness, getMessageText, getToolResult } from "../suite/harness.ts";

// Offline probe for the real password screen and supervised CLI, using the suite's faux provider.
await launchPrivateCli(process.argv.slice(2), async () => {
	const path = join(process.cwd(), "private-probe.txt");
	const content = "PRIVATE-HARNESS-PROBE-32b165e8\n";
	const harness = await createHarness({
		sessionManager: SessionManager.create(process.cwd()),
		initialActiveToolNames: ["read", "write", "core_memory_save", "core_memory_search"],
		extensionFactories: [pioneerCoreExtension],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall("core_memory_save", {
					namespace: "probe",
					key: "finding",
					text: content,
					source: "fixture",
					author: "test",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("core_memory_search", { namespace: "probe", query: "PRIVATE-HARNESS" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("verified"),
		]);
		await harness.session.prompt("Write a file, read it back, and save and retrieve private memory.");
		assert.equal(await readFile(path, "utf8"), content);
		assert.equal(getMessageText(getToolResult(harness, "read")), content);
		for (const tool of ["write", "read", "core_memory_save", "core_memory_search"]) {
			assert.equal(getToolResult(harness, tool).isError, false, getMessageText(getToolResult(harness, tool)));
		}
		assert.match(getMessageText(getToolResult(harness, "core_memory_search")), /PRIVATE-HARNESS-PROBE/);
		console.log("PRIVATE_FIXTURE_OK");
	} finally {
		harness.cleanup();
	}
});
