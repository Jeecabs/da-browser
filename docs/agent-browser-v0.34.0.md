# agent-browser 0.34.0 deep dive

## Decision

da-browser now requires agent-browser **0.34.0** and enables strict `--pin-tab` on every CDP-backed invocation. This release directly fixes da-browser's highest-risk shared-Chrome failure mode: one Pi session silently adopting or navigating another session's tab.

## What 0.34.0 changes

### Persistent session-to-tab binding

A named agent-browser session now persists its active tab as a CDP `targetId` and restores that target after a daemon restart. The binding is stored as a per-session `.target` JSON file in the socket directory. Writes are atomic, owner-only on Unix, and contain a sanitized last URL plus the sticky `pinned` setting.

Sources:

- [v0.34.0 release notes](https://github.com/vercel-labs/agent-browser/releases/tag/v0.34.0)
- [PR #1589](https://github.com/vercel-labs/agent-browser/pull/1589)
- [`tab_binding.rs` at v0.34.0](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/cli/src/native/tab_binding.rs)

The binding is about **tab selection**, not browser-profile isolation. Sessions attached to the same Chrome still share cookies, storage, and authentication context.

### Strict `--pin-tab`

`--pin-tab` adds the safety boundary needed by da-browser:

- A new pinned session opens a fresh tab instead of adopting an existing tab.
- Tabs discovered from the user or another session are listed but cannot steal the pinned session's active target.
- Closing the bound tab produces `tab_gone` instead of falling back to a neighboring tab.
- `tab list`, `tab new`, and explicit `tab <ref>` remain available for recovery.
- The pin is sticky across later commands and daemon restarts; `--no-pin-tab` disables it.

Sources:

- [CDP mode: Tab pinning](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/docs/src/app/cdp-mode/page.mdx)
- [Sessions: Tab pinning in a shared browser](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/docs/src/app/sessions/page.mdx)
- [`BrowserManager` binding behavior](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/cli/src/native/browser.rs)
- [Daemon attach/persistence behavior](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/cli/src/native/actions.rs)

### Structured recovery data

With `--json`, a missing pinned tab returns:

```json
{
  "success": false,
  "code": "tab_gone",
  "data": {
    "targetId": "...",
    "lastUrl": "https://example.com/path"
  }
}
```

Batch output carries the recovery object under `result`. `lastUrl` is intentionally limited to `about:blank` or HTTP(S) URLs with credentials, query, and fragment removed; opaque URLs are omitted.

Sources:

- [PR #1589 structured-output summary](https://github.com/vercel-labs/agent-browser/pull/1589)
- [`attach_tab_gone_data`](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/cli/src/native/actions.rs)
- [CLI pin-tab integration tests](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/cli/tests/pin_tab_cli.rs)

### Durable target references

`tab list --json` exposes each tab's `targetId`. In 0.34, that target id is accepted by tab switch and close commands. Unlike `t<N>` ids, target ids survive daemon restarts, making them the correct coordination/recovery handle.

Source: [v0.34.0 tab command documentation](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/docs/src/app/commands/page.mdx)

### Other release items

The new Remote Agent Browser provider guide is documentation for cloud-provider workflows and does not change da-browser's local Arc/CDP contract. The `agent-browser doctor` Chrome-version hang fix improves a suggested diagnostic path, but needs no wrapper change because da-browser's normal compatibility probe is `agent-browser --version`.

Source: [v0.34.0 release notes](https://github.com/vercel-labs/agent-browser/releases/tag/v0.34.0)

## da-browser integration

The extension takes the release on board as follows:

1. **Named session before first attach** — every CDP command uses the deterministic, Pi-session-derived `pi-<hash>` session inside the `da-browser` namespace.
2. **Pin before attach** — `--pin-tab` is included before `--cdp` on every invocation, including the first probe. Repeating the sticky flag also upgrades an already-running daemon safely.
3. **No safety downgrade through `browser_command`** — raw commands cannot supply `--pin-tab` or `--no-pin-tab`; the wrapper owns the isolation policy.
4. **No silent recovery from `tab_gone`** — it is classified separately from transient target loss and never enters automatic page-target creation/retry.
5. **Structured diagnostics** — single-command JSON, batch JSON, and human output are parsed for `targetId` and sanitized `lastUrl`.
6. **Explicit recovery** — `browser_tab` can list, create, or switch by durable target id while in `tab_gone`. `browser_connect` is treated as an explicit request for a fresh controlled tab and re-binds one if the old target is gone.
7. **Correct close semantics** — closing the current pinned tab remains a successful mutation. The extension records the unbound state instead of probing a neighbor and misreporting the close as a failure.
8. **Visible binding state** — status/state output reports strict pinning, the deterministic daemon session, current durable target id, and tab-gone recovery metadata. Because upstream `session info --json` does not yet expose binding fields, da-browser actively re-probes previously known bindings without creating a tab for a brand-new status request. A non-`tab_gone` binding probe failure is reported as `binding: error` and marks the session disconnected instead of claiming a fresh verification.
9. **Version gate** — older CLIs are rejected because they cannot provide the safety guarantee.

## Verification

### Upstream ignored E2E tests

The two upstream CLI E2E cases are marked `#[ignore]`, so they were run explicitly against the v0.34.0 source:

```bash
cd /tmp/agent-browser-v0.34.0/cli
cargo test --test pin_tab_cli -- --ignored --nocapture
```

Result: **2 passed, 0 failed**.

They cover:

- `--pin-tab` taking effect before CDP attach even when the daemon already exists.
- `tab_gone` recovery metadata in single-command and batch JSON, including last-URL sanitization.

### da-browser E2E

`tests/pin-tab.e2e.ts` launches an isolated browser and a self-validating HTTP server on an OS-assigned port. It first proves direct CDP navigation works, then exercises the exact argument builder used by da-browser.

```bash
pnpm test:e2e
```

The test verifies:

- pin-before-attach;
- two Pi sessions cannot steal each other's tabs;
- the same target is restored after daemon restart;
- external tab closure fails with structured `tab_gone` instead of adopting a neighbor;
- `tab list` remains available while unbound;
- `tab new` explicitly recovers onto a different target.

Result: **1 passed, 0 failed**.

### Unit and type checks

```bash
pnpm check
pnpm test
```

Results: type-check passed; **38 tests passed, 0 failed**.

## Operational notes

- Strict pinning protects target selection; it does not provide separate cookies/storage when sessions share the user's Chrome.
- A CDP target id survives an agent-browser daemon restart, not closure of the tab or browser process.
- `tab_gone` is a successful safety stop. Prefer explicit recovery over weakening the pin.
- The installed global CLI was upgraded and verified as `agent-browser 0.34.0`.
