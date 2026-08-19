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

  // Payloads carry an `origin` field alongside the value; drop it and unwrap a lone
  // remaining key so callers see the value, not the transport shape.
  const entries = Object.entries(parsed).filter(([k]) => k !== "origin");
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
