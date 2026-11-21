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
| `/browser connect obscura` | Switch to a headless, signed-out Obscura browser |
| `/browser status` | Probe connection, page targets, browser version, artifacts |
| `/browser cleanup` | Disconnect/reset browser state for the session |

## Tools

| Tool | Description |
| --- | --- |
| `browser_status` | Probe live CDP state plus strict session/target binding diagnostics |
| `browser_connect` | Connect a strictly tab-pinned session to the browser auth context, or `engine: "obscura"` for a headless one |
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
- Clicks, `browser_find` clicks and drags move the pointer along a curved, eased path by default (agent-browser's `human` input mode), so hover-gated menus open on the way, pointer-path bot checks pass and recordings show the cursor travel. It costs about a second per click; `DA_BROWSER_INPUT_MODE=instant` (about 40ms) or `smooth` (a 200ms straight glide) trades that back
- `PI_BROWSER_CONTROL_BANNER=0` turns off the controlled-tab edge glow and favicon, which are page content and otherwise appear in every recording and screenshot

## Operational notes

- da-browser needs agent-browser 0.43.0 or newer (and so Node 22). [agent-browser-v0.43.0.md](agent-browser-v0.43.0.md) lists what changed since 0.39 and how each change is handled; [agent-browser-v0.34.0.md](agent-browser-v0.34.0.md) explains strict tab pinning.
- Browser refs (`@e12`) come from snapshots and survive same-document updates for elements that stay; a replaced element or a navigation invalidates them.
- A snapshot adds `hint="…"` after the ref of a control with no accessible name, or with the same name as another: its icon, image file, `data-testid`, `name` or `id`, and the text of its row (`in:`). Use it to tell identical buttons apart; a `data-testid` from a hint works with `browser_find locator=testid`.
- A click on a hidden or disabled element fails with the reason instead of reporting success. A ref below the fold is scrolled into view first.
- `browser_find` always acts. Use `browser_snapshot`/`browser_get` to inspect without mutation.
- `/browser status` and `browser_status` actively probe the port and any previously known pinned binding. They report the daemon session, binding state, durable targetId, and sanitized tab-gone URL when available.
- CDP actions use a dedicated, Pi-session-derived daemon session, enable strict `--pin-tab`, and explicitly clear `AGENT_BROWSER_ALLOWED_DOMAINS`. agent-browser cannot install domain/WebRTC containment on pre-existing browser pages. Explicit-URL `browser_read` calls still support `allowedDomains`.
- The controlled tab binding survives daemon restarts. Other Pi sessions and user-opened tabs cannot steal the active target.
- Three other stops are reported by name and never retried. `outcome_unknown`: the command reached the daemon and no answer came back, so check the page before repeating it. `page_wedged`: the tab stopped responding, so continue in a new one. `tab_locked`: `browser_tab` named a tab pinned by another session.
- If the pinned tab disappears, commands fail safely with `tab_gone` and retain its `targetId` plus sanitized last URL when available. Recover with `browser_tab` new/switch, or use `browser_connect` as an explicit request for a fresh controlled tab. Only transient non-pin target failures retry automatically.
- A new tab's `label` starts with a letter and holds only letters, digits, `-` and `_`.
- agent-browser prints its own notices on stderr (the settings a daemon started with, an outdated-Chrome warning). They are kept out of tool results; `browser_command` shows them, and "relaunched browser" there means the daemon attached again, not that the browser restarted.
- Through `browser_command`: saved flows (`["--capture", "flow", "get", "url"]`, then `["flow", "steps"]`, `["flow", "save", "<name>"]`, `["flow", "run", "<name>"]`; experimental, and da-browser's own bookkeeping is recorded as steps), `["cookies", "set", "<name>", "<value>", "--http-only", "--same-site", "Lax"]`, `["network", "route", "<url>", "--body", "<json>", "--allow-origin", "<origin>"]`, and `["batch", "--json", "--omit-command", …]`.
- `browser_record` defaults to 30 fps. `cursor=true` draws the pointer and click ripples into the video; `contactSheet=true` (or `contactSheetThreshold`) also writes `<name>.contact-sheet.png`, a change-selected summary that is far cheaper to inspect than the video. `url` navigates first and starts once the page loads, to film a cold load. With an emulated device scale (`browser_set viewport` with `scale` 2) the take is filmed from full-density screenshots, which can drop frames on a busy page, and stop says so.
- A recording films the controlled tab in place. Chrome does not paint a background tab, so start brings a hidden tab to the front, and stop warns when the tab never painted (a minimised or covered window) or was hidden when the take ended. A tab hidden mid-take and shown again before stop goes unwarned. Navigation in the tab is followed; `browser_tab` new/switch is not, so `restart` to film the new tab.
- A daemon that exits mid-take truncates the video. Each host stops a running recording, HAR or trace when its session ends, and `/browser cleanup` stops them first. A take left idle for an hour is still lost with its daemon, and status then reports it.
- Repeated `browser_checkpoint` calls with `ifChanged=true` and `browser_snapshot` with `delta=true` return nothing when the page has not moved, so polling a page costs almost no context. `ifChanged` tolerates up to 1% pixel change by default; pass `threshold` to widen or tighten it.
- `browser_connect({ engine: "obscura" })` (or `/browser connect obscura`) moves every browser tool to a headless [Obscura](https://agent-browser.dev/engines/obscura) browser that agent-browser launches on its own daemon. It is light but signed out, and it has known accessibility, hidden-element, iframe and screenshot gaps, so use it for quick checks on local dev or public pages. See [Obscura limits](#obscura-limits) before relying on it. Private and local addresses are allowed. The `obscura` binary must be on `PATH`. `browser_connect` without `engine` switches back, and the user's browser keeps its pinned tab meanwhile.
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

## Obscura limits

Tested with Obscura 0.2.4 and agent-browser 0.39.0 against skimate.ai (a Next.js app), with headless Chrome as the baseline. Not re-run on 0.43.0.

These work as in Chrome: opening pages, snapshots (including `selector`, `delta` and annotated checkpoints), screenshots (full page, element and mobile viewport), `browser_eval`, `browser_read` of the tab, waits on text, URL and network idle, history and `pushstate`, extra tabs, viewport, device, colour scheme and geolocation, console and network logs, HAR capture, cookie export, axe audits, and plain HTML forms (fill, type, select, check, and clicks by CSS selector).

| Area | What happens | Workaround |
| --- | --- | --- |
| Clicks by ref | On 0.39.0, `browser_click`, `browser_find` and hover by `@ref` failed with a `DOM.getBoxModel` float error when the element's box had a fractional size, which most text links have. agent-browser 0.42.0 fixed it ([#2070](https://github.com/vercel-labs/agent-browser/issues/2070), [#2393](https://github.com/vercel-labs/agent-browser/pull/2393)); not re-tested here | If one still fails: `browser_command ["click", "<css selector>"]`, or `browser_open` the link's URL |
| React textareas | `HTMLTextAreaElement.prototype` has no `value` property, so typing or filling a React-controlled textarea crashes the app into its error boundary | Use the user's browser for forms |
| Client-side navigation | Some routes render an empty `main` after an in-app link click (Powder chase did every time; Trending did not) | `browser_open` the URL directly |
| Rendering | No WebGL, so pages that need it throw: skimate.ai's resort globe fell into its error state. Web fonts never load, and button labels can wrap | Use the user's browser for visual QA or WebGL pages |
| Timezone | Always reports `Europe/Berlin`, whatever the machine's zone | Don't trust dates or times rendered on the page |
| Not supported | `browser_record`, `browser_trace`, `browser_set offline`, `browser_vitals` (no paint timings, so every metric is empty), and `browser_react` (the DevTools hook never installs) | Use the user's browser |
| Speed | Page loads were no faster overall than headless Chrome: Obscura won one of five pages. It is light, using about 40 MB idle and 250 MB with skimate.ai open | Pick it for being signed out and light, not for speed |

