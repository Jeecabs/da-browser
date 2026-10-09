# da browser

Lachlan's browser-control package for pi and Claude Code. It wraps `agent-browser` as typed tools, commands, status UI, and session-scoped state, with one browser core shared by both hosts.

## Language

**Host**:
The agent that runs da browser: pi (extension, `src/index.ts`) or Claude Code (mod, `hooks/register.tsx`). The browser core reaches a host only through `BrowserHost`.
_Avoid_: Platform, client, port

**da browser package**:
A focused pi package that owns browser control, separate from the general `pi-extensions` bundle.
_Avoid_: Generic extension bundle, public plugin collection

**Trusted Browser Automation**:
Browser actions are allowed on Lachlan's trusted machine without extra confirmation prompts, but only for user-directed work.
_Avoid_: Browser sandbox, permission-gated read-only mode

**Curated Browser Wrapper**:
Common `agent-browser` actions are exposed as typed tools; uncommon commands stay behind `browser_command`.
_Avoid_: Full CLI clone, shell command passthrough

**Controlled Tab**:
The strictly pinned browser page target used by one Pi session, identified by a durable CDP target id and marked visually when possible so the human can see what the agent controls.
_Avoid_: Hidden background browser, most-recent-tab adoption, cross-session target stealing

**Recoverable CDP Failure**:
A browser-down, target-gone, or busy-page state that should produce a clear recovery step or one automatic retry.
_Avoid_: Raw protocol failure, silent retry loop

**Obscura Session**:
A headless, signed-out browser (agent-browser's experimental Obscura engine) that a session switches to with `browser_connect engine=obscura`, for fast churn on local dev or public pages that need no auth. agent-browser launches and owns it on its own daemon (`…-obscura`), so there is no **Controlled Tab** to pin or mark.
_Avoid_: Using it for signed-in work, treating it as Chrome-equivalent

**Derived Client**:
A standalone HTTP client generated from one recorded session by the `derive-client` skill, so repeat automation of a site skips the browser. It authenticates with a cookie file exported by `browser_cookies`, and the browser is needed again only to refresh the login.
_Avoid_: Scraper, browser-driven loop for every call

**Browser Artifact**:
Screenshot, snapshot, eval output, accessibility report, HAR capture, video, or trace file saved under the deterministic `/tmp/da-browser/<cwd-slug>` directory.
_Avoid_: Global permanent artifact store

## Relationships

- **da browser** is installed separately from `pi-extensions`.
- The browser core imports neither Node nor a **Host** package, because the Claude Code mod runs without Node. Host differences live in the adapters.
- Each **Host** names its daemon sessions (`pi-…`, `cc-…`) and its **Controlled Tab** marker (blue pointer and glow for pi, coral pointer with sparkle and glow for Claude Code), so neither can adopt the other's tab and a glance says which agent holds one.
- **Trusted Browser Automation** depends on the local Arc/Chromium auth context and CDP port.
- **Trusted Browser Automation** cannot use agent-browser domain/WebRTC containment on pre-existing CDP pages. CDP commands run in a dedicated daemon session and explicitly clear inherited allowlists. Explicit-URL reads can still use them.
- A **Curated Browser Wrapper** should keep schemas strict and use `prepareArguments` for resumed-session compatibility.
- **da browser** checks its minimum supported `agent-browser` version at session start and before each action. Newer versions remain valid.
- Every **Controlled Tab** uses agent-browser strict `--pin-tab` with a named, Pi-session-derived daemon. Its target binding survives daemon restarts, and user/other-session tabs must never steal it.
- The pointer moves as a person's would by default (`--input-mode human`): clicks and drags take a curved path, at about a second each, rather than jumping.
- A host's daemon exits after an hour without commands (`--idle-timeout`, which agent-browser does not apply to attached browsers by default), and the next command respawns it bound to the same **Controlled Tab**.
- A strict `tab_gone` is a safe isolation stop, not a retry signal. Preserve its durable target id and sanitized last URL; recovery must be explicit through tab new/switch or browser connect.
- **Controlled Tab** state is session/branch scoped, not global truth.
- **Recoverable CDP Failure** should say whether to relaunch Arc, reconnect, wait, or retry.
- **Browser Artifacts** are temporary evidence for agent workflows and visual QA.
- A **Derived Client** never sees secrets through model context: HARs are read through the masking analyzer, and cookie values go straight from `browser_cookies` to a mode-600 file.
- A **Conditional Artifact** (`browser_checkpoint ifChanged`, `browser_snapshot delta`) is the default for repeated observation of one page: an unchanged capture returns no path and no tree, so polling stays cheap.
- A **Presentation Recording** (`cursor`, `contactSheet`) is for a human or a vision pass to watch, not just a file on disk. `pi-filmstrip` consumes the contact sheet rather than resampling the video.

## Testing

Keep light guard tests around pure argument builders, output parsers, CDP classification, controlled-tab script generation, and state serialization.
