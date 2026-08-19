import { createHash } from "node:crypto";

const DA_BROWSER_NAMESPACE = "da-browser";

export function agentBrowserSessionName(piSessionId: string): string {
  const source = piSessionId.trim() || "session";
  // agent-browser puts namespace + session in a Unix socket path. A raw Pi UUID can exceed
  // macOS's 103-byte socket-path limit, so retain 64 bits of a deterministic SHA-256 digest.
  return `pi-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

/**
 * Build the global arguments for a command that attaches to an existing browser via CDP.
 *
 * agent-browser cannot combine a domain allowlist with pre-existing CDP pages because it
 * cannot install WebRTC containment before their scripts run. An explicit empty value
 * overrides AGENT_BROWSER_ALLOWED_DOMAINS/config inherited by pi. The dedicated namespace
 * and pi-session-derived daemon keep that override away from other agent-browser workflows.
 *
 * Strict tab pinning is deliberately present on every call. agent-browser 0.34 makes the
 * flag sticky, but repeating it also upgrades an already-running daemon before it can attach
 * or execute a command. This guarantees that concurrent Pi sessions sharing one browser do
 * not adopt, navigate, or react to one another's tabs.
 */
export function buildCdpInvocationArgs(
  commandArgs: readonly string[],
  port: number,
  piSessionId: string,
): string[] {
  if (commandArgs.some((arg) => arg === "--allowed-domains" || arg.startsWith("--allowed-domains="))) {
    throw new Error(
      "CDP-backed browser tools cannot use allowedDomains; use browser_read with an explicit URL or remove the allowlist.",
    );
  }
  const managedFlag = commandArgs.find((arg) =>
    ["--cdp", "--session", "--namespace", "--pin-tab", "--no-pin-tab"].some(
      (flag) => arg === flag || arg.startsWith(`${flag}=`),
    ),
  );
  if (managedFlag) {
    throw new Error(`da-browser manages ${managedFlag}; omit it from browser_command args.`);
  }

  return [
    "--namespace",
    DA_BROWSER_NAMESPACE,
    "--session",
    agentBrowserSessionName(piSessionId),
    "--pin-tab",
    "--allowed-domains",
    "",
    "--cdp",
    String(port),
    ...commandArgs,
  ];
}

export interface SnapshotArgsOptions {
  interactiveOnly?: boolean;
  /** Include href URLs on link elements (`-u`). */
  urls?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
}

export function buildSnapshotArgs(opts: SnapshotArgsOptions): string[] {
  const args = ["snapshot"];
  if (opts.interactiveOnly) args.push("-i");
  if (opts.urls) args.push("-u");
  if (opts.compact) args.push("-c");
  if (opts.depth != null) args.push("-d", String(opts.depth));
  if (opts.selector) args.push("-s", opts.selector);
  return args;
}

export interface ReadArgsOptions {
  /** Optional URL. Omit to read rendered text from the active browser tab. */
  url?: string;
  /** Narrow page sections, llms links/sections, or outline headings. */
  filter?: string;
  /** Return a compact heading outline for one page. */
  outline?: boolean;
  /** Read nearest-ancestor llms.txt (`index`) or llms-full.txt (`full`). */
  llms?: "index" | "full";
  /** Fail unless the server returns markdown. */
  requireMd?: boolean;
  /** Return the raw response body without HTML extraction. */
  raw?: boolean;
  /** Return structured metadata from agent-browser. */
  json?: boolean;
  timeoutMs?: number;
  maxOutput?: number;
  allowedDomains?: string[];
  contentBoundaries?: boolean;
}

export function buildReadArgs(params: ReadArgsOptions): string[] {
  const args = ["read"];
  if (params.url) args.push(params.url);
  if (params.filter) args.push("--filter", params.filter);
  if (params.outline) args.push("--outline");
  if (params.llms) args.push("--llms", params.llms);
  if (params.requireMd) args.push("--require-md");
  if (params.raw) args.push("--raw");
  if (params.timeoutMs !== undefined) args.push("--timeout", String(params.timeoutMs));
  if (params.maxOutput !== undefined) args.push("--max-output", String(params.maxOutput));
  if (params.allowedDomains && params.allowedDomains.length > 0) {
    args.push("--allowed-domains", params.allowedDomains.join(","));
  }
  if (params.contentBoundaries) args.push("--content-boundaries");
  if (params.json) args.push("--json");
  return args;
}

export interface A11yArgsOptions {
  /** Optional URL. Omit to audit the active page. */
  url?: string;
  /** Axe/WCAG tags such as wcag2a and wcag2aa. */
  tags?: string[];
  /** Scope the audit to a CSS subtree. */
  selector?: string;
  /** Return structured violations and incomplete checks. */
  json?: boolean;
}

export function buildA11yArgs(params: A11yArgsOptions): string[] {
  const args = ["a11y"];
  if (params.url) args.push(params.url);

  const tags = params.tags?.map((tag) => tag.trim()).filter(Boolean);
  if (tags?.length) args.push("--tags", tags.join(","));
  if (params.selector) args.push("--selector", params.selector);
  if (params.json) args.push("--json");
  return args;
}

export const FIND_ACTIONS = ["click", "fill", "type", "hover", "focus", "check", "uncheck"] as const;
export type FindAction = (typeof FIND_ACTIONS)[number];

const FIND_ACTIONS_WITH_TEXT = new Set<FindAction>(["fill", "type"]);
// Actions that change page state and therefore invalidate snapshot refs.
export const MUTATING_FIND_ACTIONS = new Set<FindAction>(["click", "fill", "type", "check", "uncheck"]);

export interface FindArgsOptions {
  locator: string;
  value: string;
  /**
   * Required: the CLI treats a missing action as `click` (since ~0.25), so an
   * accidental "just locate" call would mutate the page.
   */
  action: FindAction;
  /** 0-based match index, required when locator is "nth". */
  nthIndex?: number;
  text?: string;
  name?: string;
  exact?: boolean;
}

export function buildFindArgs(params: FindArgsOptions): string[] {
  if (!params.action || !(FIND_ACTIONS as readonly string[]).includes(params.action)) {
    throw new Error(
      `browser_find requires an action (${FIND_ACTIONS.join(", ")}) — agent-browser defaults a missing action to click.`,
    );
  }
  if (FIND_ACTIONS_WITH_TEXT.has(params.action) && params.text === undefined) {
    throw new Error(`browser_find action '${params.action}' requires text.`);
  }
  if (params.locator === "nth" && params.nthIndex === undefined) {
    throw new Error("browser_find locator 'nth' requires nthIndex (0-based).");
  }
  if (params.locator !== "nth" && params.nthIndex !== undefined) {
    throw new Error("browser_find nthIndex only applies to the 'nth' locator.");
  }

  const args = ["find", params.locator];
  if (params.locator === "nth") args.push(String(params.nthIndex));
  args.push(params.value, params.action);
  if (params.text !== undefined) args.push(params.text);
  if (params.name) args.push("--name", params.name);
  if (params.exact) args.push("--exact");
  return args;
}

export type TabAction = "list" | "new" | "close" | "switch";

export interface TabArgsOptions {
  action: TabAction;
  url?: string;
  /** Memorable label for `new` (interchangeable with ids in later tab refs). */
  label?: string;
  /** Stable tab id like `t2`, a user-assigned label, or a CDP target id. */
  tab?: string;
}

/**
 * Tabs use stable string ids (`t1`, `t2`, …) since agent-browser 0.26; bare integers are
 * rejected by the CLI. Models habitually pass `2`, so coerce digits to `t2` here. CDP
 * target ids pass through unchanged and, since 0.34, remain usable across daemon restarts.
 */
export function normalizeTabRef(tab: string): string {
  const trimmed = tab.trim();
  return /^\d+$/.test(trimmed) ? `t${trimmed}` : trimmed;
}

export function buildTabArgs(params: TabArgsOptions): string[] {
  switch (params.action) {
    case "list":
      if (params.url !== undefined || params.tab !== undefined) {
        throw new Error("browser_tab list does not accept url or tab.");
      }
      return ["tab", "list", "--json"];
    case "new": {
      if (params.tab !== undefined) {
        throw new Error("browser_tab new does not accept a tab ref; use label to name the new tab.");
      }
      const args = ["tab", "new"];
      if (params.label) args.push("--label", params.label.trim());
      if (params.url) args.push(params.url);
      return args;
    }
    case "close":
      if (params.url !== undefined) {
        throw new Error("browser_tab close does not accept a url.");
      }
      return params.tab === undefined ? ["tab", "close"] : ["tab", "close", normalizeTabRef(params.tab)];
    case "switch":
      if (params.url !== undefined) {
        throw new Error("browser_tab switch does not accept a url.");
      }
      if (params.tab === undefined || !params.tab.trim()) {
        throw new Error("browser_tab switch requires a tab id (like t2), label, or CDP target id.");
      }
      // Switching has no subcommand in the CLI: `tab <id|label|targetId>`.
      return ["tab", normalizeTabRef(params.tab)];
    default: {
      const exhaustive: never = params.action;
      throw new Error(`Unknown browser_tab action: ${String(exhaustive)}`);
    }
  }
}

export type IsCheck = "visible" | "enabled" | "checked";

export interface IsArgsOptions {
  check: IsCheck;
  selector: string;
}

export function buildIsArgs(params: IsArgsOptions): string[] {
  if (!params.selector || !params.selector.trim()) {
    throw new Error("browser_is requires a selector.");
  }
  return ["is", params.check, params.selector, "--json"];
}

export type SetSetting = "viewport" | "device" | "geo" | "offline" | "media" | "headers" | "credentials";

export interface SetArgsOptions {
  setting: SetSetting;
  width?: number;
  height?: number;
  /** Device scale factor for viewport, e.g. 2 for retina screenshots. */
  scale?: number;
  device?: string;
  latitude?: number;
  longitude?: number;
  offline?: boolean;
  media?: "dark" | "light";
  reducedMotion?: boolean;
  /** Extra HTTP headers for `setting: "headers"`. */
  headers?: Record<string, string>;
  username?: string;
  password?: string;
}

export function buildSetArgs(params: SetArgsOptions): string[] {
  const args = ["set", params.setting];
  switch (params.setting) {
    case "viewport":
      if (params.width === undefined || params.height === undefined) {
        throw new Error("browser_set viewport requires width and height.");
      }
      args.push(String(params.width), String(params.height));
      if (params.scale !== undefined) args.push(String(params.scale));
      return args;
    case "device":
      if (!params.device) {
        throw new Error("browser_set device requires device name.");
      }
      args.push(params.device);
      return args;
    case "geo":
      if (params.latitude === undefined || params.longitude === undefined) {
        throw new Error("browser_set geo requires latitude and longitude.");
      }
      args.push(String(params.latitude), String(params.longitude));
      return args;
    case "offline":
      if (params.offline === undefined) {
        throw new Error("browser_set offline requires offline boolean.");
      }
      args.push(params.offline ? "on" : "off");
      return args;
    case "media":
      // The CLI takes positional tokens; re-running without reduced-motion clears it,
      // so reducedMotion=false just omits the token (and needs media to emit anything).
      if (!params.media && params.reducedMotion !== true) {
        throw new Error("browser_set media requires media (dark|light) and/or reducedMotion=true.");
      }
      if (params.media) args.push(params.media);
      if (params.reducedMotion === true) args.push("reduced-motion");
      return args;
    case "headers":
      if (!params.headers || Object.keys(params.headers).length === 0) {
        throw new Error("browser_set headers requires a non-empty headers object.");
      }
      args.push(JSON.stringify(params.headers));
      return args;
    case "credentials":
      if (!params.username || params.password === undefined) {
        throw new Error("browser_set credentials requires username and password.");
      }
      args.push(params.username, params.password);
      return args;
    default: {
      const exhaustive: never = params.setting;
      throw new Error(`Unknown browser_set setting: ${String(exhaustive)}`);
    }
  }
}

export type WaitLoadState = "load" | "domcontentloaded" | "networkidle";
export type WaitElementState = "visible" | "hidden" | "attached" | "detached";

export interface WaitArgsOptions {
  /** CSS selector or @ref to wait for. */
  selector?: string;
  /** Plain time wait in milliseconds (last resort). */
  ms?: number;
  /** Wait until this text appears on the page (substring match). */
  text?: string;
  /** Wait until the URL matches a glob pattern like **\/dashboard. */
  urlPattern?: string;
  /** Wait for a load state. */
  load?: WaitLoadState;
  /** Wait until a JS expression is truthy. */
  fn?: string;
  /** Element state to wait for (selector mode only), e.g. hidden to wait for a spinner to go away. */
  state?: WaitElementState;
  timeoutMs?: number;
}

export function buildWaitArgs(params: WaitArgsOptions): string[] {
  const modes = [
    params.selector !== undefined ? "selector" : null,
    params.ms !== undefined ? "ms" : null,
    params.text !== undefined ? "text" : null,
    params.urlPattern !== undefined ? "urlPattern" : null,
    params.load !== undefined ? "load" : null,
    params.fn !== undefined ? "fn" : null,
  ].filter(Boolean);

  if (modes.length !== 1) {
    throw new Error(
      `browser_wait requires exactly one of selector, ms, text, urlPattern, load, or fn (got ${modes.length ? modes.join(", ") : "none"}).`,
    );
  }
  if (params.state !== undefined && params.selector === undefined) {
    throw new Error("browser_wait state only applies when waiting on a selector.");
  }

  const args = ["wait"];
  if (params.selector !== undefined) {
    args.push(params.selector);
    if (params.state) args.push("--state", params.state);
  } else if (params.ms !== undefined) {
    args.push(String(params.ms));
  } else if (params.text !== undefined) {
    args.push("--text", params.text);
  } else if (params.urlPattern !== undefined) {
    args.push("--url", params.urlPattern);
  } else if (params.load !== undefined) {
    args.push("--load", params.load);
  } else if (params.fn !== undefined) {
    args.push("--fn", params.fn);
  }

  if (params.timeoutMs !== undefined) args.push("--timeout", String(params.timeoutMs));
  return args;
}

export type ReactCommand = "tree" | "inspect" | "renders-start" | "renders-stop" | "suspense";

export interface ReactArgsOptions {
  command: ReactCommand;
  /** Fiber id from `react tree`, required for inspect. */
  fiberId?: number;
  /** Hide the static list in suspense output. */
  onlyDynamic?: boolean;
}

export function buildReactArgs(params: ReactArgsOptions): string[] {
  switch (params.command) {
    case "tree":
      return ["react", "tree"];
    case "inspect":
      if (params.fiberId === undefined) {
        throw new Error("browser_react inspect requires fiberId (from react tree output).");
      }
      return ["react", "inspect", String(params.fiberId)];
    case "renders-start":
      return ["react", "renders", "start"];
    case "renders-stop":
      return ["react", "renders", "stop"];
    case "suspense":
      return params.onlyDynamic ? ["react", "suspense", "--only-dynamic"] : ["react", "suspense"];
    default: {
      const exhaustive: never = params.command;
      throw new Error(`Unknown browser_react command: ${String(exhaustive)}`);
    }
  }
}

export type CaptureAction = "start" | "stop";
export type HarContentMode = "text" | "all" | "none";

export interface HarArgsOptions {
  action: CaptureAction;
  /** Response-body capture mode. Defaults to text in agent-browser. */
  content?: HarContentMode;
  /** Output path, accepted only when stopping. */
  file?: string;
}

export function buildHarArgs(params: HarArgsOptions): string[] {
  const args = ["network", "har", params.action];
  if (params.action === "start") {
    if (params.file !== undefined) {
      throw new Error("browser_har start does not accept a file path; the path is selected when stopping.");
    }
    if (params.content) args.push("--content", params.content);
    return args;
  }

  if (params.content !== undefined) {
    throw new Error("browser_har stop does not accept a content mode.");
  }
  if (params.file) args.push(params.file);
  return args;
}

export interface CaptureArgsOptions {
  action: CaptureAction;
  file?: string;
}

export function buildRecordArgs(params: CaptureArgsOptions): string[] {
  const args = ["record", params.action];
  if (params.action === "start" && params.file) args.push(params.file);
  if (params.action === "stop" && params.file !== undefined) {
    throw new Error("browser_record stop does not accept a file path.");
  }
  return args;
}

export function buildTraceArgs(params: CaptureArgsOptions): string[] {
  const args = ["trace", params.action];
  if (params.action === "start" && params.file) args.push(params.file);
  if (params.action === "stop" && params.file !== undefined) {
    throw new Error("browser_trace stop does not accept a file path.");
  }
  return args;
}
