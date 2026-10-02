import { hyperlink, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { BrowserState, ConnectionHealth } from "./state.js";

// How da-browser shows up in the pi TUI. Each surface answers one question:
//   status chip   where is the agent's browser?       static, short, hidden when idle
//   trail row     what is it doing right now?          above the editor, only during a burst
//   tool rows     what did it do?                      one plain line per call in the transcript
// The trail matters most under codemode, where browser calls inside a script get no rows.

export type UiColor = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text" | "borderMuted";

export interface UiTheme {
  fg(color: UiColor, text: string): string;
}

// ---------------------------------------------------------------------------
// Activity: a tool call in a few human words
// ---------------------------------------------------------------------------

// Every frame is one cell wide so the words after it never jitter. A trailing motion
// animates after the words (the caret while typing) instead of before them.
const MOTIONS = {
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

function clip(text: string, max: number): string {
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

function joined(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Finds what a ref points at in an agent-browser snapshot (`- button "Merge" [ref=e12]`),
 * so a click reads `click "Merge"` instead of `click @e12`.
 */
export function snapshotLabel(snapshot: string, ref: string): string | undefined {
  const id = ref.trim().replace(/^@+/, "");
  if (!/^[\w-]+$/.test(id)) return undefined;
  const line = snapshot.split("\n").find((candidate) => candidate.includes(`[ref=${id}]`));
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
      const target = quote(params.value);
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

const MAX_HOST = 24;
const MAX_ADDRESS = 40;

function parseUrl(url: string | undefined): URL | undefined {
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

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

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
export function browserChip(
  theme: UiTheme,
  state: BrowserState,
  health: ConnectionHealth,
  options: { link?: boolean } = {},
): string | undefined {
  const name = theme.fg("dim", "da browser");
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
    const linked = host && parsed && options.link !== false ? hyperlink(host, parsed.href) : host;
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

interface TrailStep extends Activity {
  id: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
}

function frameAt(motion: Motion, startedAt: number, now: number): string {
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
export class BrowserTrail {
  private steps: TrailStep[] = [];
  private readonly now: () => number;

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
  private restingAt(): number | undefined {
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

  lines(theme: UiTheme, width: number, address?: string): string[] {
    const now = this.now();
    if (this.steps.length === 0) return [];
    const restingAt = this.restingAt();
    if (restingAt !== undefined && now >= restingAt) return [];
    const draining = restingAt !== undefined && now >= restingAt - TRAIL_TIMING.drainMs;
    const paint = (color: UiColor, text: string) => theme.fg(draining ? "dim" : color, text);

    const rendered = this.steps.map((step) => {
      if (step.endedAt === undefined) {
        const frame = frameAt(step.motion, step.startedAt, now);
        return "trail" in MOTIONS[step.motion]
          ? paint("accent", `${step.text}${frame}`)
          : paint("accent", `${frame} ${step.text}`);
      }
      if (step.ok === false) return paint("error", `✗ ${step.text}`);
      return paint("muted", step.text);
    });

    const prefix = ` ${paint("muted", "da browser")}  `;
    const separator = paint("borderMuted", " › ");
    const more = paint("dim", "…");
    const budget = width - visibleWidth(prefix);

    // Newest steps win; older ones fall off the left behind an ellipsis.
    let shown: string[] = [];
    for (let index = rendered.length - 1; index >= 0; index--) {
      const candidate = [rendered[index]!, ...shown];
      const dropped = index > 0;
      const cost = visibleWidth(candidate.join(separator)) + (dropped ? visibleWidth(more + separator) : 0);
      if (cost > budget && shown.length > 0) break;
      shown = candidate;
    }
    const steps = (shown.length < rendered.length ? [more, ...shown] : shown).join(separator);

    // The page goes last and only whole: the full path, else just the host, else nothing.
    const room = budget - visibleWidth(steps) - 3;
    const host = address?.split("/")[0];
    const fitted = [address, host].find((candidate) => candidate && candidate.length <= room);
    const place = fitted ? `   ${paint("dim", fitted)}` : "";
    return [truncateToWidth(prefix + steps + place, width, "…")];
  }
}

// ---------------------------------------------------------------------------
// Transcript rows
// ---------------------------------------------------------------------------

/** One plain line per browser tool call: `browser click "Save changes"`. */
export function browserCallLine(theme: { fg(color: "toolTitle" | "accent", text: string): string; bold(text: string): string }, text: string): string {
  return `${theme.fg("toolTitle", theme.bold("browser"))} ${theme.fg("accent", text)}`;
}

/**
 * Mounts a BrowserTrail above the editor. It wakes only for the next visible change
 * (a motion frame, the fade, the disappearance) and sleeps while the row is still.
 */
export class TrailWidget implements Component {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly theme: UiTheme;
  private readonly trail: BrowserTrail;
  private readonly address: () => string | undefined;

  constructor(tui: Pick<TUI, "requestRender">, theme: UiTheme, trail: BrowserTrail, address: () => string | undefined) {
    this.tui = tui;
    this.theme = theme;
    this.trail = trail;
    this.address = address;
  }

  render(width: number): string[] {
    return this.trail.lines(this.theme, width, this.address());
  }

  invalidate(): void {}

  poke(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.tui.requestRender();
    const delay = this.trail.nextDelay();
    if (delay === undefined) return;
    this.timer = setTimeout(() => this.poke(), delay);
    this.timer.unref?.();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
