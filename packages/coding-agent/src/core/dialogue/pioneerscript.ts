/**
 * A deliberately small PioneerScript dialogue dialect for the local TUI prototype.
 * Literal triggers, aliases and one text/status reply only. No macros, objects,
 * redirects, interpolation, regex, user variables, tools or executable handlers.
 * Compile atomically: a malformed brain never installs partial rules.
 */
export type ScriptReply = { kind: "reply"; text: string } | { kind: "status" };

export function compileDialogueBrain(source: string): { reply(input: string): ScriptReply | undefined } {
	if (source.length > 16_384) throw new Error("Dialogue brain exceeds 16 KiB");
	const rules = new Map<string, ScriptReply>();
	let triggers: string[] | undefined;
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("//")) continue;
		if (line.startsWith("+ ") && !triggers) {
			triggers = line
				.slice(2)
				.split("|")
				.map((trigger) => trigger.trim().toLowerCase());
			if (triggers.some((trigger) => !/^[a-z0-9 ?'-]{1,100}$/.test(trigger))) {
				throw new Error("Only literal dialogue triggers are supported");
			}
		} else if (line.startsWith("- ") && triggers) {
			const text = line.slice(2);
			if (/[<>{}\\]/.test(text) || (text.startsWith("@") && text !== "@status")) {
				throw new Error("Executable or interpolated dialogue replies are unsupported");
			}
			const reply: ScriptReply = text === "@status" ? { kind: "status" } : { kind: "reply", text };
			for (const trigger of triggers) {
				if (rules.has(trigger)) throw new Error(`Duplicate dialogue trigger: ${trigger}`);
				rules.set(trigger, reply);
			}
			triggers = undefined;
		} else {
			throw new Error(`Unsupported dialogue syntax: ${line}`);
		}
	}
	if (triggers) throw new Error("Dialogue trigger is missing its reply");
	return { reply: (input) => rules.get(input.trim().toLowerCase()) };
}

// Bundled source, reviewed with the code. Runtime loading of arbitrary brains is
// intentionally outside this prototype's scope.
export const dialogueBrain = compileDialogueBrain(`
// PioneerScript local dialogue v1
+ hi|hello|hey
- Hello. I can keep talking here while the Thinking tab works. Ask for status, or send a task.
+ status|progress|are you working|are you working?|what are you doing|what are you doing?
- @status
+ help|what can you do|what can you do?
- Use /work to force work, /queue to add work, /interrupt with a replacement, or /cancel to stop and pause. /resume-work continues. /chat text forces a local reply. /dialog chat keeps all ordinary conversation local. /think opens the agent transcript.
+ thanks|thank you
- You're welcome. Background work continues independently.
`);
