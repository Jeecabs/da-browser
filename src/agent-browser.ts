import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  buildEmulateArgs,
  buildFindArgs,
  buildIsArgs,
  buildRecordArgs,
  buildSnapshotArgs,
  buildTabArgs,
  buildTraceArgs,
  type CaptureAction,
  type EmulateArgsOptions,
  type FindArgsOptions,
  type IsArgsOptions,
  type TabArgsOptions,
} from "./agent-browser-args.js";
import type { BrowserState, WaitMode } from "./state.js";
import { domainFromUrl, normalizeRef, sanitizeArtifactLabel } from "./state.js";
import { formatToolText } from "./tool-output.js";

export {
  buildEmulateArgs,
  buildFindArgs,
  buildIsArgs,
  buildRecordArgs,
  buildSnapshotArgs,
  buildTabArgs,
  buildTraceArgs,
};
export type {
  CaptureAction,
  CaptureArgsOptions,
  EmulateArgsOptions,
  EmulateSetting,
  FindArgsOptions,
  IsArgsOptions,
  IsCheck,
  SnapshotArgsOptions,
  TabAction,
  TabArgsOptions,
} from "./agent-browser-args.js";

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

  const debugPortListening = await isPortListening(pi, state.port, ctx);
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
  await refreshDashboardUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = "connect";
  state.lastError = undefined;

  return {
    summary: `Connected to browser via CDP on port ${state.port}.`,
    diagnostics: {
      port: state.port,
      currentUrl: state.currentUrl,
      currentDomain: state.currentDomain,
      dashboardUrl: state.dashboardUrl,
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
  options: { compact?: boolean; depth?: number; selector?: string } = {},
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await ensureArtifactDir(state);

  const args = buildSnapshotArgs({ interactiveOnly, ...options });
  const snapshot = await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });

  const snapshotFile = artifactPath(state, label, "txt");
  await writeFile(snapshotFile, snapshot, "utf8");

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastSnapshotAt = Date.now();
  state.lastSnapshotFile = snapshotFile;
  state.lastError = undefined;
  await refreshCurrentUrl(pi, state, ctx);

  return {
    summary: `Captured ${interactiveOnly ? "interactive " : ""}snapshot.`,
    contentText: await truncateForTool(snapshot, snapshotFile),
    artifacts: [snapshotFile],
    diagnostics: {
      interactiveOnly,
      compact: options.compact,
      depth: options.depth,
      selector: options.selector,
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

export async function findBrowserElement(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: FindArgsOptions & { waitMode?: WaitMode; resnapshot?: boolean },
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const hasAction = Boolean(params.action);
  const args = buildFindArgs({ ...params, json: !hasAction });

  let matches: unknown = undefined;
  let output = "";
  if (hasAction) {
    output = await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });
  } else {
    const parsed = await runAgentBrowserJSON(pi, args, ctx, 60_000, { port: state.port });
    matches = extractFindMatches(parsed);
    output = JSON.stringify(matches ?? parsed, null, 2);
  }

  const waitMode = params.waitMode ?? (hasAction ? "networkidle" : "none");
  await waitForLoad(pi, ctx, waitMode, state.port);
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  const summary = hasAction
    ? `Found ${params.locator}=${params.value} and ${params.action}.`
    : `Found ${params.locator}=${params.value}.`;

  const result: BrowserActionResult = {
    summary,
    diagnostics: {
      locator: params.locator,
      value: params.value,
      action: params.action,
      name: params.name,
      exact: params.exact,
      matches,
      waitMode,
      currentUrl: state.currentUrl,
    },
  };

  const willResnapshot = (params.resnapshot ?? hasAction) && hasAction;
  if (willResnapshot) {
    const snapshot = await snapshotBrowserPage(
      pi,
      state,
      ctx,
      true,
      `after-find-${sanitizeArtifactLabel(params.locator)}`,
    );
    result.contentText = snapshot.contentText;
    result.artifacts = snapshot.artifacts;
  } else if (output) {
    result.contentText = output;
  }

  return result;
}

function extractFindMatches(parsed: unknown): unknown {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if ("matches" in obj) return obj.matches;
    if ("result" in obj) return obj.result;
  }
  return parsed;
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

