# da browser

Private pi package for Lachlan's browser-control workflow. It wraps `agent-browser` as typed pi tools, commands, status UI, and session-scoped state.

## Language

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

**Browser Artifact**:
Screenshot, snapshot, eval output, accessibility report, HAR capture, video, or trace file saved under the deterministic `/tmp/da-browser/<cwd-slug>` directory.
_Avoid_: Global permanent artifact store

## Relationships

- **da browser** is installed separately from `pi-extensions`.
- **Trusted Browser Automation** depends on the local Arc/Chromium auth context and CDP port.
- **Trusted Browser Automation** cannot use agent-browser domain/WebRTC containment on pre-existing CDP pages. CDP commands run in a dedicated daemon session and explicitly clear inherited allowlists. Explicit-URL reads can still use them.
- A **Curated Browser Wrapper** should keep schemas strict and use `prepareArguments` for resumed-session compatibility.
- **da browser** checks its minimum supported `agent-browser` version at session start and before each action. Newer versions remain valid.
- Every **Controlled Tab** uses agent-browser 0.34 strict `--pin-tab` with a named, Pi-session-derived daemon. Its target binding survives daemon restarts, and user/other-session tabs must never steal it.
- A strict `tab_gone` is a safe isolation stop, not a retry signal. Preserve its durable target id and sanitized last URL; recovery must be explicit through tab new/switch or browser connect.
- **Controlled Tab** state is session/branch scoped, not global truth.
- **Recoverable CDP Failure** should say whether to relaunch Arc, reconnect, wait, or retry.
- **Browser Artifacts** are temporary evidence for agent workflows and visual QA.

## Testing

Keep light guard tests around pure argument builders, output parsers, CDP classification, controlled-tab script generation, and state serialization.
