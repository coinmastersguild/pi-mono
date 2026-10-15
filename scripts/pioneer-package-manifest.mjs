export const pioneerPackageName = "@pioneer-platform/pioneer-cli";
// Pioneer releases independently; bundled upstream workspace dependencies remain at their published versions.
export const pioneerPackageVersion = "1.1.1";

/** CLI and SDK both use the bundle so Pioneer provider changes do not depend on upstream publication. */
export function pioneerPackageManifest(source) {
	return {
		name: pioneerPackageName,
		version: pioneerPackageVersion,
		description: "Pioneer coding agent with Core memory, Alpha analytics, and optional encrypted sessions",
		type: "module",
		piConfig: { name: "pioneer", configDir: ".pioneer" },
		bin: { pioneer: "dist/bundle/cli.js" },
		main: "./dist/bundle/index.js",
		types: "./dist/index.d.ts",
		exports: {
			".": { types: "./dist/index.d.ts", import: "./dist/bundle/index.js" },
			"./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
		},
		files: source.files,
		dependencies: Object.fromEntries(Object.entries(source.dependencies).map(([name, version]) => [name, version.replace(/^[~^]/, "")])),
		engines: source.engines,
		license: source.license,
		author: "Pioneer Platform",
		contributors: [source.author],
		repository: { type: "git", url: "git+https://github.com/coinmastersguild/pi-mono.git", directory: "packages/coding-agent" },
		publishConfig: { access: "public" },
	};
}
