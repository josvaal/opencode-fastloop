/**
 * opencode-fastloop — server plugin.
 *
 * Shortens the error-to-detection loop in multi-repo workspaces:
 *  1. Watch: on `file.edited`, debounced typecheck of the repo owning the file.
 *     Results are written to a state file the TUI chip reads.
 *  2. Verify gate: custom `fastloop_verify` tool so the agent can prove a
 *     repo compiles before claiming completion.
 *  3. Git guard: blocks git commands when the session root is NOT a git repo
 *     (e.g. a parent folder holding two sibling git repos).
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { exec } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve, sep } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepoStatus = "idle" | "checking" | "ok" | "error"

export interface RepoState {
  status: RepoStatus
  errors: number
  ignored: number
  lastRun: number | null
  durationMs: number | null
  command: string | null
  lastErrorSample: string | null
}

export interface FastloopState {
  root: string
  repos: Record<string, RepoState>
  updatedAt: number
}

interface RepoConfig {
  name: string
  dir: string
  command: string
}

interface FastloopOptions {
  /** Per-repo check command override, e.g. { "api": "tsc --noEmit -p tsconfig.build.json" } */
  commands?: Record<string, string>
  /** Regex-source strings; error lines matching any of these are ignored
   *  (counted as `ignored`, do not fail the check). Matched against the full
   *  error line, e.g. "apps/shared/.*" for a read-only submodule. */
  ignore?: string[]
  /** Debounce window in ms (default 800). */
  debounceMs?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateDir(): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(cache, "opencode", "fastloop")
}

// One state file per workspace root so parallel sessions in different
// workspaces do not overwrite each other (last-writer-wins bug).
function stateFilePath(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12)
  return join(stateDir(), `state-${hash}.json`)
}

function writeState(state: FastloopState): void {
  const file = stateFilePath(state.root)
  mkdirSync(stateDir(), { recursive: true })
  // Atomic write: multiple sessions can share one workspace state file;
  // tmp + rename avoids a concurrent reader seeing a torn/truncated JSON.
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, file)
}

function readState(root: string): FastloopState | null {
  try {
    return JSON.parse(readFileSync(stateFilePath(root), "utf8")) as FastloopState
  } catch {
    return null
  }
}

function pickCheckCommand(pkgScripts: Record<string, string> | undefined): string | null {
  if (!pkgScripts) return null
  for (const name of ["typecheck", "type-check", "check", "tsc"]) {
    if (typeof pkgScripts[name] === "string") return `npm run --silent ${name}`
  }
  return null
}

function discoverRepos(root: string, overrides: Record<string, string> | undefined): RepoConfig[] {
  const withPkg: RepoConfig[] = []
  const withGitAndPkg: RepoConfig[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
  } catch {
    return []
  }
  for (const name of entries) {
    const dir = join(root, name)
    const pkgPath = join(dir, "package.json")
    if (!existsSync(pkgPath)) continue
    let command: string | null = overrides?.[name] ?? null
    if (!command) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
        command = pickCheckCommand(pkg.scripts)
      } catch {
        command = null
      }
    }
    if (!command) command = "npx tsc --noEmit"
    const repo: RepoConfig = { name, dir, command }
    withPkg.push(repo)
    // A sibling folder that is itself a git repo is a strong "project" signal;
    // prefer those over plain package.json folders (mcp/, tests/, etc.).
    if (existsSync(join(dir, ".git"))) withGitAndPkg.push(repo)
  }
  return withGitAndPkg.length > 0 ? withGitAndPkg : withPkg
}

function repoForFile(repos: RepoConfig[], filePath: string): RepoConfig | null {
  const abs = resolve(filePath)
  for (const repo of repos) {
    if (abs.startsWith(repo.dir + sep)) return repo
  }
  return null
}

