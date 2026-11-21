// Pure parsing of agent-browser CLI output. No I/O or framework deps so it stays
// unit-testable as a Light Guard Test, mirroring agent-browser-args.ts and cdp-errors.ts.
//
// Since the native-Rust rewrite (0.20+), `--json` responses are wrapped in a
// `{success, data, error}` envelope with the payload under named keys in `data`
// (e.g. `{title: …}`, `{tabs: […]}`, `{visible: true}`).

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Distinguishes a CLI-reported failure (success:false) from JSON parse errors. */
export class AgentBrowserCliError extends Error {}

/**
 * Unwrap the CLI's `{success, data, error}` envelope: failures become thrown errors with
 * the CLI's message, successes return `data`. Non-envelope values (older shapes, raw
 * arrays) pass through untouched.
 */
export function unwrapCliEnvelope(parsed: unknown): unknown {
  if (isPlainObject(parsed) && "success" in parsed && ("data" in parsed || "error" in parsed)) {
    if (parsed.success === false) {
      const message = typeof parsed.error === "string" && parsed.error ? parsed.error : "agent-browser command failed";
      throw new AgentBrowserCliError(message);
    }
    return parsed.data;
  }
  return parsed;
}

/**
 * Every `--json` payload carries a `lifecycle` block (launch state and, on a daemon's first
 * command, its settings changes). It describes the daemon, not the page, so it is dropped
 * before a payload is shown or its remaining keys are counted.
 */
export function stripLifecycle(data: unknown): unknown {
  if (!isPlainObject(data) || !("lifecycle" in data)) return data;
  const { lifecycle: _lifecycle, ...rest } = data;
  return rest;
}

/**
 * How much of a successful command's output to keep. `stdout` is for values that get
 * parsed. `filtered` adds stderr warnings worth reading, such as an open dialog, without
 * the daemon's own notices. `raw` is both streams untouched, for the passthrough.
 */
export type CliOutputMode = "stdout" | "filtered" | "raw";

// What a daemon says about itself on stderr, mostly on its first command: the settings it
// started with ("⚠ allowed-domains: default →  (--allowed-domains), relaunched browser"),
// "[agent-browser] launched browser", and the outdated-Chrome CVE notice (0.41.2). None of
// it is about the page, and "relaunched browser" on a CDP attach reads as a restart.
const DAEMON_NOTICE_PATTERNS: RegExp[] = [
  /^\[agent-browser\] /,
  /^⚠ [\w-]+: .* → .*, (?:relaunched browser|applied)$/,
  /^⚠ browser: relaunched \(--relaunch\)$/,
  /^⚠ Chrome [\d.]+ is behind the current stable release /,
];

const ANSI_COLOR = /\x1b\[[0-9;]*m/g;

export function isDaemonNotice(line: string): boolean {
  const plain = line.replace(ANSI_COLOR, "").trim();
  return DAEMON_NOTICE_PATTERNS.some((pattern) => pattern.test(plain));
}

export function joinCliOutput(stdout: string, stderr: string, mode: CliOutputMode = "filtered"): string {
  if (mode === "stdout") return (stdout ?? "").trim();
  const extra = mode === "raw"
    ? stderr ?? ""
    : (stderr ?? "").split("\n").filter((line) => line.trim() && !isDaemonNotice(line)).join("\n");
  return [(stdout ?? "").trim(), extra.trim()].filter(Boolean).join("\n");
}

export type BrowserGetWhat =
  | "text"
  | "html"
  | "value"
  | "attr"
  | "title"
  | "url"
  | "count"
  | "box"
  | "styles"
  | "cdp-url";

// Which key in the `data` payload carries the value for each `get` variant. `box` has no
// wrapper key (data IS the box), so it falls through to the generic logic.
const GET_RESULT_KEYS: Partial<Record<BrowserGetWhat, string>> = {
  text: "text",
  html: "html",
  value: "value",
  attr: "value",
  title: "title",
  url: "url",
  count: "count",
  styles: "styles",
  "cdp-url": "cdpUrl",
};

export function extractGetResult(what: BrowserGetWhat, parsed: unknown): unknown {
  if (!isPlainObject(parsed)) return parsed;

  const key = GET_RESULT_KEYS[what];
  if (key && key in parsed) return parsed[key];

  // Payloads carry `origin` and `lifecycle` fields alongside the value; drop them and unwrap
  // a lone remaining key so callers see the value, not the transport shape.
  const entries = Object.entries(parsed).filter(([k]) => k !== "origin" && k !== "lifecycle");
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0]?.[1];
  return Object.fromEntries(entries);
}

