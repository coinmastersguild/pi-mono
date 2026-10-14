# Pioneer goals

Goal mode keeps working after an interim model reply until the model reports
completion, a blocker, or the run stops. Enable it explicitly inside Pioneer:

```text
/goal Fix the file reader and prove the fix with a regression test
/goal status
/goal pause
/goal resume
/goal cancel
```

One goal belongs to the current session branch. The objective, progress summary,
verification evidence, status, and model-turn counts are saved with the session.
The footer and goal widget show its current state. Cancel an unfinished goal
before starting a different one; completed goals can be replaced directly.

## Turn limits and interruptions

The default limit is 20 model turns per run, including turns that call tools.
Choose a different limit when starting, or adjust the current goal while idle:

```text
/goal start --turns 40 Fix and test the file reader
/goal limit 60
```

Limits range from 1 to 1,000. Reaching the limit pauses the goal; it does not mark
the work complete. `/goal resume` starts a fresh run budget and preserves total
turns and progress. This is a turn limit, not a token or monetary budget. A final
acknowledgement after completion or a blocker is outside the active goal budget.

Escape, `/goal pause`, and `/goal cancel` stop the current run using the normal
agent cancellation mechanism. A running tool must honor cancellation or finish
before the process becomes idle. A model error pauses the goal. Restarting,
reloading, resuming a session, or navigating the session tree restores active
goals paused; use `/goal resume` to continue deliberately. `/goal status` and
other control commands do not make model requests.

## Progress and completion

The model uses the typed `goal_update` tool to record a progress summary,
completion, or a blocker. Updates must name the current goal ID. The tool cannot
create goals, resume them, replace them, or update paused goals.

Completion requires nonempty verification evidence, such as a command and its
result. Evidence is a model report, not an independent proof that an arbitrary
objective is satisfied; inspect the recorded checks and artifacts. A blocker
must explain the missing input, permission, or external change. The goal stays
blocked until the user resumes it.

Goal mode uses the tools and permissions already enabled for the session. It
requires `goal_update`; if an explicit tool allowlist excludes it, add
`--tools +goal_update`. Pioneer analytics keeps the tool in its selected loadout.
Goal mode does not authorize commits, publication, or broader filesystem access.

## Storage and integrations

Goal data is stored as session entries, with no separate plaintext goal file.
`pioneer --private` encrypts it with session history at rest. An ephemeral
`--no-session` run keeps goal state in memory only. Compaction can shorten the
conversation while retaining the saved goal state; later continuations inject
the current objective and progress again.

The CLI loads goal mode as a built-in extension. SDK clients can include
`createPioneerGoalExtension` in their extension factories and inspect session
entries with `readPioneerGoal`. `--no-extensions` disables built-in goal mode.

Office inbox monitoring remains separate. Receiving an Office event or a file
change does not automatically create or resume a goal. Maintenance mode can use
this lifecycle for event-driven work in a subsequent phase.
