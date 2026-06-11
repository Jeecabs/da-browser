import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFindArgs,
  buildIsArgs,
  buildReactArgs,
  buildRecordArgs,
  buildSetArgs,
  buildSnapshotArgs,
  buildTabArgs,
  buildTraceArgs,
  buildWaitArgs,
  normalizeTabRef,
} from "../src/agent-browser-args.ts";
import {
  extractBooleanResult,
  extractGetResult,
  formatTabTable,
  normalizeTabList,
  unwrapCliEnvelope,
} from "../src/agent-browser-output.ts";
import { prepareCompatArguments } from "../src/extension-utils.ts";
import { classifyCdpError } from "../src/cdp-errors.ts";
import {
  controlledTabLabel,
  controlledTabMarkScript,
  CONTROLLED_TAB_CLEAR_SCRIPT,
} from "../src/controlled-tab.ts";
import { appendCommonFallowArgs, normalizeCliPath } from "../src/fallow/args.ts";
import { shouldUseRooForCommand } from "../src/roo/command-policy.ts";
import { assertReadOnly } from "../src/supabase/api.ts";
import {
  connectionHealth,
  createBrowserState,
  mergeBrowserState,
  normalizeRef,
  resolveBrowserPort,
  serializeBrowserState,
} from "../src/state.ts";
import {
  buildPairSummary,
  createPairState,
  makeSessionNames,
  mergePairState,
  normalizePathInput,
  normalizePrefix,
  resolveStateForPrefix,
  serializePairState,
} from "../src/tmux-cx-pair/state.ts";

test("assertReadOnly allows inspection queries", () => {
  assert.doesNotThrow(() => assertReadOnly("SELECT * FROM foo LIMIT 1"));
  assert.doesNotThrow(() => assertReadOnly("EXPLAIN SELECT * FROM foo"));
  assert.doesNotThrow(() => assertReadOnly("WITH x AS (SELECT 1) SELECT * FROM x"));
  assert.doesNotThrow(() => assertReadOnly("SHOW search_path"));
});

test("assertReadOnly blocks obvious writes", () => {
  for (const sql of [
    "INSERT INTO foo VALUES (1)",
    "UPDATE foo SET bar = 1",
    "DELETE FROM foo",
    "DROP TABLE foo",
    "ALTER TABLE foo ADD COLUMN bar text",
    "TRUNCATE foo",
    "CREATE TABLE foo(id int)",
    "GRANT SELECT ON foo TO bar",
    "REVOKE SELECT ON foo FROM bar",
  ]) {
    assert.throws(() => assertReadOnly(sql));
  }
});

test("prepareCompatArguments applies aliases and primitive coercions", () => {
  const prepared = prepareCompatArguments(
    { selector: "@e1", lines: "42", enabled: "true" },
    {
      aliases: { selector: "ref" },
      numberFields: ["lines"],
      booleanFields: ["enabled"],
    },
  );

  assert.deepEqual(prepared, {
    selector: "@e1",
    ref: "@e1",
    lines: 42,
    enabled: true,
  });
});

test("fallow args normalize @ paths and append common flags", () => {
  assert.equal(normalizeCliPath("@src/index.ts"), "src/index.ts");
  assert.equal(normalizeCliPath("src/index.ts"), "src/index.ts");

  const args: string[] = ["dead-code"];
  appendCommonFallowArgs(args, {
    root: "@/repo",
    config: "@fallow.toml",
    workspace: ["@scope/app", "pkg-*"],
    changedSince: "origin/main",
    production: true,
    format: "json",
    threads: 4,
  });

  assert.deepEqual(args, [
    "dead-code",
    "--root",
    "/repo",
    "--config",
    "fallow.toml",
    "--workspace",
    "@scope/app",
    "--workspace",
    "pkg-*",
    "--changed-since",
    "origin/main",
    "--format",
    "json",
    "--production",
    "--threads",
    "4",
  ]);
});

test("shouldUseRooForCommand catches long-running local commands and leaves containers alone", () => {
  for (const command of [
    "pnpm run dev",
    "npm start",
    "vite dev",
    "tail -f app.log",
    "kubectl port-forward svc/api 8080:80",
    "ngrok http 3000",
    "node --watch server.js",
  ]) {
    assert.equal(shouldUseRooForCommand(command), true, command);
  }

  for (const command of [
    "pnpm install",
    "npm test -- --runInBand",
    "docker compose up -d",
    "podman logs app",
    "roo start npm run dev",
  ]) {
    assert.equal(shouldUseRooForCommand(command), false, command);
  }
});