export function formatGetResult(what: BrowserGetWhat, result: unknown): string {
  if (result === undefined || result === null) return "(no result)";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (what === "box" || what === "styles" || typeof result === "object") {
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

// The CLI names the boolean after the check (`{visible: true, origin: …}`), so look it up
// by check name and fall back to a lone boolean field for shape drift.
export function extractBooleanResult(check: string, parsed: unknown): boolean {
  if (typeof parsed === "boolean") return parsed;
  if (isPlainObject(parsed)) {
    const named = parsed[check];
    if (typeof named === "boolean") return named;
    const booleans = Object.values(parsed).filter((value) => typeof value === "boolean");
    if (booleans.length === 1) return booleans[0] as boolean;
  }
  throw new Error(`browser_is expected a boolean result, got: ${JSON.stringify(parsed)}`);
}

/**
 * `screenshot --annotate --json` returns structured `annotations` instead of the text
 * legend the non-JSON path prints. Render them as the same [N] ↔ @eN mapping a vision
 * pass needs, dropping the box geometry it cannot use.
 */
export function formatAnnotationLegend(parsed: unknown): string {
  const annotations = isPlainObject(parsed) && Array.isArray(parsed.annotations) ? parsed.annotations : [];
  const lines = annotations.filter(isPlainObject).map((entry) => {
    const number = typeof entry.number === "number" ? entry.number : "?";
    const ref = typeof entry.ref === "string" ? `@${entry.ref}` : "";
    const role = typeof entry.role === "string" ? entry.role : "";
    const name = typeof entry.name === "string" && entry.name ? ` "${entry.name}"` : "";
    return `[${number}] ${[ref, role].filter(Boolean).join(" ")}${name}`;
  });
  return lines.length ? `Annotated refs:\n${lines.join("\n")}` : "";
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  /** Unix seconds; -1 for session cookies. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export function extractCookies(parsed: unknown): BrowserCookie[] {
  const list = Array.isArray(parsed) ? parsed : isPlainObject(parsed) && Array.isArray(parsed.cookies) ? parsed.cookies : [];
  return list.filter(
    (cookie): cookie is BrowserCookie =>
      isPlainObject(cookie) &&
      typeof cookie.name === "string" &&
      typeof cookie.value === "string" &&
      typeof cookie.domain === "string",
  );
}

/** Names, scope, flags, and lifetime only. Cookie values must never reach model context. */
export function formatCookieSummary(cookies: BrowserCookie[], nowMs = Date.now()): string {
  if (cookies.length === 0) return "(no cookies for the current page URL)";
  return cookies
    .map((cookie) => {
      const lifetime = !cookie.expires || cookie.expires < 0 ? "session" : formatExpiry(cookie.expires * 1000 - nowMs);
      const flags = [cookie.httpOnly ? "httpOnly" : "", cookie.secure ? "secure" : ""].filter(Boolean).join(",");
      return `${cookie.name}  ${cookie.domain}${cookie.path ?? "/"}  ${lifetime}${flags ? `  ${flags}` : ""}`;
    })
    .join("\n");
}

function formatExpiry(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const text =
    abs < 3_600_000
      ? `${Math.round(abs / 60_000)}m`
      : abs < 172_800_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.round(abs / 86_400_000)}d`;
  return deltaMs < 0 ? `expired ${text} ago` : `expires in ${text}`;
}

export function normalizeTabList(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) return parsed.filter(isPlainObject);
  if (isPlainObject(parsed) && Array.isArray(parsed.tabs)) {
    return parsed.tabs.filter(isPlainObject);
  }
  return [];
}

// Tabs carry per-daemon ids (t1, t2, …), optional user labels, and CDP target ids. Since
// agent-browser 0.34 target ids are accepted as tab refs and remain stable across daemon
// restarts, surface them rather than hiding the only durable cross-restart handle.
export function formatTabTable(tabs: Array<Record<string, unknown>>): string {
  if (tabs.length === 0) return "(no tabs)";
  return tabs
    .map((tab) => {
      const id = typeof tab.tabId === "string" ? tab.tabId : "?";
      const active = tab.active ? "*" : " ";
      const targetId = typeof tab.targetId === "string" && tab.targetId ? ` target=${tab.targetId}` : "";
      const label = typeof tab.label === "string" && tab.label ? ` [${tab.label}]` : "";
      const title = typeof tab.title === "string" && tab.title ? ` ${tab.title}` : "";
      const url = typeof tab.url === "string" && tab.url ? `  ${tab.url}` : "";
      return `${id.padStart(3)} ${active}${targetId}${label}${title}${url}`;
    })
    .join("\n");
}
