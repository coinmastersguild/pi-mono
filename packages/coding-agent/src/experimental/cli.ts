#!/usr/bin/env node
import { setupCli } from "../cli/setup.ts";
import { launchPrivateCli } from "../core/privacy/launcher.ts";
import { main } from "../main.ts";
import { runExperimentalCommand } from "./commands.ts";

setupCli();
await launchPrivateCli(process.argv.slice(2), async (args) => {
	if (await runExperimentalCommand(args)) {
		if (args[0] === "client") process.exit(process.exitCode ?? 0);
	} else {
		await main(args);
	}
});