export async function pressBrowserKey(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  key: string,
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await runAgentBrowser(pi, ["press", key], ctx, 60_000, { port: state.port });
  await waitForLoad(pi, ctx, waitMode, state.port);
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = `press ${key}`;
  state.lastError = undefined;

  return {
    summary: `Pressed ${key}.`,
    diagnostics: {
      key,
      waitMode,
      currentUrl: state.currentUrl,
    },
  };
}

export async function scrollBrowserPage(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  direction: "up" | "down" | "left" | "right",
  pixels: number | undefined,
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  const args = ["scroll", direction];
  if (typeof pixels === "number") args.push(String(pixels));
  await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });
  await waitForLoad(pi, ctx, waitMode, state.port);
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = `scroll ${direction}${pixels ? ` ${pixels}` : ""}`;
  state.lastError = undefined;

  return {
    summary: `Scrolled ${direction}${pixels ? ` ${pixels}px` : ""}.`,
    diagnostics: {
      direction,
      pixels,
      waitMode,
      currentUrl: state.currentUrl,
    },
  };
}

export async function waitInBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  target: string,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await runAgentBrowser(pi, ["wait", target], ctx, 120_000, { port: state.port });
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = `wait ${target}`;
  state.lastError = undefined;

  return {
    summary: `Waited for ${target}.`,
    diagnostics: {
      target,
      currentUrl: state.currentUrl,
    },
  };
}

export async function navigateBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  action: "back" | "forward" | "reload",
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await runAgentBrowser(pi, [action], ctx, 60_000, { port: state.port });
  await waitForLoad(pi, ctx, waitMode, state.port);
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = action;
  state.lastError = undefined;

  return {
    summary: `Browser ${action} complete.`,
    diagnostics: {
      action,
      waitMode,
      currentUrl: state.currentUrl,
      currentDomain: state.currentDomain,
    },
  };
}

export async function getBrowserInfo(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  what: "text" | "html" | "value" | "attr" | "title" | "url" | "count" | "box" | "styles",
  selector: string | undefined,
  attrName: string | undefined,
  label = "get",
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  const args = ["get", what];
  if (what === "attr") {
    if (!attrName) throw new Error("browser_get with what='attr' requires attrName.");
    args.push(attrName);
  }
  if (selector) args.push(selector);

  const parsed = await runAgentBrowserJSON(pi, args, ctx, 60_000, { port: state.port });
  const result = extractGetResult(parsed);
  const summaryText = formatGetResult(what, result);
  const formatted = await formatToolText(summaryText, { label: `browser-${label}`, mode: "head" });

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: `Read browser ${what}.`,
    contentText: formatted.text,
    artifacts: formatted.fullOutputFile ? [formatted.fullOutputFile] : undefined,
    diagnostics: {
      what,
      selector,
      attrName,
      result,
      fullOutputFile: formatted.fullOutputFile,
      currentUrl: state.currentUrl,
    },
  };
}

function extractGetResult(parsed: unknown): unknown {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "result" in parsed) {
    return (parsed as { result: unknown }).result;
  }
  return parsed;
}

