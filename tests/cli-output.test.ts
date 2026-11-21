import assert from "node:assert/strict";
import test from "node:test";

import {
  CdpError,
  clickBrowserElement,
  connectBrowser,
  getBrowserInfo,
  isBrowserState,
  runBrowserCommand,
  snapshotBrowserPage,
} from "../src/agent-browser.ts";
import { extractGetResult, isDaemonNotice, joinCliOutput, stripLifecycle } from "../src/agent-browser-output.ts";
import type { BrowserHost, ExecResult } from "../src/host.ts";
import { createBrowserState, type BrowserState } from "../src/state.ts";

// What agent-browser 0.43.0 prints on stderr for a daemon's first command against an
// attached browser, with or without --json. Captured from a local probe.
const FIRST_COMMAND_STDERR = [
  "⚠ allowed-domains: default →  (--allowed-domains), relaunched browser",
  "⚠ Chrome 157.0.8103.79 is behind the current stable release 158.0.8127.36, which fixes 204 CVEs (CVE-2026-121101, CVE-2026-130904, CVE-2026-130905, +201 more). Update the browser; for agent-browser's Chrome, run `agent-browser install`.",
  "[agent-browser] launched browser",
].join("\n");

const LIFECYCLE = {
  effectiveLaunch: { browserLaunched: true, engine: "chrome", launchHash: 3972041502772628578 },
  launched: true,
  relaunchedBrowser: false,
  restoreStatus: "not_configured",
  reused: false,
  saveStatus: "not_attempted",
  settings: {
    changes: [{ applied: true, effect: "relaunch", option: "allowed-domains", requested: [], running: null }],
    forcedRelaunch: false,
  },
};

const noisy = (stdout: string): ExecResult => ({ stdout: `${stdout}\n`, stderr: `${FIRST_COMMAND_STDERR}\n`, code: 0 });
const envelope = (data: Record<string, unknown>) =>
  noisy(JSON.stringify({ success: true, data: { ...data, lifecycle: LIFECYCLE }, error: null, warning: "Chrome 157 is behind" }));
const has = (args: string[], ...words: string[]) => words.every((word) => args.includes(word));

/** A host whose every agent-browser answer carries the first-command stderr. */
function noisyHost(answer: (args: string[]) => ExecResult | undefined) {
  const calls: string[][] = [];
  const written: Record<string, string> = {};
  const host = {
    calls,
    written,
    async exec(command: string, args: string[]) {
      if (command === "agent-browser" && args[0] === "--version") return { stdout: "agent-browser 0.43.0", stderr: "", code: 0 };
      if (command === "lsof") return { stdout: "Arc 1 user 1u IPv4 TCP 127.0.0.1:9222 (LISTEN)", stderr: "", code: 0 };
      if (command === "curl") return { stdout: '[{"type":"page","url":"about:blank"}]', stderr: "", code: 0 };
      calls.push(args);
      return (
        answer(args) ??
        (has(args, "get", "url") ? noisy("https://example.com/app")
          : has(args, "tab", "list") ? envelope({ tabs: [{ active: true, tabId: "t1", targetId: "TARGET-A", url: "https://example.com/app" }] })
          : noisy("✓ Done"))
      );
    },
    writeFile: async (path: string, text: string) => { written[path] = text; },
    writePrivateFile: async () => {},
    ensureDir: async () => {},
    cwd: "/repo",
    homeDir: "/home",
    sessionId: "session",
    sessionPrefix: "pi",
  };
  return host as typeof host & BrowserHost;
}

const connected = (): BrowserState => ({ ...createBrowserState("/repo"), connected: true, targetId: "TARGET-A" });

test("connect reads a clean URL and target from a daemon's noisy first commands", async () => {
  const host = noisyHost(() => undefined);
  const state = createBrowserState("/repo");
  const result = await connectBrowser(host, state);
  assert.equal(state.currentUrl, "https://example.com/app");
  assert.equal(state.currentDomain, "example.com");
  assert.equal(state.targetId, "TARGET-A");
  assert.match(result.summary, /^Connected to browser via CDP on port 9222 with strict tab pinning\.$/);
  // The daemon re-attaches by itself when --cdp changes (0.42), so connect no longer asks
  // for its endpoint first; `get cdp-url` would fail on a new daemon ("Browser not launched").
  assert.equal(host.calls.some((args) => has(args, "get", "cdp-url")), false);
});

test("--json results parse with settings notices on stderr, and lose the lifecycle block", async () => {
  const host = noisyHost((args) => {
    if (has(args, "get", "box")) return envelope({ x: 80, y: 79.875, width: 46.390625, height: 21 });
    if (has(args, "is", "visible")) return envelope({ visible: true, origin: "https://example.com" });
    return undefined;
  });
  const box = await getBrowserInfo(host, connected(), "box", "#hello", undefined);
  assert.deepEqual((box.diagnostics as Record<string, unknown>).result, { x: 80, y: 79.875, width: 46.390625, height: 21 });
  assert.doesNotMatch(box.contentText ?? "", /lifecycle|relaunched/);
  const visible = await isBrowserState(host, connected(), { check: "visible", selector: "#hello" });
  assert.equal(visible.contentText, "true");
});

test("a snapshot keeps hints and page warnings, and drops daemon notices", async () => {
  const tree = [
    '- button "Delete" [ref=e9] hint="data-testid:del-alpha; in:Alpha row"',
    '- button "Delete" [ref=e10] hint="data-testid:del-beta; in:Beta row"',
    '- button [ref=e5] hint="icon:icon-gear; data-testid:settings-btn"',
  ].join("\n");
  const dialog = '⚠ A JavaScript confirm dialog is open: "Delete?"';
  const host = noisyHost((args) =>
    args.includes("snapshot") ? { stdout: `${tree}\n`, stderr: `${FIRST_COMMAND_STDERR}\n${dialog}\n`, code: 0 } : undefined,
  );
  const result = await snapshotBrowserPage(host, connected(), true);
  assert.equal(result.contentText, `${tree}\n${dialog}`);
  assert.deepEqual(Object.values(host.written), [`${tree}\n${dialog}`]);
});

