#!/usr/bin/env node

import { launchPrivateCli } from "../../core/privacy/launcher.ts";
import { type OpenDurableOptions, openDurable } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";

function parseArgs(argv: readonly string[]): OpenDurableOptions {
	let continueSession = false;
	for (const arg of argv) {
		if (arg === "--continue" || arg === "-c") continueSession = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return { continueSession };
}

await launchPrivateCli(process.argv.slice(2), async (args) => {
	const durable = await openDurable(parseArgs(args));
	try {
		await runDurableTui(durable.view, durable.controller, durable.settings);
	} finally {
		await durable.close();
	}
});
