import { dialogueBrain } from "./pioneerscript.ts";

export type DialogueEntry = { role: "user" | "assistant" | "status"; text: string };
export type DialogueMode = "auto" | "chat" | "work";
export type WorkResult = { status: "completed" | "failed" | "cancelled"; text: string };
export interface DialogueWorker {
	run(text: string, signal: AbortSignal): Promise<WorkResult>;
	isBusy(): boolean;
}

interface Task {
	id: number;
	text: string;
}

/** One serial worker, with synchronous dialogue and an explicit cancellation barrier. */
export class DialogueLoop {
	private queue: Task[] = [];
	private active?: { task: Task; abort: AbortController };
	private nextId = 1;
	private paused = false;
	private disposed = false;
	private timer?: ReturnType<typeof setTimeout>;

	private readonly worker: DialogueWorker;
	private readonly emit: (entry: DialogueEntry) => void;
	private readonly changed: () => void;
	constructor(worker: DialogueWorker, emit: (entry: DialogueEntry) => void, changed: () => void) {
		this.worker = worker;
		this.emit = emit;
		this.changed = changed;
	}

	get state() {
		return {
			active: this.active?.task.id,
			queued: this.queue.length,
			paused: this.paused,
			stopping: this.active?.abort.signal.aborted ?? false,
		};
	}

	get status(): string {
		const active = this.active;
		const state = active
			? `${active.abort.signal.aborted ? "Stopping" : "Running"} #${active.task.id}`
			: this.worker.isBusy()
				? "Thinking is busy"
				: "Thinking is idle";
		return `${state}; ${this.queue.length} queued${this.paused ? " (paused; /resume-work to continue)" : ""}.`;
	}

	submit(text: string, mode: DialogueMode): void {
		if (this.disposed || !text.trim()) return;
		if (text.length > 65_536) {
			this.note("Input exceeds 64 KiB; use a file reference for large tasks.");
			return;
		}
		this.emit({ role: "user", text });
		if (mode !== "work") {
			const reply = dialogueBrain.reply(text);
			if (reply || mode === "chat") {
				this.emit({
					role: "assistant",
					text:
						reply?.kind === "status"
							? this.status
							: (reply?.text ??
								"No local script matches that message. Use /work followed by your request to send it to Thinking."),
				});
				return;
			}
		}
		this.enqueue(text);
	}

	private enqueue(text: string, first = false): boolean {
		if (this.queue.length >= 32) {
			this.note("Queue is full (32 pending jobs). Use /pending or /drop-queue.");
			return false;
		}
		const task = { id: this.nextId++, text };
		if (first) this.queue.unshift(task);
		else this.queue.push(task);
		this.note(`Queued #${task.id}${this.paused ? " (paused)" : ""}.`);
		this.changed();
		this.pump();
		return true;
	}

	interrupt(replacement?: string): boolean {
		if (this.disposed) return false;
		if (replacement && (replacement.length > 65_536 || this.queue.length >= 32)) {
			this.note("Replacement rejected: input too large or queue full. Active work was not interrupted.");
			return false;
		}
		this.cancel();
		if (replacement?.trim()) {
			this.emit({ role: "user", text: replacement });
			this.enqueue(replacement, true);
			this.resume();
		}
		return true;
	}

	cancel(): void {
		if (this.disposed) return;
		this.paused = true;
		this.active?.abort.abort();
		this.note("Stop requested; pending work is paused. /resume-work continues it.");
		this.changed();
	}

	resume(): void {
		if (this.disposed) return;
		this.paused = false;
		this.changed();
		this.pump();
	}

	dropQueue(): void {
		this.queue = [];
		this.note("Pending jobs discarded. Active work is unchanged.");
		this.changed();
	}

	takeQueued(): string[] {
		const texts = this.queue.map((task) => task.text);
		this.queue = [];
		this.changed();
		return texts;
	}

	pending(): void {
		this.note([this.status, ...this.queue.map((task) => `#${task.id}: ${task.text.slice(0, 160)}`)].join("\n"));
	}

	private note(text: string): void {
		if (!this.disposed) this.emit({ role: "status", text });
	}

	private pump(): void {
		if (this.disposed || this.paused || this.active || this.queue.length === 0) return;
		if (this.worker.isBusy()) {
			this.timer ??= setTimeout(() => {
				this.timer = undefined;
				this.pump();
			}, 100);
			return;
		}
		const task = this.queue.shift();
		if (!task) return;
		const active = { task, abort: new AbortController() };
		this.active = active;
		this.note(`Running #${task.id} in Thinking.`);
		this.changed();
		void this.execute(active);
	}

	private async execute(active: { task: Task; abort: AbortController }): Promise<void> {
		try {
			const result = await this.worker.run(active.task.text, active.abort.signal);
			if (this.disposed) return;
			const status = active.abort.signal.aborted ? "cancelled" : result.status;
			if (status === "completed") {
				this.emit({
					role: "assistant",
					text: `Thinking #${active.task.id} responded:\n\n${result.text || "Run ended without a text response. See Thinking for details."}`,
				});
			} else {
				this.note(
					`${status === "cancelled" ? "Cancelled" : "Failed"} #${active.task.id}.${status === "failed" ? ` ${result.text}` : ""}`,
				);
			}
		} catch (error) {
			this.note(
				`${active.abort.signal.aborted ? "Cancelled" : "Failed"} #${active.task.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.active = undefined;
			if (!this.disposed) {
				this.changed();
				this.pump();
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.queue = [];
		if (this.timer) clearTimeout(this.timer);
		this.active?.abort.abort();
	}
}
