import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { unwrapVaultKey, wrapVaultKey } from "./crypto.ts";
import { MacVaultDisk } from "./native.ts";

export interface VaultDisk {
	create(path: string, diskKey: Buffer): Promise<void>;
	attach(path: string, mount: string, diskKey: Buffer): Promise<void>;
	detach(mount: string): Promise<void>;
	isAttached(path: string): Promise<boolean>;
}

export async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value)}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

async function readKeyEnvelope(path: string): Promise<unknown> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > 4096) throw new Error("Invalid vault key file.");
		return JSON.parse(await file.readFile("utf8"));
	} finally {
		await file.close();
	}
}

export async function vaultExists(directory: string): Promise<boolean> {
	try {
		await lstat(join(directory, "key.json"));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export interface OpenVaultOptions {
	directory: string;
	password: Buffer;
	create?: boolean;
	disk?: VaultDisk;
}

/** One mount lease at a time. A failed unmount is visible and leaves data in place for recovery. */
export interface OpenVault {
	root: string;
	directory: string;
	close(): Promise<void>;
}

async function lockVault(directory: string): Promise<{ directory: string; release: () => Promise<void> }> {
	const absolute = resolve(directory);
	await mkdir(absolute, { recursive: true, mode: 0o700 });
	const info = await lstat(absolute);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
		throw new Error("The vault directory must be an owned directory, not a symbolic link.");
	}
	await chmod(absolute, 0o700);
	const canonical = await realpath(absolute);
	const release = await lockfile
		.lock(canonical, {
			stale: 30_000,
			retries: 0,
			onCompromised: () => {
				// Continuing after losing the mount lease could corrupt or expose another process's workspace.
				process.stderr.write("Vault lease lost. Stop pi and lock the vault before restarting.\n");
				process.kill(process.pid, "SIGTERM");
			},
		})
		.catch(() => {
			throw new Error(
				`Vault is in use at ${canonical}. Close the Pioneer session using this vault. After a crash, wait 30 seconds and run pioneer vault lock from that project. Use pioneer create <name> for an independent project.`,
			);
		});
	return { directory: canonical, release };
}

export async function openVault(options: OpenVaultOptions): Promise<OpenVault> {
	const { directory, release } = await lockVault(options.directory);
	const disk = options.disk ?? new MacVaultDisk();
	const image = join(directory, "workspace.sparsebundle");
	const keyPath = join(directory, "key.json");
	const root = join(directory, "mount");
	let diskKey: Buffer | undefined;
	let mounted = false;
	try {
		if (await disk.isAttached(image)) {
			throw new Error("Vault is already mounted. Run pi vault lock to recover after a crash.");
		}
		if (!(await vaultExists(directory))) {
			if (!options.create) throw new Error("Vault does not exist. Run pi vault init first.");
			const entries = await readdir(directory);
			if (entries.length > 0) throw new Error("Vault directory is not empty. Preserve it before recovery.");
			diskKey = randomBytes(32);
			await atomicPrivateJson(keyPath, await wrapVaultKey(options.password, diskKey));
			await disk.create(image, diskKey);
		} else {
			diskKey = await unwrapVaultKey(options.password, await readKeyEnvelope(keyPath));
		}
		await mkdir(root, { recursive: true, mode: 0o700 });
		const mountInfo = await lstat(root);
		if (!mountInfo.isDirectory() || mountInfo.isSymbolicLink() || (await readdir(root)).length > 0) {
			throw new Error("Mount directory is not empty or is a symbolic link. Preserve it before recovery.");
		}
		await disk.attach(image, root, diskKey);
		mounted = true;
		await chmod(root, 0o700);
		await writeFile(join(root, ".metadata_never_index"), "", { mode: 0o600 });
		await Promise.all(
			["agent", "projects", "tmp", "cache", "runtime"].map((name) =>
				mkdir(join(root, name), { recursive: true, mode: 0o700 }),
			),
		);
		let closing: Promise<void> | undefined;
		return {
			root,
			directory,
			close() {
				closing ??= (async () => {
					try {
						await disk.detach(root);
						await rmdir(root);
					} finally {
						await release();
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		if (mounted) {
			try {
				await disk.detach(root);
			} catch {
				process.stderr.write("Vault remains mounted; run pi vault lock after closing open files.\n");
			}
		}
		await release();
		throw error;
	} finally {
		diskKey?.fill(0);
	}
}

export async function changeVaultPassword(directory: string, oldPassword: Buffer, newPassword: Buffer): Promise<void> {
	const lease = await lockVault(directory);
	let key: Buffer | undefined;
	try {
		const keyPath = join(lease.directory, "key.json");
		key = await unwrapVaultKey(oldPassword, await readKeyEnvelope(keyPath));
		await atomicPrivateJson(keyPath, await wrapVaultKey(newPassword, key));
	} finally {
		key?.fill(0);
		await lease.release();
	}
}

export async function recoverVaultMount(directory: string, disk: VaultDisk = new MacVaultDisk()): Promise<void> {
	const lease = await lockVault(directory);
	try {
		const root = join(lease.directory, "mount");
		if (await disk.isAttached(join(lease.directory, "workspace.sparsebundle"))) await disk.detach(root);
		// rmdir semantics: never remove data left in an unexpected mount directory.
		if ((await stat(root).catch(() => undefined))?.isDirectory()) {
			const entries = await readdir(root);
			if (entries.length) throw new Error("Mount directory contains unexpected files; preserve it for recovery.");
			await rmdir(root);
		}
	} finally {
		await lease.release();
	}
}
