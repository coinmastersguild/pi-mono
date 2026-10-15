#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const marker = "PIONEER_GOAL_PACKAGE_OK";
const directory = await mkdtemp(join(tmpdir(), "pioneer-goal-package-"));
let child;
let requests = 0;
let failure;
let completed;

function messageText(message) {
	return typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
}

function reply(response, delta, finish = "stop") {
	const chunk = (value, reason) => ({ id: `goal-${requests}`, object: "chat.completion.chunk", created: 0, model: "goal-smoke", choices: [{ index: 0, delta: value, finish_reason: reason }] });
	response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
	response.write(`data: ${JSON.stringify(chunk({ role: "assistant", ...delta }, null))}\n\n`);
	response.end(`data: ${JSON.stringify(chunk({}, finish))}\n\ndata: [DONE]\n\n`);
}

const server = createServer(async (request, response) => {
	try {
		assert.equal(request.method, "POST");
		assert.ok(request.url.endsWith("/chat/completions"));
		let body = "";
		for await (const bytes of request) body += bytes.toString();
		const payload = JSON.parse(body);
		requests++;
		const tool = (name, args) => reply(response, { tool_calls: [{ index: 0, id: `call-${requests}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
		if (requests === 1) tool("write", { path: "goal-result.txt", content: `${marker}\n` });
		else if (requests === 2) {
			assert.equal(await readFile(join(directory, "goal-result.txt"), "utf8"), `${marker}\n`);
			tool("read", { path: "goal-result.txt" });
		} else if (requests === 3) {
			assert.ok(payload.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes(marker)));
			reply(response, { content: "File verified; recording completion next." });
		} else if (requests === 4) {
			const context = payload.messages.map(messageText).findLast((text) => text.includes("The user explicitly enabled goal mode."));
			assert.ok(context, "Goal continuation context is missing");
			const state = JSON.parse(context.split("\n").at(-1));
			tool("goal_update", { goalId: state.id, status: "complete", summary: "Installed goal wrote and read its file", evidence: [`read goal-result.txt returned ${marker}`] });
		} else if (requests === 5) {
			const result = payload.messages.findLast((message) => message.role === "tool");
			completed = JSON.parse(messageText(result));
			assert.equal(completed.status, "complete");
			assert.equal(completed.runTurns, 4);
			assert.ok(completed.evidence[0].includes(marker));
			reply(response, { content: marker });
		} else throw new Error("Goal kept running after completion");
	} catch (error) {
		failure = error;
		response.writeHead(500).end("Goal fixture failed");
	}
});

try {
	assert.equal(process.argv.length, 3, "Usage: node scripts/smoke-test-pioneer-goal.mjs <installed-cli.js>");
	await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await writeFile(join(directory, "models.json"), JSON.stringify({ providers: { "goal-smoke": { api: "openai-completions", apiKey: "offline-fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "goal-smoke" }] } } }));
	child = spawn(process.execPath, [resolve(process.argv[2]), "--mode", "rpc", "--provider", "goal-smoke", "--model", "goal-smoke", "--tools", "read,write,goal_update", "--offline", "--no-mcp", "--no-intro", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session"], {
		cwd: directory,
		env: { ...process.env, PI_OFFLINE: "1", PIONEER_ANALYTIC_ENABLED: "0", PI_CODING_AGENT_DIR: directory, PIONEER_CODING_AGENT_DIR: directory },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "", stderr = "";
	child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
	const exited = new Promise((accept, reject) => { child.once("error", reject); child.once("exit", accept); });
	const finished = new Promise((accept, reject) => {
		const timer = setTimeout(() => { child.kill(); reject(new Error(`Goal package smoke timed out\n${stderr}\n${stdout}`)); }, 30_000);
		child.stdout.on("data", (bytes) => {
			stdout += bytes.toString();
			if (stdout.includes('"type":"agent_settled"')) { clearTimeout(timer); accept(); }
		});
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Goal CLI exited early (${code})\n${stderr}\n${stdout}`)); });
	});
	child.stdin.write(`${JSON.stringify({ id: "goal", type: "prompt", message: "/goal Write goal-result.txt and verify it by reading it back" })}\n`);
	await finished;
	if (failure) throw failure;
	assert.equal(requests, 5);
	assert.equal(completed?.status, "complete");
	assert.ok(stdout.includes(marker));
	child.stdin.end();
	assert.equal(await exited, 0);
	console.log("Installed Pioneer goal: file write/read, continuation, and completion evidence passed.");
} finally {
	child?.kill();
	server.closeAllConnections();
	await new Promise((accept) => server.close(accept));
	await rm(directory, { recursive: true, force: true });
}
