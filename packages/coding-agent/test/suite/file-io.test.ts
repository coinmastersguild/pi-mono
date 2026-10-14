import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("file I/O through the agent harness", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["notes.txt", "nested/deep/notes.txt", "folder with spaces/café.txt", "absolute"])(
		"writes and reads %s through provider tool calls",
		async (name) => {
			const harness = await createHarness({ initialActiveToolNames: ["read", "write"] });
			harnesses.push(harness);
			const path = name === "absolute" ? join(harness.tempDir, "absolute.txt") : name;
			const content = "First line\nUnicode: café 日本語\nLast line\n";
			harness.setResponses([
				(context) => {
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(
						expect.arrayContaining(["read", "write"]),
					);
					return fauxAssistantMessage(fauxToolCall("write", { path, content }), { stopReason: "toolUse" });
				},
				() => {
					expect(getToolResult(harness, "write").isError).toBe(false);
					expect(readFileSync(join(harness.tempDir, name === "absolute" ? "absolute.txt" : name), "utf8")).toBe(
						content,
					);
					return fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" });
				},
				() => {
					expect(getToolResult(harness, "read").isError).toBe(false);
					expect(getMessageText(getToolResult(harness, "read"))).toBe(content);
					return fauxAssistantMessage("verified");
				},
			]);
			await harness.session.prompt("Write the file and read it back.");
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(getMessageText(harness.session.messages.at(-1))).toBe("verified");
		},
	);

	it("overwrites a file and reads a selected line", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read", "write"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "file.txt", content: "old content" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("write", { path: "file.txt", content: "one\ntwo\nthree" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("read", { path: "file.txt", offset: 2, limit: 1 }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Overwrite and read line two.");
		expect(readFileSync(join(harness.tempDir, "file.txt"), "utf8")).toBe("one\ntwo\nthree");
		expect(getToolResult(harness, "read").isError).toBe(false);
		expect(getMessageText(getToolResult(harness, "read"))).toBe(
			"two\n\n[1 more lines in file. Use offset=3 to continue.]",
		);
	});

	it("returns filesystem errors to the model and continues", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read", "write"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), { stopReason: "toolUse" }),
			() => {
				expect(getToolResult(harness, "read").isError).toBe(true);
				expect(getMessageText(getToolResult(harness, "read"))).toContain("ENOENT");
				return fauxAssistantMessage(fauxToolCall("write", { path: "blocker", content: "file" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(fauxToolCall("write", { path: "blocker/child.txt", content: "cannot write" }), {
				stopReason: "toolUse",
			}),
			() => {
				expect(getToolResult(harness, "write").isError).toBe(true);
				expect(existsSync(join(harness.tempDir, "blocker/child.txt"))).toBe(false);
				return fauxAssistantMessage("errors received");
			},
		]);
		await harness.session.prompt("Exercise read and write errors.");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("errors received");
	});

	it("writes and reads through codemode using the session working directory", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "write", "codemode"],
			extensionFactories: [createCodemodeExtension()],
			settings: { codemode: { mode: "only" } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'await tools.write({ path: "nested/script.txt", content: "codemode round trip" }); text(await tools.read({ path: "nested/script.txt" }));',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Write and read through codemode.");
		expect(readFileSync(join(harness.tempDir, "nested/script.txt"), "utf8")).toBe("codemode round trip");
		expect(getToolResult(harness, "codemode").isError).toBe(false);
		expect(getMessageText(getToolResult(harness, "codemode"))).toContain("codemode round trip");
	});
});
