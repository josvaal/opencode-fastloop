# Contributing to opencode-fastloop

Maintainer-facing documentation: development setup, verification workflow, and the npm release process. Consumers do not need anything in this file.

## Development setup

```bash
git clone <repo-url> && cd opencode-fastloop
npm install
npm run build
```

### Installing the local build into OpenCode

Server plugin (symlink survives rebuilds — `dist/` is regenerated in place):

```bash
ln -sf "$PWD/dist/index.js" ~/.config/opencode/plugins/fastloop.js
```

TUI plugin: point `tui.json` at the **source** file, not `dist/tui.js`. OpenCode transpiles local `.tsx` plugins itself, which resolves `solid-js` / `@opentui` from its own runtime; the compiled JS imports `@opentui/solid/jsx-runtime` directly and may not resolve when loaded as a bare local file.

```jsonc
// tui.json
{
  "plugin": ["/absolute/path/to/opencode-fastloop/src/tui.tsx"]
}
```

Restart OpenCode after every change — config and plugins are not hot-reloaded.

## Verification checklist (before every release)

This project's failure modes are mostly **silent**, so the checklist matters:

1. **Compile**: `npm run build` exits clean.
2. **Export shape**: `node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"` — server must export the plugin function + default; the TUI module must default-export `{ id, tui }` (a bare function export fails to load with no error anywhere).
3. **Server loads**: restart OpenCode and confirm `~/.cache/opencode/fastloop/state-*.json` is created for the session's workspace.
4. **Discovery**: `fastloop_verify` (no args) lists the expected sibling repos.
5. **Verdicts are real**: run a repo's typecheck manually and compare counts; `FAILED (N errors, unknown error)` means output capture broke (older Bun-shell bug).
6. **Guard**: ask the agent to run `git status` in a non-git session root → must be blocked with the sibling-repo hint. `git init` / `git clone` must NOT be blocked.
7. **TUI**: chip renders next to the prompt, per-repo list renders in the sidebar footer, `+N ign` appears in warning color when ignore patterns match.
8. **Isolation**: open two workspaces in parallel; each TUI shows only its own repos.
9. **State persistence**: restart OpenCode; the sidebar shows the last verdict, not `idle`.

## Releasing to npm

One-time setup:

```bash
npm login
```

Release flow:

```bash
# 1. Verify the package contents (dist/, README.md, LICENSE)
npm run build
npm pack --dry-run

# 2. Bump (patch/minor/major) — creates a release commit + tag
npm version patch

# 3. Publish (prepublishOnly rebuilds dist/ automatically)
npm publish --access public

# 4. Push the release commit and tag
git push --follow-tags
```

After publishing:

- Consumers switch to the npm entries (`"opencode-fastloop/server"` in `opencode.json`, `"opencode-fastloop/tui"` in `tui.json`).
- Remove the local symlink (`~/.config/opencode/plugins/fastloop.js`) and the `src/tui.tsx` entry from `tui.json` to avoid double-loading: a local plugin and an npm plugin with the same name are both loaded separately.
- The `~/.config/opencode/fastloop.json` config file keeps working as-is; npm options take precedence over it if both are present.

## Design notes for reviewers

- **State transport**: server and TUI halves run in different processes. Communication is a JSON file per workspace root with atomic writes (tmp + rename). Do not replace this with polling-free event wiring without solving cross-process discovery first.
- **Guard philosophy**: it blocks git only when neither the worktree nor the session directory is a git root, and never blocks repo-creating subcommands (`init`, `clone`). It must stay a guard against *silent no-ops*, not a git policy engine.
- **Check commands run via `child_process.exec`**, never Bun's `$` tagged templates — interpolated strings get escaped, mangling composed commands like `npx tsc --noEmit`.
- **API names must be verified against the installed types** (`@opencode-ai/plugin/dist/{tui,index,tool}.d.ts`, `@opentui/core`) before use — the plugin API moves fast and silent load failures are the norm, not the exception.