test("buildFindArgs composes locator, action, name, and exact flags", () => {
  assert.deepEqual(
    buildFindArgs({ locator: "role", value: "button", action: "click", name: "Save" }),
    ["find", "role", "button", "click", "--name", "Save"],
  );

  assert.deepEqual(
    buildFindArgs({ locator: "text", value: "Continue", action: "click", exact: true }),
    ["find", "text", "Continue", "click", "--exact"],
  );

  assert.deepEqual(
    buildFindArgs({ locator: "role", value: "textbox", action: "fill", text: "hello", name: "Email" }),
    ["find", "role", "textbox", "fill", "hello", "--name", "Email"],
  );

  // nth takes the 0-based index as its own positional between locator and selector.
  assert.deepEqual(
    buildFindArgs({ locator: "nth", value: ".card", action: "hover", nthIndex: 2 }),
    ["find", "nth", "2", ".card", "hover"],
  );
});

test("buildFindArgs rejects unsafe or incomplete calls", () => {
  // The CLI defaults a missing action to click — a locate-only call must never slip through.
  assert.throws(
    () => buildFindArgs({ locator: "testid", value: "submit-btn" } as never),
    /requires an action/,
  );
  assert.throws(
    () => buildFindArgs({ locator: "text", value: "Save", action: "press" as never }),
    /requires an action/,
  );
  assert.throws(
    () => buildFindArgs({ locator: "label", value: "Email", action: "fill" }),
    /requires text/,
  );
  assert.throws(
    () => buildFindArgs({ locator: "nth", value: ".card", action: "click" }),
    /requires nthIndex/,
  );
  assert.throws(
    () => buildFindArgs({ locator: "text", value: "Save", action: "click", nthIndex: 1 }),
    /only applies to the 'nth' locator/,
  );
});

test("buildSnapshotArgs composes -i, -u, -c, -d, and -s flags", () => {
  assert.deepEqual(
    buildSnapshotArgs({ interactiveOnly: true, urls: true, compact: true, depth: 3, selector: "main" }),
    ["snapshot", "-i", "-u", "-c", "-d", "3", "-s", "main"],
  );

  assert.deepEqual(buildSnapshotArgs({ interactiveOnly: true }), ["snapshot", "-i"]);
  assert.deepEqual(buildSnapshotArgs({}), ["snapshot"]);
  assert.deepEqual(buildSnapshotArgs({ depth: 0 }), ["snapshot", "-d", "0"]);
});

test("buildTabArgs uses stable string tab ids and labels", () => {
  assert.deepEqual(buildTabArgs({ action: "list" }), ["tab", "list", "--json"]);

  assert.deepEqual(buildTabArgs({ action: "new" }), ["tab", "new"]);
  assert.deepEqual(buildTabArgs({ action: "new", url: "https://example.com" }), [
    "tab",
    "new",
    "https://example.com",
  ]);
  assert.deepEqual(buildTabArgs({ action: "new", label: "docs", url: "https://example.com" }), [
    "tab",
    "new",
    "--label",
    "docs",
    "https://example.com",
  ]);

  assert.deepEqual(buildTabArgs({ action: "close" }), ["tab", "close"]);
  assert.deepEqual(buildTabArgs({ action: "close", tab: "t2" }), ["tab", "close", "t2"]);
  assert.deepEqual(buildTabArgs({ action: "close", tab: "docs" }), ["tab", "close", "docs"]);

  // Switching has no subcommand: `tab <id|label>`. Bare integers coerce to t-ids.
  assert.deepEqual(buildTabArgs({ action: "switch", tab: "t3" }), ["tab", "t3"]);
  assert.deepEqual(buildTabArgs({ action: "switch", tab: "3" }), ["tab", "t3"]);
  assert.deepEqual(buildTabArgs({ action: "switch", tab: "docs" }), ["tab", "docs"]);

  assert.throws(() => buildTabArgs({ action: "switch" }), /requires a tab id/);
  assert.throws(() => buildTabArgs({ action: "new", tab: "t1" }), /does not accept a tab ref/);
  assert.throws(
    () => buildTabArgs({ action: "list", url: "https://example.com" }),
    /does not accept url or tab/,
  );
});

