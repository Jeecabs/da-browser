# da-browser tools and advanced setup

Full command and tool reference, install alternatives, and operational notes.
The [README](../README.md) stays lean on purpose.

## Install alternatives

Recommended:

```bash
pi install https://github.com/Jeecabs/da-browser
```

Other routes that also work:

```bash
pi install git:github.com/Jeecabs/da-browser
```

```bash
git clone https://github.com/Jeecabs/da-browser.git ~/.pi/agent/extensions/da-browser
cd ~/.pi/agent/extensions/da-browser
pnpm install
```

If GitHub auth is not wired into Git yet:

```bash
gh auth login
gh auth setup-git
```

Reload pi if already running:

```text
/reload
```

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
| `browser_cookies` | Export the controlled tab's cookies to a mode-600 file; values never enter context |
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

## Environment overrides

- `/browser connect 9333`, `browser_connect({ port: 9333 })`, or `PI_BROWSER_PORT=9333`
- `DA_BROWSER_INPUT_MODE=smooth|human` moves the pointer along real paths for every action in the session
- `PI_BROWSER_CONTROL_BANNER=0` turns off the controlled-tab edge glow and favicon, which are page content and otherwise appear in every recording and screenshot

## Operational notes

- Browser refs (`@e12`) come from snapshots and survive same-document updates for elements that stay; a replaced element or a navigation invalidates them.
- `browser_find` always acts. Use `browser_snapshot`/`browser_get` to inspect without mutation.
- `/browser status` and `browser_status` actively probe the port and any previously known pinned binding. They report the daemon session, binding state, durable targetId, and sanitized tab-gone URL when available.
- CDP actions use a dedicated, Pi-session-derived daemon session, enable strict `--pin-tab`, and explicitly clear `AGENT_BROWSER_ALLOWED_DOMAINS`. agent-browser cannot install domain/WebRTC containment on pre-existing browser pages. Explicit-URL `browser_read` calls still support `allowedDomains`.
- The controlled tab binding survives daemon restarts. Other Pi sessions and user-opened tabs cannot steal the active target.
- If the pinned tab disappears, commands fail safely with `tab_gone` and retain its `targetId` plus sanitized last URL when available. Recover with `browser_tab` new/switch, or use `browser_connect` as an explicit request for a fresh controlled tab. Only transient non-pin target failures retry automatically.
- `browser_record` defaults to 30 fps. `cursor=true` draws the pointer and click ripples into the video; `contactSheet=true` (or `contactSheetThreshold`) also writes `<name>.contact-sheet.png`, a change-selected summary that is far cheaper to inspect than the video. `url` navigates first and starts once the page loads, to film a cold load.
- A recording films the controlled tab in place. Chrome does not paint a background tab, so start brings a hidden tab to the front, and stop warns when the tab never painted (a minimised or covered window) or was hidden when the take ended. A tab hidden mid-take and shown again before stop goes unwarned. Navigation in the tab is followed; `browser_tab` new/switch is not, so `restart` to film the new tab.
- A daemon that exits mid-take truncates the video. Each host stops a running recording, HAR or trace when its session ends, and `/browser cleanup` stops them first. A take left idle for an hour is still lost with its daemon, and status then reports it.
- Repeated `browser_checkpoint` calls with `ifChanged=true` and `browser_snapshot` with `delta=true` return nothing when the page has not moved, so polling a page costs almost no context. `ifChanged` tolerates up to 1% pixel change by default; pass `threshold` to widen or tighten it.
- The artifact directory is `/tmp/da-browser/<cwd-slug>`.
- HAR artifacts can contain cookies, authorization headers, and response bodies. Inspect before sharing.
- agent-browser HARs omit the `Cookie`, `Accept`, `Origin`, and `Sec-Fetch-*` request headers. `browser_cookies` exports only cookies sent to the current page URL, so open the API's origin first.

## Skills

`derive-client` (`skills/derive-client`) turns one recorded session into a standalone API client:

- `skills/derive-client/scripts/har-endpoints.mjs <file.har> [--show N] [--all]` groups the API calls into templated endpoints with param variance, merged response types, and auth headers, with secrets masked.
- `skills/derive-client/assets/client-template.mts` is a zero-dependency Node client with cookie-jar matching, pacing, 429 backoff, expired-session errors, and `smoke`.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm test:e2e  # launches an isolated browser and verifies strict shared-CDP pinning
```
