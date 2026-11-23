import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
	MODEL_DATA_MANIFEST_FILE,
	createModelDataManifest,
	readModelDataProviderIds,
	readModelDataStructure,
	validateGeneratedModelData,
} from "../packages/ai/scripts/model-data.ts";

// Reuse the catalog shipped in 1.1.1 for this patch release.
const archive = process.argv[2];
const expectedHash = "1100738f4e36d8dc27794fb4be3fa4fbd470ff6adb0dd0559d0df26a505139cc";
if (!archive || createHash("sha256").update(readFileSync(archive)).digest("hex") !== expectedHash) {
	throw new Error("Expected the published Pioneer CLI 1.1.1 archive.");
}
const source = execFileSync("tar", ["-xOzf", archive, "package/dist/bundle/chunks/chunk-KUKBAEYG.js"], {
	encoding: "utf8",
	maxBuffer: 8 * 1024 * 1024,
});
const packageRoot = fileURLToPath(new URL("../packages/ai/", import.meta.url));
const dataDir = join(packageRoot, "src", "providers", "data");
const modelCatalogs = new Map(
	Array.from(source.matchAll(/flattenChatModelCatalog\("([a-z0-9-]+)",([\w$]+)\)/g), (match) => [match[1], match]),
);
const releaseManifest = /var manifest_default=\{schemaVersion:\d+,generatedAt:"([^"]+)",structureHash:"([a-f0-9]+)"/.exec(source);
if (!releaseManifest) throw new Error("Missing the published model-data manifest.");

const files = {};
for (const provider of readModelDataProviderIds(packageRoot)) {
	const match = modelCatalogs.get(provider);
	if (!match) throw new Error(`Missing published catalog for ${provider}.`);
	const declaration = `var ${match[2]}=`;
	const start = source.lastIndexOf(declaration, match.index);
	const end = source.lastIndexOf(";", match.index);
	const initializer = source.slice(start + declaration.length, end);
	if (start < 0 || !initializer.startsWith("{") || !initializer.endsWith("}")) {
		throw new Error(`Missing published catalog initializer for ${provider}.`);
	}
	const catalog = runInNewContext(`(${initializer})`, {}, {
		timeout: 1000,
		contextCodeGeneration: { strings: false, wasm: false },
	});
	files[`${provider}.json`] = `${JSON.stringify(catalog, null, "\t")}\n`;
}
mkdirSync(dataDir, { recursive: true });
for (const [name, contents] of Object.entries(files)) writeFileSync(join(dataDir, name), contents);
const manifest = createModelDataManifest(readModelDataStructure(packageRoot), files, releaseManifest[1]);
if (manifest.structureHash !== releaseManifest[2]) throw new Error("Restored model data differs from the published catalog.");
writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest, null, "\t")}\n`);
validateGeneratedModelData(packageRoot);
