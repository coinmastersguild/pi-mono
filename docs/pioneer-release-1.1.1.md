# Pioneer CLI 1.1.1

Package: `@pioneer-platform/pioneer-cli`; command: `pioneer`.
Requires Node.js 22.19 or newer. Run with Node even when installing through Bun.

This release integrates the fast Conversation/Thinking workflow with the current
fullscreen file explorer and diff viewer. F6 switches the left transcript; the
workspace pane remains visible at widths of 100 columns or more. Background work
can be queued, interrupted, replaced, or cancelled while local scripted dialogue
remains responsive. Final assistant text is forwarded to Conversation.

See [dialogue.md](dialogue.md) for commands and [workspace-pane.md](workspace-pane.md)
for filesystem controls. The source handoff is `docs/BEAST-HANDOFF.md`.

Existing Pioneer features remain included: browser login, optional encrypted
sessions and projects, Core memory/analytics, Alpha analytics, Office assignments,
goal mode, and bounded working context. Normal operation leaves encryption off.
Private storage uses the macOS vault runtime; it is encryption at rest, not a
restriction on model or analytics network requests. See [privacy.md](privacy.md),
[goals.md](goals.md), and [compaction.md](compaction.md).

The local dialogue dialect has no executable macros and loads only bundled rules.
This release does not implement the public/owner broker or an OpenClaw plugin.
Pending dialogue jobs are not restored after exit. Completion means a response
arrived, not that the task passed verification.

Pioneer is versioned independently from its bundled upstream workspaces.
`scripts/pack-pioneer.mjs` builds the only npm artifact intended for publication;
`scripts/check-pioneer-install.mjs` verifies it outside the source repository.
The dedicated `pioneer-v1.1.1` workflow publishes with npm trusted publishing.
Publication status must be confirmed from npm and the GitHub release evidence.
