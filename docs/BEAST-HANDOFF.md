# Beast handoff: Pioneer CLI dialogue workspace

Date: 2026-10-14. Release target: `@pioneer-platform/pioneer-cli@1.1.1`.
Branch: `alpha/027-dialogue-workspace` in `coinmastersguild/pi-mono`.

## Delivered implementation

Conversation and Thinking share the left pane of the current fullscreen UI.
The file explorer, quality feed, and diff viewer remain on the right. F6 switches
transcripts without losing drafts; completed agent responses reach Conversation
without changing focus. Explicit queue, cancel, interrupt/replace, and resume
controls connect a synchronous authored dialogue to one serial background agent.

This integrates the previous dialogue prototype into the newer Pi 1.1 migration
and workspace changes. It includes the local snapshot of Pioneer login,
Core/analytics, Office, goals, privacy, context budgeting, and release packaging.
The original working checkout was preserved. The older `pioneer-cli-dialogue`
checkout based on stale `develop` is superseded and lacks the workspace pane.

Install after registry verification: `npm install -g --ignore-scripts @pioneer-platform/pioneer-cli@1.1.1`.
Run `pioneer --tui-mode fullscreen` in a project, at least 100 columns wide.
See [dialogue controls and offline demo](../packages/coding-agent/docs/dialogue.md)
and [workspace controls](../packages/coding-agent/docs/workspace-pane.md).

## Code map

- `packages/coding-agent/src/core/dialogue/pioneerscript.ts`: bounded literal
  trigger/reply dialect, atomically compiled; no macro, JS, shell, or interpolation.
- `core/dialogue/loop.ts`: synchronous replies, serial FIFO, cancellation barrier,
  replacement priority, 32 pending-job limit, 64 KiB input limit.
- `core/dialogue/agent-worker.ts`: session-scoped bridge using `prompt` and
  `waitForIdle`, preflight cancellation, final text-only projection.
- `modes/interactive/interactive-mode.ts`: input routing, commands, metadata,
  session guards, result delivery, separate drafts, unread count.
- `modes/interactive/chat-viewport.ts` and `components/dialogue-tabs.ts`: fixed
  controls and selected transcript within the existing workspace split.
- Tests: `test/dialogue-*.test.ts`, `test/suite/dialogue-*.test.ts`, and
  `test/chat-viewport.test.ts`, using the faux provider without paid APIs.

All abbreviated code paths above are under `packages/coding-agent/src/`.

## Important limits

This is a local trusted-user prototype. Automatic unmatched-text routing is
appropriate only for the local user's authority. Do not expose this controller
or its session to public OpenClaw messages. Authored replies are instant, but
arbitrary conversation does not have a separate chat model yet.

Queues are volatile; history persists as `pioneer.dialogue.v1` custom session
metadata and does not enter model context. Responses indicate lifecycle completion,
not verified task success. Public/owner authorization, durable jobs, outbox delivery,
process isolation, latency load testing, and OpenClaw compatibility remain pending.
No OpenClaw service was deployed and this handoff has not been sent to Beast.

## Next implementation contract

1. Probe Beast's actual OpenClaw and Pioneer versions. Prove that an ordinary
   inbound message can be consumed before normal model/tool dispatch and can
   receive a delayed reply at its original destination. Report command-only
   compatibility if a general interception hook is unavailable.
2. Extract a portable bounded runtime shared by CLI and OpenClaw adapters. Scripts
   may propose typed actions; host policy alone grants authority. Never enable the
   legacy TypeScript PioneerScript shell/JS macros in this profile.
3. Introduce a private durable broker: signed ingress identity, owner grants,
   SQLite WAL jobs, leases, event sequence numbers, idempotency, and reply outbox.
   Keep public and owner processes, histories, memory, and credentials separate.
4. Supervise isolated CLI RPC workers using registered project IDs and minimal
   environments. Recheck grants at admission, dequeue, privileged effects, resume,
   and delivery. Use `agent_settled` plus recorded task evidence for completion.
5. Public starts with identity/help/published knowledge only. Owner work requires
   a verified private route; an owner speaking in a public room remains public.
   Plugin errors must never fall through to privileged tools. Public users cannot
   discover owner jobs. Worker output is literal data, never new instructions.
6. Test impersonation, script injection, cross-user result leakage, revoke-during-
   queue, duplicate ingress, restart/reconciliation, process-tree cancellation,
   plugin removal, and load while a worker is busy. Report p50/p95/p99 separately
   for dialogue interpretation, durable acknowledgement, and channel delivery.

Use tests-first changes and PRs into alpha. Return built/deployed/verified status
separately, exact hashes/versions, negative-test evidence, and remaining blockers.

## Release and rollback

Pioneer artifact version is independent of upstream workspace versions, in
`scripts/pioneer-package-manifest.mjs`. Build with `scripts/pack-pioneer.mjs`;
verify with `scripts/check-pioneer-install.mjs`. Publish only the Pioneer tarball,
never the upstream workspace packages. The release workflow uses `pioneer-v1.1.1`.

Rollback an installation with `npm install -g --ignore-scripts @pioneer-platform/pioneer-cli@1.1.0`.
Do not delete session history. Registry tag rollback is an owner operation;
published version tarballs remain immutable.

Release evidence and final publication status are recorded in the GitHub release.

## Validation at handoff preparation

- Full `npm run check` passes (format/lint, dependency and import checks, entry
  graphs, install lock, TypeScript, browser smoke).
- All 238 focused Pioneer regressions pass across runs. The five browser-login
  failures under the filesystem/network sandbox pass when the local mock callback
  server is allowed to bind. Dialogue/workspace coverage includes 38 tests.
- Clean tarball installs pass CLI/SDK, codemode, and goal write/read/completion
  checks under Node 26 and the minimum Node 22.19 runtime.
- The installed tarball was exercised in a 160-column terminal outside this
  repository: authored replies during a slow run, F6 switching, unread result
  delivery, and the workspace pane in both views. Source-terminal testing also
  verified queued work and interrupt/replacement ordering.
- The complete offline monorepo suite is being checked separately. Its initial
  sandbox run could not bind local HTTP/Unix sockets. Treat the release's final
  validation record as authoritative for that broader suite.
