import { closeSync, openSync, writeSync } from "node:fs";
import { ReadStream } from "node:tty";

export const VAULT_LOGIN_ART = `
     ____  ___ ___  _   _ _____ _____ ____
    |  _ \\|_ _/ _ \\| \\ | | ____| ____|  _ \\
    | |_) || | | | |  \\| |  _| |  _| | |_) |
    |  __/ | | |_| | |\\  | |___| |___|  _ <
    |_|   |___\\___/|_| \\_|_____|_____|_| \\_\\

              PRIVATE WORKSPACE
`;

/** Password input uses the controlling terminal, leaving piped prompts and RPC stdin untouched. */
export function promptVaultPassword(label: string, showArt = false, secret = true): Promise<Buffer> {
	let fd: number;
	try {
		fd = openSync("/dev/tty", "r+");
	} catch {
		throw new Error("Vault unlock requires a terminal. Use --unencrypted only to explicitly opt into plaintext.");
	}
	let terminal: ReadStream;
	try {
		terminal = new ReadStream(fd);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	return new Promise((resolve, reject) => {
		const bytes = Buffer.alloc(4096);
		let length = 0;
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			terminal.removeListener("data", onData);
			terminal.removeListener("error", onError);
			process.removeListener("SIGTERM", onSignal);
			process.removeListener("SIGHUP", onSignal);
			try {
				terminal.setRawMode(false);
				terminal.pause();
				writeSync(fd, "\n");
			} catch (restoreError) {
				error ??= restoreError instanceof Error ? restoreError : new Error("Could not restore terminal.");
			} finally {
				terminal.destroy();
			}
			const password = Buffer.from(bytes.subarray(0, length));
			bytes.fill(0);
			if (error) {
				password.fill(0);
				reject(error);
			} else resolve(password);
		};
		const onSignal = (): void => finish(new Error("Vault unlock cancelled."));
		const onError = (error: Error): void => finish(error);
		const onData = (chunk: Buffer): void => {
			for (const byte of chunk) {
				if (byte === 3 || byte === 4 || byte === 27) {
					finish(new Error("Vault unlock cancelled."));
					return;
				}
				if (byte === 10 || byte === 13) {
					finish();
					return;
				}
				if (byte === 127 || byte === 8) {
					if (length > 0) {
						do {
							length--;
						} while (length > 0 && (bytes[length] & 0xc0) === 0x80);
						bytes.fill(0, length);
					}
				} else if (byte === 21) {
					bytes.fill(0);
					length = 0;
				} else if (byte >= 32) {
					if (length === bytes.length) {
						finish(new Error("Password is too long."));
						return;
					}
					bytes[length++] = byte;
				}
			}
		};
		terminal.on("error", onError);
		terminal.on("data", onData);
		process.once("SIGTERM", onSignal);
		process.once("SIGHUP", onSignal);
		try {
			terminal.setRawMode(true);
			if (showArt)
				writeSync(fd, (process.stderr.columns ?? 80) < 52 ? "\n[ PIONEER ]\nPRIVATE WORKSPACE\n" : VAULT_LOGIN_ART);
			writeSync(fd, `${label}${secret ? " (input hidden)" : ""}: `);
			terminal.resume();
		} catch (error) {
			finish(error instanceof Error ? error : new Error("Could not read password."));
		}
	});
}

export async function createVaultPassword(): Promise<Buffer> {
	const password = await promptVaultPassword("Create password", true);
	try {
		if (password.length < 12) throw new Error("Use a password of at least 12 UTF-8 bytes.");
		const confirmation = await promptVaultPassword("Confirm password");
		try {
			if (!password.equals(confirmation)) throw new Error("Passwords do not match.");
		} finally {
			confirmation.fill(0);
		}
		return password;
	} catch (error) {
		password.fill(0);
		throw error;
	}
}
