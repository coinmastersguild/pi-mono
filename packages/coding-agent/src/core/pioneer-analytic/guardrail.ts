export interface ToolRisk {
	level: 0 | 1 | 2 | 3 | 4;
	block: boolean;
	reason: string;
}

const CRITICAL_COMMANDS = [
	/\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|--recursive\b)/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-[^\s]*f/i,
	/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i,
	/\b(?:printenv|env)\b.*\|.*(?:curl|wget|nc)\b/i,
];
const SENSITIVE_PATH = /(^|[/\\])(?:\.env(?:\.|$)|\.ssh|\.aws|\.gnupg|credentials?|secrets?)([/\\]|$)/i;

function stringValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringValues);
	if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
	return [];
}

export function classifyToolRisk(toolName: string, input: Record<string, unknown>): ToolRisk {
	const values = stringValues(input);
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : values.join(" ");
		if (CRITICAL_COMMANDS.some((pattern) => pattern.test(command))) {
			return { level: 4, block: true, reason: "destructive or exfiltrating shell command" };
		}
		return { level: 3, block: false, reason: "shell execution can mutate the system" };
	}
	if (["write", "edit"].includes(toolName) && values.some((value) => SENSITIVE_PATH.test(value))) {
		return { level: 4, block: true, reason: "write targets a credential or secret path" };
	}
	if (["write", "edit"].includes(toolName)) return { level: 3, block: false, reason: "file mutation" };
	if (toolName === "read" && values.some((value) => SENSITIVE_PATH.test(value))) {
		return { level: 3, block: false, reason: "read targets a credential or secret path" };
	}
	return { level: 1, block: false, reason: "no deterministic elevated-risk pattern matched" };
}
