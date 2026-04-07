import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";

import type { BrowserState, WaitMode } from "./state.js";
import { domainFromUrl, normalizeRef, sanitizeArtifactLabel } from "./state.js";

export interface BrowserActionResult {
  summary: string;
  contentText?: string;
  artifacts?: string[];
  diagnostics?: Record<string, unknown>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export async function connectBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
): Promise<BrowserActionResult> {
  await ensureArtifactDir(state);
  await assertAgentBrowserInstalled(pi, ctx);

  const debugPortListening = await isDebugPortListening(pi, state.port, ctx);
  if (!debugPortListening) {
    state.connected = false;
    state.lastAction = "connect";
    state.lastError = `No browser listening on port ${state.port}`;

    return {
      summary: [
        `No browser is listening on port ${state.port}.`,
        "Quit Arc and relaunch it with:",
        `roo /Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=${state.port}`,
      ].join("\n"),
      diagnostics: {
        port: state.port,
        debugPortListening: false,
      },
    };
  }

  // Arc doesn't expose page targets via CDP by default.
  // Create one so agent-browser can connect. This opens a tab in Arc
  // that inherits the user's full auth/cookie context.
  await ensurePageTarget(pi, state.port, ctx);

  // Verify CDP connection works by fetching the current URL
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = "connect";
  state.lastError = undefined;

  return {
    summary: `Connected to browser via CDP on port ${state.port}.`,
    diagnostics: {
      port: state.port,
      currentUrl: state.currentUrl,
      currentDomain: state.currentDomain,
    },
  };
}

export async function openBrowserPage(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  url: string,
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await runAgentBrowser(pi, ["open", url], ctx, 120_000, { port: state.port });
  await waitForLoad(pi, ctx, waitMode, state.port);
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = `open ${url}`;
  state.lastError = undefined;

  return {
    summary: `Opened ${url}.`,
    diagnostics: {
      currentUrl: state.currentUrl,
      currentDomain: state.currentDomain,
      waitMode,
    },
  };
}

