import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyPioneerArtifact } from "./verify-pioneer-artifact.mjs";

test("release verification rejects tampered artifacts, wrong tags, and unexpected paths", () => {
	const directory = mkdtempSync(join(tmpdir(), "pioneer-release-integrity-"));
	const filename = "pioneer-platform-pioneer-cli-1.1.0.tgz";
	const bytes = Buffer.from("test artifact");
	const artifact = { name: "@pioneer-platform/pioneer-cli", version: "1.1.0", tarball: filename, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
	const save = (value) => writeFileSync(join(directory, "artifact.json"), JSON.stringify(value));
	try {
		writeFileSync(join(directory, filename), bytes);
		save(artifact);
		assert.equal(verifyPioneerArtifact(directory, "pioneer-v1.1.0"), join(directory, filename));
		assert.throws(() => verifyPioneerArtifact(directory, "pioneer-v1.0.41"), /tag/);
		save({ ...artifact, tarball: "../other.tgz" });
		assert.throws(() => verifyPioneerArtifact(directory), /path/);
		save({ ...artifact, name: "@earendil-works/pi-coding-agent" });
		assert.throws(() => verifyPioneerArtifact(directory), /identity/);
		save(artifact);
		writeFileSync(join(directory, filename), "changed artifact");
		assert.throws(() => verifyPioneerArtifact(directory), /integrity/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
