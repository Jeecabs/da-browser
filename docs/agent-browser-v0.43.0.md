# agent-browser 0.39.1 to 0.43.0

## Decision

da-browser now requires agent-browser **0.43.0**, up from 0.39.0. Two changes in that range broke da-browser outright, three added failure codes it did not recognise, and 0.43 itself adds snapshot hints that agents should be told about.

```bash
npm install -g agent-browser@latest   # needs Node 22 since 0.42
```

The pinning contract from 0.34 is unchanged and is still described in [agent-browser-v0.34.0.md](agent-browser-v0.34.0.md).

## What broke, and the fix

### Daemon notices on stderr (0.41.2, 0.42.0)

Since 0.42 a daemon reports the settings it started with on stderr, on its first command, **even with `--json`**. 0.41.2 adds a warning when the browser is behind Chrome stable. A first command against an attached browser now prints:

```text
⚠ allowed-domains: default →  (--allowed-domains), relaunched browser
⚠ Chrome 157.0.8103.79 is behind the current stable release 158.0.8127.36, which fixes 204 CVEs (…). Update the browser; for agent-browser's Chrome, run `agent-browser install`.
[agent-browser] launched browser
```

da-browser used to append stderr to stdout. With these lines after it, a `--json` envelope no longer parsed, and `get url` returned the URL plus three lines of notices, which `browser_connect` stored as the current URL. A daemon restarts after an hour idle, so this recurred all session.

Now (`joinCliOutput` in `src/agent-browser-output.ts`):

| Caller | Reads |
| --- | --- |
| Anything parsed: every `--json` call, the URL probe, the visibility probe | stdout only |
| Output shown to the agent: snapshot, eval, console, errors, React, vitals | stdout, plus stderr lines that are not daemon notices, so an open-dialog warning still arrives |
| `browser_command` | both streams as printed |

"relaunched browser" on an attached session means the daemon attached again. It does not restart the user's browser, and the pinned tab stays bound. The Chrome warning comes from a request the daemon makes to `chromereleases.googleblog.com`, once per browser product; `AGENT_BROWSER_NO_VERSION_CHECK=1` in the environment that starts the daemon turns it off.