export async function snapshotBrowserPage(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  interactiveOnly: boolean,
  label = "snapshot",
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await ensureArtifactDir(state);

  const args = ["snapshot"];
  if (interactiveOnly) args.push("-i");
  const snapshot = await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });

  const snapshotFile = artifactPath(state, label, "txt");
  await writeFile(snapshotFile, snapshot, "utf8");

  state.connected = true;
  state.lastAction = interactiveOnly ? "snapshot -i" : "snapshot";
  state.lastSnapshotAt = Date.now();
  state.lastSnapshotFile = snapshotFile;
  state.lastError = undefined;
  await refreshCurrentUrl(pi, state, ctx);

  return {
    summary: `Captured ${interactiveOnly ? "interactive " : ""}snapshot.`,
    contentText: truncateForTool(snapshot, snapshotFile),
    artifacts: [snapshotFile],
    diagnostics: {
      interactiveOnly,
      snapshotFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function clickBrowserElement(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  ref: string,
  waitMode: WaitMode,
  resnapshot: boolean,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const normalizedRef = normalizeRef(ref);
  await runAgentBrowser(pi, ["click", `@${normalizedRef}`], ctx, 60_000, { port: state.port });
  await waitForLoad(pi, ctx, waitMode, state.port);
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = `click @${normalizedRef}`;
  state.lastError = undefined;

  const result: BrowserActionResult = {
    summary: `Clicked @${normalizedRef}.`,
    diagnostics: {
      ref: normalizedRef,
      waitMode,
      currentUrl: state.currentUrl,
    },
  };

  if (resnapshot) {
    const snapshot = await snapshotBrowserPage(pi, state, ctx, true, `after-click-${normalizedRef}`);
    result.contentText = snapshot.contentText;
    result.artifacts = snapshot.artifacts;
  }

  return result;
}

export async function fillBrowserElement(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  ref: string,
  text: string,
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const normalizedRef = normalizeRef(ref);
  await runAgentBrowser(pi, ["fill", `@${normalizedRef}`, text], ctx, 60_000, { port: state.port });
  await waitForLoad(pi, ctx, waitMode, state.port);
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = `fill @${normalizedRef}`;
  state.lastError = undefined;

  return {
    summary: `Filled @${normalizedRef}.`,
    diagnostics: {
      ref: normalizedRef,
      textLength: text.length,
      waitMode,
      currentUrl: state.currentUrl,
    },
  };
}

export async function selectBrowserOption(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  ref: string,
  option: string,
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const normalizedRef = normalizeRef(ref);
  await runAgentBrowser(pi, ["select", `@${normalizedRef}`, option], ctx, 60_000, { port: state.port });
  await waitForLoad(pi, ctx, waitMode, state.port);
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = `select @${normalizedRef}`;
  state.lastError = undefined;

  return {
    summary: `Selected option on @${normalizedRef}.`,
    diagnostics: {
      ref: normalizedRef,
      option,
      waitMode,
      currentUrl: state.currentUrl,
    },
  };
}

export async function evalInBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  script: string,
  label = "eval",
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await ensureArtifactDir(state);

  const output = await runAgentBrowser(pi, ["eval", script], ctx, 120_000, { port: state.port });
  const evalFile = artifactPath(state, label, "txt");
  await writeFile(evalFile, output, "utf8");
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = "eval";
  state.lastEvalFile = evalFile;
  state.lastError = undefined;

  return {
    summary: "Executed browser eval script.",
    contentText: truncateForTool(output, evalFile),
    artifacts: [evalFile],
    diagnostics: {
      evalFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function checkpointBrowserPage(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  label: string,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await ensureArtifactDir(state);

  const safeLabel = sanitizeArtifactLabel(label);
  const screenshotFile = artifactPath(state, `${safeLabel}-screenshot`, "png");

  await runAgentBrowser(pi, ["screenshot", screenshotFile], ctx, 60_000, { port: state.port });
  state.lastScreenshotFile = screenshotFile;

  const snapshot = await snapshotBrowserPage(pi, state, ctx, true, `${safeLabel}-snapshot`);
  state.connected = true;
  state.lastAction = `checkpoint ${safeLabel}`;
  state.lastError = undefined;

  return {
    summary: `Saved checkpoint ${safeLabel}.`,
    contentText: snapshot.contentText,
    artifacts: [screenshotFile, ...(snapshot.artifacts ?? [])],
    diagnostics: {
      screenshotFile,
      snapshotFile: state.lastSnapshotFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function cleanupBrowserArtifacts(state: BrowserState): Promise<void> {
  state.connected = false;
  state.currentUrl = undefined;
  state.currentDomain = undefined;
}

async function ensureReady(pi: ExtensionAPI, state: BrowserState, ctx: ExtensionContext): Promise<void> {
  await ensureArtifactDir(state);
  await assertAgentBrowserInstalled(pi, ctx);
}

async function assertAgentBrowserInstalled(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const result = (await pi.exec("which", ["agent-browser"], {
    signal: ctx.signal,
    timeout: 5_000,
  })) as CommandResult;

  if (result.code !== 0) {
    throw new Error("agent-browser CLI not found on PATH. Install it with `npm i -g agent-browser`.");
  }
}

async function ensurePageTarget(
  pi: ExtensionAPI,
  port: number,
  ctx: ExtensionContext,
): Promise<void> {
  // Check if a page target already exists
  const result = (await pi.exec("curl", ["-sf", `http://localhost:${port}/json/list`], {
    signal: ctx.signal,
    timeout: 5_000,
  })) as CommandResult;

  if (result.code === 0) {
    try {
      const targets = JSON.parse(result.stdout) as Array<{ type: string }>;
      if (targets.some((t) => t.type === "page")) return;
    } catch { /* fall through to create */ }
  }

  // No page target — create one. This opens a blank tab in Arc.
  const create = (await pi.exec(
    "curl",
    ["-sf", "-X", "PUT", `http://localhost:${port}/json/new?about:blank`],
    { signal: ctx.signal, timeout: 5_000 },
  )) as CommandResult;

  if (create.code !== 0) {
    throw new Error(`Failed to create a page target on port ${port}. Is the browser accepting CDP connections?`);
  }
}

async function isDebugPortListening(
  pi: ExtensionAPI,
  port: number,
  ctx: ExtensionContext,
): Promise<boolean> {
  const result = (await pi.exec("lsof", ["-i", `tcp:${port}`, "-sTCP:LISTEN", "-n", "-P"], {
    signal: ctx.signal,
    timeout: 5_000,
  })) as CommandResult;

  return result.code === 0 && result.stdout.includes(`:${port}`);
}

async function refreshCurrentUrl(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
): Promise<void> {
  const result = await runAgentBrowser(pi, ["get", "url"], ctx, 10_000, { port: state.port, allowFailure: true });
  const url = result.trim();
  state.currentUrl = url || undefined;
  state.currentDomain = domainFromUrl(url);
}

async function runAgentBrowser(
  pi: ExtensionAPI,
  args: string[],
  ctx: ExtensionContext,
  timeout: number,
  options: { allowFailure?: boolean; port?: number } = {},
): Promise<string> {
  const fullArgs = options.port ? ["--cdp", String(options.port), ...args] : args;

  const result = (await pi.exec("agent-browser", fullArgs, {
    signal: ctx.signal,
    timeout,
  })) as CommandResult;

  if (result.code !== 0) {
    if (options.allowFailure) return "";
    throw new Error(formatExecFailure("agent-browser", fullArgs, result));
  }

  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

async function waitForLoad(pi: ExtensionAPI, ctx: ExtensionContext, waitMode: WaitMode, port: number): Promise<void> {
  if (waitMode === "none") return;
  const ms = waitMode === "networkidle" ? 2000 : 1000;
  await runAgentBrowser(pi, ["wait", String(ms)], ctx, ms + 30_000, { port });
}

async function ensureArtifactDir(state: BrowserState): Promise<void> {
  await mkdir(state.artifactDir, { recursive: true });
}

function artifactPath(state: BrowserState, label: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(state.artifactDir, `${timestamp}-${sanitizeArtifactLabel(label)}.${extension}`);
}

function truncateForTool(content: string, artifactPathValue?: string): string {
  const truncation = truncateHead(content, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  const base = truncation.content || "(empty output)";
  if (!truncation.truncated) return base;

  const suffix = [
    `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`,
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
    artifactPathValue ? `Full output saved to: ${artifactPathValue}]` : "]",
  ].join(" ");

  return `${base}\n\n${suffix}`;
}

function formatExecFailure(command: string, args: string[], result: CommandResult): string {
  const details = [
    `Command failed: ${command} ${args.join(" ")}`,
    `Exit code: ${result.code}`,
  ];

  if (result.killed) details.push("Process was killed.");
  if (result.stdout.trim()) details.push(`stdout:\n${result.stdout.trim()}`);
  if (result.stderr.trim()) details.push(`stderr:\n${result.stderr.trim()}`);

  return details.join("\n");
}
