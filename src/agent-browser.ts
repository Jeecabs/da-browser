import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  extractAgentBrowserVersion,
  MIN_AGENT_BROWSER_VERSION,
  supportsAgentBrowserVersion,
} from "./agent-browser-version.js";
import {
  buildA11yArgs,
  buildFindArgs,
  buildHarArgs,
  buildIsArgs,
  buildReactArgs,
  buildReadArgs,
  buildRecordArgs,
  buildSetArgs,
  buildSnapshotArgs,
  buildTabArgs,
  buildTraceArgs,
  buildWaitArgs,
  MUTATING_FIND_ACTIONS,
  type A11yArgsOptions,
  type CaptureAction,
  type FindArgsOptions,
  type HarContentMode,
  type IsArgsOptions,
  type ReactArgsOptions,
  type ReadArgsOptions,
  type SetArgsOptions,
  type TabArgsOptions,
  type WaitArgsOptions,
} from "./agent-browser-args.js";
import {
  AgentBrowserCliError,
  extractBooleanResult,
  extractGetResult,
  formatGetResult,
  formatTabTable,
  isPlainObject,
  normalizeTabList,
  unwrapCliEnvelope,
  type BrowserGetWhat,
} from "./agent-browser-output.js";
import {
  arcRelaunchCommand,
  CdpError,
  classifyCdpError,
  friendlyCdpMessage,
} from "./cdp-errors.js";
import {
  controlledTabLabel,
  controlledTabMarkScript,
  CONTROLLED_TAB_CLEAR_SCRIPT,
} from "./controlled-tab.js";
import type { BrowserState, ConnectionProbe, WaitMode } from "./state.js";
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
  buildFindArgs,
  buildIsArgs,
  buildReactArgs,
  buildReadArgs,
  buildRecordArgs,
  buildSetArgs,
  buildSnapshotArgs,
  buildTabArgs,
  buildTraceArgs,
  buildWaitArgs,
  CdpError,
};
export { FIND_ACTIONS, normalizeTabRef } from "./agent-browser-args.js";
export { unwrapCliEnvelope, AgentBrowserCliError } from "./agent-browser-output.js";
export type { BrowserGetWhat } from "./agent-browser-output.js";
export type { CdpErrorKind } from "./cdp-errors.js";
export type {
  A11yArgsOptions,
  CaptureAction,
  CaptureArgsOptions,
  FindAction,
  FindArgsOptions,
  HarContentMode,
  IsArgsOptions,
  IsCheck,
  ReactArgsOptions,
  ReactCommand,
  ReadArgsOptions,
  SetArgsOptions,
  SetSetting,
  SnapshotArgsOptions,
  TabAction,
  TabArgsOptions,
  WaitArgsOptions,
  WaitElementState,
  WaitLoadState,
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

interface AgentBrowserVersionProbe {
  installed?: string;
  compatible: boolean;
  required: string;
}

function accessibilityCounts(payload: unknown): {
  violations?: number;
  incomplete?: number;
  passes?: number;
  inapplicable?: number;
} {
  if (!isPlainObject(payload) || !isPlainObject(payload.counts)) return {};
  const counts = payload.counts;
  return {
    violations: typeof counts.violations === "number" ? counts.violations : undefined,
    incomplete: typeof counts.incomplete === "number" ? counts.incomplete : undefined,
    passes: typeof counts.passes === "number" ? counts.passes : undefined,
    inapplicable: typeof counts.inapplicable === "number" ? counts.inapplicable : undefined,
  };
}

export async function connectBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
): Promise<BrowserActionResult> {
  await ensureArtifactDir(state);
  await assertAgentBrowserInstalled(pi, state, ctx);

  const debugPortListening = await isPortListening(pi, state.port, ctx);
  if (!debugPortListening) {
    state.connected = false;
    state.lastAction = "connect";
    state.lastError = `No browser listening on port ${state.port}`;

    return {
      summary: [
        `No browser is listening on port ${state.port}.`,
        "Quit Arc and relaunch it with:",
        `  ${arcRelaunchCommand(state.port)}`,
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

  // The daemon ignores --cdp once its session holds a connection, so a session pinned to
  // an old browser would silently absorb every command. Detach it if it's on the wrong port.
  await ensureDaemonOnPort(pi, state.port, ctx);

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
  options: { enableReactDevtools?: boolean } = {},
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  const local = isLocalUrl(url) || isLocalUrl(state.currentUrl);
  // --enable registers the vendored React DevTools hook before this navigation commits,
  // which is what unlocks the `react …` commands on the opened page.
  const args = options.enableReactDevtools ? ["open", "--enable", "react-devtools", url] : ["open", url];
  await runAgentBrowser(pi, args, ctx, 120_000, { port: state.port, local });
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
      reactDevtools: options.enableReactDevtools || undefined,
    },
  };
}

export async function snapshotBrowserPage(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  interactiveOnly: boolean,
  label = "snapshot",
  options: { urls?: boolean; compact?: boolean; depth?: number; selector?: string } = {},
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
      urls: options.urls,
      compact: options.compact,
      depth: options.depth,
      selector: options.selector,
      snapshotFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function readBrowserContent(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: ReadArgsOptions & { label?: string },
): Promise<BrowserActionResult> {
  await ensureArtifactDir(state);
  await assertAgentBrowserInstalled(pi, state, ctx);

  // Always ask the CLI for JSON internally so we can preserve source/contentType
  // diagnostics while returning plain content by default.
  const cliArgs = buildReadArgs({ ...params, json: true });
  const displayArgs = buildReadArgs(params);
  const needsBrowser = !params.url;
  const timeout = params.timeoutMs !== undefined ? params.timeoutMs + 15_000 : 60_000;
  const parsed = await runAgentBrowserJSON(pi, cliArgs, ctx, timeout, needsBrowser ? { port: state.port } : {});
  const content = params.json ? JSON.stringify(parsed ?? null, null, 2) : readPayloadContent(parsed);
  const label = params.label ?? (params.url ? `read-${domainFromUrl(params.url) ?? "url"}` : "read-active-tab");
  const formatted = await formatToolText(content || "(no content)", {
    label: `browser-${label}`,
    mode: "head",
  });

  state.lastAction = displayArgs.join(" ");
  state.lastError = undefined;

  if (needsBrowser) {
    state.connected = true;
    await refreshCurrentUrl(pi, state, ctx);
  }

  return {
    summary: params.url ? `Read ${params.url}.` : "Read active browser page.",
    contentText: formatted.text,
    artifacts: formatted.fullOutputFile ? [formatted.fullOutputFile] : undefined,
    diagnostics: {
      url: params.url,
      filter: params.filter,
      outline: params.outline,
      llms: params.llms,
      requireMd: params.requireMd,
      raw: params.raw,
      json: params.json,
      timeoutMs: params.timeoutMs,
      maxOutput: params.maxOutput,
      allowedDomains: params.allowedDomains,
      contentBoundaries: params.contentBoundaries,
      fullOutputFile: formatted.fullOutputFile,
      ...readPayloadDiagnostics(parsed),
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
  // buildFindArgs enforces a concrete action — the CLI would otherwise default to click,
  // turning a "just locate" call into a page mutation.
  const args = buildFindArgs(params);
  const output = await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port, local });

  const mutating = MUTATING_FIND_ACTIONS.has(params.action);
  const waitMode = params.waitMode ?? (mutating ? "networkidle" : "none");
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  const result: BrowserActionResult = {
    summary: `Found ${params.locator}=${params.value} and performed ${params.action}.`,
    diagnostics: {
      locator: params.locator,
      value: params.value,
      action: params.action,
      nthIndex: params.nthIndex,
      name: params.name,
      exact: params.exact,
      waitMode,
      currentUrl: state.currentUrl,
    },
  };

  if (params.resnapshot ?? mutating) {
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
  containerSelector?: string,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  const args = ["scroll", direction];
  if (typeof pixels === "number") args.push(String(pixels));
  if (containerSelector) args.push("--selector", containerSelector);
  const local = isLocalUrl(state.currentUrl);
  await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: `Scrolled ${direction}${pixels ? ` ${pixels}px` : ""}${containerSelector ? ` within ${containerSelector}` : ""}.`,
    diagnostics: {
      direction,
      pixels,
      containerSelector,
      waitMode,
      currentUrl: state.currentUrl,
    },
  };
}

export async function waitInBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: WaitArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  const args = buildWaitArgs(params);
  // Give our kill-timeout headroom above the CLI's own wait timeout so agent-browser's
  // clearer timeout error wins over a hard process kill.
  const execTimeout = params.timeoutMs !== undefined ? params.timeoutMs + 15_000 : 120_000;
  await runAgentBrowser(pi, args, ctx, execTimeout, { port: state.port, local: isLocalUrl(state.currentUrl) });
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

  const described = args.slice(1).join(" ");
  state.connected = true;
  state.lastAction = `wait ${described}`;
  state.lastError = undefined;

  return {
    summary: `Waited for ${described}.`,
    diagnostics: {
      ...params,
      currentUrl: state.currentUrl,
    },
  };
}

export async function navigateBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  action: "back" | "forward" | "reload" | "pushstate",
  waitMode: WaitMode,
  url?: string,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  if (action === "pushstate" && !url) {
    throw new Error("browser_nav pushstate requires a url.");
  }
  const local = isLocalUrl(state.currentUrl) || (action === "pushstate" && isLocalUrl(url));
  // pushstate does an SPA client-side navigation (auto-detects the Next.js router and
  // triggers the RSC fetch) instead of a full page load.
  const args = action === "pushstate" ? ["pushstate", url as string] : [action];
  await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port, local });
  await waitForLoad(pi, ctx, waitMode, state.port, local);
  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: action === "pushstate" ? `SPA-navigated to ${url}.` : `Browser ${action} complete.`,
    diagnostics: {
      action,
      url,
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
  what: BrowserGetWhat,
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
  const result = extractGetResult(what, parsed);
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

export async function debugBrowserPage(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  kind: "console" | "errors" | "network-requests" | "network-request",
  options: {
    clear?: boolean;
    filter?: string;
    /** Resource types like "xhr,fetch" (network-requests only). */
    type?: string;
    /** HTTP method like "POST" (network-requests only). */
    method?: string;
    /** Status filter like "200", "2xx", or "400-499" (network-requests only). */
    status?: string;
    /** Request id for kind network-request (full request/response detail). */
    requestId?: string;
    label?: string;
  },
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  let args: string[];
  if (kind === "network-request") {
    if (!options.requestId) throw new Error("browser_debug network-request requires requestId.");
    args = ["network", "request", options.requestId];
  } else if (kind === "network-requests") {
    args = ["network", "requests"];
    if (options.filter) args.push("--filter", options.filter);
    if (options.type) args.push("--type", options.type);
    if (options.method) args.push("--method", options.method);
    if (options.status) args.push("--status", options.status);
  } else {
    args = [kind];
  }
  if (options.clear && kind !== "network-request") args.push("--clear");

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
      type: options.type,
      method: options.method,
      status: options.status,
      requestId: options.requestId,
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
  options: { annotate?: boolean } = {},
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await ensureArtifactDir(state);

  const safeLabel = sanitizeArtifactLabel(label);
  const screenshotFile = artifactPath(state, `${safeLabel}-screenshot`, "png");

  await markControlledTab(pi, state, ctx);
  // --annotate overlays numbered labels keyed to snapshot refs ([N] ↔ @eN) and prints the
  // legend on stdout, so a vision pass over the screenshot maps straight back to refs.
  const screenshotArgs = options.annotate
    ? ["screenshot", "--annotate", screenshotFile]
    : ["screenshot", screenshotFile];
  const legend = await runAgentBrowser(pi, screenshotArgs, ctx, 60_000, { port: state.port });
  state.lastScreenshotFile = screenshotFile;

  const snapshot = await snapshotBrowserPage(pi, state, ctx, true, `${safeLabel}-snapshot`);
  state.connected = true;
  state.lastAction = `checkpoint ${safeLabel}`;
  state.lastError = undefined;

  const contentText = options.annotate
    ? [legend, snapshot.contentText].filter(Boolean).join("\n\n")
    : snapshot.contentText;

  return {
    summary: `Saved checkpoint ${safeLabel}.`,
    contentText,
    artifacts: [screenshotFile, ...(snapshot.artifacts ?? [])],
    diagnostics: {
      screenshotFile,
      annotate: options.annotate,
      snapshotFile: state.lastSnapshotFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function reactBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: ReactArgsOptions & { label?: string },
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const args = buildReactArgs(params);
  let output: string;
  try {
    output = await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port, local: isLocalUrl(state.currentUrl) });
  } catch (error) {
    if (error instanceof Error && /react|devtools|hook/i.test(error.message)) {
      throw new Error(
        `${error.message}\nReact introspection needs the DevTools hook injected before the page loads — re-open the page with browser_open enableReactDevtools=true, then retry.`,
      );
    }
    throw error;
  }

  const formatted = await formatToolText(output || "(no output)", {
    label: `browser-react-${params.command}`,
    mode: "head",
  });

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: `React ${params.command} complete.`,
    contentText: formatted.text,
    artifacts: formatted.fullOutputFile ? [formatted.fullOutputFile] : undefined,
    diagnostics: {
      command: params.command,
      fiberId: params.fiberId,
      onlyDynamic: params.onlyDynamic,
      fullOutputFile: formatted.fullOutputFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function vitalsBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  url?: string,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const args = url ? ["vitals", url] : ["vitals"];
  const local = isLocalUrl(url) || isLocalUrl(state.currentUrl);
  // Vitals waits out LCP/INP observation windows, so give it a generous budget.
  const output = await runAgentBrowser(pi, args, ctx, 120_000, { port: state.port, local });
  await refreshCurrentUrl(pi, state, ctx);

  const formatted = await formatToolText(output || "(no output)", {
    label: "browser-vitals",
    mode: "head",
  });

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: url ? `Measured web vitals for ${url}.` : "Measured web vitals for the current page.",
    contentText: formatted.text,
    artifacts: formatted.fullOutputFile ? [formatted.fullOutputFile] : undefined,
    diagnostics: {
      url,
      fullOutputFile: formatted.fullOutputFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function auditAccessibility(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: A11yArgsOptions & { label?: string },
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  // Keep the CLI response structured so counts, selectors, and incomplete checks remain
  // machine-readable. formatToolText spills oversized reports into the artifact directory.
  const args = buildA11yArgs({ ...params, json: true });
  const parsed = await runAgentBrowserJSON(pi, args, ctx, 120_000, {
    port: state.port,
    local: isLocalUrl(params.url) || isLocalUrl(state.currentUrl),
  });
  const report = JSON.stringify(parsed ?? null, null, 2);
  const formatted = await formatToolText(report, {
    label: `browser-${params.label ?? "a11y-audit"}`,
    mode: "head",
  });

  await refreshCurrentUrl(pi, state, ctx);
  await markControlledTab(pi, state, ctx);
  const counts = accessibilityCounts(parsed);

  state.connected = true;
  state.lastAction = buildA11yArgs(params).join(" ");
  state.lastError = undefined;

  return {
    summary: `Accessibility audit: ${counts.violations ?? "?"} violation${counts.violations === 1 ? "" : "s"}, ${counts.incomplete ?? "?"} incomplete.`,
    contentText: formatted.text,
    artifacts: formatted.fullOutputFile ? [formatted.fullOutputFile] : undefined,
    diagnostics: {
      url: params.url,
      tags: params.tags,
      selector: params.selector,
      axeVersion: isPlainObject(parsed) ? parsed.axeVersion : undefined,
      counts,
      fullOutputFile: formatted.fullOutputFile,
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
      label: params.label,
      tab: params.tab,
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
      ? `Opened new tab${params.label ? ` '${params.label}'` : ""}${params.url ? ` ${params.url}` : ""}.`
      : params.action === "close"
        ? params.tab !== undefined ? `Closed tab ${params.tab}.` : "Closed current tab."
        : `Switched to tab ${params.tab}.`;
  result.summary = verb;
  (result.diagnostics as Record<string, unknown>).currentUrl = state.currentUrl;
  (result.diagnostics as Record<string, unknown>).currentDomain = state.currentDomain;
  return result;
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
  const value = extractBooleanResult(params.check, parsed);

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

export async function setBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: SetArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);

  const args = buildSetArgs(params);
  await runAgentBrowser(pi, args, ctx, 30_000, { port: state.port });
  await markControlledTab(pi, state, ctx);

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: `Set ${params.setting}.`,
    diagnostics: {
      setting: params.setting,
      width: params.width,
      height: params.height,
      scale: params.scale,
      device: params.device,
      latitude: params.latitude,
      longitude: params.longitude,
      offline: params.offline,
      media: params.media,
      reducedMotion: params.reducedMotion,
      headerNames: params.headers ? Object.keys(params.headers) : undefined,
      username: params.username,
    },
  };
}

export async function harBrowser(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
  params: { action: CaptureAction; content?: HarContentMode; label?: string },
): Promise<BrowserActionResult> {
  await ensureReady(pi, state, ctx);
  await ensureArtifactDir(state);

  if (params.action === "start") {
    const file = artifactPath(state, params.label ?? "network", "har");
    const args = buildHarArgs({ action: "start", content: params.content });
    await runAgentBrowser(pi, args, ctx, 30_000, { port: state.port });
    state.har = { file, startedAt: Date.now() };
    state.connected = true;
    state.lastAction = args.join(" ");
    state.lastError = undefined;

    return {
      summary: `Started HAR capture (${params.content ?? "text"} bodies) → ${file}`,
      diagnostics: {
        action: "start",
        content: params.content ?? "text",
        file,
        currentUrl: state.currentUrl,
      },
    };
  }

  const previous = state.har;
  const file = previous?.file ?? artifactPath(state, params.label ?? "network", "har");
  const args = buildHarArgs({ action: "stop", file });
  await runAgentBrowser(pi, args, ctx, 60_000, { port: state.port });
  state.har = undefined;
  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  return {
    summary: `Stopped HAR capture → ${file}`,
    artifacts: [file],
    diagnostics: {
      action: "stop",
      file,
      durationMs: previous ? Date.now() - previous.startedAt : undefined,
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
  state.har = undefined;
}


async function markControlledTab(pi: ExtensionAPI, state: BrowserState, ctx: ExtensionContext): Promise<void> {
  if (!resolveControlBannerEnabled()) return;
  // currentDomain is refreshed just before this call, so it's the live target; lastAction
  // lags by one step here, so the pill identifies the agent + what it's driving instead.
  const target = state.currentDomain ?? `cdp:${state.port}`;
  const labelText = controlledTabLabel(target);
  await runAgentBrowser(pi, ["eval", controlledTabMarkScript(labelText)], ctx, 10_000, {
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
  await assertAgentBrowserInstalled(pi, state, ctx);
}

async function assertAgentBrowserInstalled(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
): Promise<void> {
  const probe = await probeAgentBrowserVersion(pi, state, ctx);
  if (!probe.installed) {
    throw new Error("agent-browser CLI not found or returned an unreadable version. Install it with `npm i -g agent-browser@latest`.");
  }
  if (!probe.compatible) {
    throw new Error(
      `da-browser requires agent-browser >=${probe.required}; found ${probe.installed}. Upgrade with \`npm i -g agent-browser@latest\`.`,
    );
  }
}

async function probeAgentBrowserVersion(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
): Promise<AgentBrowserVersionProbe> {
  let installed: string | undefined;
  try {
    const result = (await pi.exec("agent-browser", ["--version"], {
      signal: ctx.signal,
      timeout: 5_000,
    })) as CommandResult;
    if (result.code === 0) installed = extractAgentBrowserVersion(joinAgentBrowserOutput(result));
  } catch {
    // Status must remain usable when the executable is missing or cannot spawn.
  }

  const compatible = installed !== undefined && supportsAgentBrowserVersion(installed);
  state.agentBrowserVersion = installed;
  state.agentBrowserCompatible = compatible;
  return { installed, compatible, required: MIN_AGENT_BROWSER_VERSION };
}

interface CdpTarget {
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

async function ensurePageTarget(
  pi: ExtensionAPI,
  port: number,
  ctx: ExtensionContext,
): Promise<void> {
  const targets = await fetchTargets(pi, port, ctx);
  if (targets.some((t) => t.type === "page")) return;

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

// Re-create a page target so a fresh agent-browser attach can succeed. Swallows failures
// so the caller can fall back to surfacing the original error.
async function tryEnsureTarget(pi: ExtensionAPI, port: number, ctx: ExtensionContext): Promise<boolean> {
  try {
    await ensurePageTarget(pi, port, ctx);
    return true;
  } catch {
    return false;
  }
}

/**
 * The daemon binds one browser connection per session and silently ignores --cdp once
 * connected (verified on 0.27.0 — commands run against the old browser even when the flag
 * names a dead port). Compare the session's live CDP endpoint against the expected port
 * and detach (`close` disconnects the session without quitting Arc) so the next command
 * re-attaches to the right browser. Best-effort: verification failures don't block connect.
 */
async function ensureDaemonOnPort(pi: ExtensionAPI, port: number, ctx: ExtensionContext): Promise<void> {
  let cdpUrl: string | undefined;
  try {
    const data = await runAgentBrowserJSON(pi, ["get", "cdp-url"], ctx, 10_000, { port });
    if (isPlainObject(data) && typeof data.cdpUrl === "string") cdpUrl = data.cdpUrl;
  } catch {
    return; // no live session yet — the next command attaches fresh to the right port
  }
  if (!cdpUrl) return;

  let connectedPort: number | undefined;
  try {
    connectedPort = Number(new URL(cdpUrl).port) || undefined;
  } catch {
    return;
  }
  if (connectedPort === undefined || connectedPort === port) return;

  await runAgentBrowser(pi, ["close"], ctx, 15_000, { allowFailure: true });
}

async function fetchTargets(pi: ExtensionAPI, port: number, ctx: ExtensionContext): Promise<CdpTarget[]> {
  const result = (await pi.exec("curl", ["-sf", `http://localhost:${port}/json/list`], {
    signal: ctx.signal,
    timeout: 5_000,
  })) as CommandResult;
  if (result.code !== 0) return [];

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as CdpTarget[]) : [];
  } catch {
    return [];
  }
}

async function fetchBrowserVersion(pi: ExtensionAPI, port: number, ctx: ExtensionContext): Promise<string | undefined> {
  const result = (await pi.exec("curl", ["-sf", `http://localhost:${port}/json/version`], {
    signal: ctx.signal,
    timeout: 5_000,
  })) as CommandResult;
  if (result.code !== 0) return undefined;

  try {
    const parsed = JSON.parse(result.stdout) as { Browser?: string };
    return typeof parsed.Browser === "string" ? parsed.Browser : undefined;
  } catch {
    return undefined;
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

/**
 * Actively probe the debugging port and reconcile state.connected with reality, returning
 * a ConnectionProbe for status display. Unlike the per-action happy path (which trusts the
 * last successful call), this hits lsof + /json/list so "connected" is checkable rather
 * than merely asserted. Used by status tools and on session_start to revalidate restored
 * state before the first widget paint.
 */
export async function verifyConnection(
  pi: ExtensionAPI,
  state: BrowserState,
  ctx: ExtensionContext,
): Promise<ConnectionProbe> {
  const agentBrowser = await probeAgentBrowserVersion(pi, state, ctx);
  const portListening = await isPortListening(pi, state.port, ctx);
  if (!portListening) {
    state.connected = false;
    return {
      portListening: false,
      pageTargets: 0,
      agentBrowserVersion: agentBrowser.installed,
      agentBrowserCompatible: agentBrowser.compatible,
      requiredAgentBrowserVersion: agentBrowser.required,
    };
  }

  const targets = await fetchTargets(pi, state.port, ctx);
  const pages = targets.filter((t) => t.type === "page");
  // Best guess at a foreground page for display only — agent-browser picks its own target,
  // so this is a probe observation, not necessarily the controlled tab.
  const attached = pages.find((t) => Boolean(t.url) && t.url !== "about:blank") ?? pages[0];
  const browser = await fetchBrowserVersion(pi, state.port, ctx);

  state.connected = true;
  state.lastVerifiedAt = Date.now();

  return {
    portListening: true,
    pageTargets: pages.length,
    attachedUrl: typeof attached?.url === "string" ? attached.url : undefined,
    browser,
    agentBrowserVersion: agentBrowser.installed,
    agentBrowserCompatible: agentBrowser.compatible,
    requiredAgentBrowserVersion: agentBrowser.required,
  };
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
  // Reached only after the action's main (non-allowFailure) call already succeeded, so the
  // browser just proved it's alive — record that for the staleness signal.
  state.lastVerifiedAt = Date.now();
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
  let fullArgs = options.port !== undefined ? ["--cdp", String(options.port), ...args] : args;
  let effectiveTimeout = timeout;

  // agent-browser honors --timeout only for `wait` operations (waitForSelector and
  // --load/--url/--text/--fn); navigation and element actions use the daemon default
  // (25s, AGENT_BROWSER_DEFAULT_TIMEOUT — inherited from pi's env) and ignore the flag.
  // So only a `wait` against a local/dev-server target gets the larger budget, and we
  // keep our own kill-timeout above agent-browser's so its clearer error wins.
  if (options.local && args[0] === "wait" && !args.includes("--timeout")) {
    const localMs = localBrowserTimeoutMs();
    fullArgs = [...fullArgs, "--timeout", String(localMs)];
    effectiveTimeout = Math.max(timeout, localMs + 15_000);
  }

  const exec = (): Promise<CommandResult> =>
    pi.exec("agent-browser", fullArgs, {
      signal: ctx.signal,
      timeout: effectiveTimeout,
    }) as Promise<CommandResult>;

  let result = await exec();
  if (result.code === 0) return joinAgentBrowserOutput(result);

  // Best-effort calls (banner injection, url refresh) never heal/retry or throw — a
  // cosmetic miss must not become a hard failure.
  if (options.allowFailure) return "";

  let kind = classifyCdpError(combineStreams(result));

  // Self-heal once: a vanished page target is usually recoverable by re-creating one and
  // letting agent-browser re-attach on retry. Scoped to target-gone (and only when we know
  // the port) so element/selector errors and a genuinely-down browser still fail fast.
  if (kind === "target-gone" && options.port !== undefined) {
    const healed = await tryEnsureTarget(pi, options.port, ctx);
    if (healed) {
      result = await exec();
      if (result.code === 0) return joinAgentBrowserOutput(result);
      kind = classifyCdpError(combineStreams(result));
    }
  }

  throw new CdpError(
    friendlyCdpMessage(kind, options.port, formatExecFailure("agent-browser", fullArgs, result)),
    kind,
  );
}

function combineStreams(result: CommandResult): string {
  return `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
}

function joinAgentBrowserOutput(result: CommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function readPayloadContent(payload: unknown): string {
  if (isPlainObject(payload) && typeof payload.content === "string") return payload.content;
  if (typeof payload === "string") return payload;
  if (payload === undefined || payload === null) return "";
  return JSON.stringify(payload, null, 2);
}

function readPayloadDiagnostics(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) return {};
  return {
    source: payload.source,
    contentType: payload.contentType,
    finalUrl: payload.finalUrl,
    status: payload.status,
    truncated: payload.truncated,
  };
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
    return unwrapCliEnvelope(JSON.parse(candidate));
  } catch (error) {
    if (error instanceof AgentBrowserCliError) throw error;
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
