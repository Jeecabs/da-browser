
import type { BrowserHost, ExecResult } from "./host.ts";
import { dirname, join, resolve } from "./paths.ts";

import {
  extractAgentBrowserVersion,
  MIN_AGENT_BROWSER_VERSION,
  supportsAgentBrowserVersion,
} from "./agent-browser-version.ts";
import {
  agentBrowserSessionName,
  buildA11yArgs,
  buildCdpInvocationArgs,
  buildFindArgs,
  buildHarArgs,
  buildIsArgs,
  buildReactArgs,
  buildReadArgs,
  buildRecordArgs,
  buildScreenshotArgs,
  buildSessionListArgs,
  buildSetArgs,
  buildSnapshotArgs,
  buildTabArgs,
  buildTraceArgs,
  buildWaitArgs,
  contactSheetPath,
  MUTATING_FIND_ACTIONS,
  type A11yArgsOptions,
  type CaptureAction,
  type FindArgsOptions,
  type HarContentMode,
  type IsArgsOptions,
  type ReactArgsOptions,
  type ReadArgsOptions,
  type RecordArgsOptions,
  type ScreenshotArgsOptions,
  type SetArgsOptions,
  type SnapshotArgsOptions,
  type TabArgsOptions,
  type WaitArgsOptions,
} from "./agent-browser-args.ts";
import {
  AgentBrowserCliError,
  extractBooleanResult,
  extractCookies,
  extractGetResult,
  formatAnnotationLegend,
  formatCookieSummary,
  formatGetResult,
  formatTabTable,
  isPlainObject,
  normalizeTabList,
  unwrapCliEnvelope,
  type BrowserGetWhat,
} from "./agent-browser-output.ts";
import {
  arcRelaunchCommand,
  CdpError,
  classifyCdpError,
  extractTabGoneDetails,
  friendlyCdpMessage,
  sanitizeTabRecoveryUrl,
} from "./cdp-errors.ts";
import {
  controlledTabLabel,
  controlledTabMarkScript,
  CONTROLLED_TAB_CLEAR_SCRIPT,
} from "./controlled-tab.ts";
import type { BrowserState, ConnectionProbe, WaitMode } from "./state.ts";
import {
  domainFromUrl,
  isLocalUrl,
  localBrowserSettleMs,
  localBrowserTimeoutMs,
  normalizeRef,
  resolveControlBannerEnabled,
  sanitizeArtifactLabel,
  tabBindingStatus,
} from "./state.ts";
import { formatToolText } from "./tool-output.ts";

export {
  buildFindArgs,
  buildIsArgs,
  buildReactArgs,
  buildReadArgs,
  buildRecordArgs,
  buildScreenshotArgs,
  buildSetArgs,
  buildSnapshotArgs,
  buildTabArgs,
  buildTraceArgs,
  buildWaitArgs,
  CdpError,
  contactSheetPath,
};
export { FIND_ACTIONS, normalizeTabRef } from "./agent-browser-args.ts";
export { unwrapCliEnvelope, AgentBrowserCliError } from "./agent-browser-output.ts";
export type { BrowserGetWhat } from "./agent-browser-output.ts";
export type { CdpErrorKind } from "./cdp-errors.ts";
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
  RecordAction,
  RecordArgsOptions,
  ScreenshotArgsOptions,
  SetArgsOptions,
  SetSetting,
  SnapshotArgsOptions,
  TabAction,
  TabArgsOptions,
  WaitArgsOptions,
  WaitElementState,
  WaitLoadState,
} from "./agent-browser-args.ts";

export interface BrowserActionResult {
  summary: string;
  contentText?: string;
  artifacts?: string[];
  diagnostics?: Record<string, unknown>;
}

type CommandResult = ExecResult;

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
  host: BrowserHost,
  state: BrowserState,
): Promise<BrowserActionResult> {
  await ensureArtifactDir(host, state);
  await assertAgentBrowserInstalled(host, state);

  const debugPortListening = await isPortListening(host, state.port);
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
  await ensurePageTarget(host, state.port);

  // The daemon ignores --cdp once its session holds a connection, so a session pinned to
  // an old browser would silently absorb every command. Detach it if it's on the wrong port.
  await ensureDaemonOnPort(host, state.port);

  // Verify CDP connection works by fetching the current URL. This probe must fail hard:
  // status only proves the port exists, not that agent-browser can attach to it. A prior
  // pinned target may legitimately be gone; browser_connect is the explicit recovery action,
  // so bind a fresh tab here rather than weakening the pin or adopting a neighboring tab.
  let recoveredPinnedTab = false;
  try {
    await refreshCurrentUrl(host, state, false);
  } catch (error) {
    if (!(error instanceof CdpError) || error.kind !== "tab-gone") throw error;
    await runAgentBrowser(host, ["tab", "new"], 30_000, { port: state.port });
    recoveredPinnedTab = true;
    await refreshCurrentUrl(host, state, false);
  }
  await refreshActiveTarget(host, state);
  await refreshDashboardUrl(host, state);
  await markControlledTab(host, state);

  state.connected = true;
  state.lastAction = "connect";
  state.lastError = undefined;

  return {
    summary: recoveredPinnedTab
      ? `Connected to browser via CDP on port ${state.port}; replaced the missing pinned tab.`
      : `Connected to browser via CDP on port ${state.port} with strict tab pinning.`,
    diagnostics: {
      port: state.port,
      agentBrowserSession: agentBrowserSessionName(host.sessionId, host.sessionPrefix),
      pinTab: true,
      recoveredPinnedTab,
      targetId: state.targetId,
      currentUrl: state.currentUrl,
      currentDomain: state.currentDomain,
      dashboardUrl: state.dashboardUrl,
    },
  };
}