test("normalizeTabRef coerces bare integers to stable t-ids", () => {
  assert.equal(normalizeTabRef("2"), "t2");
  assert.equal(normalizeTabRef(" t2 "), "t2");
  assert.equal(normalizeTabRef("docs"), "docs");
});

test("buildIsArgs covers all three checks and requires a selector", () => {
  assert.deepEqual(buildIsArgs({ check: "visible", selector: "@e1" }), [
    "is",
    "visible",
    "@e1",
    "--json",
  ]);
  assert.deepEqual(buildIsArgs({ check: "enabled", selector: "button" }), [
    "is",
    "enabled",
    "button",
    "--json",
  ]);
  assert.deepEqual(buildIsArgs({ check: "checked", selector: "input#agree" }), [
    "is",
    "checked",
    "input#agree",
    "--json",
  ]);

  assert.throws(() => buildIsArgs({ check: "visible", selector: "" }), /requires a selector/);
});

test("buildSetArgs validates per-setting required fields", () => {
  assert.deepEqual(
    buildSetArgs({ setting: "viewport", width: 800, height: 600 }),
    ["set", "viewport", "800", "600"],
  );
  assert.deepEqual(
    buildSetArgs({ setting: "viewport", width: 800, height: 600, scale: 2 }),
    ["set", "viewport", "800", "600", "2"],
  );
  assert.deepEqual(
    buildSetArgs({ setting: "device", device: "iPhone 14" }),
    ["set", "device", "iPhone 14"],
  );
  assert.deepEqual(
    buildSetArgs({ setting: "geo", latitude: 51.5, longitude: -0.1 }),
    ["set", "geo", "51.5", "-0.1"],
  );
  // Offline toggles use on/off words, not booleans.
  assert.deepEqual(buildSetArgs({ setting: "offline", offline: true }), ["set", "offline", "on"]);
  assert.deepEqual(buildSetArgs({ setting: "offline", offline: false }), ["set", "offline", "off"]);
  // Media options are positional tokens; reduced motion has no negative token.
  assert.deepEqual(buildSetArgs({ setting: "media", media: "dark" }), ["set", "media", "dark"]);
  assert.deepEqual(
    buildSetArgs({ setting: "media", media: "light", reducedMotion: true }),
    ["set", "media", "light", "reduced-motion"],
  );
  assert.deepEqual(
    buildSetArgs({ setting: "media", reducedMotion: true }),
    ["set", "media", "reduced-motion"],
  );
  assert.deepEqual(
    buildSetArgs({ setting: "headers", headers: { "X-Key": "v" } }),
    ["set", "headers", '{"X-Key":"v"}'],
  );
  assert.deepEqual(
    buildSetArgs({ setting: "credentials", username: "admin", password: "secret" }),
    ["set", "credentials", "admin", "secret"],
  );

  assert.throws(() => buildSetArgs({ setting: "viewport", width: 800 }), /requires width and height/);
  assert.throws(() => buildSetArgs({ setting: "device" }), /requires device name/);
  assert.throws(() => buildSetArgs({ setting: "geo", latitude: 51.5 }), /requires latitude and longitude/);
  assert.throws(() => buildSetArgs({ setting: "offline" }), /requires offline boolean/);
  assert.throws(() => buildSetArgs({ setting: "media", reducedMotion: false }), /requires media/);
  assert.throws(() => buildSetArgs({ setting: "headers", headers: {} }), /non-empty headers/);
  assert.throws(() => buildSetArgs({ setting: "credentials", username: "admin" }), /username and password/);
});

