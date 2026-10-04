# da browser

<p align="center">
  <img src="assets/da-browser.png" alt="Tabby cat reaching for a cursor in a browser window" width="400" />
</p>

Browser control for [pi](https://github.com/earendil-works/pi) and [Claude Code](https://code.claude.com), powered by [`agent-browser`](https://github.com/vercel-labs/agent-browser). Both drive your own signed-in Arc or Chromium, each session on its own strictly pinned tab.

[Documentation](https://jeecabs.github.io/pi-tooling/da-browser/) · [All tools](https://jeecabs.github.io/pi-tooling/)

## Prerequisites

- `agent-browser` 0.38.1 or newer on `PATH`: `npm install -g agent-browser@latest`
- Arc or Chromium with remote debugging: `open -na "Arc" --args --remote-debugging-port=9222`
- `ffmpeg` on `PATH` only for `browser_record` (`brew install ffmpeg`)

Each host checks the minimum CLI version on session start and before every action. `/browser status` shows the installed version.

## Install in pi

```bash
pi install https://github.com/Jeecabs/da-browser
```

Reload pi if already running:

```text
/reload
```

## Install in Claude Code

da-browser is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview), which needs Claude Code 2.1.287 or newer.

```bash
claude plugin marketplace add Jeecabs/da-browser
claude plugin install da-browser@da-browser
```

Run `/reload-plugins` in a session that is already open. The tools appear as `mcp__da-browser__browser_*`, and the `slack` and `derive-client` skills as `da-browser:slack` and `da-browser:derive-client`.

The Claude Code mod covers the core loop so far: status, connect, open, snapshot, read, click, find, fill, press, tab, and checkpoint. The rest of the 28 pi tools follow.

## Quick start

```bash
open -na "Arc" --args --remote-debugging-port=9222
```

Then, in either host:

```text
/browser connect
/browser status
```

Open a page and snapshot it:

- `browser_open` navigates to a URL
- `browser_snapshot` collects fresh `@eN` refs
- `browser_find` locates by role/text/label and acts in one step

## Commands

| Command | Description |
| --- | --- |
| `/browser connect [port]` | Connect to Arc/Chromium through CDP |
| `/browser status` | Probe connection, page targets, browser version, artifacts |
| `/browser cleanup` | Disconnect/reset browser state for the session |
| `/browser view` | Claude Code: open or close a live view of the pinned tab |
| `/browser pick [what]` | Claude Code: click an element in the tab; its description goes into your prompt |

In Claude Code, `/browser` runs at once, even while Claude is working, without starting a turn.

## Tools

28 typed tools cover open, snapshot, read, click, find, fill, navigation, tabs, eval, recording, traces, HAR and cookie export, React inspection, a11y, and vitals. Full table and flags: [docs/tools.md](docs/tools.md).

## How it shows up

Both hosts answer the same three questions, each in one place:

| Question | pi | Claude Code |
| --- | --- | --- |
| Where is the agent's browser? | Status chip | Status line |
| What is it doing right now? | Trail row above the editor | Band above the prompt |
| What did it do, and what changed? | Tool row: the call, then new facts | Tool row: the call, then new facts |

The raw output (snapshots, page text) goes to the model, never to the transcript. The trail disappears when the browser is idle.

Claude Code adds:

- **A live view.** `/browser view` draws the pinned tab in a pane, refreshed every two seconds and after each browser call. It needs a terminal with kitty graphics (Ghostty, kitty); elsewhere the pane shows its alt text.
- **Handoffs.** With `browser_handoff`, Claude asks you to act in the tab: log in, pass a captcha, or (with `pick`) click the element it means. The ask shows as a bar in the page and in the band, with Done and Cancel.
- **A browser subagent.** `da-browser:browser` runs a web task with only the browser tools and reports back, so page snapshots stay out of the main context.
- **Screenshots in checkpoint rows**, drawn small under the facts.
- **Esc stops a browser command**, instead of leaving it running until its timeout.

## Skills

| Skill | Description |
| --- | --- |
| `derive-client` | Record a site once, then generate a zero-dependency client/CLI that calls its internal API directly. Masked HAR analysis, safe cookie export, `smoke` drift check. |
| `slack` | Slack web app on these tools: unreads, messages, threads, search, Activity, and a guarded send/reply that pins the destination and never touches drafts. |

## How it is built

One browser core, two hosts:

- **`src/agent-browser.ts` and its helpers** are the core. They import neither Node nor a host package. Everything they need from a host is the small `BrowserHost` in `src/host.ts`: run a command, write a file, cwd, home, and session id.
- **`src/index.ts` with `src/pi-host.ts`** is the pi extension. It uses `pi.exec` and `node:fs`.
- **`hooks/register.tsx`** is the Claude Code mod. It uses `$.process` and `$.fs`, and holds every call to the engine, since the mod validator does not follow `$` across imports. `hooks/live.tsx` (the live view) and `hooks/handoff.tsx` (handoffs) take plain values and callbacks from it.
- **`src/browser-present.ts`** turns calls into words and facts for both hosts. `src/browser-ui.ts` paints them for pi; the mod paints them for Claude Code.

## Development

```bash
pnpm install
pnpm check
pnpm test
claude plugin validate .
```

To work on the mod with hot reload, load this folder in Claude Code with `claude --plugin-dir .`. `pnpm test:e2e` launches an isolated browser to verify strict shared-CDP pinning. `pnpm preview:control` previews the control indicator on light and dark backgrounds. See [docs/tools.md](docs/tools.md) for install alternatives and operational detail.

## Notes

- Browser refs (`@eN`) go stale after DOM mutations. Re-snapshot before clicking or filling.
- `browser_find` always acts. Use `browser_snapshot`/`browser_get` to inspect without mutation.
- Controlled tabs get a stationary coral edge glow and a favicon that names the agent: a coral pointer under pi, a coral spark under Claude Code. Releasing control restores the original favicon.
- Strict tab pinning keeps each session on its own tab, pi and Claude Code alike (`pi-…` and `cc-…` daemon sessions). A closed pinned tab fails safely with `tab_gone`; recover with `browser_tab` new/switch or `browser_connect`.
- In Claude Code, raw `agent-browser --cdp` or `connect` through Bash is refused, because it would bypass the session's pinned tab.
- HAR captures can contain cookies, auth headers, and response bodies. Inspect before sharing.
- Artifacts live under `/tmp/da-browser/<cwd-slug>`.
