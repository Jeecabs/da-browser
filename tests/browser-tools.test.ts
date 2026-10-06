import assert from "node:assert/strict";
import test from "node:test";

import { BROWSER_TOOLS, prepareBrowserInput, type BrowserToolSpec } from "../src/browser-tools.ts";

// pi and the Claude Code mod both register from this table, so a tool missing here is
// missing in both hosts.

const tool = (name: string): BrowserToolSpec => BROWSER_TOOLS.find((spec) => spec.name === name)!;

test("the table holds all 28 tools, each once", () => {
  const names = BROWSER_TOOLS.map((spec) => spec.name).sort();
  assert.deepEqual(
    names,
    [
      "a11y", "checkpoint", "click", "command", "connect", "cookies", "debug", "eval", "fill", "find",
      "get", "har", "is", "nav", "open", "press", "react", "read", "record", "scroll",
      "select", "set", "snapshot", "status", "tab", "trace", "vitals", "wait",
    ].map((name) => `browser_${name}`),
  );
});

test("required and compat fields name real properties", () => {
  for (const spec of BROWSER_TOOLS) {
    const properties = Object.keys(spec.parameters.properties);
    const { aliases = {}, booleanFields = [], numberFields = [] } = spec.compat ?? {};
    for (const field of [...(spec.parameters.required ?? []), ...Object.values(aliases), ...booleanFields, ...numberFields]) {
      assert.ok(properties.includes(field), `${spec.name}: ${field}`);
    }
    assert.ok(spec.description.length <= 2048, `${spec.name} description is ${spec.description.length} chars`);
  }
});

test("wait turns a legacy numeric selector into ms", () => {
  const prepared = prepareBrowserInput(tool("browser_wait"), { target: " 500 " });
  assert.equal(prepared.selector, undefined);
  assert.equal(prepared.ms, 500);
  assert.equal(prepareBrowserInput(tool("browser_wait"), { selector: 750 }).ms, 750);
});

test("tab stringifies a numeric index", () => {
  assert.equal(prepareBrowserInput(tool("browser_tab"), { action: "switch", index: 2 }).tab, "2");
});

test("read and a11y split comma-separated lists", () => {
  assert.deepEqual(prepareBrowserInput(tool("browser_read"), { domains: "a.com, *.b.com," }).allowedDomains, ["a.com", "*.b.com"]);
  assert.deepEqual(prepareBrowserInput(tool("browser_a11y"), { wcagTags: "wcag2a, wcag2aa" }).tags, ["wcag2a", "wcag2aa"]);
});
