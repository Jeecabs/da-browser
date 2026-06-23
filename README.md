# lachlan-aa-pi-extensions

Personal trusted-machine [pi](https://github.com/badlogic/pi-mono) extensions and themes for Lachlan/AA workflows. This repo bundles browser ops, video artifact analysis, roo process management, tmux cx pairing, HTML artifact guidance, Excalidraw diagram generation, Fallow codebase intelligence, Supervisor tripwires, Supabase, Linear, PostHog helpers, GitHub review utilities, Watchtower incoming-change monitoring, Vice City chrome, and the neon **synthwave-84** theme.

**Recommended pi version:** `0.78.1+`

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


### PostHog

Wraps `posthog-cli` for exception reporting and URL-based triage.

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `posthog_query` | Run read/reporting HogQL through `posthog-cli exp query run` |
| `posthog_exceptions` | Rank exception groups by fingerprint/type/message, optionally filtered by URL or route tag text |
| `posthog_exception_urls` | Rank URLs by exception volume and suggest stable `url:*` tags |
| `posthog_exception_tag_report` | Return exception groups with derived URL/route tags for triage reports |

**Command:** `/posthog exceptions [url] | urls | query <hogql>`

Runtime prerequisite: `posthog-cli` on `PATH`, or set `POSTHOG_CLI_BIN`. Query reporting requires a PostHog token with `query:read`; run `posthog-cli login` or set `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID`.

Tags are report labels derived from URLs because PostHog events are immutable. To make tags native in PostHog, send the chosen tag as an event property on future exception capture.

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

### Supervisor

Opt-in Tripwire Ledger supervisor for sanity-checking agent work with low noise. It runs deterministic tripwires on tool calls, accumulates a branch-scoped risk ledger, hard-blocks only critical irreversible actions, and calls a low-thinking isolated pi reviewer only when the risk budget is crossed.

**Commands:**

| Command | Description |
|---------|-------------|
| `/supervisor on` | Enable supervisor for the session/branch |
| `/supervisor off` | Disable supervisor and clear the ledger |
| `/supervisor status` | Show budget, risk, auto-review, intervention, and latest verdict |
| `/supervisor why` | Show current ledger flags |
| `/supervisor open` | Open the right-side Supervisor dock overlay |
| `/supervisor review` | Force a model review now |
| `/supervisor reset` | Clear current ledger |
| `/supervisor budget <n>` | Set the risk budget (default `5`) |
| `/supervisor auto on|off` | Enable/disable model review when budget is crossed |
| `/supervisor intervene on|off` | Enable/disable follow-up messages for confirmed blockers |
| `/ok <rule|all>` | Acknowledge a hard-blocked rule for the current prompt |

Tripwires currently cover dangerous bash (`rm -rf`, `sudo`, force push, destructive SQL, install-script pipes), likely secret writes, `.env` edits, scope drift from explicit path requests, lockfile/migration changes, and test deletion. Failed verification commands are kept as recent-tool evidence for model review without adding risk.

Presentation uses pi-native TUI surfaces: a width-aware risk ribbon above the editor, `/supervisor open` as a right-docked overlay with keyboard controls (`r` review, `a` acknowledge, `A` acknowledge all, `+/-` budget, `f` fix prompt, `i` intervention, `c` clear), a custom renderer for `supervisor-review` messages, a custom working indicator during review, `/ok` rule completions, and `/tree` labels for blocker branches.

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

### Excalidraw

Wraps [`excalidraw-cli`](https://github.com/ahmadawais/excalidraw-cli) so agents can create hand-drawn `.excalidraw` diagrams, export them to excalidraw.com, inspect the element reference, and manage CLI checkpoints.

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `excalidraw_create` | Create a `.excalidraw` diagram from inline JSON, a JSON file, or an existing `.excalidraw` file |
| `excalidraw_export` | Upload a `.excalidraw` file to excalidraw.com and return the share URL |
| `excalidraw_reference` | Show the CLI element format reference |
| `excalidraw_checkpoint` | List, save, load, or remove diagram checkpoints |

**Command:** `/excalidraw ref | create <input> <output> | export <file> | cp <args>`

**Runtime prerequisite:** `npx` can fetch `excalidraw-cli`, or set `EXCALIDRAW_BIN=/path/to/excalidraw` to use a local/global binary.

### HTML Artifacts

One-off visual thinking should use real HTML, not fixed board primitives. Agents write bespoke `.html` files — usually `/tmp/<topic>.html` for disposable sketches or `artifacts/<topic>.html` for repo-owned work — then open them in the browser.

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `html_artifact_open` | Open an HTML artifact in macOS default browser or Arc and return its `file://` URL |
| `html_artifact_publish` | Upload an HTML artifact to Cloudflare R2 with Wrangler and return its public `r2.dev` URL |

**Command:**

| Command | Description |
|---------|-------------|
| `/artifact status` | Check Wrangler/R2 artifact publishing config without printing secrets |

For hosted artifacts, install and authenticate Wrangler:

```bash
npm i -g wrangler
wrangler login
```

Enable public `r2.dev` access for the `pi-artifacts` R2 bucket, then configure the public base URL:

```bash
mkdir -p ~/.pi/agent/config
cat > ~/.pi/agent/config/r2-artifacts.env <<'EOF'
R2_PUBLIC_BASE_URL=https://pub-xxxx.r2.dev
EOF
```

Hard-coded trusted-machine defaults: account `1328473bd418a905a314abc4181a390a`, bucket `pi-artifacts`. Override with `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET`, or `R2_PUBLIC_BASE_URL` environment variables if needed.

Guidance loaded with the tool:

- Prefer standalone HTML artifacts for diagrams, explainer boards, PRD sketches, architecture maps, and other visual work.
- Use normal HTML/CSS/JS/SVG/Canvas freely. Match the medium to the idea: static layout, SVG diagram, canvas sim, or tiny interactive app.
- Cover the design basics: readable typography, a consistent palette, responsive layout, accessible contrast, even spacing, and a clear visual hierarchy.
- Style to fit the artifact's purpose: favor restraint, use system fonts and simple palettes freely, and keep any effects in service of comprehension.
- After writing, call `html_artifact_open` to open it directly. Use `app: "arc"` for Arc or omit for macOS default browser. Verify with `browser_checkpoint` when visual fidelity matters.

### Video and browser artifact analysis

Turns browser recordings into compact, model-readable evidence. Uses local `ffmpeg`/`ffprobe` on `PATH`; override with `FFMPEG_BIN` and `FFPROBE_BIN` if needed. Install with `brew install ffmpeg`.

**Tools (callable by the LLM):**

| Tool | Description |
|------|-------------|
| `browser_artifacts_list` | List recent browser artifacts in the current pi browser artifact directory |
| `video_probe` | Inspect video duration, size, codecs, resolution, FPS, and audio tracks |
| `video_contact_sheet` | Convert a WebM/MP4/MOV/MKV into a visual QA grid, with timestamps when ffmpeg supports `drawtext` |
| `video_extract_frames` | Extract exact frames, usually around suspicious timestamps from a contact sheet |
| `browser_video_review` | Probe the latest browser recording and return a contact sheet |

**Command:** `/video status | latest | probe [path] | sheet [path]`

Common flow after `browser_record stop`:

```text
browser_artifacts_list kind:"recordings"
video_probe path:"last"
browser_video_review path:"last"
```

Use `video_extract_frames timestamps:[12.5, 18.0]` to zoom into contact-sheet tiles.

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
| `browser_tab` | List, open, close, or switch browser tabs |
| `browser_is` | Boolean assertions for `visible`/`enabled`/`checked` |
| `browser_emulate` | Emulate viewport, device, geolocation, offline, or media settings |
| `browser_record` | Start or stop video recording (.webm) of the current context |
| `browser_trace` | Start or stop a Playwright trace (.zip) for the current context |

### How it works

The extension connects to Arc via Chrome DevTools Protocol (CDP). Arc doesn't expose page targets by default, so the extension automatically creates one — opening a blank tab that inherits your full cookie/auth context. All subsequent commands (`open`, `snapshot`, `click`, etc.) operate on that tab.

The controlled tab is marked with a red top border, a `pi agent · <site>` text pill beneath it, and a red favicon, so it's obvious which tab the agent is driving. Disable the marker with `PI_BROWSER_CONTROL_BANNER=0`.

### Connection state & recovery

Each command is a fresh `agent-browser --cdp <port>` process, so "connected" means *the browser is reachable on the port with a usable page target* — not a held socket. The status indicator reflects that honestly:

- `●` connected — verified reachable recently
- `◐` stale — was connected, but not confirmed in the last 5 min
- `○` disconnected — port not listening, or never connected

`/browser status` and the `browser_status` tool actively probe the port (`/json/list`) and report listening state, page-target count, and browser version — trust them over the cached dot.

Recovery is partly automatic: if a command fails because the controlled tab vanished, the extension recreates a page target and retries once. If the browser itself is down, the action fails with the relaunch command instead of a raw CDP error.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Arc is not reachable on CDP port 9222` | Arc quit, crashed, or launched without remote debugging | Relaunch with the command below, then `/browser connect` |
| `The controlled browser tab is gone` (after auto-retry) | The tab was closed or its page context was destroyed | `/browser connect` to open a fresh controlled tab |
| Status shows `◐ stale` | No command has confirmed liveness recently | `/browser status` re-probes and flips it to `●` or `○` |
| Commands act on the wrong tab | agent-browser picks its own target when several tabs are open | Keep the red-bordered controlled tab focused; close stray tabs or re-`/browser connect` |
| `port listening` but `0 page targets` | Browser up but no page target yet | Next action auto-creates one, or `/browser connect` to create + verify |

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

### QA capture example

```text
browser_record({ action: "start", label: "demo" })
# ... drive the page ...
browser_record({ action: "stop" })
```

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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });
}
```

Run `/reload` in pi to pick up changes. See the [pi extension docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) for the full API reference.
