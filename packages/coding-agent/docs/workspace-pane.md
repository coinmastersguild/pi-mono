# Live workspace pane

Fullscreen terminals at least 100 columns wide show chat on the left and a live workspace on the right. Narrow terminals retain the full chat. Use `/files off` to hide the pane, `/files on` to restore it, `Alt+E` to focus it, arrows to browse, Enter to expand folders, and Escape to return to chat. The shortcuts are configurable as `app.workspace.focus` and `app.workspace.toggle`.

`/files all`, `changes`, `hidden`, and `ignored` select tree filters. Click the filter labels or files directly. The mouse wheel scrolls the tree independently of chat. `.pi`, `.pioneer`, and agent instruction files receive control markers. Arrow selection shows changed line ranges; clicking a file or pressing Enter opens its code diff in the right pane.

Diffs show old/new line numbers, red deletions, green additions, and three unchanged context lines beside edits. Long unchanged sections become clickable `... N unchanged lines ...` rows; click again to collapse them. Use the wheel, arrows, or Page Up/Down to scroll, and left/right arrows to pan long lines. Enter toggles the selected context row. Escape or the `‹ Files` header returns to the tree at its previous position. Open diffs refresh as disk changes arrive. Clean files show their code; new files show added lines. Private, ignored, binary, and linked files remain metadata-only. Source previews are bounded to 256 KiB, Git patches to 1 MiB, and displayed content to 20,000 rows, with explicit limit messages.

Counts combine staged and unstaged changes against HEAD, plus bounded untracked text-file counts. Pure renames do not count every line as rewritten. Binary, oversized, unreadable, and private untracked files are explicitly uncounted. Ignored files are excluded from Git totals. The recent feed describes observed disk events; “during agent run” indicates timing, not proof that the agent performed a write.

Private markers are filename/location heuristics, not a secret detector. They cover common credential directories, `.env`, key files, and authentication files. Private files have metadata-only inspection. Quality checks exclude them, ignored files, symlinks, generated/minified files, and lockfiles. No file content enters the quality analytics request.

## Quality and rule packs

The pane runs the workspace's installed Biome without `--write`, using its existing configuration. A second strict pass treats warnings as failures and defaults to:

- [suspicious/noExplicitAny](https://biomejs.dev/linter/rules/no-explicit-any/javascript/)
- [complexity/noExcessiveCognitiveComplexity](https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/javascript/)

Strict results and ordinary lint counts are separate because their rules can overlap. The pane reports violations; it does not block agent tools or change the repository's CI configuration. `/files quality` or clicking the quality heading expands findings. Exact repeated blocks use eight nonempty, whitespace-trimmed lines and a minimum of 180 characters. They are review hints, not semantic duplication detection.

Install a reviewed rule pack at `.pi/quality-rules.json`:

```json
{
  "version": 1,
  "rules": [
    "suspicious/noExplicitAny",
    "complexity/noExcessiveCognitiveComplexity"
  ]
}
```

Downloaded rule packs use this same format. Only 1–32 Biome rule identifiers are accepted, with a 16 KiB file limit. They cannot specify shell commands, plugin code, remote URLs, or automatic fixes. Unsupported rules and invalid packs produce an unavailable-check result. The installed Biome version determines rule behavior; this repository pins 2.3.5.

Checks cover up to 32 changed JS/TS/JSON source files, each at most 128 KiB. Excluded counts are visible. Results are scoped to that sample, not the entire repository. Scans debounce for one second and skip unchanged file timestamps. Tree scans cap entries at 12,000 and directory watchers at 128, with a 2.5-second polling fallback and 180 ms filesystem-event debounce. The pane reports when the tree is capped.

## Analytics backends

- `/files core`: local Pioneer Core, the default.
- `/files alpha`: optional Alpha analytics at `https://alpha.pioneers.dev/api/v1/analytic`, using the existing Pioneer login or `PIONEER_API_KEY`/`PIONEER_JWT`.
- `/files local`: filesystem, lint, strict rules, and duplication checks only.

Set `PIONEER_QUALITY_BACKEND=core|alpha|local` for the initial selection. There is no automatic backend fallback. Only numeric counts and fixed scope labels are sent: no source, filenames, prompts, comments, or lint message text. “Review probability” is an advisory estimate of whether the measured findings need review, not a correctness or security score. Model output never changes permissions or suppresses deterministic findings.

Core requests use loopback discovery and an approved `PIONEER_CORE_AGENT_TOKEN_FILE`, deny redirects, and respect the vault lease. Locked/denied access pauses requests until `/files refresh`; queue or evaluator failures are shown without invented results. The client expects Core's `answers` map of numeric probabilities, which differs from Alpha's typed answer objects. Automatic approval pickup awaits the Core API contract; approving a request alone does not make its token available to this client.

The older context-analytics extension (`--analytic`, `PIONEER_ANALYTIC_ENABLED`, or existing key-based activation) is separate from this pane. Its retrieval and tool-triage traffic is not controlled by `/files` backend selection.

## Shared Core knowledge

`/core` checks the current grants. Native `core_memory_search` and `core_memory_save` tools use explicit namespaces and Core's permission checks. Saves require source and author fields and create new keys; existing records are not silently overwritten. Searches return sourced evidence, never new instructions. No conversation capture, automatic memory ingestion, credential retrieval, or external broker execution is added.
