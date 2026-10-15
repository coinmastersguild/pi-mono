import { spawn } from "node:child_process";

export type NativeCommand = (command: string, args: string[], input?: Buffer) => Promise<Buffer>;

/** No shell, no password in argv/environment, and bounded output. Native errors never echo input. */
export const runNative: NativeCommand = (command, args, input) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		const output: Buffer[] = [];
		let bytes = 0;
		let oversized = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
		child.stdin.on("error", () => {});
		child.stderr.resume();
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 8 * 1024 * 1024) {
				oversized = true;
				child.kill("SIGKILL");
			} else output.push(chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 || oversized) reject(new Error(`${command} ${args[0]} failed (exit ${code ?? "signal"}).`));
			else resolve(Buffer.concat(output));
		});
		child.stdin.end(input);
	});

/** Native APFS disk images encrypt writes immediately, including SQLite WAL and temporary files. */
export class MacVaultDisk {
	private readonly run: NativeCommand;
	constructor(run: NativeCommand = runNative) {
		this.run = run;
	}

	async create(path: string, diskKey: Buffer): Promise<void> {
		const input = Buffer.from(`${diskKey.toString("hex")}\0`);
		try {
			await this.run(
				"/usr/bin/hdiutil",
				[
					"create",
					"-size",
					"128g",
					"-type",
					"SPARSEBUNDLE",
					"-fs",
					"APFS",
					"-volname",
					"Pioneer",
					"-encryption",
					"AES-256",
					"-stdinpass",
					"-nospotlight",
					path,
				],
				input,
			);
		} finally {
			input.fill(0);
		}
	}

	async attach(path: string, mount: string, diskKey: Buffer): Promise<void> {
		const plist = await this.run("/usr/bin/hdiutil", ["isencrypted", path, "-plist"]);
		const json = await this.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], plist);
		const info: unknown = JSON.parse(json.toString("utf8"));
		if (!info || typeof info !== "object" || !("encrypted" in info) || info.encrypted !== true) {
			throw new Error("Refusing to mount an unencrypted vault image.");
		}
		const input = Buffer.from(`${diskKey.toString("hex")}\0`);
		try {
			await this.run(
				"/usr/bin/hdiutil",
				["attach", path, "-stdinpass", "-mountpoint", mount, "-nobrowse", "-noautoopen", "-owners", "on"],
				input,
			);
		} finally {
			input.fill(0);
		}
	}

	async detach(mount: string): Promise<void> {
		// Never force an unmount while a process might still be writing.
		await this.run("/usr/bin/hdiutil", ["detach", mount]);
	}

	async isAttached(path: string): Promise<boolean> {
		const plist = await this.run("/usr/bin/hdiutil", ["info", "-plist"]);
		const json = await this.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], plist);
		const info: unknown = JSON.parse(json.toString("utf8"));
		if (!info || typeof info !== "object" || !("images" in info) || !Array.isArray(info.images)) {
			throw new Error("Could not inspect attached vaults.");
		}
		return info.images.some((image: unknown) =>
			Boolean(image && typeof image === "object" && "image-path" in image && image["image-path"] === path),
		);
	}
}
