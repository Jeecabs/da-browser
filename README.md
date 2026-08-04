# da browser

Private [pi](https://github.com/badlogic/pi-mono) package for browser-control tools powered by [`agent-browser`](https://github.com/vercel-labs/agent-browser).


## Install

### HTTPS install

Use the HTTPS URL for the private GitHub repo:

```bash
pi install https://github.com/Jeecabs/da-browser
```

If GitHub auth is not wired into Git yet:

```bash
gh auth login
gh auth setup-git
```

### Git shorthand install

```bash
pi install git:github.com/Jeecabs/da-browser
```

### Local development

```bash
git clone https://github.com/Jeecabs/da-browser.git ~/.pi/agent/extensions/da-browser
cd ~/.pi/agent/extensions/da-browser
pnpm install
```

Reload pi if already running:

```text
/reload
```

## Runtime prerequisites

- `agent-browser` 0.33.1 or newer on `PATH`
- Arc/Chromium launched with a remote debugging port, default `9222`

Install or upgrade the CLI:

```bash
npm install -g agent-browser@latest
```

The extension checks this minimum on session start and before every browser action. The extension accepts newer compatible versions. `/browser status` and `browser_status` show the installed version and required minimum.

Useful Arc launch command:

```bash
open -na "Arc" --args --remote-debugging-port=9222
```

Override defaults:

- `/browser connect 9333`
- `browser_connect({ port: 9333 })`
- `PI_BROWSER_PORT=9333`

## Commands

| Command | Description |
| --- | --- |
| `/browser connect [port]` | Connect to Arc/Chromium through CDP |
| `/browser status` | Probe connection, page targets, browser version, artifacts |
| `/browser cleanup` | Disconnect/reset browser state for the session |

## Tools

| Tool | Description |
| --- | --- |
| `browser_status` | Probe live debugging port and artifact locations |
| `browser_connect` | Connect to browser auth context |
| `browser_open` | Navigate to a URL |
| `browser_snapshot` | Capture page accessibility snapshot |
| `browser_read` | Fetch markdown/llms-aware text, or read active tab |
| `browser_click` | Click by `@ref` |
| `browser_find` | Locate by role/text/label/testid/CSS and act |
| `browser_fill` | Fill an input by `@ref` |
| `browser_select` | Select dropdown option by `@ref` |
| `browser_press` | Press keys like Enter, Tab, Escape, Control+a |
| `browser_scroll` | Scroll page or container |
| `browser_wait` | Wait for selector/ref/text/url/load/fn/ms |
| `browser_nav` | Back, forward, reload, or SPA pushstate |
| `browser_get` | Read text/html/value/attr/title/url/count/box/styles/cdp-url |
| `browser_debug` | Read console logs, page errors, network requests |
| `browser_har` | Capture network traffic and response bodies as HAR |
| `browser_command` | Run raw `agent-browser` args with active CDP port |
| `browser_eval` | Evaluate JS in page context |
| `browser_tab` | List/open/close/switch tabs |
| `browser_is` | Boolean visible/enabled/checked assertions |
| `browser_set` | Configure viewport/device/geo/offline/media/headers/credentials |
| `browser_record` | Start/stop WebM recording |
| `browser_trace` | Start/stop Playwright trace zip |
| `browser_checkpoint` | Save screenshot + interactive snapshot |
| `browser_react` | Inspect React tree/fibers/renders/Suspense |
| `browser_a11y` | Run embedded axe-core accessibility audits |
| `browser_vitals` | Measure web vitals and React hydration timing |

## Development

```bash
pnpm install
pnpm check
pnpm test
```

## Notes

- Browser refs (`@e12`) come from the latest snapshot and go stale after DOM mutations.
- `browser_find` always acts. Use `browser_snapshot`/`browser_get` to inspect without mutation.
- `/browser status` and `browser_status` actively probe the port. Trust them over cached state.
- CDP actions use a dedicated daemon session and explicitly clear `AGENT_BROWSER_ALLOWED_DOMAINS`. agent-browser cannot install domain/WebRTC containment on pre-existing browser pages. Explicit-URL `browser_read` calls still support `allowedDomains`.
- If the controlled tab disappears, commands recreate a page target and retry once.
- The artifact directory is `/tmp/da-browser/<cwd-slug>`.
- HAR artifacts can contain cookies, authorization headers, and response bodies. Inspect before sharing.