function formatGetResult(
  what: "text" | "html" | "value" | "attr" | "title" | "url" | "count" | "box" | "styles",
  result: unknown,
): string {
  if (result === undefined || result === null) return "(no result)";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (what === "box" || what === "styles" || typeof result === "object") {
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

export async function debugBrowserPage(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  kind: "console" | "errors" | "network-requests",
  options: { clear?: boolean; filter?: string; label?: string },
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  const args = kind === "network-requests" ? ["network", "requests"] : [kind];
  if (options.clear) args.push("--clear");
  if (kind === "network-requests" && options.filter) args.push("--filter", options.filter);

  const output = await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });
  const formatted = await formatToolText(output || "(no output)", {
    label: `browser-${options.label ?? kind}`,
    mode: "tail",
  });

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: `Collected browser ${kind}.`,
    contentText: formatted.text,
    artifacts: formatted.fullOutputFile ? [formatted.fullOutputFile] : undefined,
    diagnostics: {
      kind,
      clear: options.clear,
      filter: options.filter,
      fullOutputFile: formatted.fullOutputFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function runBrowserCommand(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  args: string[],
  timeoutMs: number | undefined,
  label = "command",
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  const safeArgs = normalizeBrowserCommandArgs(args);
  const timeout = Math.min(Math.max(timeoutMs ?? 60_000, 1_000), 300_000);
  const output = await runAgentBrowser(pi, safeArgs, ctx, timeout, { port: state.port });
  await refreshCurrentUrl(pi, state, ctx);
  const formatted = await formatToolText(output || "(no output)", {
    label: `browser-${label}`,
    mode: "head",
  });

  state.connected = true;
  state.lastAction = safeArgs.join(" ");
  state.lastError = undefined;

  return {
    summary: `Ran agent-browser ${safeArgs.join(" ")}.`,
    contentText: formatted.text,
    artifacts: formatted.fullOutputFile ? [formatted.fullOutputFile] : undefined,
    diagnostics: {
      args: safeArgs,
      timeoutMs: timeout,
      fullOutputFile: formatted.fullOutputFile,
      currentUrl: state.currentUrl,
      currentDomain: state.currentDomain,
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

  state.connected = true;
  state.lastAction = "eval";
  state.lastEvalFile = evalFile;
  state.lastError = undefined;

  return {
    summary: "Executed browser eval script.",
    contentText: await truncateForTool(output, evalFile),
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

export async function tabBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: TabArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const args = buildTabArgs(params);
  const result: BrowserActionResult = {
    summary: "",
    diagnostics: {
      action: params.action,
      url: params.url,
      index: params.index,
    },
  };

  if (params.action === "list") {
    const parsed = await runAgentBrowserJSON(pi, args, ctx, 30_000, { port: state.port });
    const tabs = normalizeTabList(parsed);
    result.summary = `Listed ${tabs.length} tab${tabs.length === 1 ? "" : "s"}.`;
    result.contentText = formatTabTable(tabs);
    (result.diagnostics as Record<string, unknown>).tabs = tabs;
    state.lastAction = args.join(" ");
    state.connected = true;
    state.lastError = undefined;
    return result;
  }

  await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });
  await refreshCurrentUrl(pi, state, ctx);

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  const verb =
    params.action === "new"
      ? params.url ? `Opened new tab ${params.url}.` : "Opened new tab."
      : params.action === "close"
        ? params.index !== undefined ? `Closed tab ${params.index}.` : "Closed current tab."
        : `Switched to tab ${params.index}.`;
  result.summary = verb;
  (result.diagnostics as Record<string, unknown>).currentUrl = state.currentUrl;
  (result.diagnostics as Record<string, unknown>).currentDomain = state.currentDomain;
  return result;
}

function normalizeTabList(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed.filter(isPlainObject) as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.tabs)) return obj.tabs.filter(isPlainObject) as Array<Record<string, unknown>>;
    if (Array.isArray(obj.result)) return obj.result.filter(isPlainObject) as Array<Record<string, unknown>>;
  }
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatTabTable(tabs: Array<Record<string, unknown>>): string {
  if (tabs.length === 0) return "(no tabs)";
  return tabs
    .map((tab, i) => {
      const index = "index" in tab ? tab.index : i;
      const url = typeof tab.url === "string" ? tab.url : "";
      const title = typeof tab.title === "string" ? tab.title : "";
      const active = tab.active ? " *" : "";
      const titlePart = title ? ` ${title}` : "";
      const urlPart = url ? `  ${url}` : "";
      return `${String(index).padStart(2)}${active}${titlePart}${urlPart}`;
    })
    .join("\n");
}

export async function isBrowserState(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: IsArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const args = buildIsArgs(params);
  const parsed = await runAgentBrowserJSON(pi, args, ctx, 30_000, { port: state.port });
  const value = extractBooleanResult(parsed);

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: `${params.selector} ${params.check}: ${value}`,
    contentText: String(value),
    diagnostics: {
      check: params.check,
      selector: params.selector,
      result: value,
    },
  };
}

function extractBooleanResult(parsed: unknown): boolean {
  if (typeof parsed === "boolean") return parsed;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.result === "boolean") return obj.result;
    if (typeof obj.value === "boolean") return obj.value;
  }
  throw new Error(`browser_is expected a boolean result, got: ${JSON.stringify(parsed)}`);
}

export async function emulateBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: EmulateArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const args = buildEmulateArgs(params);
  await runAgentBrowser(pi, args, ctx, 30_000, { port: state.port });

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: `Emulated ${params.setting}.`,
    diagnostics: {
      setting: params.setting,
      width: params.width,
      height: params.height,
      device: params.device,
      latitude: params.latitude,
      longitude: params.longitude,
      offline: params.offline,
      media: params.media,
      reducedMotion: params.reducedMotion,
    },
  };
}

