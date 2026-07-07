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
The browser page target used by pi, marked visually when possible so the human can see what the agent controls.
_Avoid_: Hidden background browser, arbitrary tab selection guarantee

**Recoverable CDP Failure**:
A browser-down, target-gone, or busy-page state that should produce a clear recovery step or one automatic retry.
_Avoid_: Raw protocol failure, silent retry loop

**Browser Artifact**:
Screenshot, snapshot, eval output, video, or trace file saved under the deterministic `/tmp/da-browser/<cwd-slug>` directory.
_Avoid_: Global permanent artifact store

## Relationships

- **da browser** is installed separately from `pi-extensions`.
- **Trusted Browser Automation** depends on the local Arc/Chromium auth context and CDP port.
- A **Curated Browser Wrapper** should keep schemas strict and use `prepareArguments` for resumed-session compatibility.
- **Controlled Tab** state is session/branch scoped, not global truth.
- **Recoverable CDP Failure** should say whether to relaunch Arc, reconnect, wait, or retry.
- **Browser Artifacts** are temporary evidence for agent workflows and visual QA.

## Testing

Keep light guard tests around pure argument builders, output parsers, CDP classification, controlled-tab script generation, and state serialization.
