# opencode-fastloop

**Instant typecheck feedback for [OpenCode](https://opencode.ai) agents working across multiple repositories.**

`opencode-fastloop` shortens the distance between *the moment an AI agent breaks your build* and *the moment it finds out*. Instead of discovering type errors minutes later — when the agent declares the task "done" and tests fail — the plugin runs the affected repository's typecheck in the background seconds after every edit, surfaces the verdict in the OpenCode TUI, and gives the agent a verification tool it must call before claiming completion.

Designed for **multi-repo workspaces**: e.g. a parent folder (not a git repo itself) containing an Angular frontend and a NestJS backend as sibling git repositories.

---

## Table of contents

- [Why](#why)
- [What it does](#what-it-does)
  - [1. Watch — background typechecks](#1-watch--background-typechecks)
  - [2. Verify gate — the `fastloop_verify` tool](#2-verify-gate--the-fastloop_verify-tool)
  - [3. Git guard](#3-git-guard)
  - [4. TUI: chip and sidebar list](#4-tui-chip-and-sidebar-list)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Config file (local-directory installs)](#config-file-local-directory-installs)
  - [Plugin options (npm installs)](#plugin-options-npm-installs)
  - [Check command discovery](#check-command-discovery)
  - [Ignoring known-noisy errors](#ignoring-known-noisy-errors)
- [Multi-workspace isolation](#multi-workspace-isolation)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Why

Studies on developer productivity (DORA, DevEx/SPACE) converge on the same finding: the strongest predictor of development efficiency is not how fast code is written, but **how quickly defects are detected after being introduced**. This is amplified when AI agents write the code:

- Fast, inexpensive models (the kind most people run for volume work) have a characteristic failure mode: *declaring a task complete without verifying it*.
- Every turn an agent spends discovering a broken build late is a turn of rework: re-reading context, re-running tools, re-explaining.
- In a fullstack TypeScript setup (NestJS + Angular), contract and convention drift between the two projects is the single most expensive source of rework — and the agent has no built-in signal that it just broke the other side.

`opencode-fastloop` attacks the feedback loop directly, because that is the lever a plugin can actually move. It embodies one principle: **fail fast, in seconds, where the work just happened.**

## What it does

The plugin has two halves: a **server plugin** (hooks + custom tool, runs in the OpenCode server process) and a **TUI plugin** (renders live UI, runs in the TUI renderer process). They coordinate through a state file on disk, scoped per workspace.

### 1. Watch — background typechecks

On every `file.edited` event, the plugin determines which discovered repository owns the edited file, and schedules a debounced typecheck of that repository (default 800 ms; concurrent checks for the same repo are coalesced). The result is written to a state file that the TUI reads.

### 2. Verify gate — the `fastloop_verify` tool

A custom tool registered into OpenCode. It runs the typecheck of one repo (or all repos) synchronously and returns a structured pass/fail summary, including error samples and ignored-error counts. Pair it with a rule in your `AGENTS.md`:

```markdown
- You MUST call `fastloop_verify` before claiming a coding task is complete.
```

This turns "I think I'm done" into "I verified I'm done".

### 3. Git guard

Multi-repo workspaces usually have a plain parent folder that is **not** a git repository. When an OpenCode session is opened there, agent-run `git` commands silently operate on nothing. The guard hooks `tool.execute.before` and blocks any `git` command in that situation, telling the agent which sibling repositories exist instead.

The guard only activates when neither the session worktree nor the session directory is a git root — it never interferes with legitimate repos.

### 4. TUI: chip and sidebar list

- A compact chip next to the session prompt: `● ok` / `● 3 err` / `◌ check`, colored with the active theme's `success` / `error` / `textMuted` tokens.
- A per-repository list in the sidebar footer:

```
fastloop
● gym      ok
● server   ok   +3 ign
```

The `+N ign` count (warning color) shows errors matched by your `ignore` patterns — signal that the filter is doing work, without failing the check.

All colors are read from `api.theme.current.*` (RGBA) at render time: the UI respects any theme and dark/light mode. Nothing is hardcoded.

## Architecture

```
┌────────────────────────────┐        file.edited events
│  Server plugin (fastloop)  │──────────────────────────────┐
│  - repo discovery          │                              │
│  - debounced typechecks    │      writes                  ▼
│  - fastloop_verify tool    │  state-<hash>.json    ~/.cache/opencode/fastloop/
│  - git guard               │────────────────────── (one file per workspace root)
└────────────────────────────┘                              │
                                                            │ polled every 800 ms
┌────────────────────────────┐                              │
│  TUI plugin (fastloop-chip)│◄─────────────────────────────┘
│  - prompt chip             │  matches the file whose `root`
│  - sidebar repo list       │  equals this session's worktree/directory
└────────────────────────────┘
```

Key decisions:

- **File transport, not events**: the server plugin and TUI plugin run in different processes; a small JSON file with atomic writes (tmp + rename) is simpler and more robust than inventing a bus.
- **One state file per workspace root** (hashed filename): parallel OpenCode sessions in different workspaces never overwrite each other. Sessions in the *same* workspace share the file deliberately — the state is a fact about the repository, not about the session.
- **Repo discovery prefers sibling folders that are git repos** (with a `package.json`); plain `package.json` folders are used only as a fallback. This avoids treating `mcp/`, `tests/` or build artifacts as projects.
- **Typecheck command**: the first of `typecheck`, `type-check`, `check`, `tsc` scripts found in the repo's `package.json`, else `npx tsc --noEmit`. Per-repo override available. Note: `tsc --noEmit` does not check Angular component templates; add a `typecheck` script running the Angular compiler if you want template coverage.

## Installation

**Prerequisites:** OpenCode running under Bun; a truecolor terminal for accurate chip colors.

### From npm (once published)

```bash
# opencode.json
{
  "plugin": ["opencode-fastloop/server"]
}

# tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-fastloop/tui"]
}
```

Restart OpenCode (config is not hot-reloaded).

### From local files (development / pre-publish)

Server plugin: symlink or copy the built file into the global plugins directory:

```bash
npm run build
ln -sf "$PWD/dist/index.js" ~/.config/opencode/plugins/fastloop.js
```

TUI plugin: point `tui.json` at the source file (OpenCode transpiles local `.tsx` plugins itself, which resolves `solid-js` / `@opentui` from its runtime — more reliable than loading the compiled `dist/tui.js` for local development):

```jsonc
// tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/opencode-fastloop/src/tui.tsx"]
}
```

Restart OpenCode.

## Configuration

The plugin has three option sources, in precedence order (later wins):

1. Config file — `~/.config/opencode/fastloop.json` (always available)
2. npm plugin options — `["opencode-fastloop/server", { ... }]` (requires the npm package to resolve)

> **Important:** options only flow through npm package entries. Plugins auto-loaded from the plugin directory receive **no** options — that is what the config file exists for.

Schema (both sources accept the same fields):

| Field | Type | Default | Description |
|---|---|---|---|
| `commands` | `Record<string, string>` | auto-discovered | Per-repo typecheck command override, keyed by repo folder name. |
| `ignore` | `string[]` | `[]` | Regex-source strings matched against full error lines. Ignored lines are counted and reported but do not fail the check. |
| `debounceMs` | `number` | `800` | Debounce window for `file.edited`-triggered checks. |

### Config file (local-directory installs)

`~/.config/opencode/fastloop.json`:

```json
{
  "commands": { "server": "npx tsc --noEmit -p tsconfig.build.json" },
  "ignore": ["apps/shared/.*"],
  "debounceMs": 800
}
```

Malformed fields are skipped (never crash the plugin); unknown fields are ignored.

### Plugin options (npm installs)

```jsonc
// opencode.json
{
  "plugin": [
    ["opencode-fastloop/server", {
      "commands": { "api": "tsc --noEmit -p tsconfig.build.json" },
      "ignore": ["apps/shared/.*"],
      "debounceMs": 800
    }]
  ]
}
```

### Check command discovery

Per repository, `fastloop` picks the first available `package.json` script:

1. `typecheck`
2. `type-check`
3. `check`
4. `tsc`

Falls back to `npx tsc --noEmit`. Recommended: add an explicit `typecheck` script to each repo's `package.json` — for Angular frontends, make it run the Angular compiler for template coverage:

```json
{
  "scripts": {
    "typecheck": "ng build --configuration development 2>&1 | tail -n 20"
  }
}
```

### Ignoring known-noisy errors

`ignore` patterns are JavaScript regex sources tested against each full error line. Typical uses: read-only submodules, vendored code, known-flaky spec files.

```
Total: 11 errors → ignore: ["apps/shared/.*"] → report: 8 real errors, 3 ignored
```

If only ignored errors remain, the repository reports `ok` with the ignored count surfaced in the TUI and in `fastloop_verify` output. A command that fails with no parseable output still reports an error (never a silent pass).

## Multi-workspace isolation

State lives in `~/.cache/opencode/fastloop/state-<sha256-12 of root>.json`:

- **Different workspaces** → different files. Two OpenCode instances working in parallel each display their own repositories; nothing is overwritten across workspaces.
- **Same workspace, multiple sessions** → shared file, by design. The state is a fact about the repository ("the typecheck has 6 errors"), not about the session. Writes are atomic (tmp + rename) so concurrent sessions never corrupt the file.
- On startup, the plugin **carries over** the last verdict of known repos instead of resetting to `idle`, so re-opening a session shows the last known state. Transient `checking` states never survive a restart.

## Requirements

- OpenCode (server + TUI plugin runtimes)
- Bun runtime (plugins execute inside OpenCode's Bun process)
- Node-compatible `child_process` (used internally for typecheck execution)
- Truecolor terminal (`COLORTERM=truecolor`) for accurate chip colors

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Chip never appears | TUI plugin failed to load | TUI plugin modules must default-export `{ id, tui }` — a bare function export fails **silently**. Check `tui.json` paths; look for errors in the TUI process logs. |
| `fastloop_verify` finds no repos | Session opened at a path with no discoverable repos | Open OpenCode in the workspace parent folder, or set `commands` + verify the root is a folder containing git-repo siblings with `package.json`. |
| `FAILED (N errors, unknown error)` | Typecheck produced no parseable error lines | Run the repo's command manually; upgrade to a version using `child_process.exec` (older versions passed composed commands through Bun's shell, which mangles them). |
| Unknown top-level key error at startup | `tui.json` / `opencode.json` schemas are strict and separate | TUI keys belong in `tui.json`, server keys in `opencode.json`. Escape hatches: `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_PURE=1`. |
| Wrong workspace shown in the chip/sidebar | Ancestor match picked a broader root | The TUI matches the deepest root that is an ancestor of the session path; open the session inside the workspace itself for exact matching. |

Debug logging from the server plugin side can be inspected in the OpenCode log (`~/.local/share/opencode/log/opencode.log`).

## Development

```bash
npm install
npm run build
```

Maintainers: see [CONTRIBUTING.md](./CONTRIBUTING.md) for the release and publishing workflow.

## License

MIT — see [LICENSE](./LICENSE).
