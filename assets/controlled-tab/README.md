# Controlled-tab favicon

Warm coral tile with an ivory pointer, generated with the built-in ImageGen tool.
`favicon-source.png` preserves the original transparent output. The 16, 32 and 64 px
PNGs are resized exports; the tab override embeds the 64 px version as a data URL.

Claude Code uses `claude-favicon-source.png`: a coral rounded tile with an ivory
pointer and one four-point sparkle, generated with the built-in ImageGen tool.
The transparent source is preserved, with optimised 16, 32 and 64 px PNG exports.
`hooks/claude-favicon.ts` embeds the 32 px PNG (under 4 KB), without runtime image
processing, filesystem access or network requests. The former `claude-spark.svg`
is retained as an unused historical asset.

Run `node scripts/build-favicon.mjs` after changing either packaged favicon to
regenerate both embedded constants. Run `pnpm preview:control` to compare pi and
Claude on light and dark backgrounds and exercise control/release.

## Claude generation prompt

Single browser favicon: warm coral rounded square tile, one bold ivory mouse
pointer pointing upper left and exactly one separated four-point ivory sparkle
at upper right. Flat front view, simple silhouettes readable at 16 px, transparent
corners, no text, sunburst, extra stars, mockup or shadow outside the tile.

## Generation prompt

Use case: logo-brand
Asset type: browser favicon for an AI agent taking control of a tab, single square image.
Primary request: Create a beautifully restrained, premium app icon: a warm coral-red softly rounded square tile with one bold ivory mouse-pointer arrow pointing toward upper left, optically centered. The pointer is the entire symbol, unmistakable and legible at 16px. Subtle satin-glass depth with a gentle peach highlight at upper left and richer warm red at lower right, very fine edge lighting. Sophisticated, crisp, minimal, quiet. Flat front view, no perspective.
Composition: single icon occupies 94% of the square canvas, centered. Transparent outside the rounded square. Thick simple pointer silhouette occupies 60% of the tile, with a clearly defined arrowhead and short stem. No extra marks.
Color palette: coral #f97066, warm red #dc453e, soft peach #ffb4a0, ivory-white pointer.
Constraints: true transparent background, no text, no letters, no watermark, no drop shadow outside tile, no mockup, no sheet of variants, no sparkle, no robot face, no background scenery. Design specifically for legibility as a tiny browser-tab favicon.
