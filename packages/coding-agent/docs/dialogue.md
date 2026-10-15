# Conversation, Thinking, and files

Pioneer keeps a fast Conversation tab and the full agent transcript in Thinking.
In fullscreen mode, both share the left pane; the live file explorer and diffs
stay on the right. Use a terminal at least 100 columns wide. Run
`pioneer --tui-mode fullscreen` or change the mode in `/settings`.

F6 switches tabs and preserves each editor draft. Results appear in Conversation
without taking focus from Thinking; an unread count marks new replies. Alt+E
focuses the file explorer; Escape returns to the editor. `/files on` shows it.

| Input | Behavior |
| --- | --- |
| `hello`, `status`, `help` | Immediate authored replies in Conversation |
| Other ordinary text | Queues agent work in the default auto mode |
| `/dialog chat` | Keeps ordinary Conversation input local |
| `/dialog auto` | Restores automatic work routing |
| `/chat [message]` | Opens Conversation; optional message stays local |
| `/think` | Opens Thinking; ordinary input there always requests work |
| `/work <task>` or `/queue <task>` | Explicitly queues background work |
| `/interrupt <replacement>` | Cancels active work, waits for it to stop, then runs the replacement before queued jobs |
| `/cancel` | Cancels active work and pauses the queue |
| `/pending`, `/resume-work`, `/drop-queue` | Inspects, resumes, or discards pending jobs |

Alt+Enter queues work. Alt+Up restores queued jobs into the editor. Existing
slash commands and shell commands retain their behavior. Conversation-only mode
applies to ordinary text; explicit `/work`, shell, and extension commands still
run with the local user's permissions.

Only one dialogue job runs at a time. Completion waits for the agent's lifecycle,
including tools, extension continuations, retries, and compaction. The displayed
response is assistant text; it is not proof that a task succeeded. Inspect the
Thinking transcript and verification evidence when needed.

Conversation history is stored as session metadata, outside model context.
Queues are in memory and are not restored after exit. Session navigation is
blocked while dialogue work remains; cancel and discard it explicitly first.

The local script supports bounded literal triggers and authored replies. It does
not load arbitrary brains or execute PioneerScript macros. This release is a
local trusted-user UI. It is not an OpenClaw public-user security boundary.

## Offline demo from source

From the repository root, with Node.js 22.19 or newer:

```sh
PI_CODING_AGENT_DIR="$(mktemp -d /tmp/pioneer-dialogue.XXXXXX)" \
PI_OFFLINE=1 PIONEER_QUALITY_BACKEND=local PIONEER_ANALYTIC_ENABLED=0 \
./pi-test.sh --no-env --tui-mode fullscreen --no-extensions --no-skills \
  --no-context-files --no-prompt-templates --no-themes --no-tools \
  -e packages/coding-agent/examples/extensions/dialogue-demo.ts \
  --provider dialogue-demo --model local
```

Choose “Do not trust (this session only)” at the project-resource prompt. The
explicit demo extension still loads. Type `/work demo`, then `hello` and `status`
while it streams. Press F6 and verify that files remain visible. Queue another
job, interrupt it, and check that the final response returns to Conversation.

The demo uses a local fake provider, no tools, and no provider API calls.