Sources: [#2309](https://github.com/vercel-labs/agent-browser/pull/2309), [#2396](https://github.com/vercel-labs/agent-browser/pull/2396), [`output.rs` at v0.43.0](https://github.com/vercel-labs/agent-browser/blob/v0.43.0/cli/src/output.rs), [`browser_security.rs`](https://github.com/vercel-labs/agent-browser/blob/v0.43.0/cli/src/browser_security.rs)

### `get cdp-url` no longer attaches (0.42.0)

`get cdp-url` never launches or attaches a browser now. On a session with no browser yet it fails with `Browser not launched`, where 0.39 attached and answered. The same release makes the daemon decide reuse and relaunch in one place: a command whose `--cdp` differs from the running one re-attaches by itself (`⚠ cdp: 9222 → 9333 (--cdp), relaunched browser`).

That makes da-browser's old endpoint check before connect (`ensureDaemonOnPort`, written when 0.27 silently ignored a changed `--cdp`) both broken and unnecessary, so it is removed. After a port change the old target is not in the new browser, the first probe returns `tab_gone`, and `browser_connect` binds a fresh tab as it already did.

Sources: [v0.42.0 release notes](https://github.com/vercel-labs/agent-browser/releases/tag/v0.42.0), [#2396](https://github.com/vercel-labs/agent-browser/pull/2396), [#2418](https://github.com/vercel-labs/agent-browser/pull/2418)

## New failure codes

| Code | Since | When | da-browser |
| --- | --- | --- | --- |
| `outcome_unknown` | 0.39.1 | A mutating command reached the daemon and no response came back. The CLI does not send it again. | Kind `outcome-unknown`. Never retried; the message says to check the page before repeating the action. |
| `page_wedged` | 0.39.4 | The tab's renderer stopped answering. A tab in an attached browser is left alone; a launched one is replaced by a blank tab after a second timeout. | Kind `page-wedged`. Never retried; says to continue in a new tab, or to open the page again on Obscura. |
| `tab_locked:` | 0.39.4 | `tab <targetId>` named a tab another session holds with `--pin-tab`. It has an error prefix and no `code` field. | Kind `tab-locked`. Says to pick another tab. |
| `Target closed: CDP session <id> detached` | 0.43.0 | The tab closed while a command was waiting on Chrome. It used to wait for the timeout. | Already matched as `target-gone`; under the strict pin the single retry ends in `tab_gone`. |

The first matters most. An `outcome_unknown` usually quotes a socket or timeout error, which the generic patterns read as a lost target, and the lost-target path retries once. That retry was the duplicate click the upstream fix removed. These codes are now matched before any generic pattern.

Sources: [#2085](https://github.com/vercel-labs/agent-browser/pull/2085), [#2100](https://github.com/vercel-labs/agent-browser/pull/2100), [#2135](https://github.com/vercel-labs/agent-browser/pull/2135), [#2576](https://github.com/vercel-labs/agent-browser/pull/2576)

## Snapshot hints (0.43.0)

A control whose accessible name is empty, or the same as another ref's in the same snapshot, gets a hint after its ref:

```text
- button "Delete" [ref=e9] hint="data-testid:del-alpha; in:Alpha row"
- button "Delete" [ref=e10] hint="data-testid:del-beta; in:Beta row"
- button [ref=e5] hint="icon:icon-gear; data-testid:settings-btn"
- button [ref=e6] hint="img:trash; id:img1"
```

The parts are the icon, the image file, `data-testid`, `name` or `id`, and the text of the nearest row or list item (`in:`). The hint sits outside the `[…]` bracket, so the existing ref parsing is unaffected. The `--json` payload's `refs` map does not carry it; da-browser shows the text tree.

da-browser passes hints through, tells agents what they mean in the tool guidelines and the `browser_snapshot` description, and names an unnamed control by its hint in the activity line (`click button (icon:icon-gear)`). A `data-testid` in a hint works directly with `browser_find locator=testid`.

Source: [#2578](https://github.com/vercel-labs/agent-browser/pull/2578)

## Release by release

**Supported** means da-browser changed. **Passthrough** means `browser_command` reaches it and no typed tool is warranted. **No change** means it works as it is, or does not touch da-browser.

| Release | Change | da-browser |
| --- | --- | --- |
| 0.39.1 | `outcome_unknown` instead of retrying a mutating command | Supported: new failure kind, no retry |
| 0.39.2 | `click` and `dblclick` fail on hidden or disabled elements instead of reporting success | Supported: guideline added. A ref below the fold is still scrolled into view and clicked |
| 0.39.2 | Stale refs fail when recovery is ambiguous; batched target invalidation; CDP attachment persists across commands | No change: fixes da-browser already relied on |
| 0.39.2 | Commas kept inside `--args` values; unreadable policy files deny; MCP rejects undeclared keys | No change: not used |
| 0.39.3 | `connect` and `--cdp` wait up to two seconds for a port that still refuses | No change: helps a browser that is still starting |
| 0.39.3 | Auto-discovered `agent-browser.json` can no longer set paths, args or plugins; process identity checked before signals | No change |
| 0.39.4 | `page_wedged`; `tab_locked` when taking a pinned tab by target id | Supported: new failure kinds; the e2e test covers `tab_locked` |
| 0.39.4 | Full-page screenshots on high-DPI displays, element screenshots outside the first viewport, `wait --download` | No change: `browser_checkpoint` benefits |
| 0.40.0 | `batch --omit-command`; `network route --allow-origin` | Passthrough |
| 0.40.0 | `state load` writes storage through DevTools; `<session>.config` files cleaned up | No change |
| 0.40.0 | `@agent-browser/eve` needs eve 0.84; one MCP server per Vercel Sandbox | No change: not used |
| 0.41.0 | `agent-browser mcp call <tool>` | Supported in the Bash guard: `mcp call agent_browser_connect` is refused like `connect` |
| 0.41.0 | MCP tool arguments cannot set global flags | No change |
| 0.41.1 | `cookies set --http-only --same-site` (camelCase still accepted); `errors --clear` clears | Passthrough for `cookies set`; `browser_debug errors clear=true` now works |
| 0.41.2 | Outdated-Chrome CVE warning | Supported: kept out of results, see above |
| 0.41.2 | `skills get <name> --ref <ref>` | Passthrough |
| 0.41.2 | Commands that omit a timeout no longer restart the session; browserless commands no longer launch a browser | No change: `session list` and URL reads stay cheap |
| 0.42.0 | Saved flows (experimental): `--capture flow`, `flow steps`, `flow save`, `flow run`, `flow list` | Passthrough, see below |
| 0.42.0 | Session reuse and relaunch decided in the daemon; settings notices on stderr; `get cdp-url` never attaches | Supported: stdout-only parsing, endpoint check removed |
| 0.40 to 0.43 | New global flags in `--help`: `--relaunch`, `--no-auto-connect`, `--cdp-headers`, `--capture` | Passthrough. `--relaunch`, `--capture` and `--cdp-headers` re-attach and keep the pinned tab. `--auto-connect` with `--cdp` is refused by the CLI |
| 0.42.0 | Unknown commands and cookie operations are rejected (`"type": "unknown_command"`) | No change: surfaces as an ordinary failure |
| 0.42.0 | `errors` prints the page error text; `fill` and `type` keep literal text; fractional pointer coordinates | No change: `browser_debug` and `browser_fill` benefit |
| 0.42.0 | Ref clicks no longer fail on fractional box sizes ([#2070](https://github.com/vercel-labs/agent-browser/issues/2070)) | Supported in wording: the Obscura warning is softened to a fallback. Not re-tested, see below |
| 0.40 to 0.43 | `--help` now states the rules for session names (letters, numbers, `-`, `_`) and tab labels (a letter first, then letters, digits, `-`, `_`; not `t<N>`) | Session names already comply. Supported: `browser_tab` checks the label first, so the error names its own field |
| 0.42.0 | Node 22 minimum | Supported: noted in the README |
| 0.43.0 | Snapshot hints | Supported, see above |
| 0.43.0 | `Target closed` as soon as a tab closes | No change: already classified |
| 0.43.0 | Recordings switch to screenshots under an emulated device scale; `record stop` reports `"capture": "screenshots"` and `deviceScaleFactor` | Supported: `browser_record` stop reports it |
| 0.43.0 | Per-platform binary packages; large snapshots parse the tree once | No change: `npm i -g agent-browser@latest` is still the install |
| 0.43.0 | Modern Web Guidance skill | Passthrough: `browser_command ["skills", "get", …]` |

### Saved flows

`--capture flow` records a session so `flow save` can replay its requests later. It works on a pinned CDP session through `browser_command`: the daemon re-attaches with capture on, keeps the pinned tab, and capture stays on for later commands. Two things follow. da-browser's own bookkeeping (URL probes, tab lists, the controlled-tab marker's `eval`) is recorded as steps, so save with `--from` and `--to`. And agent-browser prints saved flows for a site after navigation, on stdout, which da-browser's navigation tools do not show; ask with `browser_command ["flow", "list"]`. It is experimental upstream and stays behind the passthrough. The `derive-client` skill is still the route to a client that runs without agent-browser.

## Verification

### Live, against agent-browser 0.43.0

An isolated headless Chrome (its own socket directory and port) and a local probe page, driven through da-browser's own core functions and argument builder:

- connect on a new daemon: clean URL and target despite the three notices;
- snapshot with hints; click by ref, including an icon-only button found by its hint and a button 3000px below the fold;
- `browser_find` by testid and by role; fill with literal text; wait, `is`, `get box` without the lifecycle block;
- a click on a disabled button fails with `Element '@e7' is disabled, so the click would not reach it`;
- `errors`, then `errors --clear`, then empty;
- annotated and conditional checkpoints, HAR, cookie export, axe audit, tab read;
- tab new with a label, the label rule, list, close, `tab_gone`, and recovery through connect;
- a recording at device scale 2 reports `capture: screenshots`, with cursor and contact sheet;
- `browser_command` with `flow list`, an unknown command, and `cookies set --http-only --same-site`.

### da-browser E2E

```bash
pnpm test:e2e
```

Passes on 0.43.0. It now also checks that `get cdp-url` does not attach a new session, that a first attach with `--json` keeps stdout to one envelope, and that a peer session gets `tab_locked` on the victim's target.

### Unit and type checks

```bash
pnpm check
pnpm test
```

Type-check passed; **128 tests passed, 0 failed**. New fixtures are real 0.43.0 output from the probe, or message text from its source where a failure could not be produced on demand.

### Not verified live

- `outcome_unknown` and `page_wedged`: classification is tested against the message and JSON shape in the 0.43.0 source ([`connection.rs`](https://github.com/vercel-labs/agent-browser/blob/v0.43.0/cli/src/connection.rs), [`browser.rs`](https://github.com/vercel-labs/agent-browser/blob/v0.43.0/cli/src/native/browser.rs)).
- `Target closed: CDP session … detached`: tested as a string only.
- Obscura: the binary was not installed, so nothing in [Obscura limits](tools.md#obscura-limits) was re-run on 0.43.0, including the ref-click fix.
- Arc: the live run used agent-browser's own headless Chrome, never the user's browser.
- `flow save` and `flow run`: only `--capture flow`, `flow steps` and `flow list` were run.

## Operational notes

- A daemon's first page command also asks for the Chrome release feed, with a three-second timeout, so it can be slower. Offline it gives up quietly.
- `relaunched browser` in `browser_command` output is the daemon re-attaching. The user's browser is not restarted.
- Hints add a few tokens per ambiguous control and remove the screenshot an agent would otherwise take to tell two "Delete" buttons apart.
- For a sharp recording, an emulated scale of 2 now works but drops frames on busy pages. Leave the scale at 1 for motion.
