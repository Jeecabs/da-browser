import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync(new URL("../skills/slack/SKILL.md", import.meta.url), "utf8");

test("slack skill frontmatter loads in pi", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  assert.match(frontmatter, /^name: slack$/m);
  const description = frontmatter.match(/^description: (.+)$/m)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length <= 1024, `description length ${description.length}`);
});

test("slack skill eval snippets parse", () => {
  const snippets = [...skill.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.equal(snippets.length, 8);
  for (const snippet of snippets) assert.doesNotThrow(() => new Function(snippet), snippet.slice(0, 80));
});
