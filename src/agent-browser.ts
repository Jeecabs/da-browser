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
import {
  domainFromUrl,
  isLocalUrl,
  localBrowserSettleMs,
  localBrowserTimeoutMs,
  normalizeRef,
  resolveControlBannerEnabled,
  sanitizeArtifactLabel,
} from "./state.js";
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
  await markControlledTab(pi, state, ctx);

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
  const local = isLocalUrl(url) || isLocalUrl(state.currentUrl);
  await runAgentBrowser(pi, ["open", url], ctx, 120_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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

  const local = isLocalUrl(state.currentUrl);
  const normalizedRef = normalizeRef(ref);
  await runAgentBrowser(pi, ["click", `@${normalizedRef}`], ctx, 60_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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

  const local = isLocalUrl(state.currentUrl);
  const hasAction = Boolean(params.action);
  const args = buildFindArgs({ ...params, json: !hasAction });

  let matches: unknown = undefined;
  let output = "";
  if (hasAction) {
    output = await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port, local });
  } else {
    const parsed = await runAgentBrowserJSON(pi, args, ctx, 60_000, { port: state.port, local });
    matches = extractFindMatches(parsed);
    output = JSON.stringify(matches ?? parsed, null, 2);
  }

  const waitMode = params.waitMode ?? (hasAction ? "networkidle" : "none");
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  if (hasAction) await markControlledTab(pi, state, ctx);

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

  const local = isLocalUrl(state.currentUrl);
  const normalizedRef = normalizeRef(ref);
  await runAgentBrowser(pi, ["fill", `@${normalizedRef}`, text], ctx, 60_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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

  const local = isLocalUrl(state.currentUrl);
  const normalizedRef = normalizeRef(ref);
  await runAgentBrowser(pi, ["select", `@${normalizedRef}`, option], ctx, 60_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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
  const local = isLocalUrl(state.currentUrl);
  await runAgentBrowser(pi, ["press", key], ctx, 60_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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
  const local = isLocalUrl(state.currentUrl);
  await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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
  await runAgentBrowser(pi, ["wait", target], ctx, 120_000, { port: state.port, local: isLocalUrl(state.currentUrl) });
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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
  const local = isLocalUrl(state.currentUrl);
  await runAgentBrowser(pi, [action], ctx, 60_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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
  await markControlledTab(pi, state, ctx);
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

  const output = await runAgentBrowser(pi, ["eval", script], ctx, 120_000, { port: state.port, local: isLocalUrl(state.currentUrl) });
  await markControlledTab(pi, state, ctx);
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

  await markControlledTab(pi, state, ctx);
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

  if (params.action === "new" || params.action === "switch") {
    await clearControlledTab(pi, state, ctx);
  }
  await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

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
  await markControlledTab(pi, state, ctx);

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
    await markControlledTab(pi, state, ctx);
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

const CONTROLLED_TAB_BADGE_ID = "__pi_agent_controlled_tab_badge__";
const CONTROLLED_TAB_STYLE_ID = "__pi_agent_controlled_tab_style__";
const CONTROLLED_TAB_FAVICON_ATTR = "data-pi-agent-controlled-tab-favicon";
const CONTROLLED_TAB_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f87171"/>
      <stop offset="0.55" stop-color="#dc2626"/>
      <stop offset="1" stop-color="#991b1b"/>
    </linearGradient>
    <radialGradient id="hl" cx="30%" cy="22%" r="70%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#g)"/>
  <rect width="64" height="64" rx="15" fill="url(#hl)"/>
</svg>`;

// Marks a controlled tab with a sticky red border: a slim full-width line pinned to
// the very top of the viewport with a soft breathing glow beneath it. It overlays the
// page (position:fixed + pointer-events:none) so it never reflows or blocks content,
// and a matching red favicon mirrors the signal in the tab strip.
const CONTROLLED_TAB_MARK_SCRIPT = `(() => {
  const badgeId = ${JSON.stringify(CONTROLLED_TAB_BADGE_ID)};
  const styleId = ${JSON.stringify(CONTROLLED_TAB_STYLE_ID)};
  const faviconAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ATTR)};
  const faviconHref = "data:image/svg+xml," + encodeURIComponent(${JSON.stringify(CONTROLLED_TAB_FAVICON_SVG)});

  let icon = document.querySelector("link[" + faviconAttr + "]");
  if (!icon) {
    icon = document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel*="icon" i]');
  }
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    icon.dataset.piAgentControlledTabCreated = "true";
    (document.head || document.documentElement).appendChild(icon);
  }
  if (!icon.hasAttribute(faviconAttr)) {
    icon.dataset.piAgentControlledTabOriginalHref = icon.getAttribute("href") || "";
  }
  icon.setAttribute(faviconAttr, "true");
  icon.href = faviconHref;

  const sel = "#" + badgeId;
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent =
    "@keyframes __pi_rec_slide{from{background-position:0 0}to{background-position:200% 0}}" +
    "@keyframes __pi_rec_breathe{0%,100%{opacity:.4}50%{opacity:.95}}" +
    sel + "{position:fixed;top:0;left:0;right:0;height:4px;z-index:2147483647;pointer-events:none;" +
      "background:linear-gradient(90deg,#991b1b,#dc2626 22%,#f87171 50%,#dc2626 78%,#991b1b);background-size:200% 100%;" +
      "animation:__pi_rec_slide 5.5s linear infinite;" +
      "box-shadow:0 0 10px 1px rgba(239,68,68,.85),0 5px 22px -4px rgba(220,38,38,.6);}" +
    sel + "::after{content:'';position:absolute;left:0;right:0;top:100%;height:16px;pointer-events:none;" +
      "background:linear-gradient(to bottom,rgba(239,68,68,.5),rgba(239,68,68,0));" +
      "animation:__pi_rec_breathe 2.6s ease-in-out infinite;}" +
    "@media (prefers-reduced-motion: reduce){" +
      sel + "{animation:none}" +
      sel + "::after{animation:none;opacity:.7}}";

  document.getElementById(badgeId)?.remove();
  const root = document.createElement("div");
  root.id = badgeId;
  document.documentElement.appendChild(root);
})()`;

const CONTROLLED_TAB_CLEAR_SCRIPT = `(() => {
  const badgeId = ${JSON.stringify(CONTROLLED_TAB_BADGE_ID)};
  const styleId = ${JSON.stringify(CONTROLLED_TAB_STYLE_ID)};
  const faviconAttr = ${JSON.stringify(CONTROLLED_TAB_FAVICON_ATTR)};

  document.getElementById(badgeId)?.remove();
  document.getElementById(styleId)?.remove();

  const icon = document.querySelector("link[" + faviconAttr + "]");
  if (icon) {
    if (icon.dataset.piAgentControlledTabCreated === "true") {
      icon.remove();
    } else {
      const originalHref = icon.dataset.piAgentControlledTabOriginalHref || "";
      if (originalHref) icon.setAttribute("href", originalHref);
      else icon.removeAttribute("href");
      icon.removeAttribute(faviconAttr);
      delete icon.dataset.piAgentControlledTabOriginalHref;
    }
  }
})()`;

async function markControlledTab(pi: ExtensionAPI, state: BrowserState, ctx: ExtensionContext): Promise<void> {
  if (!resolveControlBannerEnabled()) return;
  await runAgentBrowser(pi, ["eval", CONTROLLED_TAB_MARK_SCRIPT], ctx, 10_000, {
    port: state.port,
    allowFailure: true,
  });
}

async function clearControlledTab(pi: ExtensionAPI, state: BrowserState, ctx: ExtensionContext): Promise<void> {
  await runAgentBrowser(pi, ["eval", CONTROLLED_TAB_CLEAR_SCRIPT], ctx, 10_000, {
    port: state.port,
    allowFailure: true,
  });
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
  options: { allowFailure?: boolean; port?: number; local?: boolean } = {},
): Promise<string> {
  let fullArgs = options.port ? ["--cdp", String(options.port), ...args] : args;
  let effectiveTimeout = timeout;

  // agent-browser honors --timeout only for `wait` operations (waitForSelector and
  // --load/--url/--text/--fn); navigation and element actions use a fixed 60s default and
  // ignore it. So only a `wait` against a local/dev-server target gets the larger budget,
  // and we keep our own kill-timeout above agent-browser's so its clearer error wins.
  if (options.local && args[0] === "wait" && !args.includes("--timeout")) {
    const localMs = localBrowserTimeoutMs();
    fullArgs = [...fullArgs, "--timeout", String(localMs)];
    effectiveTimeout = Math.max(timeout, localMs + 15_000);
  }

  const result = (await pi.exec("agent-browser", fullArgs, {
    signal: ctx.signal,
    timeout: effectiveTimeout,
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
  options: { port?: number; local?: boolean } = {},
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

async function waitForLoad(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  waitMode: WaitMode,
  port: number,
  local = false,
): Promise<void> {
  if (waitMode === "none") return;

  if (local) {
    // On slow dev servers a fixed 1-2s settle routinely misses the response window, so
    // wait for the real load state instead — but cap it (PI_BROWSER_LOCAL_SETTLE_MS) and
    // allowFailure, so pages that never go idle (polling/SSE) proceed after the cap
    // rather than hanging or erroring.
    const settleMs = localBrowserSettleMs();
    const loadState = waitMode === "networkidle" ? "networkidle" : "load";
    await runAgentBrowser(pi, ["wait", "--load", loadState, "--timeout", String(settleMs)], ctx, settleMs + 15_000, {
      port,
      allowFailure: true,
    });
    return;
  }

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
