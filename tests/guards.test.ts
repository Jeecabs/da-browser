import assert from "node:assert/strict";
import test from "node:test";

import { prepareCompatArguments } from "../src/extension-utils.ts";
import { shouldUseRooForCommand } from "../src/roo/command-policy.ts";
import { assertReadOnly } from "../src/supabase/api.ts";
import {
  createBrowserState,
  mergeBrowserState,
  normalizeRef,
  resolveBrowserPort,
  serializeBrowserState,
} from "../src/state.ts";

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
