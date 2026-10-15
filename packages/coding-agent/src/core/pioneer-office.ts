import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type CallToolResult, McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import lockfile from "proper-lockfile";

export interface OfficeEvent {
	cursor: number;
	kind: "mention" | "task_assigned";
	body: string;
	channelId: string;
	taskId?: string;
	title?: string;
}
export interface OfficeIdentity {
	id: string;
	companyId: string;
	companyName: string;
	username: string;
}
interface InboxState {
	cursor: number;
	items: Array<{ event: OfficeEvent; accepted: boolean }>;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isEvent(value: unknown): value is OfficeEvent {
	return (
		record(value) &&
		Number.isSafeInteger(value.cursor) &&
		Number(value.cursor) > 0 &&
		(value.kind === "mention" || value.kind === "task_assigned") &&
		typeof value.body === "string" &&
		typeof value.channelId === "string" &&
		(value.taskId === undefined || typeof value.taskId === "string") &&
		(value.title === undefined || typeof value.title === "string")
	);
}
export function officeResult(result: CallToolResult): unknown {
	if (result.isError) throw new Error("Office rejected the request; check agent permissions");
	if (result.structuredContent) return result.structuredContent;
	const text = result.content.find((item) => item.type === "text");
	if (!text || text.type !== "text") throw new Error("Office returned no data");
	return JSON.parse(text.text);
}

/** Save received events and their cursor together, before notifying the terminal. */
export class OfficeInbox {
	private state: InboxState = { cursor: 0, items: [] };
	private readonly path: string;
	constructor(path: string) {
		this.path = path;
		if (!existsSync(path)) return;
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			!record(value) ||
			!Number.isSafeInteger(value.cursor) ||
			Number(value.cursor) < 0 ||
			!Array.isArray(value.items) ||
			!value.items.every(
				(item: unknown) => record(item) && isEvent(item.event) && typeof item.accepted === "boolean",
			)
		) {
			throw new Error("Office inbox is invalid; preserve it before recovery");
		}
		this.state = value as unknown as InboxState;
	}
	get cursor(): number {
		return this.state.cursor;
	}
	get items(): InboxState["items"] {
		return this.state.items;
	}
	private save(next: InboxState): void {
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
		renameSync(tmp, this.path);
		this.state = next;
	}
	receive(value: unknown): number {
		if (
			!record(value) ||
			!Array.isArray(value.events) ||
			!value.events.every(isEvent) ||
			!Number.isSafeInteger(value.nextCursor) ||
			Number(value.nextCursor) < this.cursor
		) {
			throw new Error("Office returned an invalid inbox batch");
		}
		const events = value.events as OfficeEvent[];
		let cursor = this.cursor;
		const fresh: OfficeEvent[] = [];
		for (const event of events) {
			if (event.cursor <= this.cursor) continue;
			if (event.cursor <= cursor || event.cursor > Number(value.nextCursor))
				throw new Error("Office inbox cursor order is invalid");
			fresh.push(event);
			cursor = event.cursor;
		}
		// Never advance past a missing event, even if a buggy server supplies a larger cursor.
		if (Number(value.nextCursor) !== cursor) throw new Error("Office inbox cursor skipped events");
		if (fresh.length)
			this.save({ cursor, items: [...this.state.items, ...fresh.map((event) => ({ event, accepted: false }))] });
		return fresh.length;
	}
	accept(cursor: number, resume = false): OfficeEvent {
		const item = this.state.items.find((entry) => entry.event.cursor === cursor);
		if (!item || item.event.kind !== "task_assigned") throw new Error("Choose an assigned task from /office inbox");
		if (item.accepted && !resume) throw new Error("Already accepted; use /office resume to continue deliberately");
		this.save({
			...this.state,
			items: this.state.items.map((entry) => (entry === item ? { ...entry, accepted: true } : entry)),
		});
		return item.event;
	}
}

interface OfficeConnectionOptions {
	url: string;
	headers: Record<string, string>;
	stateDir: string;
	onStatus: (status: string) => void;
	onInbox: (count: number) => void;
}

export class OfficeConnection {
	identity?: OfficeIdentity;
	inbox?: OfficeInbox;
	private client?: McpClient;
	private controller = new AbortController();
	private running?: Promise<void>;
	private release?: () => Promise<void>;
	private readonly options: OfficeConnectionOptions;
	constructor(options: OfficeConnectionOptions) {
		this.options = options;
	}
	start(): void {
		this.running = this.run();
	}
	private async run(): Promise<void> {
		const signal = this.controller.signal;
		while (!signal.aborted) {
			try {
				const client = new McpClient({ name: "pioneer-pi-presence", version: "1.0.0", requestTimeoutMs: 15000 });
				this.client = client;
				await client.connect(new StreamableHttpTransport({ url: this.options.url, headers: this.options.headers }));
				const self = officeResult(await client.callTool("agents_get_self", {}, { signal }));
				if (
					!record(self) ||
					typeof self.id !== "string" ||
					typeof self.companyId !== "string" ||
					typeof self.username !== "string" ||
					!self.isWorkspaceAgent ||
					!Array.isArray(self.channels) ||
					!self.channels.includes("general")
				) {
					throw new Error("Agent needs a scoped roster identity and #general membership");
				}
				this.identity = {
					id: self.id,
					companyId: self.companyId,
					companyName: String(self.companyName ?? "Office"),
					username: self.username,
				};
				mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
				const key = createHash("sha256").update(`${self.companyId}:${self.id}`).digest("hex");
				const path = join(this.options.stateDir, `${key}.json`);
				this.release = await lockfile.lock(path, {
					realpath: false,
					stale: 15000,
					onCompromised: () => this.controller.abort(),
				});
				this.inbox = new OfficeInbox(path);
				this.options.onStatus(`online @${self.username} · ${this.identity.companyName}`);
				if (this.inbox.items.length) this.options.onInbox(this.inbox.items.length);
				while (!signal.aborted) {
					const batch = officeResult(
						await client.callTool("events_wait", { cursor: this.inbox.cursor, timeoutMs: 8000 }, { signal }),
					);
					const added = this.inbox.receive(batch);
					if (added) this.options.onInbox(added);
				}
			} catch (error) {
				if (!signal.aborted)
					this.options.onStatus(
						`offline · ${error instanceof Error ? error.message.split("\n")[0] : "connection failed"}`,
					);
			} finally {
				await this.client?.close().catch(() => {});
				this.client = undefined;
				await this.release?.().catch(() => {});
				this.release = undefined;
			}
			if (!signal.aborted) await sleep(5000, undefined, { signal }).catch(() => {});
		}
	}
	async stop(): Promise<void> {
		this.controller.abort();
		await this.client?.close().catch(() => {});
		await this.running;
	}
}
