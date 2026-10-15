import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import type { DialogueWorker } from "./loop.ts";

/** Captures one session: late results cannot migrate to a newly selected session. */
export function createDialogueWorker(
	session: AgentSession,
	externallyBusy: () => boolean = () => false,
): DialogueWorker {
	return {
		isBusy: () => externallyBusy() || !session.isIdle,
		async run(text, signal) {
			let last: AssistantMessage | undefined;
			const abort = () => {
				session.abortCompaction();
				void session.abort();
			};
			const unsubscribeSession = session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") last = event.message;
			});
			signal.addEventListener("abort", abort, { once: true });
			try {
				signal.throwIfAborted();
				await session.prompt(text, {
					// Includes auth, input hooks, compaction and before_agent_start hooks.
					// Throwing here prevents a cancelled preflight from starting a model run.
					preflightResult: (accepted) => {
						if (accepted === "started") signal.throwIfAborted();
					},
				});
				await session.waitForIdle();
				if (signal.aborted) return { status: "cancelled", text: "" };
				if (!last) return { status: "completed", text: "" };
				if (last.stopReason === "aborted") return { status: "cancelled", text: "" };
				if (last.stopReason === "error") return { status: "failed", text: last.errorMessage ?? "Model run failed" };
				if (last.stopReason === "toolUse")
					return { status: "failed", text: "Run ended before a final assistant response. See Thinking." };
				return {
					status: "completed",
					text: last.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				};
			} catch (error) {
				if (signal.aborted) return { status: "cancelled", text: "" };
				throw error;
			} finally {
				signal.removeEventListener("abort", abort);
				unsubscribeSession();
			}
		},
	};
}
