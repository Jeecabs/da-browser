# pi-browser-ops

`pi-browser-ops` is a pi extension package that makes `agent-browser` feel like a native part of the coding agent instead of a raw shell recipe.

The immediate goal is to turn a repeated workflow:

1. relaunch Arc with remote debugging
2. export auth state
3. load auth into `agent-browser`
4. open a dashboard
5. snapshot, click, fill, verify

into first-class pi commands, tools, and session state.

## Why this exists

The current browser workflow is useful but awkward for an agent:

- setup is easy to forget
- auth export is sensitive and should be cleaned up
- `@e123` refs drift after page updates
- the agent has no durable sense of browser state
- the workflow is expressed as shell snippets instead of typed tools

This extension wraps that flow with:

- `/browser connect`, `/browser status`, `/browser cleanup`
- typed tools like `browser_open`, `browser_snapshot`, `browser_click`
- a persistent widget showing connection state, URL, last action, and artifacts
- automatic artifact management for snapshots, screenshots, and eval output
- cleanup of the plaintext Arc auth export on shutdown

## Source Reference

This extension is being built against the pi coding agent in [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono), specifically the extension APIs under `packages/coding-agent`.

Relevant upstream reference points:

- extension runtime and event model
- example extensions in `packages/coding-agent/examples/extensions`
- commands, tools, status widgets, and reload patterns

## Current MVP

Implemented in this repo:

- `/browser connect`
- `/browser status`
- `/browser cleanup`
- `browser_status`
- `browser_connect`
- `browser_open`
- `browser_snapshot`
- `browser_click`
- `browser_fill`
- `browser_select`
- `browser_eval`
- `browser_checkpoint`

## Install Guide

### 1. Put the extension where pi can discover it

Place this repo in one of pi's extension discovery locations:

```bash
~/.pi/agent/extensions/pi-browser-ops/
```

or:

```bash
.pi/extensions/pi-browser-ops/
```

### 2. Install dependencies with pnpm

From the extension directory:

```bash
pnpm install
```

### 3. Reload pi

If the extension is in an auto-discovered location, run:

```text
/reload
```

If you are testing directly from a path during development:

```bash
pi -e ./src/index.ts
```

### 4. Relaunch Arc with remote debugging

Quit Arc fully, then relaunch it with your chosen debugging port:

```bash
/Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=9222
```

If you need a different port, pick one and use the same value when you connect from pi.

### 5. Connect from pi

In pi, run:

```text
/browser connect
```

or, with an explicit port override:

```text
/browser connect 9333
```

### 6. Start using the browser tools

Typical sequence:

1. `browser_connect`
2. `browser_open`
3. `browser_snapshot`
4. `browser_click` / `browser_fill` / `browser_select`
5. `browser_checkpoint`

## Runtime prerequisites

- `agent-browser` installed and on `PATH`
- Arc launched with remote debugging on port `9222`

Arc launch command:

```bash
/Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=9222
```

The `/browser connect` command checks for both prerequisites and tells you exactly what is missing.

## Port behavior

The extension uses `9222` as the smart default browser debugging port, but it is not hard-coded.

You can override it in three ways:

- `/browser connect 9333`
- `browser_connect({ port: 9333 })`
- `PI_BROWSER_PORT=9333`

## Notes

- The auth export file is written under `/tmp/pi-browser-ops/.../arc-auth.json`
- That file contains plaintext session data and is deleted on `session_shutdown` or `/browser cleanup`
- Snapshots, screenshots, and eval output remain in the artifact directory for debugging

## Next steps

Good follow-up work for true first-class support in pi itself:

- a built-in browser provider abstraction, parallel to built-in file and shell tools
- smarter post-action resnapshot logic
- domain-specific presets for Cloudflare, Clerk, Supabase, Vercel, and Google
- opt-in confirm gates for high-risk browser mutations
- a higher-level `browser_task` tool that can execute guarded multi-step UI workflows
