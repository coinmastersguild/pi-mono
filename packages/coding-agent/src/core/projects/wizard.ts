import { openSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";
import { VAULT_LOGIN_ART } from "../privacy/password.ts";
import type { GuildProject } from "./guild.ts";

export interface ProjectSetup {
	project: GuildProject;
	transparent: boolean;
}

export function validateProjectName(name: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
		throw new Error(
			"Use a project name of 1–64 letters, numbers, hyphens, or underscores, starting with a letter or number.",
		);
	}
}

export async function promptProjectSetup(
	name: string,
	transparent: boolean,
	existing = false,
	privateHistory = false,
): Promise<ProjectSetup> {
	let input: ReadStream;
	let output: WriteStream;
	try {
		input = new ReadStream(openSync("/dev/tty", "r"));
		try {
			output = new WriteStream(openSync("/dev/tty", "w"));
		} catch (error) {
			input.destroy();
			throw error;
		}
	} catch {
		throw new Error("Pioneer project setup needs a terminal. Run pioneer create <name> interactively.");
	}
	const terminal = createInterface({ input, output, terminal: true });
	terminal.on("SIGINT", () => terminal.close());
	const ask = (label: string, fallback?: string): Promise<string> =>
		new Promise((resolveAnswer, reject) => {
			const cancel = (): void => reject(new Error("Pioneer project setup cancelled. No project was created."));
			terminal.once("close", cancel);
			terminal.question(`${label}${fallback === undefined ? "" : ` [${fallback}]`}: `, (answer) => {
				terminal.off("close", cancel);
				const value = answer.trim() || fallback || "";
				if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
					reject(new Error("Setup answers must be a single line of at most 4096 characters."));
				else resolveAnswer(value);
			});
		});
	try {
		output.write(`${VAULT_LOGIN_ART}\nPioneer Guild project setup — GUILD-SETUP-001\nProject: ${name}\n`);
		output.write(
			`Storage: ${transparent ? (privateHistory ? "normal code files; encrypted history, logs, and memory" : "normal code and history (encryption off)") : "encrypted project, history, logs, and memory"}. Git stays local; no remote is added.\n`,
		);
		const purpose = await ask("What is this project for?");
		if (!purpose) throw new Error("A project purpose is required.");
		const success = await ask("How will you know the first version works?");
		if (!success) throw new Error("A success criterion is required.");
		const kind = (await ask("Project type: service / cli / library", "service")).toLowerCase();
		if (kind !== "service" && kind !== "cli" && kind !== "library")
			throw new Error("Choose service, cli, or library.");
		let port: number | undefined;
		if (kind === "service") {
			port = Number(await ask("Proposed local service port", "3000"));
			if (!Number.isInteger(port) || port < 1024 || port > 65535)
				throw new Error("Use a port between 1024 and 65535.");
		}
		const productionAnswer = existing
			? (await ask("Already serving production users? yes / no", "no")).toLowerCase()
			: "no";
		if (!["yes", "no"].includes(productionAnswer)) throw new Error("Choose yes or no for production state.");
		const milestone = await ask("First milestone", "First working version");
		output.write(
			`\nPlan: ${purpose}\nSuccess: ${success}\nMilestone 1: ${milestone}\nCreate architecture, planning state, draft spec, handoff, and deployment checklists.\nDeployment scripts begin unconfigured; no build, deployment, or commit will run.\n`,
		);
		if (!/^(y|yes)$/i.test(await ask("Write this project setup? yes / no", "yes")))
			throw new Error("Pioneer project setup cancelled. No files were written.");
		return {
			project: { name, purpose, success, kind, port, production: productionAnswer === "yes", milestone },
			transparent,
		};
	} finally {
		terminal.close();
		input.destroy();
		output.destroy();
	}
}
