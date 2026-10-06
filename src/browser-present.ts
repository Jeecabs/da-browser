// Host-neutral presentation of browser calls: the words, motions and facts both the pi
// TUI and the Claude Code mod draw. No terminal, theme or Node APIs in here; each host
// paints these with its own renderer (browser-ui.ts for pi, the mod for Claude Code).

// How da-browser shows up in the pi TUI. Each surface answers one question:
//   status chip   where is the agent's browser?       static, short, hidden when idle
//   trail row     what is it doing right now?          above the editor, only during a burst
//   tool rows     what did it do, what changed?        one call line, then only new information
// The trail matters most under codemode, where browser calls inside a script get no rows.


import type { BrowserState, ConnectionHealth } from "./state.ts";

export type UiColor =
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "dim"
  | "muted"
  | "text"
  | "borderMuted"
  | "mdHeading"
  | "mdLink";

export interface UiTheme {
  fg(color: UiColor, text: string): string;
}

// ---------------------------------------------------------------------------
// Activity: a tool call in a few human words
// ---------------------------------------------------------------------------

// Every frame is one cell wide so the words after it never jitter. A trailing motion
// animates after the words (the caret while typing) instead of before them.
export const MOTIONS = {
  ripple: { frames: ["∙", "∘", "○", "◌"], ms: 120 },
  caret: { frames: ["▏", " "], ms: 420, trail: true },
  key: { frames: ["▪", "▫"], ms: 180 },
  load: { frames: ["◜", "◠", "◝", "◞", "◡", "◟"], ms: 90 },
  scan: { frames: ["⡀", "⠄", "⠂", "⠁", "⠈", "⠐", "⠠", "⢀"], ms: 80 },
  shutter: { frames: ["○", "◎", "◉", "●", "◉", "◎"], ms: 90 },
  clock: { frames: ["◴", "◷", "◶", "◵"], ms: 220 },
  think: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], ms: 80 },
  down: { frames: ["⠁", "⠂", "⠄", "⡀"], ms: 100 },
  up: { frames: ["⡀", "⠄", "⠂", "⠁"], ms: 100 },
  left: { frames: ["⇠", "←"], ms: 200 },
  right: { frames: ["⇢", "→"], ms: 200 },
} satisfies Record<string, { frames: readonly string[]; ms: number; trail?: boolean }>;

export type Motion = keyof typeof MOTIONS;

export interface Activity {
  /** Imperative and short, so it reads in a trail and in the transcript: `click "Save"`. */
  text: string;
  motion: Motion;
}

const MAX_QUOTE = 24;

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function quote(value: unknown): string {
  return typeof value === "string" && value.trim() ? `"${clip(value, MAX_QUOTE)}"` : "";
}

function word(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? clip(value, MAX_QUOTE) : fallback;
}

function hostOf(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return clip(url, MAX_QUOTE);
  }
}

