// Regenerates src/controlled-tab-favicon.ts from the packaged PNG.
import { readFileSync, writeFileSync } from "node:fs";

const piPng = readFileSync(new URL("../assets/controlled-tab/favicon-32.png", import.meta.url));
if (piPng.length >= 4096) throw new Error("pi favicon must be under 4 KB");
const png = piPng.toString("base64");
writeFileSync(
  new URL("../src/controlled-tab-favicon.ts", import.meta.url),
  `// Generated from assets/controlled-tab/favicon-32.png by scripts/build-favicon.mjs; do not edit.\n// Inlined so the marker needs no file read, which the Claude Code mod cannot do at load.\nexport const CONTROLLED_TAB_FAVICON_PNG_BASE64 =\n  "${png}";\n`,
);

const claudePng = readFileSync(new URL("../assets/controlled-tab/claude-favicon-32.png", import.meta.url));
if (claudePng.length >= 4096) throw new Error("Claude favicon must be under 4 KB");
writeFileSync(
  new URL("../hooks/claude-favicon.ts", import.meta.url),
  `// Generated from assets/controlled-tab/claude-favicon-32.png by scripts/build-favicon.mjs; do not edit.\n// Embedded cursor and sparkle: no runtime file read or network request.\nexport const CLAUDE_FAVICON_HREF =\n  "data:image/png;base64,${claudePng.toString("base64")}";\n`,
);