test("buildWaitArgs requires exactly one mode and composes flags", () => {
  assert.deepEqual(buildWaitArgs({ selector: "@e3" }), ["wait", "@e3"]);
  assert.deepEqual(buildWaitArgs({ selector: "#spinner", state: "hidden" }), [
    "wait",
    "#spinner",
    "--state",
    "hidden",
  ]);
  assert.deepEqual(buildWaitArgs({ ms: 1500 }), ["wait", "1500"]);
  assert.deepEqual(buildWaitArgs({ text: "Saved" }), ["wait", "--text", "Saved"]);
  assert.deepEqual(buildWaitArgs({ urlPattern: "**/dashboard" }), ["wait", "--url", "**/dashboard"]);
  assert.deepEqual(buildWaitArgs({ load: "networkidle" }), ["wait", "--load", "networkidle"]);
  assert.deepEqual(buildWaitArgs({ fn: "window.ready" }), ["wait", "--fn", "window.ready"]);
  assert.deepEqual(buildWaitArgs({ text: "Saved", timeoutMs: 60000 }), [
    "wait",
    "--text",
    "Saved",
    "--timeout",
    "60000",
  ]);

  assert.throws(() => buildWaitArgs({}), /exactly one of/);
  assert.throws(() => buildWaitArgs({ selector: "@e3", text: "Saved" }), /exactly one of/);
  assert.throws(() => buildWaitArgs({ text: "Saved", state: "hidden" }), /state only applies/);
});

test("buildReactArgs maps commands and validates inspect", () => {
  assert.deepEqual(buildReactArgs({ command: "tree" }), ["react", "tree"]);
  assert.deepEqual(buildReactArgs({ command: "inspect", fiberId: 42 }), ["react", "inspect", "42"]);
  assert.deepEqual(buildReactArgs({ command: "renders-start" }), ["react", "renders", "start"]);
  assert.deepEqual(buildReactArgs({ command: "renders-stop" }), ["react", "renders", "stop"]);
  assert.deepEqual(buildReactArgs({ command: "suspense" }), ["react", "suspense"]);
  assert.deepEqual(buildReactArgs({ command: "suspense", onlyDynamic: true }), [
    "react",
    "suspense",
    "--only-dynamic",
  ]);

  assert.throws(() => buildReactArgs({ command: "inspect" }), /requires fiberId/);
});

test("unwrapCliEnvelope unwraps data and throws CLI errors", () => {
  assert.deepEqual(
    unwrapCliEnvelope({ success: true, data: { title: "Home" }, error: null }),
    { title: "Home" },
  );
  assert.throws(
    () => unwrapCliEnvelope({ success: false, data: null, error: "Element not found." }),
    /Element not found/,
  );
  // Non-envelope shapes pass through untouched.
  assert.deepEqual(unwrapCliEnvelope([1, 2]), [1, 2]);
  assert.equal(unwrapCliEnvelope("plain"), "plain");
});

test("extractGetResult and extractBooleanResult read named data fields", () => {
  assert.equal(extractGetResult("title", { title: "Home" }), "Home");
  assert.equal(extractGetResult("url", { url: "https://x.dev" }), "https://x.dev");
  assert.equal(extractGetResult("attr", { origin: "https://x.dev", value: "btn primary" }), "btn primary");
  assert.equal(extractGetResult("count", { count: 12, selector: "a" }), 12);
  assert.equal(extractGetResult("cdp-url", { cdpUrl: "ws://127.0.0.1:9222/x" }), "ws://127.0.0.1:9222/x");
  // box has no wrapper key — the data object IS the box.
  assert.deepEqual(extractGetResult("box", { x: 0, y: 1, width: 2, height: 3 }), {
    x: 0,
    y: 1,
    width: 2,
    height: 3,
  });
  // origin noise is stripped before lone-key unwrapping.
  assert.equal(extractGetResult("text", { origin: "https://x.dev", text: "hello" }), "hello");

  assert.equal(extractBooleanResult("visible", { origin: "https://x.dev", visible: true }), true);
  assert.equal(extractBooleanResult("enabled", { enabled: false, origin: "https://x.dev" }), false);
  assert.equal(extractBooleanResult("checked", true), true);
  assert.throws(() => extractBooleanResult("visible", { origin: "https://x.dev" }), /expected a boolean/);
});

test("normalizeTabList and formatTabTable surface stable ids and labels", () => {
  const tabs = normalizeTabList({
    tabs: [
      { tabId: "t2", label: null, active: true, title: "Home", url: "https://x.dev", type: "page" },
      { tabId: "t3", label: "docs", active: false, title: "Docs", url: "https://x.dev/docs", type: "page" },
    ],
  });
  assert.equal(tabs.length, 2);

  const table = formatTabTable(tabs);
  assert.match(table, /t2 \*/);
  assert.match(table, /t3 {3}\[docs\] Docs/);
  assert.equal(formatTabTable([]), "(no tabs)");

  assert.deepEqual(normalizeTabList({ unexpected: true }), []);
});

