# Pioneer CLI 1.1.0 release preparation

Npm package: `@pioneer-platform/pioneer-cli`; installed command: `pioneer`.
The supported runtime is Node.js 22.19 or newer. Direct Bun execution of this Node
artifact fails with the pinned HTTP dependency on Bun 1.3.9 and 1.3.14. Use Node
for CLI and SDK execution, including when the package is installed with Bun.
Existing npm latest observed during preparation: `1.0.41`. Version `1.1.0` is a new
version; it does not replace the immutable `1.0.41` artifact.

Normal CLI operation uses plaintext storage without an encryption prompt.
`pioneer --private` encrypts agent history, logs, credentials, and project memory
while reading/writing ordinary project files. `pioneer create --private <name>`
creates a project with this private agent state. Add `--encrypt-workspace` to create
or run an encrypted project too. Existing protected projects retain their vaults.
Encryption is at rest, currently uses the macOS disk-image runtime, and requires
a controlling terminal. Normal unencrypted operation remains cross-platform.

Pioneer Core tools support explicitly granted local sourced memory and typed
analytics. Alpha analytics uses the Pioneer credential, including browser login,
at `https://alpha.pioneers.dev/api/v1/analytic`, with local ranking fallback.
`PIONEER_ANALYTIC_ENABLED=0` disables automatic Alpha analytics. Private project
memory stays in the vault; the at-rest mode does not prevent cloud model/analytics
requests from transmitting context.

The Pioneer artifact contains bundled CLI and SDK entries so Pioneer providers
and integrations ship independently from the upstream workspace packages.
`scripts/pack-pioneer.mjs` builds and packs this artifact.
`scripts/check-pioneer-install.mjs` installs it outside the repository and tests
CLI startup, SDK exports, a local fake-provider codemode exchange, and goal
execution through RPC with a real file write/read and recorded completion evidence.

Built-in `/goal` mode persists objective, progress, evidence, and turn limits in
session history. It continues after interim replies, stops on completion/blockers,
and restores paused after restart. The default run limit is 20 model turns.
Goal state follows the selected encryption mode. Maintenance mode is not part
of this release. Pioneer Office receives and persists events; task acceptance is
explicit through `/office accept` or `/office resume`.

Automatic compaction is enabled by default. Working context defaults to an
estimated 32,768-token cap, compacts around 24,576 tokens, and retains roughly
8,192 recent tokens. System/tool declarations and extension context count toward
the final request guard; oversized requests stop if compaction cannot safely
reduce them. Goals retain their current state across compaction. Configure
`compaction.maxContextTokens` globally or per model; `0` explicitly disables the
working cap. Raw session history is preserved.

Publication uses `.github/workflows/publish-pioneer.yml`, environment
`pioneer-npm-publish`, and npm trusted publishing for this package. The npm owner
must configure that GitHub workflow as a trusted publisher before publication.
No publication, tags, or commits are performed by local preparation.
The publishing job runs focused Pioneer and agent regression tests, rejects an
incorrect release tag, and verifies the tarball's SHA-512 integrity. Manual
workflow runs must select the matching `pioneer-v1.1.0` tag.
