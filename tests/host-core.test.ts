import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { agentBrowserSessionName, buildCdpInvocationArgs } from "../src/agent-browser-args.ts";
import { controlledTabMarkScript } from "../src/controlled-tab.ts";
import { basename, dirname, join, resolve } from "../src/paths.ts";
import { sha256Hex } from "../src/sha256.ts";
import { truncateText } from "../src/tool-output.ts";

// The core runs without Node in the Claude Code mod, so its stand-ins for node:crypto and
// node:path must agree with the originals exactly: a different session hash would strand
// every pi session's existing tab binding.

test("sha256Hex matches node:crypto", () => {
  for (const input of ["", "abc", "c2804a12-b277-4e01-a9bf-a1bb9b87f70f", "x".repeat(1000), "ünïcødé ✳"]) {
    assert.equal(sha256Hex(input), createHash("sha256").update(input).digest("hex"));
  }
});

test("pi session names are unchanged and Claude Code sessions get their own prefix", () => {
  const id = "c2804a12-b277-4e01-a9bf-a1bb9b87f70f";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  assert.equal(agentBrowserSessionName(id), `pi-${digest}`);
  assert.equal(agentBrowserSessionName(id, "cc"), `cc-${digest}`);
  assert.deepEqual(buildCdpInvocationArgs(["get", "url"], 9222, id, "cc").slice(0, 4), ["--namespace", "da-browser", "--session", `cc-${digest}`]);
});

test("posix path helpers agree with node:path", () => {
  assert.equal(join("/tmp", "da-browser", "x"), path.join("/tmp", "da-browser", "x"));
  for (const [base, target] of [["/a/b", "../c"], ["/a", "./x/y"], ["/a/b", "/abs/./z"], ["/", "a"]]) {
    assert.equal(resolve(base!, target!), path.resolve(base!, target!));
  }
  assert.equal(dirname("/a/b/c.txt"), path.dirname("/a/b/c.txt"));
  assert.equal(dirname("/a"), path.dirname("/a"));
  assert.equal(basename("/a/b/"), path.basename("/a/b/"));
});

test("truncateText keeps whole lines from the head or the tail", () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
  assert.equal(truncateText(text, "head", 3).content, "line 0\nline 1\nline 2");
  assert.equal(truncateText(text, "tail", 3).content, "line 7\nline 8\nline 9");
  const cut = truncateText(text, "head", 100, 19);
  assert.equal(cut.truncated, true);
  assert.equal(cut.content, "line 0\nline 1");
  assert.equal(truncateText("short", "head").truncated, false);
});

test("the controlled-tab marker takes a host's favicon", () => {
  assert.match(controlledTabMarkScript("x"), /data:image\/png;base64,/);
  const custom = controlledTabMarkScript("x", "data:image/svg+xml,spark");
  assert.match(custom, /data:image\/svg\+xml,spark/);
  assert.doesNotMatch(custom, /data:image\/png;base64,/);
});
