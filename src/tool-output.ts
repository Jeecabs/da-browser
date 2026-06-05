import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

const TOOL_OUTPUT_DIR = path.join(os.tmpdir(), "pi-extension-tool-output");

export interface ToolTextResult {
  text: string;
  truncated: boolean;
  fullOutputFile?: string;
}

function sanitizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "output";
}

export async function formatToolText(
  content: string,
  options: { label: string; mode?: "head" | "tail"; fullOutputFile?: string },
): Promise<ToolTextResult> {
  const truncation = (options.mode ?? "head") === "tail"
    ? truncateTail(content, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      })
    : truncateHead(content, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });

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
      await mkdir(TOOL_OUTPUT_DIR, { recursive: true });
      fullOutputFile = path.join(
        TOOL_OUTPUT_DIR,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${sanitizeLabel(options.label)}.txt`,
      );
      await writeFile(fullOutputFile, content, "utf8");
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
