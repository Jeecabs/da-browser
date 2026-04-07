# pi-extensions

Custom [pi](https://github.com/badlogic/pi-mono) extensions. Currently ships **pi-browser-ops** — a first-class browser automation harness built on `agent-browser` and Arc's auth context.

## Install

### 1. Clone into a pi extension directory

pi auto-discovers extensions from two locations. Pick one:

**Global** (all projects):

```bash
git clone git@github.com:Jeecabs/pi-extensions.git ~/.pi/agent/extensions/pi-extensions
```

**Project-local** (single repo):

```bash
git clone git@github.com:Jeecabs/pi-extensions.git .pi/extensions/pi-extensions
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

The extension entry point is declared in `package.json` under `"pi": { "extensions": ["./src/index.ts"] }`, so pi picks it up automatically.

### Quick test (no install)

To try the extension without placing it in a discovery directory:

```bash
pi -e ./src/index.ts
```

## What's included

### pi-browser-ops

Wraps the `agent-browser` CLI into typed pi tools and commands so the agent can drive a browser natively.

**Commands:**

| Command | Description |
|---------|-------------|
| `/browser connect [port]` | Connect to Arc (default port `9222`) |
| `/browser status` | Show connection state |
| `/browser cleanup` | Tear down session and remove auth artifacts |

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

### Runtime prerequisites

- [`agent-browser`](https://github.com/nicholasoxford/agent-browser) installed and on `PATH`
- Arc launched with remote debugging:

```bash
/Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=9222
```

The `/browser connect` command checks for both and tells you what's missing.

### Port override

Default port is `9222`. Override with any of:

- `/browser connect 9333`
- `browser_connect({ port: 9333 })`
- `PI_BROWSER_PORT=9333` env var

### Security note

The auth export file is written to `/tmp/pi-browser-ops/.../arc-auth.json` (plaintext session data). It is automatically deleted on `session_shutdown` or `/browser cleanup`.

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
