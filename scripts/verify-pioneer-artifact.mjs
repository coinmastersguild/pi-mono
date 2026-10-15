#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pioneerPackageName } from "./pioneer-package-manifest.mjs";

export function verifyPioneerArtifact(directory, tag) {
	const artifact = JSON.parse(readFileSync(join(directory, "artifact.json"), "utf8"));
	if (artifact.name !== pioneerPackageName || !/^\d+\.\d+\.\d+$/.test(artifact.version)) throw new Error("Unexpected Pioneer release identity");
	if (artifact.tarball !== `pioneer-platform-pioneer-cli-${artifact.version}.tgz`) throw new Error("Unexpected Pioneer tarball path");
	if (tag && tag !== `pioneer-v${artifact.version}`) throw new Error("Release tag does not match Pioneer package version");
	const path = join(directory, artifact.tarball);
	const integrity = `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
	if (integrity !== artifact.integrity) throw new Error("Pioneer tarball integrity mismatch");
	return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REF_TYPE !== "tag") throw new Error("Publish from a pioneer-v<version> tag");
	console.log(verifyPioneerArtifact(resolve(process.argv[2] ?? ".artifacts/pioneer"), process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined));
}
