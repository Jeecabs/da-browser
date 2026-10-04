import type { BrowserHost } from "./host.ts";
import { tmpDir } from "./env.ts";
import { join } from "./paths.ts";

// Tool text the model reads, cut to pi's limits (2000 lines or 50KB, whichever first) with
// the full text spilled to a file. Written here rather than imported from pi so the
// Claude Code mod, which has no Node and no pi, shares the same output.

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

export interface ToolTextResult {
  text: string;
  truncated: boolean;
  fullOutputFile?: string;
}

interface Truncation {
  content: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** Whole lines only, from the head or the tail; a single oversized line keeps its end in tail mode. */
export function truncateText(content: string, mode: "head" | "tail", maxLines = MAX_LINES, maxBytes = MAX_BYTES): Truncation {
  const totalBytes = byteLength(content);
  const lines = splitLines(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes };
  }

  const kept: string[] = [];
  let bytes = 0;
  const ordered = mode === "head" ? lines : [...lines].reverse();
  for (const line of ordered) {
    if (kept.length >= maxLines) break;
    const cost = byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) {
      if (mode === "tail" && kept.length === 0) {
        let tail = line;
        while (byteLength(tail) > maxBytes) tail = tail.slice(Math.ceil((byteLength(tail) - maxBytes) / 4) || 1);
        kept.push(tail);
      }
      break;
    }
    kept.push(line);
    bytes += cost;
  }
  const output = (mode === "head" ? kept : kept.reverse()).join("\n");
  return { content: output, truncated: true, totalLines, totalBytes, outputLines: kept.length, outputBytes: byteLength(output) };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sanitizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "output";
}

export async function formatToolText(
  host: Pick<BrowserHost, "writeFile">,
  content: string,
  options: { label: string; mode?: "head" | "tail"; fullOutputFile?: string },
): Promise<ToolTextResult> {
  const truncation = truncateText(content, options.mode ?? "head");

  const base = truncation.content || "(empty output)";
  if (!truncation.truncated) {
    return {
      text: base,
      truncated: false,
    };
  }

  let fullOutputFile = options.fullOutputFile;
  if (!fullOutputFile) {
    try {
      fullOutputFile = join(
        tmpDir(),
        "pi-extension-tool-output",
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${sanitizeLabel(options.label)}.txt`,
      );
      await host.writeFile(fullOutputFile, content);
    } catch {
      fullOutputFile = undefined;
    }
  }

  const suffix = [
    `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`,
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
    fullOutputFile ? `Full output saved to: ${fullOutputFile}]` : "Full output could not be saved.]",
  ].join(" ");

  return {
    text: `${base}\n\n${suffix}`,
    truncated: true,
    fullOutputFile,
  };
}
