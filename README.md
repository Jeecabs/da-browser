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

- `agent-browser` 0.38.1 or newer on `PATH`
- Arc/Chromium launched with a remote debugging port, default `9222`
- `ffmpeg` on `PATH` for `browser_record` (`brew install ffmpeg`); `agent-browser doctor` reports it

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
- `DA_BROWSER_INPUT_MODE=smooth|human` moves the pointer along real paths for every action in the session

## Commands

| Command | Description |
| --- | --- |
| `/browser connect [port]` | Connect to Arc/Chromium through CDP |
| `/browser status` | Probe connection, page targets, browser version, artifacts |
| `/browser cleanup` | Disconnect/reset browser state for the session |

## Tools

| Tool | Description |
| --- | --- |
| `browser_status` | Probe live CDP state plus strict session/target binding diagnostics |
| `browser_connect` | Connect a strictly tab-pinned session to the browser auth context |
| `browser_open` | Navigate to a URL |
| `browser_snapshot` | Capture page accessibility snapshot, or `delta` changes only |
| `browser_read` | Fetch markdown/llms-aware text, or read active tab |
| `browser_click` | Click by `@ref`, optionally along a human pointer path |
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
| `browser_tab` | List/open/close/switch tabs by id, label, or durable CDP targetId |
| `browser_is` | Boolean visible/enabled/checked assertions |
| `browser_set` | Configure viewport/device/geo/offline/media/headers/credentials |
| `browser_record` | Start/restart/stop a WebM or MP4 recording |
| `browser_trace` | Start/stop Playwright trace zip |
| `browser_checkpoint` | Save screenshot + interactive snapshot, skippable when unchanged |
| `browser_react` | Inspect React tree/fibers/renders/Suspense |
| `browser_a11y` | Run embedded axe-core accessibility audits |
| `browser_vitals` | Measure web vitals and React hydration timing |

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm test:e2e  # launches an isolated browser and verifies strict shared-CDP pinning
pnpm preview:control  # compare the live control indicator on light and dark backgrounds
```

## Notes

- Browser refs (`@e12`) come from the latest snapshot and go stale after DOM mutations.
- `browser_find` always acts. Use `browser_snapshot`/`browser_get` to inspect without mutation.
- `/browser status` and `browser_status` actively probe the port and any previously known pinned binding. They report the daemon session, binding state, durable targetId, and sanitized tab-gone URL when available.
- CDP actions use a dedicated, Pi-session-derived daemon session, enable agent-browser 0.34 strict `--pin-tab`, and explicitly clear `AGENT_BROWSER_ALLOWED_DOMAINS`. agent-browser cannot install domain/WebRTC containment on pre-existing browser pages. Explicit-URL `browser_read` calls still support `allowedDomains`.
- The controlled tab binding survives daemon restarts. Other Pi sessions and user-opened tabs cannot steal the active target.
- If the pinned tab disappears, commands fail safely with `tab_gone` and retain its `targetId` plus sanitized last URL when available. Recover with `browser_tab` new/switch, or use `browser_connect` as an explicit request for a fresh controlled tab. Only transient non-pin target failures retry automatically.
- `browser_record` defaults to 30 fps. `cursor=true` draws the pointer and click ripples into the video; `contactSheet=true` also writes `<name>.contact-sheet.png`, a change-selected summary that is far cheaper to inspect than the video.
- Controlled tabs use a coral pointer favicon and a stationary glow that fades inward from the viewport edges. The marker does not block clicks, move content, or animate; releasing control restores the site's original favicon links.
- Repeated `browser_checkpoint` calls with `ifChanged=true` and `browser_snapshot` with `delta=true` return nothing when the page has not moved, so polling a page costs almost no context. `ifChanged` tolerates up to 1% pixel change by default; pass `threshold` to widen or tighten it.
- The artifact directory is `/tmp/da-browser/<cwd-slug>`.
- HAR artifacts can contain cookies, authorization headers, and response bodies. Inspect before sharing.
