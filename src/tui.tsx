/** @jsxImportSource @opentui/solid */
/**
 * opencode-fastloop — TUI plugin.
 *
 * Renders a live status chip next to the session prompt reflecting the
 * typecheck state maintained by the server plugin (state.json):
 *   ● ok       green  — all checks passing
 *   ● N err    red    — last check had N type errors
 *   ◌ wait     muted  — check in flight / no data yet
 *
 * Colors always come from api.theme.current (RGBA) so the chip respects
 * the active theme and dark/light mode.
 */
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { FastloopState } from "./index.js"

const POLL_MS = 800

function stateDir(): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(cache, "opencode", "fastloop")
}

/**
 * Pick the state file belonging to THIS TUI session's workspace. Server
 * plugins write one state-<hash>.json per workspace root. Match by the
 * stored `root` field against the session worktree/directory; fall back to
 * the closest ancestor (handles sessions opened in a parent folder).
 */
function loadState(worktree: string, directory: string): FastloopState | null {
  let files: string[] = []
  try {
    files = readdirSync(stateDir()).filter((f) => f.startsWith("state-") && f.endsWith(".json"))
  } catch {
    return null
  }
  const candidates = [worktree, directory].filter(Boolean).map((p) => resolve(p))
  let best: { state: FastloopState; depth: number } | null = null
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(stateDir(), file), "utf8")) as FastloopState
      if (!parsed?.root || !parsed.repos) continue
      const root = resolve(parsed.root)
      const depth = root.split("/").length
      const isAncestorOrSelf = candidates.some((c) => c === root || c.startsWith(root + "/"))
      if (!isAncestorOrSelf) continue
      // Prefer the deepest matching root (most specific workspace).
      if (!best || depth > best.depth) best = { state: parsed, depth }
    } catch {
      continue
    }
  }
  return best?.state ?? null
}

interface ChipView {
  token: "success" | "error" | "textMuted"
  dot: string
  label: string
}

function chipView(state: FastloopState | null): ChipView {
  if (!state || Object.keys(state.repos).length === 0) {
    return { dot: "◌", token: "textMuted", label: "idle" }
  }
  const repos = Object.values(state.repos)
  if (repos.some((r) => r.status === "checking")) {
    return { dot: "◌", token: "textMuted", label: "check" }
  }
  const totalErrors = repos.reduce((acc, r) => acc + (r.status === "error" ? r.errors : 0), 0)
  if (totalErrors > 0) {
    return { dot: "●", token: "error", label: `${totalErrors} err` }
  }
  if (repos.every((r) => r.status === "ok")) {
    return { dot: "●", token: "success", label: "ok" }
  }
  return { dot: "◌", token: "textMuted", label: "idle" }
}

export const FastloopTuiPlugin: TuiPlugin = async (api: TuiPluginApi) => {
  // This session's workspace scope: only read state files under it, so two
  // opencode instances in different workspaces never show each other's data.
  const worktree = api.state.path.worktree
  const directory = api.state.path.directory
  const [state, setState] = createSignal<FastloopState | null>(loadState(worktree, directory))

  const timer = setInterval(() => setState(loadState(worktree, directory)), POLL_MS)
  api.lifecycle.onDispose(() => clearInterval(timer))

  const Chip = () => {
    const view = () => chipView(state())
    // TuiThemeCurrent tokens are RGBA objects (not callables); pass directly.
    const color = () => api.theme.current[view().token]
    return (
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <text fg={color()}>{view().dot}</text>
        <text fg={api.theme.current.textMuted}>fastloop</text>
        <text fg={color()}>{view().label}</text>
      </box>
    )
  }

  const repoColor = (status: string) =>
    status === "ok"
      ? api.theme.current.success
      : status === "error"
        ? api.theme.current.error
        : api.theme.current.textMuted

  const repoDot = (status: string) =>
    status === "ok" || status === "error" ? "●" : "◌"

  const repoLabel = (r: { status: string; errors: number }) => {
    if (r.status === "ok") return "ok"
    if (r.status === "error") return `${r.errors} err`
    if (r.status === "checking") return "check"
    return "idle"
  }

  const RepoList = () => {
    const repos = () => Object.entries(state()?.repos ?? {})
    return (
      <box flexDirection="column" paddingLeft={1}>
        <text fg={api.theme.current.textMuted}>fastloop</text>
        {repos().map(([name, r]) => (
          <box flexDirection="row" gap={1}>
            <text fg={repoColor(r.status)}>{repoDot(r.status)}</text>
            <text fg={api.theme.current.text}>{name}</text>
            <text fg={repoColor(r.status)}>{repoLabel(r)}</text>
            {r.ignored > 0 && (
              <text fg={api.theme.current.warning}>+{r.ignored} ign</text>
            )}
          </box>
        ))}
      </box>
    )
  }

  // TuiSlotPlugin has `id?: never` — registration is identified by slot shape.
  // Compact chip next to the prompt; per-repo list in the sidebar footer.
  api.slots.register({
    order: 0,
    slots: {
      session_prompt_right: Chip,
      sidebar_footer: RepoList,
    },
  })
}

const plugin = { id: "fastloop-chip", tui: FastloopTuiPlugin }
export default plugin
