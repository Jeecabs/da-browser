import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  getMarkdownTheme,
  highlightCode,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, hyperlink, Image, Markdown, Text, type Component } from "@earendil-works/pi-tui";

import { explainFailure, formatBody, resultLine, type Presentation } from "./browser-ui.js";
import { firstTextContent, isRecord, renderCompactToolResult } from "./compact-tool-renderer.js";

function presentationOf(details: unknown): Presentation | undefined {
  if (!isRecord(details) || !isRecord(details.presentation)) return undefined;
  const presentation = details.presentation as unknown as Presentation;
  return Array.isArray(presentation.facts) && Array.isArray(presentation.files) ? presentation : undefined;
}

// Screenshots are read once per path; a missing file just means no thumbnail.
const imageCache = new Map<string, string | null>();

function thumbnail(path: string, theme: Theme, expanded: boolean): Component | undefined {
  if (!imageCache.has(path)) {
    try {
      imageCache.set(path, readFileSync(path).toString("base64"));
    } catch {
      imageCache.set(path, null);
    }
  }
  const data = imageCache.get(path);
  if (!data) return undefined;
  const mimeType = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
  return new Image(
    data,
    mimeType,
    { fallbackColor: (text) => theme.fg("dim", text) },
    expanded ? { maxWidthCells: 80, maxHeightCells: 30 } : { maxWidthCells: 36, maxHeightCells: 12 },
  );
}

function expandedBody(body: string, presentation: Presentation, theme: Theme): Component {
  if (presentation.bodyKind === "markdown") return new Markdown(body, 0, 0, getMarkdownTheme());
  if (presentation.bodyKind === "code") {
    try {
      return new Text(highlightCode(body, "json").join("\n"), 0, 0);
    } catch {
      return new Text(theme.fg("muted", body), 0, 0);
    }
  }
  return new Text(formatBody(theme, presentation.bodyKind, body), 0, 0);
}

/**
 * Browser result rows. Collapsed: one line of what changed or was learned, a thumbnail for
 * screenshots, nothing at all for a plain success. Expanded: the output, coloured by kind.
 * Results from before this renderer existed fall back to the compact summary.
 */
export function renderBrowserResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { isError: boolean; showImages?: boolean },
): Component {
  if (options.isPartial) return new Text("", 0, 0);
  const text = firstTextContent(result);

  if (context.isError) {
    const { reason, hint } = explainFailure(text);
    const line = theme.fg("error", reason) + (hint ? `  ${theme.fg("dim", hint)}` : "");
    return new Text(options.expanded ? `${line}\n\n${theme.fg("muted", text.trim())}` : line, 0, 0);
  }

  const presentation = presentationOf(result.details);
  if (!presentation) return renderCompactToolResult(result, options, theme, context);

  const container = new Container();
  const line = resultLine(theme, presentation);
  if (line) container.addChild(new Text(line, 0, 0));

  if (options.expanded) {
    const body = text.startsWith(presentation.summary) ? text.slice(presentation.summary.length).trim() : text.trim();
    if (body) container.addChild(expandedBody(body, presentation, theme));
    if (presentation.files.length) {
      const files = presentation.files.map((file) => theme.fg("dim", hyperlink(file, pathToFileURL(file).href)));
      container.addChild(new Text(files.join("\n"), 0, 0));
    }
  }

  if (presentation.image && context.showImages !== false) {
    const image = thumbnail(presentation.image, theme, options.expanded);
    if (image) container.addChild(image);
  }
  return container;
}
