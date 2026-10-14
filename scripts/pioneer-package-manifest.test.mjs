import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pioneerPackageManifest } from "./pioneer-package-manifest.mjs";

test("Pioneer artifact installs its own command and bundles SDK integrations", () => {
	const source = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));
	const manifest = pioneerPackageManifest(source);
	assert.equal(manifest.name, "@pioneer-platform/pioneer-cli");
	assert.equal(manifest.version, "1.1.1");
	assert.deepEqual(manifest.bin, { pioneer: "dist/bundle/cli.js" });
	assert.equal(manifest.exports["."].import, "./dist/bundle/index.js");
	assert.equal(manifest.piConfig.configDir, ".pioneer");
	assert.ok(Object.values(manifest.dependencies).every((version) => /^\d+\.\d+\.\d+$/.test(version)));
	assert.equal(source.name, "@earendil-works/pi-coding-agent");
});
