# Controlled-tab favicon

Blue satin-glass tile with an ivory pointer, generated with the built-in ImageGen tool.
`favicon-source.png` preserves the original transparent output. The 16, 32 and 64 px
PNGs are resized exports; the tab override embeds the 32 px version (under 4 KB) as a data URL.

Claude Code uses `claude-favicon-source.png`: a coral rounded tile with an ivory
pointer and one four-point sparkle, generated with the built-in ImageGen tool.
The transparent source is preserved, with optimised 16, 32 and 64 px PNG exports.
`hooks/claude-favicon.ts` embeds the 32 px PNG (under 4 KB), without runtime image
processing, filesystem access or network requests. The former `claude-spark.svg`
is retained as an unused historical asset.

pi uses a matching blue edge glow; Claude Code keeps its coral edge glow.

Run `node scripts/build-favicon.mjs` after changing either packaged favicon to
regenerate both embedded constants. Run `pnpm preview:control` to compare pi and
Claude on light and dark backgrounds and exercise control/release.

## Claude generation prompt

Single browser favicon: warm coral rounded square tile, one bold ivory mouse
pointer pointing upper left and exactly one separated four-point ivory sparkle
at upper right. Flat front view, simple silhouettes readable at 16 px, transparent
corners, no text, sunburst, extra stars, mockup or shadow outside the tile.

## pi generation prompt

Edit the existing plain-pointer icon into a polished blue sibling. Preserve the
bold ivory pointer pointing upper left, frontal rounded-square composition,
satin-glass depth and transparent corners. Use sky blue `#82c9ff` for the upper-left
highlight, azure `#428fe8` through the middle and deeper blue `#236cc4` towards the
lower right. Keep the pointer legible at 16 px. No sparkle, additional symbol,
text, mockup, backdrop or external shadow. Generated with the built-in ImageGen
tool, then resized into the packaged PNG exports.
