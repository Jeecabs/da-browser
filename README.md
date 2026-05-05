# lachlan-aa-pi-extensions

Personal trusted-machine [pi](https://github.com/badlogic/pi-mono) extensions and themes for Lachlan/AA workflows. This repo bundles browser ops, roo process management, tmux cx pairing, Idea Board shared workbench state, Fallow codebase intelligence, Supabase and Linear helpers, GitHub review utilities, Watchtower incoming-change monitoring, Vice City chrome, and the neon **synthwave-84** theme.

**Recommended pi version:** `0.68.1+`

## Install

### Recommended: install as a pi package

**Global** (all projects):

```bash
pi install git:github.com/Jeecabs/pi-extensions
```

**Project-local** (writes to `.pi/settings.json`):

```bash
pi install git:github.com/Jeecabs/pi-extensions -l
```

pi loads this repo through the `pi` manifest in `package.json`, which now explicitly declares both the extension entrypoints and the bundled `themes/` directory.

### Local development: clone into a discovery directory

Use this when actively editing the repo and relying on `/reload` hot-reload.

**Global** (all projects):

```bash
git clone https://github.com/Jeecabs/pi-extensions.git ~/.pi/agent/extensions/pi-extensions
```

**Project-local** (single repo):

```bash
git clone https://github.com/Jeecabs/pi-extensions.git .pi/extensions/pi-extensions
```

Install dependencies:

```bash
cd ~/.pi/agent/extensions/pi-extensions   # or your project-local path
pnpm install
```

Reload pi if already running:

```text
/reload
```

If this repo is installed as a package, do not also copy `themes/synthwave-84.json` into `~/.pi/agent/themes`, or pi will show duplicate themes.

### Quick test (no install)

For a one-off smoke test without auto-discovery:

```bash
pi -e .
```

## What's included

### synthwave-84 theme

A custom pi theme with a stronger Vice City / Miami neon palette and a restrained synthwave mode:

- theme name: `synthwave-84`
- manual install location (only if this repo is **not** already installed as a pi package): `~/.pi/agent/themes/synthwave-84.json`
- theatre mode command: `/vicecity [on|off|status|pause|resume|next|prev]`
- soundtrack helper: `/vicecity song <spotify track url|spotify:track:uri|query>`

`/vicecity on` enables a minimal **WAVE-84** mode, adds a single compact tuner strip above the editor, and automatically starts the default Vice City soundtrack in the local macOS Spotify desktop client.

`/vicecity song ...` overrides the soundtrack. Exact autoplay works with a Spotify track URL or `spotify:track:...` URI; plain text opens Spotify search results in the local client.


### Fallow

Wraps the [Fallow](https://docs.fallow.tools) CLI into pi tools for codebase-level dead-code, duplication, health, and PR audit workflows. Tools default to `--format json` because Fallow recommends JSON for agent workflows.

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `fallow_status` | Show Fallow version and resolved config status |
| `fallow_overview` | Run combined dead-code, duplication, and health analysis |
| `fallow_audit` | Audit changed files for PR quality gates |
| `fallow_dead_code` | Find unused files, exports, deps, cycles, boundary violations, and stale suppressions |
| `fallow_dupes` | Find duplicate code clone groups |
| `fallow_health` | Analyze complexity, hotspots, refactor targets, score, and runtime coverage |
| `fallow_fix` | Preview/apply automatic unused export/dependency cleanup; defaults to dry-run |
| `fallow_list` | Inspect discovered files, entry points, plugins, and boundaries |
| `fallow_explain` | Explain one Fallow issue type with guidance and docs links |

**Command:**

| Command | Description |
|---------|-------------|
| `/fallow status` | Show Fallow version |
| `/fallow audit [base]` | Run `fallow audit --format json` |
| `/fallow dead-code [base]` | Run `fallow dead-code --format json`, optionally changed since base |
| `/fallow dupes` | Run duplication analysis |
| `/fallow health` | Run health analysis |
| `/fallow fix` | Preview automatic cleanup |
| `/fallow fix --apply` | Apply automatic cleanup with `--yes` |
| `/fallow list` | Show discovery info |
| `/fallow config` | Show resolved config path |

**Runtime prerequisite:** `npx` can fetch `fallow`, or set `FALLOW_BIN=/path/to/fallow` to use a local binary.

### roo

Wraps the [roo](https://github.com/Jeecabs/roo) process manager into pi tools so the agent can start background processes and read their logs.

The extension also teaches pi to prefer roo for long-running or inspectable commands. Things like `pnpm run dev`, `npm run dev`, `vite`, `next dev`, tunnels, and watchers should be started with `roo_start`, inspected with `roo_logs`, and stopped with `roo_stop`. Matching long-lived local-process commands are blocked from the built-in `bash` tool so the agent retries with roo instead. Docker/Podman-style workflows are intentionally left alone so the agent can use their native lifecycle and log inspection commands.

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `roo_status` | List all roo-managed processes globally (name, status, pid, uptime, cmd, cwd, log path) |
| `roo_start` | Start a background process (auto-named from command, e.g. `npm run dev` → `dev`) |
| `roo_stop` | Stop a process by name |
| `roo_logs` | Read last N lines of a process's log output |

The status bar shows a yellow dot with the process name when one is running, or a count when multiple are active.

**Runtime prerequisite:** [`roo`](https://github.com/Jeecabs/roo) installed and on `PATH`.

### tmux cx pair

Human-driven two-agent cockpit for local `cx` sessions. The agent can launch a left/right pair in tmux, capture raw pane output, relay targeted messages, inspect health, and stop both sessions.

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `tmux_cx_pair_bootstrap` | Create `<prefix>-left` and `<prefix>-right`, launch `cx`, and send role prompts |
| `tmux_cx_pair_status` | Show tracked or prefixed pair health |
| `tmux_cx_pair_capture` | Capture recent raw output from left, right, or both |
| `tmux_cx_pair_send` | Send a targeted message to left, right, or both |
| `tmux_cx_pair_stop` | Hard-kill both pair sessions |

The status bar shows the active prefix and live session count, e.g. `cx feature-x 2/2`.

**Runtime prerequisites:** `tmux` installed and the local `cx` alias available in tmux shells.

Design notes: [`docs/tmux-cx-pair.md`](docs/tmux-cx-pair.md).

### Idea Board

Shared agent/human workbench state. Pi gets tools for writing concise renderable work products to JSON, and a bundled local viewer renders the board live from project (`.pi/idea-board/state.json`) or global (`~/.pi/agent/idea-board/state.json`) scope.

**Command:**

```text
/idea-board [status|open|reset] [project|global]
```

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `idea_board_set` | Replace the board with a JSON-render component spec |
| `idea_board_append` | Append one component to an existing parent id, creating a default board if needed |
| `idea_board_patch` | Apply targeted set/remove/set-children/set-meta operations |
| `idea_board_open` | Return the local viewer URL |

The tools are explicitly for work products — hypotheses, options, tradeoffs, decisions, questions, todos, handoff notes — not private chain-of-thought. Specs are validated before write: root must exist, root must be `Board`, children must reference existing ids, and cycles are rejected.

### Watchtower

Opt-in git monitor for incoming target-branch changes and dirty-file conflict risk.

**Commands:**

| Command | Description |
|---------|-------------|
| `/watchtower` | Toggle Watchtower on/off |
| `/watchtower on` | Enable polling |
| `/watchtower off` | Disable polling |
| `/watchtower status` | Show branch, target, dirty files, threat, and fetch state |
| `/watchtower refresh` | Fetch and rescan now |
| `/watchtower open` | Open expanded overlay |
| `/watchtower target [ref]` | Show or set watched target branch |
| `/watchtower target auto` | Clear manual target and auto-detect |
| `/upstream` | Compatibility alias for `/watchtower` |

`/watchtower` includes argument autocomplete, including branch/ref suggestions after `target `.

### browser ops

Wraps the `agent-browser` CLI into typed pi tools and commands so the agent can drive a browser natively. Common actions are typed tools; rarer `agent-browser` features are available through `browser_command` with structured args.

**Commands:**

| Command | Description |
|---------|-------------|
| `/browser connect [port]` | Connect to Arc (default port `9222`) |
| `/browser status` | Show connection state |
| `/browser cleanup` | Disconnect and reset state |

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `browser_status` | Check connection state |
| `browser_connect` | Connect to browser |
| `browser_open` | Navigate to a URL |
| `browser_snapshot` | Capture page accessibility snapshot |
| `browser_click` | Click an element |
| `browser_fill` | Fill a form field |
| `browser_select` | Select a dropdown option |
| `browser_press` | Press browser keys like Enter, Tab, Escape, Control+a |
| `browser_scroll` | Scroll the current page |
| `browser_wait` | Wait for a selector/ref or milliseconds |
| `browser_nav` | Go back, forward, or reload |
| `browser_get` | Read text/html/value/attr/title/url/count/box/styles |
| `browser_debug` | Read console logs, page errors, or network requests |
| `browser_command` | Run raw `agent-browser` args with active CDP port prepended |
| `browser_eval` | Evaluate JS in page context |
| `browser_checkpoint` | Save current page state |

### How it works

The extension connects to Arc via Chrome DevTools Protocol (CDP). Arc doesn't expose page targets by default, so the extension automatically creates one — opening a blank tab that inherits your full cookie/auth context. All subsequent commands (`open`, `snapshot`, `click`, etc.) operate on that tab.

### Runtime prerequisites

- [`agent-browser`](https://github.com/nicholasoxford/agent-browser) installed and on `PATH`
- Arc launched with remote debugging:

```bash
roo start --name arc /Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=9222
```

The `/browser connect` command checks for both and tells you what's missing.

### Port override

Default port is `9222`. Override with any of:

- `/browser connect 9333`
- `browser_connect({ port: 9333 })`
- `PI_BROWSER_PORT=9333` env var

## Writing new extensions

Add a new `.ts` file to `src/` or create a subdirectory with an `index.ts`. Then add the path to the `"pi.extensions"` array in `package.json`:

```json
{
  "pi": {
    "extensions": [
      "./src/index.ts",
      "./src/my-new-extension.ts"
    ]
  }
}
```

Extensions export a default function that receives the `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });
}
```

Run `/reload` in pi to pick up changes. See the [pi extension docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) for the full API reference.
