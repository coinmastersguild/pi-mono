#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { launchPrivateCli } from "./core/privacy/launcher.ts";
import { main } from "./main.ts";

setupCli();
void launchPrivateCli(process.argv.slice(2), main);
