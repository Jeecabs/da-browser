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

The package declares its extensions and themes in `package.json` under `"pi"`, so pi picks them up automatically.

### Quick test (no install)

To try the extension without placing it in a discovery directory:

```bash
pi -e ./src/index.ts
```

## What's included

### synthwave-84 theme

A custom pi theme with a stronger Vice City / Miami neon palette:

- theme name: `synthwave-84`
- install location for manual use: `~/.pi/agent/themes/synthwave-84.json`
- optional editor chrome command: `/vicecity [on|off|status]`

`/vicecity on` enables an optional pseudo-glow editor treatment using a custom editor border. This is a terminal approximation, not a true blur/glow effect.


### roo

Wraps the [roo](https://github.com/Jeecabs/roo) process manager into pi tools so the agent can start background processes and read their logs.

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
