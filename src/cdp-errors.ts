// Pure CDP failure classification and recovery messaging. No I/O or framework deps
// so it stays unit-testable as a Light Guard Test, mirroring agent-browser-args.ts.
//
// Each agent-browser tool call is a fresh `agent-browser --cdp <port>` process, so a
// "connection" failure is really one of: the browser is gone (port not listening), the
// page target it attached to vanished (tab closed / context destroyed), or the page was
// too busy to respond. Classifying these lets callers self-heal the recoverable ones and
// give the agent an actionable next step instead of a raw exec dump.

export type CdpErrorKind = "browser-down" | "target-gone" | "page-busy" | "unknown";

export class CdpError extends Error {
  readonly kind: CdpErrorKind;

  constructor(message: string, kind: CdpErrorKind) {
    super(message);
    this.name = "CdpError";
    this.kind = kind;
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
  if (BROWSER_DOWN_PATTERNS.some((re) => re.test(haystack))) return "browser-down";
  if (TARGET_GONE_PATTERNS.some((re) => re.test(haystack))) return "target-gone";
  if (PAGE_BUSY_PATTERNS.some((re) => re.test(haystack))) return "page-busy";
  return "unknown";
}

export function arcRelaunchCommand(port: number): string {
  return `roo start --name arc /Applications/Arc.app/Contents/MacOS/Arc --remote-debugging-port=${port}`;
}

// Turns a classified failure into an actionable message for the agent. Recoverable kinds
// get a clean instruction; unknown/page-busy keep the raw details so nothing is hidden.
export function friendlyCdpMessage(kind: CdpErrorKind, port: number | undefined, rawDetails: string): string {
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
    case "target-gone":
      return [
        "The controlled browser tab is gone (closed, navigated, or its page context was destroyed).",
        "Auto-recovery failed — run browser_connect to open a fresh controlled tab, then retry.",
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
