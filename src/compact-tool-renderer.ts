import { keyHint, type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function firstTextContent(result: AgentToolResult<unknown>): string {
  const block = result.content.find((item) => item.type === "text");
  return block?.type === "text" ? block.text : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectArtifactLines(details: unknown): string[] {
  if (!isRecord(details)) return [];

  const lines: string[] = [];
  const fullOutputFile = details.fullOutputFile;
  if (typeof fullOutputFile === "string" && fullOutputFile) {
    lines.push(`full: ${fullOutputFile}`);
  }

  const artifacts = details.artifacts;
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      if (typeof artifact === "string" && artifact) lines.push(`artifact: ${artifact}`);
    }
  }

  return lines;
}

function summarizeText(text: string): { summary: string; hiddenLines: number; hasHiddenText: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return { summary: "Done", hiddenLines: 0, hasHiddenText: false };

  const lines = trimmed.split(/\r?\n/);
  const summary = lines.find((line) => line.trim())?.trim() ?? "Done";
  const hiddenLines = Math.max(0, lines.length - 1);
  const hasHiddenText = hiddenLines > 0 || trimmed.length > summary.length;
  return { summary, hiddenLines, hasHiddenText };
}

/**
 * Default-compact TUI renderer for noisy extension tools.
 * The model still receives the normal tool content; only the interactive row is folded.
 */
export function renderCompactToolResult(
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
  context: { isError: boolean },
): Text {
  if (isPartial) {
    return new Text(theme.fg("warning", "Running…"), 0, 0);
  }

  const text = firstTextContent(result);
  const artifacts = collectArtifactLines(result.details);

  if (expanded) {
    const body = text.trim() || "Done";
    const artifactText = artifacts.length ? `\n\n${artifacts.join("\n")}` : "";
    return new Text(`${body}${artifactText}`, 0, 0);
  }

  const { summary, hiddenLines, hasHiddenText } = summarizeText(text);
  const color = context.isError ? "error" : "success";
  const hidden = hasHiddenText
    ? ` ${theme.fg("dim", `(${hiddenLines || "details"} hidden, ${keyHint("app.tools.expand", "expand")})`)}`
    : "";
  const artifactText = artifacts.length ? `\n${theme.fg("dim", artifacts.slice(0, 2).join("\n"))}` : "";
  const moreArtifacts = artifacts.length > 2 ? theme.fg("dim", `\n… ${artifacts.length - 2} more artifacts`) : "";

  return new Text(`${theme.fg(color, summary)}${hidden}${artifactText}${moreArtifacts}`, 0, 0);
}
