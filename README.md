# pi-bash-sandbox

OS-level sandboxing for [pi](https://pi.dev/)'s `bash` tool, using
[bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`).

> [简体中文](README.zh-CN.md)

- **Per-project, stateless.** Every command resolves its own policy and spawns a
  fresh `bwrap`. No long-lived sandbox process, no global singletons.
- **Filesystem, network, and environment control** via a user-editable
  `sandbox.json`, merged from global + project layers.
- **Also gates the built-in file tools** (`read` / `write` / `edit` /
  `grep` / `find` / `ls`), which do not run inside `bwrap`.
- **Fail-closed** by default: if `bwrap` is unavailable, commands error instead
  of silently running unsandboxed.

## Requirements

- Linux (including WSL2) with `bwrap` installed.
- bubblewrap **≥ 0.4** (developed and tested against 0.9.0).
- Unprivileged user namespaces enabled.

```bash
# Debian / Ubuntu
sudo apt install bubblewrap
# Fedora / RHEL
sudo dnf install bubblewrap
# Arch
sudo pacman -S bubblewrap
```

On Ubuntu 24.04+ AppArmor restricts unprivileged user namespaces. If the probe
reports `userns=false`, see `weakerNestedSandbox` below.

macOS and Windows are not supported for OS-level isolation. On those platforms
the probe fails and, with the default `onUnavailable: "error"`, commands are
refused. Set `onUnavailable: "fallback"` to run unsandboxed instead.

## Install

```bash
# Try it without installing
pi -e /path/to/pi-bash-sandbox

# Install as an extension (from a git source)
pi install git:github.com/<you>/pi-bash-sandbox
```

Verify inside a session:

```
/sandbox
```

## Quick start

Create `~/.pi/agent/sandbox.json` (global) or `<project>/.pi/sandbox.json`
(project):

```json
{
  "enabled": true,
  "network": "none",
  "filesystem": {
    "allowWrite": [".", "/tmp"],
    "denyWrite": ["~/.ssh", ".env", ".env.*", "*.pem", "*.key"],
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"]
  },
  "tmp": "private",
  "tools": { "enabled": true, "requireAllowWrite": true }
}
```

With no config at all, these built-in defaults apply. Note the default
`network: "none"` blocks `git push`, `pnpm install`, `curl`, etc. Set
`"network": "host"` if you need outbound access.

## How it works

```
LLM calls the bash tool
        │
        ▼
createBashToolDefinition(cwd, { operations })   ← reuse pi's pipeline
        │  exec(command, cwd, { onData, signal, timeout, env })
        ▼
SandboxedBashOperations
        ├─ resolveProjectRoot(cwd)               → project root (worktrees merged)
        ├─ loadSandboxConfig(...)                → merge + expand + trust gate
        ├─ probeBwrap()                          → cached capability probe
        ├─ buildBwrapArgs(...)                   → pure argv builder
        └─ spawn(bwrap, argv)                    → streaming, process-group kill
```

The `bash` tool is overridden by name; pi's built-in renderers, truncation,
streaming updates, and timeout handling are reused. `!` / `!!` user commands are
routed through the same operations via the `user_bash` event.

### Mount order (bwrap)

Later mounts cover earlier ones, so the order is significant:

```
--ro-bind / /                        read-only host root
--dev /dev
--tmpfs /tmp                         (tmp: private) before allowWrite, or it shadows projects under /tmp
--bind <allowWrite> <allowWrite>     writable paths
--ro-bind <denyWrite> <denyWrite>    read-only self-bind: content readable, writes fail
--tmpfs <denyRead dir> --remount-ro  empty and read-only
--ro-bind /dev/null <denyRead file>  content hidden
--unshare-net                        network: none
--unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
--unshare-user --cap-drop ALL
--proc /proc
--chdir <cwd>
-- <shell> -c <command>
```

`--clearenv` plus explicit `--setenv` means the sandbox starts from a clean
environment; only the whitelisted variables exist inside.

## Configuration

### Locations and precedence

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/sandbox.json` (respects `PI_CODING_AGENT_DIR`) |
| Project | `<project>/.pi/sandbox.json` (only when the project is trusted) |

Merging order: **built-in defaults ← global ← project**. Array fields *override*
rather than concatenate, so a project can drop a global rule. `env.set` merges
per key. For linked worktrees, the worktree's own `.pi/sandbox.json` is used when
present, otherwise the main checkout's.

`enabled` follows the same layering: set it globally to change the default for
every project, or in a project config to override just that project.
`/sandbox-enable` and `/sandbox-disable` write it for you.

### Schema

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch |
| `network` | `"none"` \| `"host"` | `"none"` | `none` adds `--unshare-net` |
| `filesystem.allowWrite` | string[] | `[".", "/tmp"]` | Writable paths (everything else is read-only) |
| `filesystem.denyWrite` | string[] | `["~/.ssh", ".env", ".env.*", "*.pem", "*.key"]` | Read-only paths |
| `filesystem.denyRead` | string[] | `["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"]` | Hidden paths |
| `tmp` | `"private"` \| `"shared"` | `"private"` | `private` mounts an empty `/tmp` |
| `env.passthrough` | string[] | `["PATH","HOME","TERM","LANG","LC_*","TMPDIR","PI_*"]` | Variables kept from pi's env (globs allowed) |
| `env.deny` | string[] | `["*_KEY","*_TOKEN","*_SECRET","*_PASSWORD","ANTHROPIC_*","OPENAI_*"]` | Variables removed (wins over passthrough) |
| `env.set` | object | `{}` | Variables forced to a value |
| `unsharePid` | boolean | `true` | Isolate pid/ipc/uts/cgroup namespaces |
| `weakerNestedSandbox` | boolean | `false` | Bind host `/proc` instead of mounting a fresh one (for containers without `CAP_SYS_ADMIN`) |
| `onUnavailable` | `"error"` \| `"fallback"` | `"error"` | What to do when `bwrap` is unusable |
| `extraBwrapArgs` | string[] | `[]` | Appended verbatim before `--`. Powerful and risky |
| `tools.enabled` | boolean | `true` | Gate `read`/`write`/`edit`/`grep`/`find`/`ls` via `tool_call` |
| `tools.requireAllowWrite` | boolean | `true` | `write`/`edit` targets must be inside `allowWrite` |

Path rules support `~` expansion, relative paths (resolved against the command
cwd), and globs (`*`, `?`, `**`). A bare relative pattern such as `.env` or
`*.pem` matches by basename. Rules that match nothing are skipped — `bwrap` can
only bind paths that exist, and the tool policy matches the raw patterns, so
`.env.*` protects files created later too.

### Tool policy semantics

`read` / `grep` / `find` / `ls` are blocked when their `path` (default: cwd)
matches a `denyRead` rule. `write` / `edit` are blocked on `denyRead` or
`denyWrite`, and by default must land inside `allowWrite`. Set
`tools.requireAllowWrite: false` to relax the containment check while keeping the
deny lists.

## Commands

| Command | Description |
|---|---|
| `/sandbox` | Show the resolved config, config sources, and bwrap status |
| `/sandbox-test <command>` | Dry-run: print the exact bwrap argv without executing |
| `/sandbox-why <path>` | Explain how a path is treated (which rules match, bash vs tool policy) |
| `/sandbox-init` | Create a `.pi/sandbox.json` template in the current project |
| `/sandbox-enable [project\|global]` | Write `enabled: true` (default scope: project) |
| `/sandbox-disable [project\|global]` | Write `enabled: false` (default scope: project) |
| `/sandbox-reload` | Clear all caches (config, probe, project, settings) |
| `--no-sandbox` | Disable both the bash sandbox and the tool policy for this session |

## Security model and limitations

**What is isolated**

- `bash` and `!` / `!!` user commands run inside bwrap mount/pid/net/user
  namespaces with a clean environment.
- `read` / `write` / `edit` / `grep` / `find` / `ls` are gated by a `tool_call`
  policy using the same rules (this is policy, not OS isolation).

**Known limitations**

- **Project-to-project reads.** `--ro-bind / /` means any project can read any
  other unless you add it to `denyRead`. Use explicit `denyRead` entries or a
  minimal-root configuration for stronger isolation.
- **The tool policy is best-effort.** It blocks the built-in file tools, but a
  custom extension tool or the pi-web web terminal / file browser is not covered.
- **Interactive TTY commands** (vim, htop) are not supported inside the sandbox.
- **Heavy globs.** Path/glob rules are re-expanded on every command so newly
  created files are picked up immediately. A recursive pattern like `**/*.pem`
  walks the tree per command; prefer targeted patterns.
- **`extraBwrapArgs` is a loaded gun.** It is appended verbatim.

## Development

```bash
pnpm install
pnpm test        # unit + real-bwrap integration (auto-skips without bwrap)
pnpm run check   # tsc --noEmit
pnpm run all     # check + test
```

| Path | Purpose |
|---|---|
| `src/config.ts` | Config discovery, layering, validation, path expansion |
| `src/project.ts` | cwd → project root / worktree root |
| `src/bwrap.ts` | Pure `buildBwrapArgs` |
| `src/env.ts` | Environment allow/deny matching |
| `src/probe.ts` | bwrap availability and capability detection |
| `src/exec.ts` | `SandboxedBashOperations` |
| `src/policy.ts` | `tool_call` policy for the built-in file tools |
| `src/config-write.ts` | Config writes for `/sandbox-init` and enable/disable |
| `src/settings.ts` | Reads `shellCommandPrefix` / `shellPath` from pi settings |
| `src/ui.ts` | `/sandbox` output |

Integration tests exercise real `bwrap` and skip automatically when it is not
available, so the suite stays green on machines without it.

## License

MIT