test("buildRecordArgs and buildTraceArgs cover start with/without label and stop", () => {
  assert.deepEqual(buildRecordArgs({ action: "start" }), ["record", "start"]);
  assert.deepEqual(buildRecordArgs({ action: "start", file: "/tmp/x.webm" }), [
    "record",
    "start",
    "/tmp/x.webm",
  ]);
  assert.deepEqual(buildRecordArgs({ action: "stop" }), ["record", "stop"]);
  assert.throws(
    () => buildRecordArgs({ action: "stop", file: "/tmp/x.webm" }),
    /does not accept a file path/,
  );

  assert.deepEqual(buildTraceArgs({ action: "start" }), ["trace", "start"]);
  assert.deepEqual(buildTraceArgs({ action: "start", file: "/tmp/t.zip" }), [
    "trace",
    "start",
    "/tmp/t.zip",
  ]);
  assert.deepEqual(buildTraceArgs({ action: "stop" }), ["trace", "stop"]);
  assert.throws(
    () => buildTraceArgs({ action: "stop", file: "/tmp/t.zip" }),
    /does not accept a file path/,
  );
});

test("prepareCompatArguments for browser_find aliases role/element and coerces exact", () => {
  const aliased = prepareCompatArguments(
    { role: "button" },
    {
      aliases: { role: "value", element: "value" },
      booleanFields: ["exact", "resnapshot"],
    },
  );
  assert.equal((aliased as { value?: string }).value, "button");

  const bothKeys = prepareCompatArguments(
    { role: "button", value: "link" },
    {
      aliases: { role: "value", element: "value" },
      booleanFields: ["exact", "resnapshot"],
    },
  );
  assert.equal((bothKeys as { value?: string }).value, "link");

  const coerced = prepareCompatArguments(
    { exact: "true", resnapshot: "false" },
    {
      aliases: { role: "value", element: "value" },
      booleanFields: ["exact", "resnapshot"],
    },
  );
  assert.equal((coerced as { exact?: boolean }).exact, true);
  assert.equal((coerced as { resnapshot?: boolean }).resnapshot, false);
});

test("browser state helpers normalize refs, ports, and persisted state", () => {
  assert.equal(normalizeRef("@@e12"), "e12");
  assert.equal(resolveBrowserPort(9333), 9333);

  const initial = createBrowserState("/tmp/my project", 9333, 4949);
  assert.equal(initial.port, 9333);
  assert.equal(initial.dashboardPort, 4949);
  assert.equal(initial.connected, false);

  const restored = mergeBrowserState(
    "/tmp/my project",
    {
      port: 9444,
      dashboardPort: 4848,
      connected: true,
      currentUrl: "https://linear.app/foo",
      currentDomain: "linear.app",
      dashboardUrl: "http://localhost:4848",
      lastAction: "open",
      recording: { file: "/tmp/rec.webm", startedAt: 1700000000000 },
      tracing: { file: "/tmp/trace.zip", startedAt: 1700000001000 },
    },
    9222,
    4848,
  );

  assert.deepEqual(serializeBrowserState(restored), {
    port: 9444,
    dashboardPort: 4848,
    connected: true,
    currentUrl: "https://linear.app/foo",
    currentDomain: "linear.app",
    dashboardUrl: "http://localhost:4848",
    lastAction: "open",
    lastSnapshotAt: undefined,
    lastSnapshotFile: undefined,
    lastScreenshotFile: undefined,
    lastEvalFile: undefined,
    lastError: undefined,
    lastVerifiedAt: undefined,
    recording: { file: "/tmp/rec.webm", startedAt: 1700000000000 },
    tracing: { file: "/tmp/trace.zip", startedAt: 1700000001000 },
  });
});

