// Pure CDP failure classification and recovery messaging. No I/O or framework deps
// so it stays unit-testable as a Light Guard Test, mirroring agent-browser-args.ts.
//
// Each agent-browser tool call is a fresh `agent-browser --cdp <port>` process, so a
// "connection" failure is really one of: the browser is gone (port not listening), the
// page target it attached to vanished (tab closed / context destroyed), or the page was
// too busy to respond. Classifying these lets callers self-heal the recoverable ones and
// give the agent an actionable next step instead of a raw exec dump.

export type CdpErrorKind = "browser-down" | "tab-gone" | "target-gone" | "page-busy" | "unknown";

export interface TabGoneDetails {
  targetId?: string;
  lastUrl?: string;
}

export class CdpError extends Error {
  readonly kind: CdpErrorKind;
  readonly targetId?: string;
  readonly lastUrl?: string;

  constructor(message: string, kind: CdpErrorKind, details: TabGoneDetails = {}) {
    super(message);
    this.name = "CdpError";
    this.kind = kind;
    this.targetId = details.targetId;
    this.lastUrl = details.lastUrl;
  }
}

// Browser process unreachable on the debugging port (quit, crashed, never launched, or a
// non-CDP listener). agent-browser surfaces these as "Failed to connect via CDP …".
const BROWSER_DOWN_PATTERNS: RegExp[] = [
  /failed to connect/i,
  /could not connect/i,
  /econnrefused/i,
  /connection[ _]?refused/i,
  /make sure the app is running/i,
  /remote-debugging-port/i,
  /browser (has been|was)? ?closed/i,
  /browser is not running/i,
];

// The specific page/target agent-browser attached to is gone, but the browser is alive.
// Usually recoverable by re-creating a page target and retrying once.
const TAB_GONE_PATTERN = /tab_gone/i;

const TARGET_GONE_PATTERNS: RegExp[] = [
  /target (closed|crashed)/i,
  /no (such )?(page )?target/i,
  /no target with given id/i,
  /session closed/i,
  /websocket.*(close|error)/i,
  /execution context was destroyed/i,
  /(page|frame) (was )?(closed|detached)/i,
];

// The page is reachable but didn't settle/respond in the allotted time.
const PAGE_BUSY_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /exceeded/i,
  /navigation (failed|timeout)/i,
];

export function classifyCdpError(text: string): CdpErrorKind {
  const haystack = text ?? "";
  // `tab_gone` is an intentional strict-pin safety stop, not a generic target loss. It
  // must never enter the automatic target-creation retry path below the wrapper.
  if (TAB_GONE_PATTERN.test(haystack)) return "tab-gone";
  if (BROWSER_DOWN_PATTERNS.some((re) => re.test(haystack))) return "browser-down";
  if (TARGET_GONE_PATTERNS.some((re) => re.test(haystack))) return "target-gone";
  if (PAGE_BUSY_PATTERNS.some((re) => re.test(haystack))) return "page-busy";
  return "unknown";
}

/**
 * Recover strict-pin metadata from both documented 0.34 JSON shapes and the human error.
 * Single commands put it under `data`; batch puts it under `result`.
 */
export function extractTabGoneDetails(text: string): TabGoneDetails {
  const candidate = jsonCandidate(text);
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const entry = Array.isArray(parsed)
        ? parsed.find((value) => isRecord(value) && value.code === "tab_gone")
        : parsed;
      if (isRecord(entry) && entry.code === "tab_gone") {
        const recovery = isRecord(entry.data) ? entry.data : isRecord(entry.result) ? entry.result : undefined;
        if (recovery) {
          return {
            targetId: typeof recovery.targetId === "string" ? recovery.targetId : undefined,
            lastUrl: typeof recovery.lastUrl === "string" ? sanitizeTabRecoveryUrl(recovery.lastUrl) : undefined,
          };
        }
      }
    } catch {
      // Fall through to the stable human format when mixed stdout/stderr is not pure JSON.
    }
  }

  const plain = text.match(/tab_gone:.*?\(target\s+([^,)]+)(?:,\s*last url\s+([^)]*))?\)/i);
  return {
    targetId: plain?.[1]?.trim() || undefined,
    lastUrl: sanitizeTabRecoveryUrl(plain?.[2]?.trim()),
  };
}

/** Match agent-browser's safe persisted/reported last-URL policy defensively. */
export function sanitizeTabRecoveryUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  if (raw === "about:blank") return raw;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function jsonCandidate(text: string): string | undefined {
  const objectAt = text.indexOf("{");
  const arrayAt = text.indexOf("[");
  const starts = [objectAt, arrayAt].filter((index) => index >= 0);
  if (starts.length === 0) return undefined;
  return text.slice(Math.min(...starts)).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function arcRelaunchCommand(port: number): string {
  return `whiskd start --name arc /Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=${port}`;
}

// Turns a classified failure into an actionable message for the agent. Recoverable kinds
// get a clean instruction; unknown/page-busy keep the raw details so nothing is hidden.
export function friendlyCdpMessage(
  kind: CdpErrorKind,
  port: number | undefined,
  rawDetails: string,
  details: TabGoneDetails = {},
): string {
  const portLabel = port ?? "the debugging port";

  switch (kind) {
    case "browser-down":
      return [
        `Arc is not reachable on CDP port ${portLabel}.`,
        "Quit Arc and relaunch it with:",
        `  ${arcRelaunchCommand(typeof port === "number" ? port : 9222)}`,
        "Then run browser_connect.",
        "If Arc IS running with that port, a stale agent-browser daemon may be the culprit — run `agent-browser doctor --offline --quick` to diagnose.",
      ].join("\n");
    case "tab-gone":
      return [
        "The pinned browser tab is gone. Strict tab isolation prevented da-browser from adopting a neighboring tab.",
        details.targetId ? `Previous CDP target: ${details.targetId}` : undefined,
        details.lastUrl ? `Last URL (sanitized): ${details.lastUrl}` : undefined,
        "Recover explicitly with browser_tab action='new' (optionally using the last URL), or browser_tab action='list' then switch using a targetId.",
        "browser_connect is also an explicit request to create a fresh controlled tab.",
      ].filter((line): line is string => Boolean(line)).join("\n");
    case "target-gone":
      return [
        "The controlled browser page target disappeared or its context was destroyed.",
        "Automatic transient-target recovery failed — run browser_connect to open a fresh controlled tab, then retry.",
      ].join("\n");
    case "page-busy":
      return [
        "The page did not respond in time — it may still be loading or busy.",
        "Retry, or browser_wait on a known selector before the action.",
        rawDetails,
      ].join("\n");
    default:
      return rawDetails;
  }
}
