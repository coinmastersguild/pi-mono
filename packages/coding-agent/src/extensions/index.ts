import type { InlineExtension } from "../core/extensions/types.ts";
import { createPioneerAnalyticExtension } from "../core/pioneer-analytic/index.ts";
import codemodeExtension from "./codemode/index.ts";
import imageAttachmentsExtension from "./image-attachments.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import pioneerCoreExtension from "./pioneer-core.ts";
import pioneerGoalExtension from "./pioneer-goal.ts";
import pioneerIntroExtension from "./pioneer-intro.ts";
import pioneerOfficeExtension from "./pioneer-office.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "pioneer-core", factory: pioneerCoreExtension, builtin: true },
	{ name: "pioneer-goal", factory: pioneerGoalExtension, builtin: true },
	{ name: "image-attachments", factory: imageAttachmentsExtension, builtin: true },
	{ name: "pioneer-intro", factory: pioneerIntroExtension, builtin: true },
	{ name: "pioneer-office", factory: pioneerOfficeExtension, builtin: true },
	{ name: "pioneer-analytic", factory: createPioneerAnalyticExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