test("classifyCdpError maps CDP failures to recovery kinds", () => {
  assert.equal(
    classifyCdpError(
      "✗ Failed to connect via CDP to ws://localhost:9222. Make sure the app is running with --remote-debugging-port=9222",
    ),
    "browser-down",
  );
  assert.equal(classifyCdpError("net::ERR_CONNECTION_REFUSED"), "browser-down");
  assert.equal(classifyCdpError("Error: Target closed"), "target-gone");
  assert.equal(classifyCdpError("No page target found"), "target-gone");
  assert.equal(classifyCdpError("Protocol error: No target with given id found"), "target-gone");
  assert.equal(classifyCdpError("Execution context was destroyed"), "target-gone");
  assert.equal(classifyCdpError("Timeout 30000ms exceeded"), "page-busy");
  // Action-level errors must NOT be classified as connection failures (no false retry).
  assert.equal(classifyCdpError("Element not found: @e5"), "unknown");
  assert.equal(classifyCdpError(""), "unknown");
});

test("controlled-tab overlay builds safe, valid inject scripts", () => {
  assert.equal(controlledTabLabel("supabase.com"), "pi agent · supabase.com");

  const script = controlledTabMarkScript(controlledTabLabel("supabase.com"));
  // Parses as valid JS (document refs aren't evaluated by Function()).
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /pi agent · supabase\.com/);
  // Label is applied via textContent, not innerHTML.
  assert.match(script, /\.textContent = labelText/);

  // A label that tries to break out of the JS string is JSON-encoded, so the script stays
  // valid (no injection) and the payload appears only in escaped form.
  const payload = '"; alert(1); //';
  const nasty = controlledTabMarkScript(payload);
  assert.doesNotThrow(() => new Function(nasty));
  assert.ok(nasty.includes(JSON.stringify(payload)));

  assert.doesNotThrow(() => new Function(CONTROLLED_TAB_CLEAR_SCRIPT));
});

test("connectionHealth reflects liveness honestly", () => {
  const base = createBrowserState("/tmp/proj", 9222, 4848);
  const now = 1_700_000_000_000;

  assert.equal(connectionHealth({ ...base, connected: false }, now), "down");
  assert.equal(connectionHealth({ ...base, connected: true, lastVerifiedAt: now }, now + 1_000), "ok");
  // Connected but not confirmed for > 5 min → suspect (◐ stale), not a confident ●.
  assert.equal(connectionHealth({ ...base, connected: true, lastVerifiedAt: now }, now + 6 * 60_000), "suspect");
  // Connected with no verification timestamp yet → no staleness evidence, treat as ok.
  assert.equal(connectionHealth({ ...base, connected: true }, now), "ok");
});

test("tmux cx pair helpers normalize names, paths, and persisted state", () => {
  assert.equal(normalizePrefix(" Feature/API!! "), "feature-api");
  assert.equal(normalizePrefix(undefined), undefined);
  assert.throws(() => normalizePrefix("!!!"), /Prefix/);

  assert.deepEqual(makeSessionNames("feature-api"), {
    leftSession: "feature-api-left",
    rightSession: "feature-api-right",
  });

  assert.equal(normalizePathInput("@src", "/tmp/repo"), "/tmp/repo/src");
  assert.equal(normalizePathInput("/tmp/other", "/tmp/repo"), "/tmp/other");

  const initial = createPairState("/tmp/repo");
  assert.deepEqual(serializePairState(initial), { cwd: "/tmp/repo" });

  const restored = mergePairState("/tmp/repo", {
    cwd: "/work",
    prefix: "feature-api",
    leftSession: "feature-api-left",
    rightSession: "feature-api-right",
    goal: "ship it",
    leftRole: "builder",
    rightRole: "tester",
  });

  assert.equal(restored.cwd, "/work");
  assert.equal(restored.leftRole, "builder");

  const other = resolveStateForPrefix(restored, "Other Pair");
  assert.equal(other.prefix, "other-pair");
  assert.equal(other.leftSession, "other-pair-left");
  assert.equal(other.goal, undefined);
});

test("tmux cx pair summary includes runtime health", () => {
  const text = buildPairSummary(
    {
      cwd: "/tmp/repo",
      prefix: "feature-api",
      goal: "ship it",
      leftRole: "builder",
      rightRole: "tester",
    },
    {
      left: { session: "feature-api-left", exists: true, currentCommand: "node", currentPath: "/tmp/repo" },
      right: { session: "feature-api-right", exists: false },
    },
  );

  assert.match(text, /prefix=feature-api/);
  assert.match(text, /left: running/);
  assert.match(text, /right: missing/);
});