test("browser_command shows the CLI's own notices", async () => {
  const host = noisyHost((args) =>
    args.includes("--relaunch") ? { stdout: "https://example.com/app\n", stderr: "⚠ browser: relaunched (--relaunch)\n", code: 0 } : undefined,
  );
  const result = await runBrowserCommand(host, connected(), ["--relaunch", "get", "url"], undefined);
  assert.equal(result.contentText, "https://example.com/app\n⚠ browser: relaunched (--relaunch)");
});

test("an outcome_unknown click is reported once and never sent again", async () => {
  const failure = JSON.stringify({
    success: false,
    code: "outcome_unknown",
    error:
      "Failed to read response: websocket connection closed (the command reached the daemon but no response came back; it may or may not have run, so it was not retried)",
  });
  const host = noisyHost((args) => (args.includes("click") ? { stdout: "", stderr: `✗ ${JSON.parse(failure).error}\n`, code: 1 } : undefined));
  const error = await clickBrowserElement(host, connected(), "@e3", "none", false).then(() => undefined, (thrown: unknown) => thrown);
  assert.ok(error instanceof CdpError);
  assert.equal(error.kind, "outcome-unknown");
  assert.match(error.message, /^The command reached the browser daemon but no answer came back/);
  assert.equal(host.calls.filter((args) => args.includes("click")).length, 1);
});

test("a wedged tab is reported as such and not retried on a fresh target", async () => {
  const stdout = JSON.stringify({
    success: false,
    code: "page_wedged",
    data: { targetId: "TARGET-A", replaced: false, lastUrl: "https://example.com/app" },
    error: "page_wedged: the active tab (https://example.com/app) stopped responding; close it or switch tabs to continue",
  });
  const host = noisyHost((args) => (has(args, "get", "title") ? { stdout, stderr: "", code: 1 } : undefined));
  const error = await getBrowserInfo(host, connected(), "title", undefined, undefined).then(() => undefined, (thrown: unknown) => thrown);
  assert.ok(error instanceof CdpError);
  assert.equal(error.kind, "page-wedged");
  assert.match(error.message, /^The controlled tab stopped responding[\s\S]*agent-browser: page_wedged: the active tab/);
  assert.equal(host.calls.filter((args) => has(args, "get", "title")).length, 1);
});

test("joinCliOutput keeps daemon notices out of parsed and displayed output", () => {
  // stderr of a 0.43.0 daemon's first command against an attached browser.
  const firstCommandStderr = [
    "⚠ allowed-domains: default →  (--allowed-domains), relaunched browser",
    "⚠ Chrome 157.0.8103.79 is behind the current stable release 158.0.8127.36, which fixes 204 CVEs (CVE-2026-121101, CVE-2026-130904, CVE-2026-130905, +201 more). Update the browser; for agent-browser's Chrome, run `agent-browser install`.",
    "[agent-browser] launched browser",
  ].join("\n");

  assert.equal(joinCliOutput("https://example.com/\n", firstCommandStderr, "stdout"), "https://example.com/");
  assert.equal(joinCliOutput('- button "Save" [ref=e1]\n', firstCommandStderr), '- button "Save" [ref=e1]');
  assert.equal(joinCliOutput("", firstCommandStderr), "");
  assert.equal(joinCliOutput("ok", firstCommandStderr, "raw"), `ok\n${firstCommandStderr}`);

  // A warning about the page still reaches the agent.
  const dialog = '⚠ A JavaScript confirm dialog is open: "Delete?"';
  assert.equal(joinCliOutput("✓ Done\n", `${firstCommandStderr}\n${dialog}\n`), `✓ Done\n${dialog}`);

  for (const notice of [
    "⚠ cdp: 9222 → 9333 (--cdp), relaunched browser",
    "⚠ capture: default → flow (--capture), relaunched browser",
    "⚠ cdp-headers: default → <redacted> (--cdp-headers), relaunched browser",
    "⚠ browser: relaunched (--relaunch)",
    "\x1b[33m⚠\x1b[0m allowed-domains: default →  (--allowed-domains), relaunched browser",
    "\x1b[2m[agent-browser]\x1b[0m relaunched browser; restore: restored",
  ]) {
    assert.equal(isDaemonNotice(notice), true, notice);
  }
  for (const line of [dialog, "⚠ Element is covered by another element", "✓ Done", "Error: boom"]) {
    assert.equal(isDaemonNotice(line), false, line);
  }
});

test("stripLifecycle drops the daemon block every --json payload carries", () => {
  const lifecycle = { launched: false, reused: true, settings: { changes: [], forcedRelaunch: false } };
  assert.deepEqual(stripLifecycle({ url: "https://example.com/", lifecycle }), { url: "https://example.com/" });
  assert.deepEqual(stripLifecycle({ visible: true }), { visible: true });
  assert.deepEqual(stripLifecycle([1, 2]), [1, 2]);
  assert.equal(stripLifecycle(undefined), undefined);

  // `get box` has no wrapper key, so the block used to come back as part of the box.
  const box = { x: 79.984375, y: 79.875, width: 46.390625, height: 21 };
  assert.deepEqual(extractGetResult("box", { ...box, lifecycle }), box);
  assert.deepEqual(extractGetResult("box", stripLifecycle({ ...box, lifecycle })), box);
});