function sampleError(output: string): string | null {
  const lines = output
    .split("\n")
    .filter((l) => /error/i.test(l))
    .slice(0, 3)
    .map((l) => l.trim().slice(0, 160))
  return lines.length > 0 ? lines.join("\n  ") : null
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

// Local plugins loaded from the plugin directory receive NO options (options
// only flow through npm package entries). To stay config-driven without
// hardcoding, the plugin also reads ~/.config/opencode/fastloop.json.
// Precedence: npm options (when published) override the file.
function readConfigFile(): FastloopOptions {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  const file = join(configDir, "opencode", "fastloop.json")
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    const parsed: FastloopOptions = {}
    if (raw.commands && typeof raw.commands === "object" && !Array.isArray(raw.commands)) {
      parsed.commands = raw.commands as Record<string, string>
    }
    if (Array.isArray(raw.ignore) && raw.ignore.every((p) => typeof p === "string")) {
      parsed.ignore = raw.ignore as string[]
    }
    if (typeof raw.debounceMs === "number" && raw.debounceMs >= 0) {
      parsed.debounceMs = raw.debounceMs
    }
    return parsed
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const FastloopPlugin: Plugin = async (input, options) => {
  const opts: FastloopOptions = { ...readConfigFile(), ...((options ?? {}) as FastloopOptions) }
  const debounceMs = opts.debounceMs ?? 800
  const worktree = input.worktree
  const directory = input.directory

  // When the session opens in a plain folder (no .git), `worktree` can resolve
  // to "/" and repo discovery finds nothing. Prefer the deepest root that
  // actually yields repos: worktree first, then the session directory.
  let root = worktree
  let repos = discoverRepos(worktree, opts.commands)
  if (repos.length === 0 && directory && directory !== worktree) {
    const fromDir = discoverRepos(directory, opts.commands)
    if (fromDir.length > 0) {
      root = directory
      repos = fromDir
    }
  }

  // Guard is active only when git commands have no valid repo anywhere:
  // neither the worktree nor the session directory is a git root.
  const isGitRoot =
    existsSync(join(worktree, ".git")) || (directory ? existsSync(join(directory, ".git")) : false)

  const ignoreRes = (opts.ignore ?? [])
    .map((pattern) => {
      try {
        return new RegExp(pattern)
      } catch {
        return null
      }
    })
    .filter((re): re is RegExp => re !== null)

  // Carry over the last verdict of known repos across restarts: fresh state
  // starts at "idle", but a persisted status for the same repo is preserved
  // (except "checking", which is a transient state and cannot survive a
  // restart — it degrades to the previous idle/ok/error nothing, so reset).
  const previous = readState(root)
  const previousRepos =
    previous && previous.root === root && previous.repos ? previous.repos : {}

  const state: FastloopState = {
    root,
    repos: Object.fromEntries(
      repos.map((r) => {
        const prev = previousRepos[r.name]
        if (prev && prev.status !== "checking") {
          return [r.name, { ...prev, command: r.command } satisfies RepoState]
        }
        return [
          r.name,
          { status: "idle", errors: 0, ignored: 0, lastRun: null, durationMs: null, command: r.command, lastErrorSample: null } satisfies RepoState,
        ]
      }),
    ),
    updatedAt: Date.now(),
  }
  writeState(state)

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()

  async function runCheck(repo: RepoConfig): Promise<void> {
    if (running.has(repo.name)) return // coalesce: latest state wins on next edit
    running.add(repo.name)
    state.repos[repo.name] = {
      ...(state.repos[repo.name] ?? ({} as RepoState)),
      status: "checking",
      lastRun: Date.now(),
    }
    state.updatedAt = Date.now()
    writeState(state)

    const started = Date.now()
    let ok = false
    let output = ""
    try {
      // child_process exec (not Bun $): Bun's tagged templates escape
      // interpolated strings, which mangles a composed command like
      // "npx tsc --noEmit" into a single quoted argument.
      output = await new Promise<string>((resolvePromise) => {
        exec(
          repo.command,
          { cwd: repo.dir, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => {
            ok = !err
            resolvePromise(String(stderr ?? "") + String(stdout ?? ""))
          },
        )
      })
    } catch (err) {
      ok = false
      output = String(err)
    }

    state.repos[repo.name] = verdictFromOutput(repo, output, ok, started)
    state.updatedAt = Date.now()
    writeState(state)
    running.delete(repo.name)
  }

  function scheduleCheck(repo: RepoConfig): void {
    const existing = timers.get(repo.name)
    if (existing) clearTimeout(existing)
    timers.set(
      repo.name,
      setTimeout(() => {
        timers.delete(repo.name)
        void runCheck(repo)
      }, debounceMs),
    )
  }

  // Applies ignore patterns: error lines matching any regex are counted as
  // `ignored` and do not fail the check. A command that exits 0 is always ok.
  function verdictFromOutput(
    repo: RepoConfig,
    output: string,
    commandOk: boolean,
    started: number,
  ): RepoState {
    const allLines = output.split("\n").filter((l) => /error/i.test(l))
    const keep = (l: string) => !ignoreRes.some((re) => re.test(l))
    const realLines = allLines.filter(keep)
    const ignored = allLines.length - realLines.length
    const tsMatches = realLines.join("\n").match(/error TS\d+/g)
    const errors = realLines.length === 0 ? 0 : tsMatches ? tsMatches.length : realLines.length
    const status: RepoStatus = errors > 0 ? "error" : "ok"
    return {
      status,
      errors,
      ignored,
      lastRun: Date.now(),
      durationMs: Date.now() - started,
      command: repo.command,
      lastErrorSample: status === "ok" ? null : sampleError(realLines.join("\n")),
      // Preserve the "command failed but produced no parseable output" case.
      ...(status === "ok" && !commandOk && errors === 0 && allLines.length === 0
        ? { status: "error" as RepoStatus, errors: 1, lastErrorSample: "command failed with no output" }
        : {}),
    }
  }

  async function verifyAll(repoName?: string): Promise<string> {
    const targets = repoName
      ? repos.filter((r) => r.name === repoName)
      : repos
    if (targets.length === 0) return `No repos with package.json found under ${root}.`
    const lines: string[] = []
    for (const repo of targets) {
      await runCheck(repo)
      const s = state.repos[repo.name]
      const ignoredNote = s.ignored > 0 ? `, ${s.ignored} ignored` : ""
      lines.push(
        s.status === "ok"
          ? `${repo.name}: OK (${s.durationMs}ms${ignoredNote}, \`${s.command}\`)`
          : `${repo.name}: FAILED (${s.errors} errors${ignoredNote}, \`${s.command}\`)\n  ${s.lastErrorSample ?? "unknown error"}`,
      )
    }
    return lines.join("\n")
  }

  return {
    tool: {
      fastloop_verify: tool({
        description:
          "Run the typecheck command of one repo or all repos in the workspace and report pass/fail. " +
          "You MUST call this before claiming a coding task is complete.",
        args: {
          repo: tool.schema.string().optional().describe("Repo directory name to verify. Omit to verify all."),
        },
        async execute(args) {
          return { output: await verifyAll(args.repo) }
        },
      }),
    },

    "tool.execute.before": async (evt, output) => {
      if (isGitRoot) return
      if (evt.tool !== "bash") return
      const command = String(output.args?.command ?? "")
      if (!/^\s*git(\s|$)/.test(command)) return
      // These subcommands create or fetch a repository; they are exactly how
      // a non-git workspace gains valid repos. Never block them.
      if (/^\s*git\s+(init|clone)\b/.test(command)) return
      throw new Error(
        `fastloop: "${command.trim().slice(0, 60)}" was blocked — the session root "${root}" is NOT a git repository. ` +
          `This workspace contains sibling git repos: ${repos.map((r) => r.name).join(", ") || "(none found)"}. ` +
          `Run git commands inside a specific repo instead.`,
      )
    },

    event: async ({ event }) => {
      if (event.type !== "file.edited") return
      const file = (event.properties as { file?: string } | undefined)?.file
      if (!file) return
      const repo = repoForFile(repos, file)
      if (!repo) return
      scheduleCheck(repo)
    },
  }
}

export default FastloopPlugin
