import assert from "node:assert/strict";
import test from "node:test";

import { prepareCompatArguments } from "../src/extension-utils.ts";
import { appendCommonFallowArgs, normalizeCliPath } from "../src/fallow/args.ts";
import { shouldUseRooForCommand } from "../src/roo/command-policy.ts";
import { assertReadOnly } from "../src/supabase/api.ts";
import {
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

test("browser state helpers normalize refs, ports, and persisted state", () => {
  assert.equal(normalizeRef("@@e12"), "e12");
  assert.equal(resolveBrowserPort(9333), 9333);

  const initial = createBrowserState("/tmp/my project", 9333);
  assert.equal(initial.port, 9333);
  assert.equal(initial.connected, false);

  const restored = mergeBrowserState("/tmp/my project", {
    port: 9444,
    connected: true,
    currentUrl: "https://linear.app/foo",
    currentDomain: "linear.app",
    lastAction: "open",
  });

  assert.deepEqual(serializeBrowserState(restored), {
    port: 9444,
    connected: true,
    currentUrl: "https://linear.app/foo",
    currentDomain: "linear.app",
    lastAction: "open",
    lastSnapshotAt: undefined,
    lastSnapshotFile: undefined,
    lastScreenshotFile: undefined,
    lastEvalFile: undefined,
    lastError: undefined,
  });
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
