<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md).

# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Pi packages](docs/packages.md) and share via npm or git.

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way.

Use Pi [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Pi TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

On Windows:

```shell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

The installer pins all dependencies and updates Pi with `pi update`. Alternatively, install directly with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @pioneer-platform/pioneer-cli
```

Pi requires Node.js 22.19 or newer. The macOS, Linux, and Windows installers can install it if needed. Pi does not require dependency lifecycle scripts for a normal npm installation.

On macOS and Linux, Nix users can install the latest release with `nix profile add github:earendil-works/pi/stable`. See the [quickstart](docs/quickstart.md#1-install-pi) for updating and pinning releases.

Start Pioneer in the directory where you want it to work:

```bash
cd /path/to/project
pioneer
```

To create a project, run `pioneer create test-workspace` from its parent directory.
The guided Pioneer Guild setup creates architecture, planning state, a draft spec,
and local Git. Add `--private` for encrypted agent state or `--encrypt-workspace` for encrypted code too. Use `pioneer setup` to guide setup
of an existing project while preserving its files.

Encryption is off by default. `pioneer --private` encrypts history, logs,
credentials, and local memory while writing normal code files. Add
`--encrypt-workspace` to encrypt the project too. Private encryption currently
requires macOS. Local Git works; remotes require `--allow-git-remotes`.
See [privacy modes](docs/privacy.md) for setup, migration, and recovery.

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Pioneer GLM and browser sign-in

The Pioneer launcher (`pioneer`, or `./pi-test.sh` in this checkout) loads this repository's `.env` and preserves your working directory. Set `PIONEER_API_KEY` there for automatic authentication. Explicit shell credentials take precedence. Pioneer `auto` routes to Alpha's GLM backend and is the preferred default when no saved or explicit model is selected.

Run `/login`, select Pioneer, and choose browser sign-in. The browser opens Alpha's keys page; connect your wallet and select **Connect Pi** to authorize a dedicated CLI key. Pi receives and validates the key through a temporary loopback callback and saves it in its credential store. The Alpha server must include the CLI handoff page. Remote terminals can paste a key instead.

Use `/model` or `--provider pioneer --model auto` to select Pioneer explicitly. Other providers and their subscriptions remain available through `/login` and `/model`.

### Pioneer goal mode

Use `/goal <objective>` to run a persistent goal with progress and verification
evidence. `/goal status`, `/goal pause`, `/goal resume`, and `/goal cancel` control
it. Runs default to 20 model turns; `/goal start --turns 40 <objective>` changes
the limit. Goals restore paused after restarting and follow session encryption.
See [goal mode](docs/goals.md) for limits, storage, and SDK usage.

### Pioneer Office cooperation

Configure `pioneer-office` in the native `~/.pi/agent/mcp.json` with the host's `/mcp` URL and a scoped Office agent bearer token. Alpha inference credentials and Office agent credentials are separate. The agent must have a roster identity and membership in `general`; chat and task cooperation uses `chat:read`, `chat:send`, `chat:write`, and `tasks:write`.

Pi connects on startup and long-polls its inbox while it is open. `/office` shows connection status; `/office inbox` lists messages and assignments. `/office accept <cursor>` explicitly hands an assignment to the running model. Previously accepted work requires `/office resume <cursor>` after a restart. Incoming messages alone never start model turns. Ask the agent to use Office MCP to read channels, send messages, delegate tasks, or report results.

Inbox data lives under the agent directory's `office-inbox/`. Events and the cursor are saved together before notification. Only one Pi process consumes an identity's inbox at a time; provision separate Office identities and agent directories for independent agents. `--no-mcp` disables the connection. The native integration replaces the old `pi-mcp-adapter` package; do not load both.

### Pioneer Analytic decision support

Pioneer CLI includes an opt-in decision layer for fast typed scoring. It narrows large tool catalogs, retrieves relevant prior-session and code context, selects applicable guild guidance, prioritizes files for deeper review, and adds a semantic check to deterministic tool guardrails.

Set a Pioneer credential and enable the extension:

```bash
export PIONEER_API_KEY="..."
export PIONEER_ANALYTIC_ENABLED=1
pi --analytic
```

The default endpoint is `https://alpha.pioneers.dev/api/v1/analytic`. Override it with `PIONEER_ANALYTIC_URL` for development. `--analytic-mode shadow` records selections and warnings without changing the active tool set or blocking actions; `assist` applies selections and guardrails.

Use `/analytic-status` to inspect request/fallback counters and `/analytic-scan [objective]` to produce a code-review priority list. Analytic results are triage signals: tests, static checks, existing permissions, and human approval rules remain authoritative. If the endpoint is unavailable, retrieval and tool discovery fall back to local lexical ranking.

## Share your OSS coding agent sessions

If you use Pi for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) using a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish Pi sessions
- Published Pi development sessions: [`badlogicgames/pi-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## Development

Clone the repository, install its dependencies, and run Pi from source:

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