export function joined(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Finds what a ref points at in an agent-browser snapshot (`- button "Merge" [ref=e12]`),
 * so a click reads `click "Merge"` instead of `click @e12`.
 */
export function snapshotLabel(snapshot: string, ref: string): string | undefined {
  const id = ref.trim().replace(/^@+/, "");
  if (!/^[\w-]+$/.test(id)) return undefined;
  // Refs share the attribute bracket with others: `[ref=e2]` or `[level=1, ref=e1]`.
  const pattern = new RegExp(`[\\[,\\s]ref=${id}[\\],]`);
  const line = snapshot.split("\n").find((candidate) => pattern.test(candidate));
  const match = line?.match(/^\s*-\s*([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
  if (!match) return undefined;
  const label = match[2]?.replace(/\\(.)/g, "$1").trim();
  return label ? `"${clip(label, MAX_QUOTE)}"` : match[1];
}

/**
 * Turns a tool call into a few human words and a motion. Typed text, eval source,
 * headers and credentials are never echoed: the TUI is visible to anyone nearby.
 * `labelFor` resolves element refs to their names from the latest snapshot.
 */
export function describeActivity(
  tool: string,
  params: Record<string, unknown> = {},
  labelFor: (ref: string) => string | undefined = () => undefined,
): Activity {
  const name = tool.replace(/^browser_/, "");
  const action = typeof params.action === "string" ? params.action : undefined;
  const element = (ref: unknown): string =>
    typeof ref === "string" && ref.trim() ? (labelFor(ref) ?? clip(ref, MAX_QUOTE)) : "";

  switch (name) {
    case "status":
      return { text: "check connection", motion: "think" };
    case "connect":
      return { text: "connect", motion: "load" };
    case "open":
      return { text: joined("open", hostOf(params.url)), motion: "load" };
    case "snapshot":
      return { text: joined("snapshot", word(params.selector)), motion: "scan" };
    case "read":
      return { text: joined("read", hostOf(params.url) || "page"), motion: "scan" };
    case "click":
      return { text: joined("click", element(params.ref)), motion: "ripple" };
    case "find": {
      // A role locator names the element with `name`: `click button "Save changes"`.
      const target = params.locator === "role" && typeof params.name === "string" ? joined(word(params.value), quote(params.name)) : quote(params.value);
      if (action === "fill" || action === "type") return { text: joined("type into", target), motion: "caret" };
      if (action === "hover" || action === "focus" || action === "check" || action === "uncheck") {
        return { text: joined(action, target), motion: "ripple" };
      }
      return { text: joined("click", target), motion: "ripple" };
    }
    case "fill":
      return { text: joined("type into", element(params.ref)), motion: "caret" };
    case "select":
      return { text: joined("choose", quote(params.option)), motion: "ripple" };
    case "press":
      return { text: joined("press", word(params.key, "a key")), motion: "key" };
    case "scroll": {
      const direction = params.direction === "up" || params.direction === "left" || params.direction === "right" ? params.direction : "down";
      return { text: `scroll ${direction}`, motion: direction };
    }
    case "wait": {
      if (typeof params.text === "string") return { text: joined("wait for", quote(params.text)), motion: "clock" };
      if (typeof params.urlPattern === "string") return { text: joined("wait for", word(params.urlPattern)), motion: "clock" };
      if (typeof params.selector === "string") return { text: joined("wait for", element(params.selector)), motion: "clock" };
      if (typeof params.load === "string") return { text: `wait for ${params.load}`, motion: "clock" };
      if (typeof params.ms === "number") return { text: `wait ${Math.max(1, Math.round(params.ms / 1000))}s`, motion: "clock" };
      return { text: "wait", motion: "clock" };
    }
    case "nav":
      if (action === "back" || action === "forward") return { text: `go ${action}`, motion: "load" };
      if (action === "pushstate") return { text: joined("route to", word(params.url)), motion: "load" };
      return { text: "reload", motion: "load" };
    case "get":
      return { text: `get ${word(params.what, "page")}`, motion: "scan" };
    case "debug": {
      const kind = params.kind === "errors" ? "errors" : params.kind === "console" ? "console" : "network";
      return { text: `read ${kind}`, motion: "scan" };
    }
    case "command": {
      const first = Array.isArray(params.args) && typeof params.args[0] === "string" ? params.args[0] : "";
      return { text: joined("run", word(first, "command")), motion: "think" };
    }
    case "eval":
      return { text: "run js", motion: "think" };
    case "tab":
      if (action === "new") return { text: joined("new tab", hostOf(params.url)), motion: "load" };
      if (action === "close" || action === "switch") return { text: `${action} tab`, motion: "load" };
      return { text: "list tabs", motion: "scan" };
    case "is":
      return { text: joined("check", element(params.selector) || word(params.check, "element")), motion: "scan" };
    case "set":
      return { text: `set ${word(params.setting, "browser")}`, motion: "think" };
    case "har":
    case "trace":
      return { text: `${action === "stop" ? "stop" : "start"} ${name}`, motion: "think" };
    case "record":
      return { text: `${action ?? "start"} recording`, motion: action === "stop" ? "think" : "shutter" };
    case "cookies":
      return { text: "export cookies", motion: "think" };
    case "checkpoint":
      return { text: joined("checkpoint", quote(params.label)), motion: "shutter" };
    case "react":
      return { text: "inspect react", motion: "scan" };
    case "a11y":
      return { text: joined("audit", hostOf(params.url) || "a11y"), motion: "scan" };
    case "vitals":
      return { text: joined("measure", hostOf(params.url) || "vitals"), motion: "scan" };
    default:
      return { text: name.replace(/_/g, " "), motion: "think" };
  }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const MAX_HOST = 24;
const MAX_ADDRESS = 40;

export function parseUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.host ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `https://www.github.com/acme/app/pull/12?tab=files` → `github.com/acme/app/pull/12`.
 * Long paths keep the host and the last segments, which usually name the page (`pull/12`).
 */
export function formatAddress(url: string | undefined, max = MAX_ADDRESS): string | undefined {
  const parsed = parseUrl(url);
  if (!parsed) return undefined;
  const host = parsed.host.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const full = [host, ...segments].join("/");
  if (full.length <= max) return full;
  for (const keep of [2, 1]) {
    if (segments.length <= keep) continue;
    const short = `${host}/…/${segments.slice(-keep).join("/")}`;
    if (short.length <= max) return short;
  }
  return clip(full, max);
}


/**
 * The status-row chip. Lohan's Land joins every extension status into one segment and
 * drops the whole row when it overflows, so this stays short and never animates. There
 * is no lamp: words carry the state, and with nothing to say the chip is hidden.
 *
 *   da browser linear.app          parked on a page (click it to open the page)
 *   da browser tab closed          the controlled tab is gone
 *   da browser offline             the browser went away
 *   da browser update agent-browser
 */
export function chipText(
  theme: UiTheme,
  state: BrowserState,
  health: ConnectionHealth,
  link?: (text: string, href: string) => string,
  named = true,
): string | undefined {
  const name = named ? theme.fg("dim", "da browser") : "";
  let note: string;

  if (state.agentBrowserCompatible === false) {
    note = theme.fg("warning", "update agent-browser");
  } else if (state.tabGoneTargetId) {
    note = theme.fg("warning", "tab closed");
  } else if (health === "down") {
    if (!state.lastError) return undefined;
    note = theme.fg("error", "offline");
  } else {
    const parsed = parseUrl(state.currentUrl);
    const host = parsed ? clip(parsed.host.replace(/^www\./, ""), MAX_HOST) : state.currentDomain;
    const linked = host && parsed && link ? link(host, parsed.href) : host;
    // Unverified for a while: the host fades rather than claiming certainty.
    note = linked ? theme.fg(health === "ok" ? "muted" : "dim", linked) : "";
  }

  const captures = [
    state.recording ? theme.fg("error", "rec") : "",
    state.tracing ? theme.fg("warning", "trace") : "",
    state.har ? theme.fg("warning", "har") : "",
  ].filter(Boolean);
  return [joined(name, note), ...captures].join("  ");
}

// ---------------------------------------------------------------------------
// Trail row
// ---------------------------------------------------------------------------

export const TRAIL_TIMING = {
  /** Finished trail stays readable this long after the last step. */
  lingerMs: 3_000,
  /** Then it fades to dim before disappearing. */
  drainMs: 1_200,
  maxSteps: 16,
};

export interface TrailView {
  draining: boolean;
  steps: Array<{ text: string; status: "running" | "done" | "failed"; frame?: string; frameAfter?: boolean }>;
}

export interface TrailStep extends Activity {
  id: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
}

export function frameAt(motion: Motion, startedAt: number, now: number): string {
  const { frames, ms } = MOTIONS[motion];
  return frames[Math.floor(Math.max(0, now - startedAt) / ms) % frames.length]!;
}

/**
 * The steps of one browser burst, drawn as a single row above the editor:
 *
 *    da browser  open › click "Save changes" › ◜ type into "Display name"   linear.app/acme/issue/ENG-42
 *
 * Finished steps dim, the running one moves, a failure turns red. When the burst ends the
 * row lingers, fades, and renders nothing, so it costs no space at rest.
 */
export class TrailModel {
  protected steps: TrailStep[] = [];
  protected readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  begin(id: string, activity: Activity): void {
    const now = this.now();
    // A new burst starts clean once the previous one has faded out.
    const restingAt = this.restingAt();
    if (restingAt !== undefined && now >= restingAt) this.steps = [];
    this.steps.push({ ...activity, id, startedAt: now });
    if (this.steps.length > TRAIL_TIMING.maxSteps) this.steps.splice(0, this.steps.length - TRAIL_TIMING.maxSteps);
  }

  end(id: string, ok: boolean): void {
    const step = this.steps.find((candidate) => candidate.id === id && candidate.endedAt === undefined);
    if (!step) return;
    step.endedAt = this.now();
    step.ok = ok;
  }

  reset(): void {
    this.steps = [];
  }

  /** When the finished trail disappears, or undefined while a step runs or nothing is shown. */
  protected restingAt(): number | undefined {
    if (this.steps.length === 0 || this.steps.some((step) => step.endedAt === undefined)) return undefined;
    const lastEnd = Math.max(...this.steps.map((step) => step.endedAt!));
    return lastEnd + TRAIL_TIMING.lingerMs + TRAIL_TIMING.drainMs;
  }

  /** Milliseconds until the row next changes, or undefined when it is still. */
  nextDelay(): number | undefined {
    const now = this.now();
    const running = this.steps.filter((step) => step.endedAt === undefined);
    if (running.length) return Math.min(...running.map((step) => MOTIONS[step.motion].ms));
    const restingAt = this.restingAt();
    if (restingAt === undefined || now >= restingAt) return undefined;
    const drainAt = restingAt - TRAIL_TIMING.drainMs;
    return Math.max(1, (now < drainAt ? drainAt : restingAt) - now);
  }
  /**
   * What a host draws now, without colours or widths: each step's words, whether it is
   * running (with the motion frame to show), done or failed, and whether the row is
   * fading. Undefined when the row is at rest and should draw nothing.
   */
  view(): TrailView | undefined {
    const now = this.now();
    if (this.steps.length === 0) return undefined;
    const restingAt = this.restingAt();
    if (restingAt !== undefined && now >= restingAt) return undefined;
    return {
      draining: restingAt !== undefined && now >= restingAt - TRAIL_TIMING.drainMs,
      steps: this.steps.map((step) => {
        if (step.endedAt !== undefined) return { text: step.text, status: step.ok === false ? "failed" : "done" };
        const frame = frameAt(step.motion, step.startedAt, now);
        return { text: step.text, status: "running", frame, frameAfter: "trail" in MOTIONS[step.motion] };
      }),
    };
  }


}

// ---------------------------------------------------------------------------
// Results: only what the call line does not already say
// ---------------------------------------------------------------------------

// The call line says what was done and pi colours the row by success, so a result adds
// what changed or what was learned. The model still receives the full tool output.

export interface Fact {
  text: string;
  tone: UiColor;
  href?: string;
}

export type BodyKind = "tree" | "markdown" | "console" | "network" | "a11y" | "vitals" | "code" | "text";

/** Kept in the tool result's details so the transcript redraws the same after a resume. */
export interface Presentation {
  facts: Fact[];
  /** Files worth opening, never the internal snapshot dumps. */
  files: string[];
  image?: string;
  durationMs: number;
  /** The agent-facing summary paragraph, which the expanded view leaves out. */
  summary: string;
  bodyKind: BodyKind;
}

export interface SnapshotView {
  url?: string;
  snapshot?: string;
  /** False for scoped or delta snapshots, which cannot be compared with a whole page. */
  comparable: boolean;
}

export interface ResultInput {
  tool: string;
  params: Record<string, unknown>;
  /** Full text content the model receives: summary paragraph, then tool output. */
  text: string;
  details: Record<string, unknown>;
  before: SnapshotView;
  after: SnapshotView;
  durationMs: number;
  snapshotFiles: readonly string[];
}

const ELEMENT_LINE = /^\s*-\s*([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?.*[[,\s]ref=[\w-]+[\],]/;

/** Named elements that carry a ref: what the agent can act on, as `button "Save"`. */
export function snapshotElements(snapshot: string): string[] {
  return snapshot.split("\n").flatMap((line) => {
    const match = line.match(ELEMENT_LINE);
    if (!match) return [];
    const name = match[2]?.replace(/\\(.)/g, "$1").trim();
    return [name ? `${match[1]} "${clip(name, MAX_QUOTE)}"` : match[1]!];
  });
}

/**
 * Elements that appeared or disappeared between two snapshots. Only interactive elements
 * carry refs, so text-only changes (a toast, a status line) are invisible here: an empty
 * result means "no visible change in controls", never "nothing happened".
 */
export function snapshotChanges(before: string, after: string): { added: string[]; removed: string[] } {
  const remaining = new Map<string, number>();
  for (const element of snapshotElements(before)) remaining.set(element, (remaining.get(element) ?? 0) + 1);
  const added: string[] = [];
  for (const element of snapshotElements(after)) {
    const left = remaining.get(element) ?? 0;
    if (left > 0) remaining.set(element, left - 1);
    else added.push(element);
  }
  const removed = [...remaining.entries()].flatMap(([element, count]) => Array<string>(count).fill(element));
  return { added, removed };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

function compactNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim());
}

const VITAL_LIMITS: Record<string, [good: number, poor: number]> = {
  lcp: [2500, 4000],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
  inp: [200, 500],
  cls: [0.1, 0.25],
};

function vitalValue(raw: string): number | undefined {
  const match = raw.match(/^([\d.]+)(ms|s)?$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1000 : value;
}

/** Google's Core Web Vitals bands: good, needs improvement, poor. */
export function vitalTone(metric: string, raw: string): UiColor {
  const limits = VITAL_LIMITS[metric.toLowerCase()];
  const value = vitalValue(raw);
  if (!limits || value === undefined) return "dim";
  return value <= limits[0] ? "success" : value <= limits[1] ? "warning" : "error";
}

/** `ttfb: 0.4ms  fcp: 16ms  lcp: 16ms  cls: 0  inp: -` → LCP, CLS and INP, rated. */
export function vitalsFacts(body: string): Fact[] {
  return ["lcp", "cls", "inp"].map((metric) => {
    const raw = body.match(new RegExp(`\\b${metric}:\\s*([\\d.]+(?:ms|s)?|-)`))?.[1] ?? "-";
    return { text: `${metric.toUpperCase()} ${raw === "-" ? "–" : raw}`, tone: vitalTone(metric, raw) };
  });
}

export const NETWORK_LINE = /^\[([^\]]+)\]\s+(\S+)\s+(\S+)\s+\(([^)]+)\)\s+(\S+)\s*$/;

function changeFacts(changes: { added: string[]; removed: string[] }): Fact[] {
  const facts: Fact[] = [
    ...changes.added.slice(0, 2).map((element) => ({ text: `+ ${element}`, tone: "success" as const })),
    ...changes.removed.slice(0, 1).map((element) => ({ text: `− ${element}`, tone: "muted" as const })),
  ];
  const more = Math.max(0, changes.added.length - 2) + Math.max(0, changes.removed.length - 1);
  if (more) facts.push({ text: `+${more} more`, tone: "dim" });
  return facts;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}

const BODY_KINDS: Record<string, BodyKind> = {
  snapshot: "tree",
  click: "tree",
  find: "tree",
  checkpoint: "tree",
  read: "markdown",
  a11y: "a11y",
  vitals: "vitals",
  eval: "code",
};

/**
 * da-browser asks for axe results as JSON; this turns them into the CLI's own list,
 * `[critical] image-alt: Images must have alternative text (1 node)`. Text input
 * (or JSON cut short by truncation) passes through unchanged.
 */
export function a11yText(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const violations = parsed && typeof parsed === "object" ? (parsed as { violations?: unknown }).violations : undefined;
  if (!Array.isArray(violations)) return body;
  return violations
    .flatMap((violation) => {
      if (!violation || typeof violation !== "object") return [];
      const v = violation as { impact?: unknown; id?: unknown; help?: unknown; helpUrl?: unknown; nodes?: unknown };
      const nodes = Array.isArray(v.nodes) ? v.nodes : [];
      const targets = nodes.flatMap((node) => {
        const target = node && typeof node === "object" ? (node as { target?: unknown }).target : undefined;
        return Array.isArray(target) ? [`  - ${target.join(" ")}`] : [];
      });
      return [
        `[${String(v.impact ?? "minor")}] ${String(v.id ?? "rule")}: ${String(v.help ?? "")} (${count(nodes.length, "node")})`,
        ...(typeof v.helpUrl === "string" ? [`  ${v.helpUrl}`] : []),
        ...targets,
      ];
    })
    .join("\n");
}

/** Decides what a finished browser call adds to its transcript row. */
export function presentResult(input: ResultInput): Presentation {
  const name = input.tool.replace(/^browser_/, "");
  const { params, details } = input;
  const summary = input.text.split("\n\n")[0] ?? "";
  const body = input.text.slice(summary.length).trim();
  const facts: Fact[] = [];
  const goTo = (url: string | undefined) => {
    const address = formatAddress(url);
    if (address) facts.push({ text: `→ ${address}`, tone: "muted", href: url });
  };
  const value = (text: string) => {
    const line = firstLine(text);
    if (!line) return;
    facts.push({ text: line.length > 60 ? `${line.slice(0, 59)}…` : line, tone: "text" });
    const more = lines(text).length - 1;
    if (more > 0) facts.push({ text: `+${count(more, "line")}`, tone: "dim" });
  };
  let bodyKind: BodyKind = BODY_KINDS[name] ?? "text";

  switch (name) {
    case "open":
    case "connect":
    case "nav":
      goTo(input.after.url);
      break;
    case "tab":
      if (params.action === "list") facts.push({ text: count(lines(body).filter((line) => /\[t\d+\]/.test(line)).length, "tab"), tone: "muted" });
      else if (params.action !== "close") goTo(input.after.url);
      break;
    case "click":
    case "find":
    case "fill":
    case "select":
    case "press":
    case "scroll": {
      if (input.after.url && input.after.url !== input.before.url) {
        goTo(input.after.url);
      } else if (input.before.comparable && input.after.comparable && input.before.snapshot && input.after.snapshot) {
        facts.push(...changeFacts(snapshotChanges(input.before.snapshot, input.after.snapshot)));
      }
      break;
    }
    case "snapshot":
      if (params.delta) {
        facts.push(/^unchanged\b/i.test(body) ? { text: "no change", tone: "muted" } : { text: "changed", tone: "accent" });
        bodyKind = "code";
      } else {
        facts.push({ text: count(snapshotElements(body).length, "element"), tone: "muted" });
      }
      break;
    case "checkpoint": {
      const ratio = typeof details.pixelChangeRatio === "number" ? ` ${Math.round(details.pixelChangeRatio * 100)}%` : "";
      facts.push(details.changed === false ? { text: "unchanged", tone: "muted" } : { text: `changed${ratio}`, tone: "accent" });
      break;
    }
    case "read": {
      if (params.raw || params.json) {
        bodyKind = params.json ? "code" : "text";
        value(body);
        break;
      }
      const title = body.match(/^#{1,2}\s+(.+)$/m)?.[1];
      if (title) facts.push({ text: `"${clip(title, 40)}"`, tone: "text" });
      facts.push({ text: `${compactNumber(body.match(/[\p{L}\p{N}]+/gu)?.length ?? 0)} words`, tone: "muted" });
      break;
    }
    case "get":
    case "eval":
    case "command":
    case "react":
      value(body);
      break;
    case "is": {
      const check = typeof params.check === "string" ? params.check : "true";
      facts.push(details.result === true ? { text: check, tone: "success" } : { text: `not ${check}`, tone: "warning" });
      break;
    }
    case "wait":
      facts.push({ text: `after ${seconds(input.durationMs)}`, tone: "muted" });
      break;
    case "debug": {
      const output = lines(body).filter((line) => line.trim() !== "(no output)");
      if (params.kind === "console") {
        bodyKind = "console";
        const levels = (pattern: RegExp) => output.filter((line) => pattern.test(line)).length;
        const errors = levels(/^\[error\]/);
        const warnings = levels(/^\[warn(ing)?\]/);
        const other = output.length - errors - warnings;
        if (errors) facts.push({ text: count(errors, "error"), tone: "error" });
        if (warnings) facts.push({ text: count(warnings, "warning"), tone: "warning" });
        if (other) facts.push({ text: count(other, "log"), tone: "muted" });
        if (!output.length) facts.push({ text: "no console output", tone: "muted" });
      } else if (params.kind === "errors") {
        bodyKind = "console";
        const errors = output.filter((line) => line.replace(/^✗\s*/, "").trim()).length;
        facts.push(errors ? { text: count(errors, "page error"), tone: "error" } : { text: "no page errors", tone: "success" });
      } else if (params.kind === "network-requests") {
        bodyKind = "network";
        const requests = output.map((line) => line.match(NETWORK_LINE)).filter((match) => match !== null);
        const failed = requests.filter((match) => !/^[123]\d\d$/.test(match[5]!)).length;
        facts.push({ text: count(requests.length, "request"), tone: "muted" });
        if (failed) facts.push({ text: `${failed} failed`, tone: "error" });
      } else {
        value(body);
      }
      break;
    }
    case "a11y": {
      const counts = details.counts && typeof details.counts === "object" ? (details.counts as Record<string, unknown>) : {};
      const listed = lines(a11yText(body));
      const impacts = (impact: string) => listed.filter((line) => line.startsWith(`[${impact}]`)).length;
      const violations = typeof counts.violations === "number" ? counts.violations : impacts("critical") + impacts("serious") + impacts("moderate") + impacts("minor");
      const severe = impacts("critical") + impacts("serious");
      if (!violations) {
        facts.push({ text: "no violations", tone: "success" });
        break;
      }
      facts.push({ text: count(violations, "violation"), tone: severe ? "error" : "warning" });
      if (impacts("critical")) facts.push({ text: `${impacts("critical")} critical`, tone: "error" });
      if (impacts("serious")) facts.push({ text: `${impacts("serious")} serious`, tone: "error" });
      break;
    }
    case "vitals":
      facts.push(...vitalsFacts(body));
      break;
    case "cookies":
      if (typeof details.count === "number") facts.push({ text: `${count(details.count, "cookie")} saved`, tone: "success" });
      break;
    case "har":
    case "trace":
      if (params.action !== "stop") facts.push({ text: "capturing", tone: "warning" });
      break;
    case "record":
      if (params.action === "stop") {
        if (typeof details.durationMs === "number") facts.push({ text: `${seconds(details.durationMs)} video`, tone: "muted" });
        if (details.stillFrame === true) facts.push({ text: "still frame: the tab never repainted", tone: "warning" });
        else if (details.hiddenAtStop === true) facts.push({ text: "froze: the tab was hidden at the end", tone: "warning" });
      } else {
        facts.push({ text: "recording", tone: "warning" });
        if (details.broughtForward === true) facts.push({ text: "brought tab forward", tone: "dim" });
      }
      break;
    case "status": {
      const probe = details.probe && typeof details.probe === "object" ? (details.probe as Record<string, unknown>) : undefined;
      if (!probe) break;
      facts.push(probe.portListening ? { text: "browser reachable", tone: "success" } : { text: "browser not reachable", tone: "error" });
      if (typeof probe.pageTargets === "number") facts.push({ text: count(probe.pageTargets, "page"), tone: "muted" });
      if (probe.tabBinding === "gone") facts.push({ text: "tab closed", tone: "warning" });
      break;
    }
  }

  // A take being recorded is not on disk yet; a restart's finished take is.
  const recording = name === "record" && params.action !== "stop";
  const unwritten = recording ? [...stringList(details.file), ...stringList(details.contactSheetPath)] : [];
  const hidden = new Set([...input.snapshotFiles, ...stringList(details.snapshotFile), ...unwritten]);
  const files = [
    ...new Set([
      ...stringList(details.screenshotFile),
      ...stringList(details.artifacts),
      ...stringList(details.fullOutputFile),
      ...stringList(details.file),
      ...stringList(details.contactSheetPath),
      ...stringList(details.previousPath),
      ...stringList(details.previousContactSheetPath),
    ]),
  ].filter((file) => !hidden.has(file));
  const image = files.find((file) => /\.(png|jpe?g)$/i.test(file));

  return { facts, files, image, durationMs: input.durationMs, summary, bodyKind };
}

/** `2026-10-02T03-12-45-123Z-after-click-e12.txt` → `after-click-e12.txt`. */
export function artifactName(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "");
}


/**
 * Failures for a human: a short reason in red and the next step. The agent-facing
 * message (relaunch commands, target ids) stays in the expanded view.
 */
export function explainFailure(text: string): { reason: string; hint?: string } {
  // A failed CLI call reads `Command failed: agent-browser …` then `stderr:`; the reason
  // is the stderr line, not the command. A --json failure leads with `agent-browser: <error>`.
  const stderr = text.match(/\nstderr:\n([\s\S]*)$/)?.[1];
  const first = (stderr ? firstLine(stderr) : firstLine(text)).replace(/^(?:✗|agent-browser:)\s*/, "");
  if (/^Unknown ref\b/i.test(first)) return { reason: first, hint: "refs go stale when the page changes; take a new snapshot" };
  if (/^Arc is not reachable/.test(first)) return { reason: "Arc not reachable", hint: "relaunch Arc with remote debugging, then /browser connect" };
  if (/pinned browser tab is gone/.test(first)) return { reason: "tab closed", hint: "/browser connect opens a fresh one" };
  if (/page target disappeared/.test(first)) return { reason: "page went away", hint: "/browser connect opens a fresh tab" };
  if (/did not respond in time/.test(first)) return { reason: "page busy", hint: "retry, or wait for a known element first" };
  if (/requires agent-browser/i.test(text)) return { reason: "agent-browser too old", hint: "npm i -g agent-browser@latest" };
  return { reason: first.length > 100 ? `${first.slice(0, 99)}…` : first || "failed" };
}
