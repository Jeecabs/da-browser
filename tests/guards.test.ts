import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEmulateArgs,
  buildFindArgs,
  buildIsArgs,
  buildRecordArgs,
  buildSnapshotArgs,
  buildTabArgs,
  buildTraceArgs,
} from "../src/agent-browser-args.ts";
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

  assert.deepEqual(buildFindArgs({ locator: "testid", value: "submit-btn" }), [
    "find",
    "testid",
    "submit-btn",
  ]);
});

test("buildSnapshotArgs composes -i, -c, -d, and -s flags", () => {
  assert.deepEqual(
    buildSnapshotArgs({ interactiveOnly: true, compact: true, depth: 3, selector: "main" }),
    ["snapshot", "-i", "-c", "-d", "3", "-s", "main"],
  );

  assert.deepEqual(buildSnapshotArgs({ interactiveOnly: true }), ["snapshot", "-i"]);
  assert.deepEqual(buildSnapshotArgs({}), ["snapshot"]);
  assert.deepEqual(buildSnapshotArgs({ depth: 0 }), ["snapshot", "-d", "0"]);
});

test("buildFindArgs appends --json when requested", () => {
  assert.deepEqual(
    buildFindArgs({ locator: "role", value: "button", json: true }),
    ["find", "role", "button", "--json"],
  );

  assert.deepEqual(
    buildFindArgs({ locator: "role", value: "button", action: "click", json: true }),
    ["find", "role", "button", "click", "--json"],
  );
});

test("buildTabArgs handles list, new, close, and switch", () => {
  assert.deepEqual(buildTabArgs({ action: "list" }), ["tab", "list", "--json"]);

  assert.deepEqual(buildTabArgs({ action: "new" }), ["tab", "new"]);
  assert.deepEqual(buildTabArgs({ action: "new", url: "https://example.com" }), [
    "tab",
    "new",
    "https://example.com",
  ]);

  assert.deepEqual(buildTabArgs({ action: "close" }), ["tab", "close"]);
  assert.deepEqual(buildTabArgs({ action: "close", index: 2 }), ["tab", "close", "2"]);

  assert.deepEqual(buildTabArgs({ action: "switch", index: 1 }), ["tab", "switch", "1"]);

  assert.throws(() => buildTabArgs({ action: "switch" }), /requires an index/);
  assert.throws(
    () => buildTabArgs({ action: "new", index: 1 }),
    /does not accept an index/,
  );
  assert.throws(
    () => buildTabArgs({ action: "list", url: "https://example.com" }),
    /does not accept url or index/,
  );
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

test("buildEmulateArgs validates per-setting required fields", () => {
  assert.deepEqual(
    buildEmulateArgs({ setting: "viewport", width: 800, height: 600 }),
    ["emulate", "viewport", "800", "600"],
  );
  assert.deepEqual(
    buildEmulateArgs({ setting: "device", device: "iPhone 14" }),
    ["emulate", "device", "iPhone 14"],
  );
  assert.deepEqual(
    buildEmulateArgs({ setting: "geo", latitude: 51.5, longitude: -0.1 }),
    ["emulate", "geo", "51.5", "-0.1"],
  );
  assert.deepEqual(buildEmulateArgs({ setting: "offline", offline: true }), [
    "emulate",
    "offline",
    "true",
  ]);
  assert.deepEqual(buildEmulateArgs({ setting: "offline", offline: false }), [
    "emulate",
    "offline",
    "false",
  ]);
  assert.deepEqual(buildEmulateArgs({ setting: "media", media: "dark" }), [
    "emulate",
    "media",
    "dark",
  ]);
  assert.deepEqual(
    buildEmulateArgs({ setting: "media", media: "light", reducedMotion: true }),
    ["emulate", "media", "light", "--reduced-motion", "reduce"],
  );
  assert.deepEqual(
    buildEmulateArgs({ setting: "media", reducedMotion: false }),
    ["emulate", "media", "--reduced-motion", "no-preference"],
  );

  assert.throws(() => buildEmulateArgs({ setting: "viewport", width: 800 }), /requires width and height/);
  assert.throws(() => buildEmulateArgs({ setting: "device" }), /requires device name/);
  assert.throws(
    () => buildEmulateArgs({ setting: "geo", latitude: 51.5 }),
    /requires latitude and longitude/,
  );
  assert.throws(() => buildEmulateArgs({ setting: "offline" }), /requires offline boolean/);
  assert.throws(() => buildEmulateArgs({ setting: "media" }), /requires media .* or reducedMotion/);
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
