// Regenerates src/controlled-tab-favicon.ts from the packaged PNG.
import { readFileSync, writeFileSync } from "node:fs";

const png = readFileSync(new URL("../assets/controlled-tab/favicon-64.png", import.meta.url)).toString("base64");
writeFileSync(
  new URL("../src/controlled-tab-favicon.ts", import.meta.url),
  `// Generated from assets/controlled-tab/favicon-64.png by scripts/build-favicon.mjs; do not edit.\n// Inlined so the marker needs no file read, which the Claude Code mod cannot do at load.\nexport const CONTROLLED_TAB_FAVICON_PNG_BASE64 =\n  "${png}";\n`,
);
