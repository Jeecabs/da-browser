# pi-extensions

Custom [pi](https://github.com/badlogic/pi-mono) extensions and themes. Currently ships **pi-browser-ops** — a first-class browser automation harness built on `agent-browser` and Arc's auth context — plus a neon **synthwave-84** theme.

## Install

### 1. Clone into a pi extension directory

pi auto-discovers extensions from two locations. Pick one:

**Global** (all projects):

```bash
git clone https://github.com/Jeecabs/pi-extensions.git ~/.pi/agent/extensions/pi-extensions
```

**Project-local** (single repo):

```bash
git clone https://github.com/Jeecabs/pi-extensions.git .pi/extensions/pi-extensions
```

### 2. Install dependencies

```bash
cd ~/.pi/agent/extensions/pi-extensions   # or your project-local path
pnpm install
```

### 3. Reload pi

If pi is already running:

```
/reload
```

The package declares its extensions in `package.json` under `"pi"`, and pi auto-discovers the top-level `themes/` directory. If you're installing this repo as a package, don't also copy `synthwave-84.json` into `~/.pi/agent/themes`, or pi will show it as a duplicate.

### Quick test (no install)

To try the extension without placing it in a discovery directory:

```bash
pi -e ./src/index.ts
```

## What's included

### synthwave-84 theme

A custom pi theme with a stronger Vice City / Miami neon palette and a more theatrical synthwave mode:

- theme name: `synthwave-84`
- manual install location (only if this repo is **not** already installed as a pi package): `~/.pi/agent/themes/synthwave-84.json`
- theatre mode command: `/vicecity [on|off|status|pause|resume|next|prev]`
- soundtrack helper: `/vicecity song <spotify track url|spotify:track:uri|query>`

`/vicecity on` enables the animated neon chrome, switches pi into **WAVE-84** radio mode, adds an analog tuner strip above the editor, shows a now-spinning deck widget with an animated playback-linked meter below the editor, and automatically starts the default Vice City soundtrack in the local macOS Spotify desktop client.

`/vicecity song ...` overrides the soundtrack. Exact autoplay works with a Spotify track URL or `spotify:track:...` URI; plain text opens Spotify search results in the local client.

> Note: the deck meter is synced to Spotify playback state/track timing available via AppleScript. It is not a true audio-spectrum readout from Spotify.


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

### pi-browser-ops

Wraps the `agent-browser` CLI into typed pi tools and commands so the agent can drive a browser natively.

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

Run `/reload` in pi to pick up changes. See the [upstream extension docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) for the full API reference.
