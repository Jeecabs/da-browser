import { keyHint, type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "expand");
  } catch {
    return "Ctrl+O to expand";
  }
}

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

const MAX_SUMMARY_CHARS = 180;
const TOTAL_KEYS = new Set(["total", "total_count", "total_issues", "count"]);

function humanizeKey(key: string): string {
  return key
    .replace(/^total_/, "")
    .replace(/_only_/g, "-only ")
    .replace(/_/g, " ");
}

function parseJson(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function findTotalEntry(values: Record<string, unknown>): [string, number] | undefined {
  for (const [key, value] of Object.entries(values)) {
    if (TOTAL_KEYS.has(key) && typeof value === "number") return [key, value];
  }
  return undefined;
}

function isNonzeroCategory(entry: [string, unknown]): entry is [string, number] {
  const [key, value] = entry;
  if (TOTAL_KEYS.has(key)) return false;
  if (typeof value !== "number") return false;
  return value !== 0;
}

function formatTotalEntry(entry: [string, number] | undefined): string[] {
  if (!entry) return [];
  const [key, value] = entry;
  const label = key === "total_issues" ? (value === 1 ? "issue" : "issues") : humanizeKey(key);
  return [`${value} ${label}`];
}

function summarizeNumericRecord(values: Record<string, unknown>): string | undefined {
  const parts = formatTotalEntry(findTotalEntry(values));
  const categories = Object.entries(values).filter(isNonzeroCategory);
  parts.push(...categories.slice(0, 5).map(([key, value]) => `${value} ${humanizeKey(key)}`));
  if (categories.length > 5) parts.push(`+${categories.length - 5} more`);
  return parts.join(" · ") || undefined;
}

function summarizeArray(values: unknown[]): string {
  return `${values.length} result${values.length === 1 ? "" : "s"}`;
}

function nestedSummary(values: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(values.summary)) return values.summary;
  return values;
}

function summarizeJson(text: string): string | undefined {
  const parsed = parseJson(text);
  if (Array.isArray(parsed)) return summarizeArray(parsed);
  if (!isRecord(parsed)) return undefined;
  return summarizeNumericRecord(nestedSummary(parsed));
}

function bulletSummary(lines: string[]): string | undefined {
  if (!lines.every((line) => /^[-*]\s/.test(line))) return undefined;
  return `${lines.length} items · ${lines[0]!.replace(/^[-*]\s+/, "")}`;
}

function headingSummary(lines: string[]): string | undefined {
  const first = lines[0] ?? "Done";
  if (!first.endsWith(":")) return undefined;
  if (lines.length === 2) return `${first} ${lines[1]!.replace(/^>\s*/, "")}`;
  return `${first.slice(0, -1)} · ${lines.length - 1} lines`;
}

function summarizeLines(lines: string[]): string {
  const nonempty = lines.map((line) => line.trim()).filter(Boolean);
  return bulletSummary(nonempty) ?? headingSummary(nonempty) ?? nonempty[0] ?? "Done";
}

function clipSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_CHARS) return summary;
  return `${summary.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

export function summarizeToolText(text: string): { summary: string; hiddenLines: number; hasHiddenText: boolean } {
  const trimmed = text.trim();
  if (!trimmed) return { summary: "Done", hiddenLines: 0, hasHiddenText: false };

  const lines = trimmed.split(/\r?\n/);
  const summary = clipSummary(summarizeJson(trimmed) ?? summarizeLines(lines));
  const hiddenLines = Math.max(0, lines.length - 1);
  return { summary, hiddenLines, hasHiddenText: hiddenLines > 0 || summary !== trimmed };
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

  const { summary, hiddenLines, hasHiddenText } = summarizeToolText(text);
  const color = context.isError ? "error" : "success";
  const hidden = hasHiddenText
    ? ` ${theme.fg("dim", `(${hiddenLines || "details"} hidden, ${expandHint()})`)}`
    : "";
  const artifactText = artifacts.length ? `\n${theme.fg("dim", artifacts.slice(0, 2).join("\n"))}` : "";
  const moreArtifacts = artifacts.length > 2 ? theme.fg("dim", `\n… ${artifacts.length - 2} more artifacts`) : "";

  return new Text(`${theme.fg(color, summary)}${hidden}${artifactText}${moreArtifacts}`, 0, 0);
}
