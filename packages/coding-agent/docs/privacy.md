# Pioneer privacy modes

Encryption is off by default. Run `pioneer` normally to work in the current project
with normal plaintext agent state. Git remotes still require `--allow-git-remotes`.

| Command | Code and local Git | Agent history, logs, credentials, local memory |
| --- | --- | --- |
| `pioneer` | Plaintext | Plaintext |
| `pioneer --private` | Normal project files | Encrypted at rest |
| `pioneer --private --encrypt-workspace` | Encrypted copy | Encrypted at rest |

## Create projects

```sh
pioneer create my-project
pioneer create --private private-history-project
pioneer create --private --encrypt-workspace encrypted-project
```

The guided Pioneer Guild setup captures purpose, success criteria, project type,
service ports, and the first milestone. It creates architecture documents,
`docs/planning/STATE.json`, a draft spec, sprint/milestone plans, a handoff, and local
Git. Deployment scripts begin unconfigured and fail until implemented. Setup runs
no build, deployment, commit, or remote publication. `pioneer setup` adds missing
Guild files to existing projects while preserving and reporting existing files.

Private projects use their own `.pioneer/vault` and a minimal workspace locator.
Pioneer discovers this locator on subsequent starts and prompts for the password.
With private history, source files and generated project documents remain in the
normal project directory. With an encrypted workspace, source and Git exist only
inside the encrypted image; the outer directory contains the locator and
`PIONEER.txt`. Existing fully protected projects retain their encryption.

## Private history with normal code

`pioneer --private` unlocks an encrypted agent-state vault without copying or
moving the project. The password screen leaves piped prompt/RPC input intact.
Sessions, credentials, pi-owned logs, private memory, supported caches, and scratch
files use the encrypted volume. Tools can read/write the ordinary project.
Code files, tool-created logs in the project, exports, and terminal output are
not encrypted by this mode. The macOS write sandbox permits the project and vault;
tools expecting writable locations elsewhere may need their paths configured.

For an existing ordinary project, the default private-history vault is
`private-history-vault` beside the configured agent directory. Choose an explicit
location with `--private --vault-dir /path/to/vault`. Private mode refuses explicit
`--session`/`--session-dir` destinations outside its managed history; use
`--resume` or `--continue`. Old plaintext sessions are not automatically moved.

## Encrypted workspace and migration

Add `--encrypt-workspace` to opt into an encrypted project copy. Imports verify
files, file modes, relative symlinks, and source stability. External/absolute
symlinks, linked Git worktrees, and alternate object stores must be made
self-contained first. Originals remain plaintext and are never deleted. Changes
in the encrypted copy are not synchronized back to the originals.

Manual vault commands remain available:

```sh
pioneer vault init
pioneer vault import /path/to/project
pioneer vault import-state /path/to/old/agent
pioneer vault list
pioneer --workspace <id>
pioneer vault password
pioneer vault lock
```

For a private-history vault, prefix management commands with `--private`, or run
them from a private project's directory. State import refuses to overwrite an
already populated destination. Imported JSONL sessions are retargeted to matching
imported projects and original bytes retained as encrypted `.imported` backups.
Experimental database paths are not rewritten. Remote Core memory is not migrated.

## Core and Alpha integrations

Normal sessions expose explicitly granted local Pioneer Core memory search/save
and typed analytics tools. Core uses local loopback discovery and a scoped token
file supplied through `PIONEER_CORE_AGENT_TOKEN_FILE`; it has no cloud fallback.
Run `/core` to check grants. Private sessions save/search project findings in local
encrypted memory instead of sending those findings to Core.

Alpha analytics uses `https://alpha.pioneers.dev/api/v1/analytic` with an environment
or saved Pioneer login credential. It helps tool selection and retrieves prior
session/code/Guild evidence, with lexical fallback on failure. Core tools remain
available through analytic tool selection. `PIONEER_ANALYTIC_ENABLED=0` disables
automatic analytics; `--analytic` explicitly enables it. `PI_OFFLINE=1` prevents
Alpha requests. Run `/analytic-status` to inspect status and fallback counters.
At-rest encryption does not prevent configured model/analytics requests from
transmitting context.

## Locking and limits

Encryption currently requires macOS and a controlling terminal. One password
unlocks a project's encrypted state and, when selected, its encrypted code. The
APFS sparse bundle uses AES-256; a random disk key is wrapped using scrypt and
AES-256-GCM. Image encryption is verified before mounting. Passwords and disk keys
are not passed in process arguments or environment variables. Key-envelope
authentication does not provide authenticated integrity for every disk block.

Normal exit unmounts the vault. Abrupt termination can leave it mounted: wait for
the 30-second lease expiry, close processes using its files, and run `pioneer vault
lock`. Unmount is never forced. There is no idle auto-lock or password recovery.
Back up the image and `key.json` together while locked. Changing a password does
not invalidate old key-file backups, which still use the old password.

Protection is at rest. Processes under the same macOS account can read an unlocked
mount. Root, terminal recordings, process memory, OS swap/crash captures, remote
services, original plaintext copies, and external application data are outside
this boundary. The SDK does not automatically start the private CLI runtime.

## Test kit

From `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/privacy.test.ts test/privacy-onboarding.test.ts test/pioneer-projects.test.ts test/suite/file-io.test.ts test/suite/pioneer-integrations.test.ts
PI_TEST_NATIVE_VAULT=1 node ../../node_modules/vitest/dist/cli.js --run test/privacy-macos.test.ts
```

The native test uses a disposable macOS image and checks local Git, write
confinement, lock/unlock persistence, wrong-password rejection, and absence of a
plaintext canary in encrypted image bands. Harness tests use the faux provider and
consume no provider tokens.
