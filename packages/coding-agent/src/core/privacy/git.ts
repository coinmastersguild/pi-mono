import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A deliberate-operation guard. OS isolation, not this wrapper, is the boundary against hostile processes. */
export const GIT_GUARD_SOURCE = `#!/bin/sh
set -eu
deny() { printf '%s\\n' 'Git remotes are disabled. Restart pi with --allow-git-remotes to opt in.' >&2; exit 126; }
scan() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -C|--git-dir|--work-tree) [ "$#" -ge 2 ] || deny; shift 2 ;;
      -c) [ "$#" -ge 2 ] || deny; case "$2" in core.quotepath=*|color.ui=*|user.name=*|user.email=*) shift 2 ;; *) deny ;; esac ;;
      --git-dir=*|--work-tree=*|--no-pager|--paginate|--no-optional-locks|--literal-pathspecs|--no-replace-objects) shift ;;
      --version|--help) return ;;
      -*) deny ;;
      *) break ;;
    esac
  done
  [ "$#" -gt 0 ] || return
  case "$1" in
    config)
      shift
      for value in "$@"; do
        value=$(printf '%s' "$value" | /usr/bin/tr '[:upper:]' '[:lower:]')
        case "$value" in
          remote.*|branch.*.remote|branch.*.pushremote|url.*|include*|protocol.*|alias.*|core.gitproxy|core.sshcommand|core.hookspath|credential.*|http.*|--file|-f|--global|--system|--edit|-e|--rename-section|--remove-section) deny ;;
        esac
      done ;;
    remote) shift; [ "$#" -eq 0 ] || { case "$1" in -v|--verbose|get-url|remove|rm) ;; *) deny ;; esac; } ;;
    add|am|annotate|apply|archive|bisect|blame|branch|cat-file|checkout|cherry|cherry-pick|clean|commit|describe|diff|diff-files|diff-index|diff-tree|for-each-ref|format-patch|fsck|gc|grep|init|log|ls-files|ls-tree|merge|merge-base|mv|notes|reflog|reset|restore|rev-list|rev-parse|revert|rm|show|show-branch|show-ref|sparse-checkout|stash|status|switch|symbolic-ref|tag|update-index|update-ref|verify-commit|verify-tag|whatchanged|worktree) ;;
    *) deny ;;
  esac
}
scan "$@"
export GIT_ALLOW_PROTOCOL=''
export GIT_TERMINAL_PROMPT=0
exec /usr/bin/git "$@"
`;

export async function prepareGitPolicy(root: string, allowRemotes: boolean): Promise<NodeJS.ProcessEnv> {
	if (allowRemotes) return {};
	const bin = join(root, "runtime", "bin");
	const hooks = join(root, "runtime", "empty-hooks");
	await mkdir(bin, { recursive: true, mode: 0o700 });
	await mkdir(hooks, { recursive: true, mode: 0o700 });
	const wrapper = join(bin, "git");
	const temporary = join(bin, `.git-${randomUUID()}`);
	try {
		await writeFile(temporary, GIT_GUARD_SOURCE, { flag: "wx", mode: 0o500 });
		await rename(temporary, wrapper);
	} finally {
		await rm(temporary, { force: true });
	}
	return {
		PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		GIT_ALLOW_PROTOCOL: "",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "protocol.allow",
		GIT_CONFIG_VALUE_0: "never",
		GIT_CONFIG_KEY_1: "core.hooksPath",
		GIT_CONFIG_VALUE_1: hooks,
	};
}

/** Prevent ordinary subprocesses from inheriting host Git configuration overrides. */
export function clearInheritedGitOverrides(environment: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(environment)) {
		if (name.startsWith("GIT_CONFIG") || name === "GIT_ALLOW_PROTOCOL" || name === "GIT_SSH_COMMAND") {
			delete environment[name];
		}
	}
}