export async function openBrowserPage(
  host: BrowserHost,
  state: BrowserState,
  url: string,
  waitMode: WaitMode,
  options: { enableReactDevtools?: boolean } = {},
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  const local = isLocalUrl(url) || isLocalUrl(state.currentUrl);
  // --enable registers the vendored React DevTools hook before this navigation commits,
  // which is what unlocks the `react …` commands on the opened page.
  const args = options.enableReactDevtools ? ["open", "--enable", "react-devtools", url] : ["open", url];
  await runAgentBrowser(host, args, 120_000, { port: state.port, local });
  await waitForLoad(host, waitMode, state.port, local);
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

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
  host: BrowserHost,
  state: BrowserState,
  interactiveOnly: boolean,
  label = "snapshot",
  options: Omit<SnapshotArgsOptions, "interactiveOnly"> = {},
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  await ensureArtifactDir(host, state);

  const args = buildSnapshotArgs({ interactiveOnly, ...options });
  const snapshot = await runAgentBrowser(host, args, 60_000, { port: state.port });

  const snapshotFile = artifactPath(state, label, "txt");
  await host.writeFile(snapshotFile, snapshot);

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastSnapshotAt = Date.now();
  state.lastSnapshotFile = snapshotFile;
  state.lastError = undefined;
  await refreshCurrentUrl(host, state);

  return {
    summary: `Captured ${interactiveOnly ? "interactive " : ""}snapshot${options.delta ? " (delta)" : ""}.`,
    contentText: await truncateForTool(host, snapshot, snapshotFile),
    artifacts: [snapshotFile],
    diagnostics: {
      interactiveOnly,
      urls: options.urls,
      compact: options.compact,
      depth: options.depth,
      selector: options.selector,
      delta: options.delta,
      snapshotFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function readBrowserContent(
  host: BrowserHost,
  state: BrowserState,
  params: ReadArgsOptions & { label?: string },
): Promise<BrowserActionResult> {
  await ensureArtifactDir(host, state);
  await assertAgentBrowserInstalled(host, state);

  // Always ask the CLI for JSON internally so we can preserve source/contentType
  // diagnostics while returning plain content by default.
  const cliArgs = buildReadArgs({ ...params, json: true });
  const displayArgs = buildReadArgs(params);
  const needsBrowser = !params.url;
  const timeout = params.timeoutMs !== undefined ? params.timeoutMs + 15_000 : 60_000;
  const parsed = await runAgentBrowserJSON(host, cliArgs, timeout, needsBrowser ? { port: state.port } : {});
  const content = params.json ? JSON.stringify(parsed ?? null, null, 2) : readPayloadContent(parsed);
  const label = params.label ?? (params.url ? `read-${domainFromUrl(params.url) ?? "url"}` : "read-active-tab");
  const formatted = await formatToolText(host, content || "(no content)", {
    label: `browser-${label}`,
    mode: "head",
  });

  state.lastAction = displayArgs.join(" ");
  state.lastError = undefined;

  if (needsBrowser) {
    state.connected = true;
    await refreshCurrentUrl(host, state);
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
  host: BrowserHost,
  state: BrowserState,
  ref: string,
  waitMode: WaitMode,
  resnapshot: boolean,
  human = false,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const local = isLocalUrl(state.currentUrl);
  const normalizedRef = normalizeRef(ref);
  // --human moves the pointer along a curved, eased path before pressing, so hover-gated
  // UI and pointer-path bot checks see a real approach instead of a teleport.
  const clickArgs = human ? ["click", `@${normalizedRef}`, "--human"] : ["click", `@${normalizedRef}`];
  await runAgentBrowser(host, clickArgs, 60_000, { port: state.port, local });
  await waitForLoad(host, waitMode, state.port, local);
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

  state.connected = true;
  state.lastAction = clickArgs.join(" ");
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
    const snapshot = await snapshotBrowserPage(host, state, true, `after-click-${normalizedRef}`);
    result.contentText = snapshot.contentText;
    result.artifacts = snapshot.artifacts;
  }

  return result;
}

export async function findBrowserElement(
  host: BrowserHost,
  state: BrowserState,
  params: FindArgsOptions & { waitMode?: WaitMode; resnapshot?: boolean },
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const local = isLocalUrl(state.currentUrl);
  // buildFindArgs enforces a concrete action — the CLI would otherwise default to click,
  // turning a "just locate" call into a page mutation.
  const args = buildFindArgs(params);
  const output = await runAgentBrowser(host, args, 60_000, { port: state.port, local });

  const mutating = MUTATING_FIND_ACTIONS.has(params.action);
  const waitMode = params.waitMode ?? (mutating ? "networkidle" : "none");
  await waitForLoad(host, waitMode, state.port, local);
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

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
      host,
      state,
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
  host: BrowserHost,
  state: BrowserState,
  ref: string,
  text: string,
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const local = isLocalUrl(state.currentUrl);
  const normalizedRef = normalizeRef(ref);
  await runAgentBrowser(host, ["fill", `@${normalizedRef}`, text], 60_000, { port: state.port, local });
  await waitForLoad(host, waitMode, state.port, local);
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

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
  host: BrowserHost,
  state: BrowserState,
  ref: string,
  option: string,
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const local = isLocalUrl(state.currentUrl);
  const normalizedRef = normalizeRef(ref);
  await runAgentBrowser(host, ["select", `@${normalizedRef}`, option], 60_000, { port: state.port, local });
  await waitForLoad(host, waitMode, state.port, local);
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

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
  host: BrowserHost,
  state: BrowserState,
  key: string,
  waitMode: WaitMode,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  const local = isLocalUrl(state.currentUrl);
  await runAgentBrowser(host, ["press", key], 60_000, { port: state.port, local });
  await waitForLoad(host, waitMode, state.port, local);
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

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
  host: BrowserHost,
  state: BrowserState,
  direction: "up" | "down" | "left" | "right",
  pixels: number | undefined,
  waitMode: WaitMode,
  containerSelector?: string,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  const args = ["scroll", direction];
  if (typeof pixels === "number") args.push(String(pixels));
  if (containerSelector) args.push("--selector", containerSelector);
  const local = isLocalUrl(state.currentUrl);
  await runAgentBrowser(host, args, 60_000, { port: state.port, local });
  await waitForLoad(host, waitMode, state.port, local);
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

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
  host: BrowserHost,
  state: BrowserState,
  params: WaitArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  const args = buildWaitArgs(params);
  // Give our kill-timeout headroom above the CLI's own wait timeout so agent-browser's
  // clearer timeout error wins over a hard process kill.
  const execTimeout = params.timeoutMs !== undefined ? params.timeoutMs + 15_000 : 120_000;
  await runAgentBrowser(host, args, execTimeout, { port: state.port, local: isLocalUrl(state.currentUrl) });
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

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
  host: BrowserHost,
  state: BrowserState,
  action: "back" | "forward" | "reload" | "pushstate",
  waitMode: WaitMode,
  url?: string,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  if (action === "pushstate" && !url) {
    throw new Error("browser_nav pushstate requires a url.");
  }
  const local = isLocalUrl(state.currentUrl) || (action === "pushstate" && isLocalUrl(url));
  // pushstate does an SPA client-side navigation (auto-detects the Next.js router and
  // triggers the RSC fetch) instead of a full page load.
  const args = action === "pushstate" ? ["pushstate", url as string] : [action];
  await runAgentBrowser(host, args, 60_000, { port: state.port, local });
  await waitForLoad(host, waitMode, state.port, local);
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);

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
  host: BrowserHost,
  state: BrowserState,
  what: BrowserGetWhat,
  selector: string | undefined,
  attrName: string | undefined,
  label = "get",
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  const args = ["get", what];
  if (what === "attr") {
    if (!attrName) throw new Error("browser_get with what='attr' requires attrName.");
    args.push(attrName);
  }
  if (selector) args.push(selector);

  const parsed = await runAgentBrowserJSON(host, args, 60_000, { port: state.port });
  const result = extractGetResult(what, parsed);
  const summaryText = formatGetResult(what, result);
  const formatted = await formatToolText(host, summaryText, { label: `browser-${label}`, mode: "head" });

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
  host: BrowserHost,
  state: BrowserState,
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
  await ensureReady(host, state);
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

  const output = await runAgentBrowser(host, args, 60_000, { port: state.port });
  const formatted = await formatToolText(host, output || "(no output)", {
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
  host: BrowserHost,
  state: BrowserState,
  args: string[],
  timeoutMs: number | undefined,
  label = "command",
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  const safeArgs = normalizeBrowserCommandArgs(args);
  const timeout = Math.min(Math.max(timeoutMs ?? 60_000, 1_000), 300_000);
  const output = await runAgentBrowser(host, safeArgs, timeout, { port: state.port });
  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);
  const formatted = await formatToolText(host, output || "(no output)", {
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
  host: BrowserHost,
  state: BrowserState,
  script: string,
  label = "eval",
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  await ensureArtifactDir(host, state);

  const output = await runAgentBrowser(host, ["eval", script], 120_000, { port: state.port, local: isLocalUrl(state.currentUrl) });
  await markControlledTab(host, state);
  const evalFile = artifactPath(state, label, "txt");
  await host.writeFile(evalFile, output);

  state.connected = true;
  state.lastAction = "eval";
  state.lastEvalFile = evalFile;
  state.lastError = undefined;

  return {
    summary: "Executed browser eval script.",
    contentText: await truncateForTool(host, output, evalFile),
    artifacts: [evalFile],
    diagnostics: {
      evalFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function checkpointBrowserPage(
  host: BrowserHost,
  state: BrowserState,
  label: string,
  options: Omit<ScreenshotArgsOptions, "file"> & { delta?: boolean } = {},
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  await ensureArtifactDir(host, state);

  const safeLabel = sanitizeArtifactLabel(label);
  const screenshotFile = artifactPath(state, `${safeLabel}-screenshot`, "png");

  await markControlledTab(host, state);
  // --annotate overlays numbered labels keyed to snapshot refs ([N] ↔ @eN) and prints the
  // legend on stdout, so a vision pass over the screenshot maps straight back to refs.
  // --if-changed/--threshold (0.38) skip an unchanged capture: no file, no vision tokens.
  const screenshotArgs = buildScreenshotArgs({ ...options, file: screenshotFile });
  const shot = await runAgentBrowserJSON(host, screenshotArgs, 60_000, { port: state.port });
  const changed = !isPlainObject(shot) || shot.changed !== false;
  const legend = options.annotate ? formatAnnotationLegend(shot) : "";
  if (changed) state.lastScreenshotFile = screenshotFile;

  const snapshot = await snapshotBrowserPage(host, state, true, `${safeLabel}-snapshot`, {
    delta: options.delta,
  });
  state.connected = true;
  state.lastAction = `checkpoint ${safeLabel}`;
  state.lastError = undefined;

  const contentText = [legend, snapshot.contentText].filter(Boolean).join("\n\n");

  return {
    summary: changed
      ? `Saved checkpoint ${safeLabel}.`
      : `Checkpoint ${safeLabel}: page unchanged, screenshot skipped.`,
    contentText,
    artifacts: changed ? [screenshotFile, ...(snapshot.artifacts ?? [])] : snapshot.artifacts,
    diagnostics: {
      screenshotFile: changed ? screenshotFile : undefined,
      changed,
      pixelChangeRatio: isPlainObject(shot) ? shot.pixelChangeRatio : undefined,
      annotate: options.annotate,
      snapshotFile: state.lastSnapshotFile,
      currentUrl: state.currentUrl,
    },
  };
}

export async function reactBrowser(
  host: BrowserHost,
  state: BrowserState,
  params: ReactArgsOptions & { label?: string },
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const args = buildReactArgs(params);
  let output: string;
  try {
    output = await runAgentBrowser(host, args, 60_000, { port: state.port, local: isLocalUrl(state.currentUrl) });
  } catch (error) {
    if (error instanceof Error && /react|devtools|hook/i.test(error.message)) {
      throw new Error(
        `${error.message}\nReact introspection needs the DevTools hook injected before the page loads — re-open the page with browser_open enableReactDevtools=true, then retry.`,
      );
    }
    throw error;
  }

  const formatted = await formatToolText(host, output || "(no output)", {
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
  host: BrowserHost,
  state: BrowserState,
  url?: string,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const args = url ? ["vitals", url] : ["vitals"];
  const local = isLocalUrl(url) || isLocalUrl(state.currentUrl);
  // Vitals waits out LCP/INP observation windows, so give it a generous budget.
  const output = await runAgentBrowser(host, args, 120_000, { port: state.port, local });
  await refreshCurrentUrl(host, state);

  const formatted = await formatToolText(host, output || "(no output)", {
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
  host: BrowserHost,
  state: BrowserState,
  params: A11yArgsOptions & { label?: string },
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  // Keep the CLI response structured so counts, selectors, and incomplete checks remain
  // machine-readable. formatToolText spills oversized reports into the artifact directory.
  const args = buildA11yArgs({ ...params, json: true });
  const parsed = await runAgentBrowserJSON(host, args, 120_000, {
    port: state.port,
    local: isLocalUrl(params.url) || isLocalUrl(state.currentUrl),
  });
  const report = JSON.stringify(parsed ?? null, null, 2);
  const formatted = await formatToolText(host, report, {
    label: `browser-${params.label ?? "a11y-audit"}`,
    mode: "head",
  });

  await refreshCurrentUrl(host, state);
  await markControlledTab(host, state);
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
  host: BrowserHost,
  state: BrowserState,
  params: TabArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const args = buildTabArgs(params);
  const previousTargetId = state.targetId;
  const previousUrl = state.currentUrl;
  const result: BrowserActionResult = {
    summary: "",
    diagnostics: {
      action: params.action,
      url: params.url,
      label: params.label,
      tab: params.tab,
      pinTab: true,
    },
  };

  if (params.action === "list") {
    const parsed = await runAgentBrowserJSON(host, args, 30_000, { port: state.port });
    const tabs = normalizeTabList(parsed);
    const active = tabs.find((tab) => tab.active === true);
    state.targetId = typeof active?.targetId === "string" ? active.targetId : undefined;
    if (state.targetId) {
      state.tabGoneTargetId = undefined;
      state.tabGoneLastUrl = undefined;
    } else if (previousTargetId) {
      state.tabGoneTargetId ??= previousTargetId;
      state.tabGoneLastUrl ??= sanitizeTabRecoveryUrl(previousUrl);
      state.currentUrl = undefined;
      state.currentDomain = undefined;
    }
    result.summary = state.targetId
      ? `Listed ${tabs.length} tab${tabs.length === 1 ? "" : "s"}.`
      : `Listed ${tabs.length} tab${tabs.length === 1 ? "" : "s"}; no tab is bound. Create or switch one to recover.`;
    result.contentText = formatTabTable(tabs);
    (result.diagnostics as Record<string, unknown>).tabs = tabs;
    (result.diagnostics as Record<string, unknown>).targetId = state.targetId;
    (result.diagnostics as Record<string, unknown>).tabBinding = state.targetId ? "pinned" : "gone";
    state.lastAction = args.join(" ");
    state.connected = true;
    state.lastVerifiedAt = Date.now();
    state.lastError = undefined;
    return result;
  }

  if (params.action === "new" || params.action === "switch") {
    await clearControlledTab(host, state);
  }
  // Keep tab command results structured: 0.34 includes the durable targetId, and close can
  // intentionally leave a strict session in tab_gone instead of selecting the next tab.
  const commandResult = await runAgentBrowserJSON(host, args, 60_000, { port: state.port });
  const tabs = await refreshActiveTarget(host, state);

  if (state.targetId) {
    await refreshCurrentUrl(host, state);
    await markControlledTab(host, state);
  } else {
    // Closing the bound/current tab is a successful mutation under strict pinning. Do not
    // turn it into a failed tool call by probing the now-intentionally-unbound page.
    const closedTargetId = isPlainObject(commandResult) && typeof commandResult.targetId === "string"
      ? commandResult.targetId
      : previousTargetId;
    state.tabGoneTargetId = closedTargetId;
    state.tabGoneLastUrl = sanitizeTabRecoveryUrl(previousUrl);
    state.currentUrl = undefined;
    state.currentDomain = undefined;
    state.lastVerifiedAt = Date.now();
  }

  state.connected = true;
  state.lastAction = args.join(" ");
  state.lastError = undefined;

  const verb =
    params.action === "new"
      ? `Opened new pinned tab${params.label ? ` '${params.label}'` : ""}${params.url ? ` ${params.url}` : ""}.`
      : params.action === "close"
        ? state.targetId
          ? params.tab !== undefined ? `Closed tab ${params.tab}.` : "Closed current tab."
          : `Closed ${params.tab !== undefined ? `tab ${params.tab}` : "the current tab"}; the session remains pinned and awaits explicit recovery.`
        : `Switched and re-pinned to tab ${params.tab}.`;
  // The recorder stays attached to the tab it started on, which is now hidden and freezes.
  const recordingLeftBehind = state.recording && (params.action === "new" || params.action === "switch");
  result.summary = recordingLeftBehind
    ? `${verb}\nWarning: the recording is still filming the previous tab, which is now in the background and will freeze. Use browser_record restart to film this tab.`
    : verb;
  (result.diagnostics as Record<string, unknown>).commandResult = commandResult;
  (result.diagnostics as Record<string, unknown>).tabs = tabs;
  (result.diagnostics as Record<string, unknown>).targetId = state.targetId;
  (result.diagnostics as Record<string, unknown>).tabBinding = state.targetId ? "pinned" : "gone";
  (result.diagnostics as Record<string, unknown>).currentUrl = state.currentUrl;
  (result.diagnostics as Record<string, unknown>).currentDomain = state.currentDomain;
  return result;
}

export async function isBrowserState(
  host: BrowserHost,
  state: BrowserState,
  params: IsArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const args = buildIsArgs(params);
  const parsed = await runAgentBrowserJSON(host, args, 30_000, { port: state.port });
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
  host: BrowserHost,
  state: BrowserState,
  params: SetArgsOptions,
): Promise<BrowserActionResult> {
  await ensureReady(host, state);

  const args = buildSetArgs(params);
  await runAgentBrowser(host, args, 30_000, { port: state.port });
  await markControlledTab(host, state);

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
  host: BrowserHost,
  state: BrowserState,
  params: { action: CaptureAction; content?: HarContentMode; label?: string },
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  await ensureArtifactDir(host, state);

  if (params.action === "start") {
    const file = artifactPath(state, params.label ?? "network", "har");
    const args = buildHarArgs({ action: "start", content: params.content });
    await runAgentBrowser(host, args, 30_000, { port: state.port });
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
  await runAgentBrowser(host, args, 60_000, { port: state.port });
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

export async function exportCookies(
  host: BrowserHost,
  state: BrowserState,
  params: { path?: string; label?: string },
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  await ensureArtifactDir(host, state);

  // agent-browser scopes `cookies get` to the pinned tab's URL, so the caller must be on the
  // origin whose cookies it wants. The values go straight to disk and never into the result.
  const cookies = extractCookies(await runAgentBrowserJSON(host, ["cookies", "get"], 30_000, { port: state.port }));
  const file = params.path
    ? resolve(host.cwd, params.path.replace(/^~(?=$|\/)/, host.homeDir))
    : artifactPath(state, params.label ?? "cookies", "json");
  await host.writePrivateFile(file, `${JSON.stringify(cookies, null, 2)}\n`);
  state.connected = true;
  state.lastAction = "cookies get";
  state.lastError = undefined;

  return {
    summary: `Exported ${cookies.length} cookies for ${state.currentUrl ?? "the current page"} → ${file} (mode 600, values withheld)`,
    contentText: formatCookieSummary(cookies),
    artifacts: [file],
    diagnostics: { file, count: cookies.length, currentUrl: state.currentUrl },
  };
}

export async function recordBrowser(
  host: BrowserHost,
  state: BrowserState,
  params: Omit<RecordArgsOptions, "file"> & { label?: string; format?: "webm" | "mp4" },
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  await ensureArtifactDir(host, state);

  if (params.action === "stop") {
    const previous = state.recording;
    // agent-browser drops its recording on every stop, failed or not, so ours goes too;
    // otherwise a failed stop leaves "rec" showing with nothing left to stop.
    state.recording = undefined;
    state.lastAction = "record stop";
    // A tab hidden mid-take froze from then on, though it painted a few frames first.
    const hiddenAtStop = previous ? await controlledTabHidden(host, state) : false;
    let stopped: unknown;
    try {
      stopped = await runAgentBrowserJSON(host, buildRecordArgs({ action: "stop" }), 60_000, { port: state.port });
    } catch (error) {
      if (!/No recording in progress/.test(error instanceof Error ? error.message : String(error))) throw error;
      return {
        summary: `No recording was running: the browser daemon restarted (idle timeout, crash, or a session change) or the take was already stopped.${previous ? ` ${previous.file} may be missing or truncated.` : ""}`,
        diagnostics: { action: "stop", lost: true, file: previous?.file },
      };
    }
    state.connected = true;
    state.lastError = undefined;

    const data = isPlainObject(stopped) ? stopped : {};
    const file = readString(stopped, "path") ?? previous?.file;
    const sheet = readString(stopped, "contactSheetPath");
    // Chrome does not paint a hidden tab, so its screencast holds one frame for the take.
    const fps = typeof data.fps === "number" ? data.fps : 30;
    const stillFrame = typeof data.capturedFrames === "number" && data.capturedFrames <= 1 && typeof data.frames === "number" && data.frames > fps;
    return {
      summary: [
        file ? `Stopped recording → ${file}` : "Stopped recording.",
        stillFrame
          ? "Warning: the video is one still frame. The tab never repainted, most likely because it was in the background or its window was minimised."
          : hiddenAtStop
            ? "Warning: the tab was in the background when the take ended, so the video froze from when it was hidden."
            : "",
      ].filter(Boolean).join("\n"),
      artifacts: [file, sheet].filter((entry): entry is string => Boolean(entry)),
      diagnostics: {
        action: "stop",
        file,
        contactSheetPath: sheet,
        frames: data.frames,
        capturedFrames: data.capturedFrames,
        fps: data.fps,
        contactSheetFrames: data.contactSheetFrames,
        stillFrame,
        hiddenAtStop,
        durationMs: previous ? Date.now() - previous.startedAt : undefined,
      },
    };
  }

  // .mp4 (H.264) plays inline in more viewers; .webm (VP8) stays the smaller default.
  if (params.format !== undefined && params.format !== "webm" && params.format !== "mp4") {
    throw new Error(`browser_record format must be webm or mp4 (got ${params.format}).`);
  }
  const file = artifactPath(state, params.label ?? "recording", params.format ?? "webm");
  const args = buildRecordArgs({ ...params, file });
  const visibility = await bringControlledTabForward(host, state);
  const previous = state.recording;
  const started = await runAgentBrowserJSON(host, args, 30_000, { port: state.port });
  await markControlledTab(host, state);
  const contactSheet = Boolean(params.contactSheet || params.contactSheetThreshold !== undefined);
  state.recording = { file, startedAt: Date.now(), ...(contactSheet ? { contactSheet } : {}) };
  state.connected = true;
  state.lastAction = `record ${params.action}`;
  state.lastError = undefined;
  await refreshCurrentUrl(host, state);

  // restart finalises the take before it, which only the restart's own answer names.
  const previousPath = params.action === "restart" ? readString(started, "previousPath") : undefined;
  const previousContactSheetPath = previousPath && previous?.contactSheet ? contactSheetPath(previousPath) : undefined;
  return {
    summary: [
      previousPath ? `Saved the previous take → ${previousPath}` : "",
      `${params.action === "restart" ? "Restarted" : "Started"} recording (${params.fps ?? 30} fps${params.cursor ? ", cursor" : ""}) → ${file}`,
      visibility === "brought" ? "Brought the controlled tab to the front: Chrome does not paint background tabs, so the video would have frozen." : "",
      visibility === "hidden" ? "Warning: the controlled tab is still hidden (its window may be minimised or covered), so the video freezes until it is visible." : "",
    ].filter(Boolean).join("\n"),
    artifacts: [previousPath, previousContactSheetPath].filter((entry): entry is string => Boolean(entry)),
    diagnostics: {
      action: params.action,
      file,
      fps: params.fps ?? 30,
      cursor: params.cursor,
      contactSheetPath: contactSheet ? contactSheetPath(file) : undefined,
      previousPath,
      previousContactSheetPath,
      broughtForward: visibility === "brought",
      currentUrl: state.currentUrl,
    },
  };
}

/**
 * Chrome does not paint a background tab, so a screencast of one holds a single frame for
 * the whole take. A recording is user-directed, so the controlled tab comes to the front.
 * `/json/activate` is the browser's own endpoint, so the session's tab pin is untouched.
 */
async function bringControlledTabForward(host: BrowserHost, state: BrowserState): Promise<"visible" | "brought" | "hidden"> {
  if (!(await controlledTabHidden(host, state))) return "visible";
  if (!state.targetId) await refreshActiveTarget(host, state);
  if (state.targetId) {
    await host.exec("curl", ["-sf", `http://localhost:${state.port}/json/activate/${state.targetId}`], { timeout: 5_000 });
  }
  return (await controlledTabHidden(host, state)) ? "hidden" : "brought";
}

/** Whether the controlled tab is in the background, where Chrome does not paint it. */
async function controlledTabHidden(host: BrowserHost, state: BrowserState): Promise<boolean> {
  const visibility = await runAgentBrowser(host, ["eval", "document.visibilityState"], 10_000, { port: state.port, allowFailure: true });
  return visibility.includes("hidden");
}

/** Whether this host's daemon is alive, asked without spawning one; undefined if unknown. */
async function daemonRunning(host: BrowserHost): Promise<boolean | undefined> {
  const listed = await host.exec("agent-browser", buildSessionListArgs(), { timeout: 5_000 }).catch(() => undefined);
  try {
    const data = listed?.code === 0 ? unwrapCliEnvelope(JSON.parse(listed.stdout)) : undefined;
    const sessions = isPlainObject(data) ? data.sessions : undefined;
    return Array.isArray(sessions) ? sessions.includes(agentBrowserSessionName(host.sessionId, host.sessionPrefix)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stops a running recording, HAR or trace before its session goes, since a daemon that
 * exits mid-capture leaves a truncated or empty file. It skips the readiness probes to fit a
 * host's session-end budget: once a stop reaches the daemon, the file is finalised even if
 * this client is then cut off. Best effort, as an ending session has no one to report to.
 */
export async function stopCapturesNow(host: BrowserHost, state: BrowserState): Promise<void> {
  const stops = [
    state.recording ? buildRecordArgs({ action: "stop" }) : undefined,
    state.har ? buildHarArgs({ action: "stop", file: state.har.file }) : undefined,
    state.tracing ? buildTraceArgs({ action: "stop" }) : undefined,
  ].filter((args): args is string[] => Boolean(args));
  state.recording = undefined;
  state.har = undefined;
  state.tracing = undefined;
  // A stop is a CDP call, which would respawn a daemon that already exited and took the
  // captures with it, only to hear there is nothing to stop.
  if (stops.length === 0 || (await daemonRunning(host)) === false) return;
  await Promise.all(stops.map((args) => runAgentBrowser(host, args, 10_000, { port: state.port, allowFailure: true }).catch(() => "")));
}

function readString(payload: unknown, key: string): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  const value = payload[key];
  return typeof value === "string" && value ? value : undefined;
}

export async function traceBrowser(
  host: BrowserHost,
  state: BrowserState,
  params: { action: CaptureAction; label?: string },
): Promise<BrowserActionResult> {
  return captureRecording(host, state, params, {
    kind: "tracing",
    extension: "zip",
    buildArgs: buildTraceArgs,
  });
}

async function captureRecording(
  host: BrowserHost,
  state: BrowserState,
  params: { action: CaptureAction; label?: string },
  options: {
    kind: "tracing";
    extension: string;
    buildArgs: (input: { action: CaptureAction; file?: string }) => string[];
  },
): Promise<BrowserActionResult> {
  await ensureReady(host, state);
  await ensureArtifactDir(host, state);

  if (params.action === "start") {
    const label = params.label ?? options.kind;
    const file = artifactPath(state, label, options.extension);
    const args = options.buildArgs({ action: "start", file });
    await runAgentBrowser(host, args, 30_000, { port: state.port });
    await markControlledTab(host, state);
    state[options.kind] = { file, startedAt: Date.now() };
    state.connected = true;
    state.lastAction = args.join(" ");
    state.lastError = undefined;
    await refreshCurrentUrl(host, state);

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
  await runAgentBrowser(host, args, 60_000, { port: state.port });
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
  state.targetId = undefined;
  state.tabGoneTargetId = undefined;
  state.tabGoneLastUrl = undefined;
  state.dashboardUrl = undefined;
  state.recording = undefined;
  state.tracing = undefined;
  state.har = undefined;
}


async function markControlledTab(host: BrowserHost, state: BrowserState): Promise<void> {
  if (!resolveControlBannerEnabled()) return;
  // currentDomain is refreshed just before this call, so it's the live target; lastAction
  // lags by one step here, so the pill identifies the agent + what it's driving instead.
  const target = state.currentDomain ?? `cdp:${state.port}`;
  const labelText = controlledTabLabel(target);
  await runAgentBrowser(host, ["eval", controlledTabMarkScript(labelText, host.markerFaviconHref, host.markerAccent)], 10_000, {
    port: state.port,
    allowFailure: true,
  });
}

async function clearControlledTab(host: BrowserHost, state: BrowserState): Promise<void> {
  await runAgentBrowser(host, ["eval", CONTROLLED_TAB_CLEAR_SCRIPT], 10_000, {
    port: state.port,
    allowFailure: true,
  });
}

async function ensureReady(host: BrowserHost, state: BrowserState): Promise<void> {
  await ensureArtifactDir(host, state);
  await assertAgentBrowserInstalled(host, state);
}

async function assertAgentBrowserInstalled(
  host: BrowserHost,
  state: BrowserState,
): Promise<void> {
  const probe = await probeAgentBrowserVersion(host, state);
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
  host: BrowserHost,
  state: BrowserState,
): Promise<AgentBrowserVersionProbe> {
  let installed: string | undefined;
  try {
    const result = (await host.exec("agent-browser", ["--version"], {
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
  host: BrowserHost,
  port: number,
): Promise<void> {
  const targets = await fetchTargets(host, port);
  if (targets.some((t) => t.type === "page")) return;

  // No page target — create one. This opens a blank tab in Arc.
  const create = (await host.exec(
    "curl",
    ["-sf", "-X", "PUT", `http://localhost:${port}/json/new?about:blank`],
    { timeout: 5_000 },
  )) as CommandResult;

  if (create.code !== 0) {
    throw new Error(`Failed to create a page target on port ${port}. Is the browser accepting CDP connections?`);
  }
}

// Re-create a page target so a fresh agent-browser attach can succeed. Swallows failures
// so the caller can fall back to surfacing the original error.
async function tryEnsureTarget(host: BrowserHost, port: number): Promise<boolean> {
  try {
    await ensurePageTarget(host, port);
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
async function ensureDaemonOnPort(host: BrowserHost, port: number): Promise<void> {
  let cdpUrl: string | undefined;
  try {
    const data = await runAgentBrowserJSON(host, ["get", "cdp-url"], 10_000, { port });
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

  await runAgentBrowser(host, ["close"], 15_000, { port, allowFailure: true });
}

async function fetchTargets(host: BrowserHost, port: number): Promise<CdpTarget[]> {
  const result = (await host.exec("curl", ["-sf", `http://localhost:${port}/json/list`], {
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

async function fetchBrowserVersion(host: BrowserHost, port: number): Promise<string | undefined> {
  const result = (await host.exec("curl", ["-sf", `http://localhost:${port}/json/version`], {
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
  host: BrowserHost,
  port: number,
): Promise<boolean> {
  const result = (await host.exec("lsof", ["-i", `tcp:${port}`, "-sTCP:LISTEN", "-n", "-P"], {
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
  host: BrowserHost,
  state: BrowserState,
): Promise<ConnectionProbe> {
  const agentBrowser = await probeAgentBrowserVersion(host, state);
  const agentBrowserSession = agentBrowserSessionName(host.sessionId, host.sessionPrefix);
  const portListening = await isPortListening(host, state.port);
  if (!portListening) {
    state.connected = false;
    return {
      portListening: false,
      pageTargets: 0,
      agentBrowserSession,
      pinTab: true,
      tabBinding: tabBindingStatus(state),
      targetId: state.targetId ?? state.tabGoneTargetId,
      lastUrl: state.tabGoneLastUrl,
      agentBrowserVersion: agentBrowser.installed,
      agentBrowserCompatible: agentBrowser.compatible,
      requiredAgentBrowserVersion: agentBrowser.required,
    };
  }

  const targets = await fetchTargets(host, state.port);
  const pages = targets.filter((t) => t.type === "page");
  // Best guess at a foreground page for display only — agent-browser picks its own target,
  // so this is a probe observation, not necessarily the controlled tab.
  const attached = pages.find((t) => Boolean(t.url) && t.url !== "about:blank") ?? pages[0];
  const browser = await fetchBrowserVersion(host, state.port);

  // A daemon that exited (idle timeout, crash) took any capture with it, and the binding
  // probe below would respawn it without one. Ask first, through a call that spawns nothing.
  const lostCaptures = await findLostCaptures(host, state);

  // Only touch agent-browser when state proves this Pi session has previously established a
  // binding. This actively restores/checks known bindings without making browser_status on a
  // brand-new session create a tab as a side effect.
  const bindingError = agentBrowser.compatible && (state.targetId || state.tabGoneTargetId)
    ? await probeKnownTabBinding(host, state)
    : undefined;

  state.connected = bindingError === undefined;
  if (bindingError === undefined) state.lastVerifiedAt = Date.now();
  if (lostCaptures) state.lastError = `The browser daemon exited, so the ${lostCaptures} in progress was lost.`;

  return {
    portListening: true,
    pageTargets: pages.length,
    attachedUrl: typeof attached?.url === "string" ? attached.url : undefined,
    browser,
    agentBrowserSession,
    pinTab: true,
    tabBinding: tabBindingStatus(state, bindingError),
    targetId: state.targetId ?? state.tabGoneTargetId,
    lastUrl: state.tabGoneLastUrl,
    bindingError,
    agentBrowserVersion: agentBrowser.installed,
    agentBrowserCompatible: agentBrowser.compatible,
    requiredAgentBrowserVersion: agentBrowser.required,
  };
}

/** Clears captures whose daemon is gone and names them, e.g. "recording, HAR"; else undefined. */
async function findLostCaptures(host: BrowserHost, state: BrowserState): Promise<string | undefined> {
  if (!state.recording && !state.har && !state.tracing) return undefined;
  // Unknown is not gone: only a listing without this session clears state.
  if ((await daemonRunning(host)) !== false) return undefined;
  const lost = [state.recording && "recording", state.har && "HAR", state.tracing && "trace"].filter(Boolean).join(", ");
  state.recording = undefined;
  state.har = undefined;
  state.tracing = undefined;
  return lost;
}

async function probeKnownTabBinding(
  host: BrowserHost,
  state: BrowserState,
): Promise<string | undefined> {
  const priorTargetId = state.tabGoneTargetId ?? state.targetId;
  const priorLastUrl = state.tabGoneLastUrl;

  try {
    await refreshActiveTarget(host, state);
    await refreshCurrentUrl(host, state, false);
    state.lastError = undefined;
    return undefined;
  } catch (error) {
    if (error instanceof CdpError && error.kind === "tab-gone") {
      state.targetId = undefined;
      state.tabGoneTargetId = error.targetId ?? priorTargetId;
      state.tabGoneLastUrl = error.lastUrl ?? priorLastUrl;
      state.currentUrl = undefined;
      state.currentDomain = undefined;
      return undefined;
    }

    if (!state.targetId && !state.tabGoneTargetId) state.targetId = priorTargetId;
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = `Pinned tab probe failed: ${message}`;
    return message;
  }
}

async function refreshCurrentUrl(
  host: BrowserHost,
  state: BrowserState,
  allowFailure = true,
): Promise<void> {
  const result = await runAgentBrowser(host, ["get", "url"], 10_000, { port: state.port, allowFailure });
  const url = result.trim();
  state.currentUrl = url || undefined;
  state.currentDomain = domainFromUrl(url);
  state.tabGoneTargetId = undefined;
  state.tabGoneLastUrl = undefined;
  // Reached only after the action's main (non-allowFailure) call already succeeded, so the
  // browser just proved it's alive — record that for the staleness signal.
  state.lastVerifiedAt = Date.now();
}

/** Read the session's active durable CDP target after connect or a tab mutation. */
async function refreshActiveTarget(
  host: BrowserHost,
  state: BrowserState,
): Promise<Array<Record<string, unknown>>> {
  const parsed = await runAgentBrowserJSON(host, ["tab", "list"], 30_000, { port: state.port });
  const tabs = normalizeTabList(parsed);
  const active = tabs.find((tab) => tab.active === true);
  state.targetId = typeof active?.targetId === "string" ? active.targetId : undefined;
  return tabs;
}

async function refreshDashboardUrl(
  host: BrowserHost,
  state: BrowserState,
): Promise<void> {
  if (await isPortListening(host, state.dashboardPort)) {
    state.dashboardUrl = `http://localhost:${state.dashboardPort}`;
  } else {
    state.dashboardUrl = undefined;
  }
}

async function runAgentBrowser(
  host: BrowserHost,
  args: string[],
  timeout: number,
  options: { allowFailure?: boolean; port?: number; local?: boolean } = {},
): Promise<string> {
  let fullArgs = options.port !== undefined
    ? buildCdpInvocationArgs(args, options.port, host.sessionId, host.sessionPrefix)
    : args;
  let effectiveTimeout = timeout;

  // agent-browser honors --timeout only for `wait` operations (waitForSelector and
  // --load/--url/--text/--fn); navigation and element actions use the daemon default
  // (25s, AGENT_BROWSER_DEFAULT_TIMEOUT — inherited from the host's env) and ignore the flag.
  // So only a `wait` against a local/dev-server target gets the larger budget, and we
  // keep our own kill-timeout above agent-browser's so its clearer error wins.
  if (options.local && args[0] === "wait" && !args.includes("--timeout")) {
    const localMs = localBrowserTimeoutMs();
    fullArgs = [...fullArgs, "--timeout", String(localMs)];
    effectiveTimeout = Math.max(timeout, localMs + 15_000);
  }

  const exec = (): Promise<CommandResult> =>
    host.exec("agent-browser", fullArgs, {
      timeout: effectiveTimeout,
    }) as Promise<CommandResult>;

  let result = await exec();
  if (result.code === 0) return joinAgentBrowserOutput(result);

  // Best-effort calls (banner injection, url refresh) never heal/retry or throw — a
  // cosmetic miss must not become a hard failure.
  if (options.allowFailure) return "";

  let failureText = combineStreams(result);
  let kind = classifyCdpError(failureText);

  // Self-heal once: a transient vanished page target is usually recoverable by re-creating
  // one and letting agent-browser re-attach on retry. A strict `tab_gone` stop is deliberately
  // excluded: silently creating/adopting a tab would defeat 0.34's session isolation.
  if (kind === "target-gone" && options.port !== undefined) {
    const healed = await tryEnsureTarget(host, options.port);
    if (healed) {
      result = await exec();
      if (result.code === 0) return joinAgentBrowserOutput(result);
      failureText = combineStreams(result);
      kind = classifyCdpError(failureText);
    }
  }

  const tabGone = kind === "tab-gone" ? extractTabGoneDetails(failureText) : {};
  throw new CdpError(
    friendlyCdpMessage(
      kind,
      options.port,
      formatExecFailure("agent-browser", fullArgs, result),
      tabGone,
    ),
    kind,
    tabGone,
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
  host: BrowserHost,
  args: string[],
  timeout: number,
  options: { port?: number; local?: boolean } = {},
): Promise<unknown> {
  const argsWithJson = args.includes("--json") ? args : [...args, "--json"];
  const output = await runAgentBrowser(host, argsWithJson, timeout, options);
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
  host: BrowserHost,
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
    await runAgentBrowser(host, ["wait", "--load", loadState, "--timeout", String(settleMs)], settleMs + 15_000, {
      port,
      allowFailure: true,
    });
    return;
  }

  const ms = waitMode === "networkidle" ? 2000 : 1000;
  await runAgentBrowser(host, ["wait", String(ms)], ms + 30_000, { port });
}

async function ensureArtifactDir(host: BrowserHost, state: BrowserState): Promise<void> {
  await host.ensureDir(state.artifactDir);
}

function artifactPath(state: BrowserState, label: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(state.artifactDir, `${timestamp}-${sanitizeArtifactLabel(label)}.${extension}`);
}

async function truncateForTool(host: BrowserHost, content: string, artifactPathValue?: string): Promise<string> {
  const output = await formatToolText(host, content, {
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
  // With --json, agent-browser reports the reason on stdout as {"success":false,"error":…}
  // and leaves stderr empty, so lead with it rather than the long command line.
  let reason: string | undefined;
  try {
    unwrapCliEnvelope(JSON.parse(result.stdout.slice(Math.max(0, findJsonStart(result.stdout)))));
  } catch (error) {
    if (error instanceof AgentBrowserCliError) reason = error.message;
  }
  const details = [
    ...(reason ? [`agent-browser: ${reason}`] : []),
    `Command failed: ${command} ${args.join(" ")}`,
    `Exit code: ${result.code}`,
  ];

  if (result.killed) details.push("Process was killed.");
  if (result.stdout.trim()) details.push(`stdout:\n${result.stdout.trim()}`);
  if (result.stderr.trim()) details.push(`stderr:\n${result.stderr.trim()}`);

  return details.join("\n");
}
