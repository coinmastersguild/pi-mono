import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Bounded regular-file read. Reject links (including ancestor aliases) and files outside the workspace. */
export async function readWorkspaceFile(cwd: string, path: string, maxBytes: number): Promise<Buffer | undefined> {
	try {
		const root = await realpath(cwd),
			absolute = resolve(root, path);
		const inside = relative(root, absolute);
		if (
			!inside ||
			inside === ".." ||
			inside.startsWith(`..${sep}`) ||
			isAbsolute(inside) ||
			(await realpath(absolute)) !== absolute
		)
			return undefined;
		const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > maxBytes) return undefined;
			const buffer = Buffer.alloc(maxBytes + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			return length <= maxBytes ? buffer.subarray(0, length) : undefined;
		} finally {
			await file.close();
		}
	} catch {
		return undefined;
	}
}
