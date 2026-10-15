import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const AAD = Buffer.from("pioneer-vault-key-v1");

/** Only the randomly generated disk key is wrapped here. Project bytes use the native encrypted filesystem. */
export interface VaultKeyEnvelope {
	version: 1;
	kdf: "scrypt-N131072-r8-p1";
	salt: string;
	nonce: string;
	ciphertext: string;
	tag: string;
}

function derive(password: Buffer, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, 32, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
	});
}

function decode(value: unknown, size: number): Buffer {
	if (typeof value !== "string" || !/^[a-f0-9]+$/.test(value) || value.length !== size * 2) {
		throw new Error("Invalid vault key envelope. Preserve the vault for recovery.");
	}
	return Buffer.from(value, "hex");
}

export async function wrapVaultKey(password: Buffer, diskKey: Buffer): Promise<VaultKeyEnvelope> {
	if (password.length < 12) throw new Error("Use a password of at least 12 UTF-8 bytes.");
	if (password.length > 4096 || diskKey.length !== 32) throw new Error("Invalid vault key input.");
	const salt = randomBytes(32);
	const nonce = randomBytes(12);
	const key = await derive(password, salt);
	try {
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(AAD);
		const ciphertext = Buffer.concat([cipher.update(diskKey), cipher.final()]);
		return {
			version: 1,
			kdf: "scrypt-N131072-r8-p1",
			salt: salt.toString("hex"),
			nonce: nonce.toString("hex"),
			ciphertext: ciphertext.toString("hex"),
			tag: cipher.getAuthTag().toString("hex"),
		};
	} finally {
		key.fill(0);
	}
}

export async function unwrapVaultKey(password: Buffer, input: unknown): Promise<Buffer> {
	if (!input || typeof input !== "object" || !("version" in input) || input.version !== 1) {
		throw new Error("Unsupported vault key format.");
	}
	const envelope = input as Partial<VaultKeyEnvelope>;
	if (envelope.kdf !== "scrypt-N131072-r8-p1" || password.length > 4096) {
		throw new Error("Unsupported vault key parameters.");
	}
	const salt = decode(envelope.salt, 32);
	const nonce = decode(envelope.nonce, 12);
	const ciphertext = decode(envelope.ciphertext, 32);
	const tag = decode(envelope.tag, 16);
	const key = await derive(password, salt);
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAAD(AAD);
		decipher.setAuthTag(tag);
		// Do not return unauthenticated plaintext from update().
		const plaintext = decipher.update(ciphertext);
		try {
			decipher.final();
			return plaintext;
		} catch {
			plaintext.fill(0);
			throw new Error("Incorrect password or damaged vault key file.");
		}
	} finally {
		key.fill(0);
	}
}