export async function recordBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: { action: CaptureAction; label?: string },
): Promise<BrowserActionResult> {
  return captureRecording(pi, state, ctx, params, {
    kind: "recording",
    extension: "webm",
    buildArgs: buildRecordArgs,
  });
}

export async function traceBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: { action: CaptureAction; label?: string },
): Promise<BrowserActionResult> {
  return captureRecording(pi, state, ctx, params, {
    kind: "tracing",
    extension: "zip",
    buildArgs: buildTraceArgs,
  });
}

async function captureRecording(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: { action: CaptureAction; label?: string },
  options: {
    kind: "recording" | "tracing";
    extension: string;
    buildArgs: (input: { action: CaptureAction; file?: string }) => string[];
  },
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await ensureArtifactDir(state);

  if (params.action === "start") {
    const label = params.label ?? options.kind;
    const file = artifactPath(state, label, options.extension);
    const args = options.buildArgs({ action: "start", file });
    await runAgentBrowser(pi, args, ctx, 30_000, { port: state.port });
    state[options.kind] = { file, startedAt: Date.now() };
    state.connected = true;
    state.lastAction = args.join(" ");
    state.lastError = undefined;
    await refreshCurrentUrl(pi, state, ctx);

    return {
      summary: `Started ${options.kind} → ${file}`,
      diagnostics: {
        action: "start",
        file,
        currentUrl: state.currentUrl,
      },
    };
  }

  const previous = state[options.kind];
  const args = options.buildArgs({ action: "stop" });
  await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });
  state[options.kind] = undefined;
  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: previous ? `Stopped ${options.kind} → ${previous.file}` : `Stopped ${options.kind}.`,
    artifacts: previous?.file ? [previous.file] : undefined,
    diagnostics: {
      action: "stop",
      file: previous?.file,
      durationMs: previous ? Date.now() - previous.startedAt : undefined,
    },
  };
}

export async function cleanupBrowserArtifacts(state: BrowserState): Promise<void> {
  state.connected = false;
  state.currentUrl = undefined;
  state.currentDomain = undefined;
  state.dashboardUrl = undefined;
  state.recording = undefined;
  state.tracing = undefined;
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

async function isPortListening(
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

async function refreshDashboardUrl(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
): Promise<void> {
  if (await isPortListening(pi, state.dashboardPort, ctx)) {
    state.dashboardUrl = `http://localhost:${state.dashboardPort}`;
  } else {
    state.dashboardUrl = undefined;
  }
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

async function runAgentBrowserJSON(
  pi: ExtensionAPI,
  args: string[],
  ctx: ExtensionContext,
  timeout: number,
  options: { port?: number } = {},
): Promise<unknown> {
  const argsWithJson = args.includes("--json") ? args : [...args, "--json"];
  const output = await runAgentBrowser(pi, argsWithJson, ctx, timeout, options);
  if (!output) return undefined;

  const jsonStart = findJsonStart(output);
  const candidate = jsonStart >= 0 ? output.slice(jsonStart) : output;

  try {
    return JSON.parse(candidate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse agent-browser --json output (${reason}): ${truncateOutputForError(output)}`);
  }
}

function findJsonStart(output: string): number {
  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (ch === "{" || ch === "[") return i;
  }
  return -1;
}

function truncateOutputForError(output: string, max = 200): string {
  const trimmed = output.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
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

async function truncateForTool(content: string, artifactPathValue?: string): Promise<string> {
  const output = await formatToolText(content, {
    label: "browser-output",
    mode: "head",
    fullOutputFile: artifactPathValue,
  });
  return output.text;
}

function normalizeBrowserCommandArgs(args: string[]): string[] {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("browser_command requires at least one agent-browser argument.");
  }

  const safeArgs = args.map((arg) => {
    if (typeof arg !== "string") throw new Error("browser_command args must be strings.");
    const trimmed = arg.trim();
    if (!trimmed) throw new Error("browser_command args cannot contain empty strings.");
    return trimmed;
  });

  if (safeArgs.includes("--cdp")) {
    throw new Error("browser_command always uses the active browser CDP port; omit --cdp.");
  }

  return safeArgs;
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
