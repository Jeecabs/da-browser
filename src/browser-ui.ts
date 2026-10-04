import { pathToFileURL } from "node:url";

import { hyperlink, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { BrowserState, ConnectionHealth } from "./state.ts";
import {
  chipText,
  TrailModel,
  TRAIL_TIMING,
  MAX_HOST,
  artifactName,
  clip,
  frameAt,
  joined,
  MOTIONS,
  parseUrl,
  seconds,
  vitalTone,
  a11yText,
  NETWORK_LINE,
  type BodyKind,
  type Presentation,
  type UiColor,
  type UiTheme,
} from "./browser-present.ts";

export * from "./browser-present.ts";

// How da-browser shows up in the pi TUI. Each surface answers one question:
//   status chip   where is the agent's browser?       static, short, hidden when idle
//   trail row     what is it doing right now?          above the editor, only during a burst
//   tool rows     what did it do, what changed?        one call line, then only new information
// The trail matters most under codemode, where browser calls inside a script get no rows.


// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

/** The status-row chip for pi, with the host a clickable OSC 8 link. See chipText. */
export function browserChip(
  theme: UiTheme,
  state: BrowserState,
  health: ConnectionHealth,
  options: { link?: boolean } = {},
): string | undefined {
  return chipText(theme, state, health, options.link === false ? undefined : hyperlink);
}

/**
 * The trail model painted as one pi TUI row (see TrailModel for what it holds).
 */
export class BrowserTrail extends TrailModel {
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

/** The collapsed result: facts, then duration when slow, then files to open. */
export function resultLine(theme: UiTheme, presentation: Presentation, options: { link?: boolean } = {}): string {
  const link = options.link !== false;
  const parts = presentation.facts.map((fact) => theme.fg(fact.tone, fact.href && link ? hyperlink(fact.text, fact.href) : fact.text));
  const timed = presentation.facts.some((fact) => fact.text.startsWith("after "));
  if (presentation.durationMs >= 1000 && !timed) parts.push(theme.fg("dim", seconds(presentation.durationMs)));
  for (const file of presentation.files) {
    const label = artifactName(file);
    parts.push(theme.fg("dim", link ? hyperlink(label, pathToFileURL(file).href) : label));
  }
  return parts.join("  ");
}

const INTERACTIVE_ROLES = new Set([
  "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "listbox", "treeitem",
]);

function treeLine(theme: UiTheme, line: string): string {
  const match = line.match(/^(\s*-\s*)([\w-]+)(\s+"(?:[^"\\]|\\.)*")?(.*)$/);
  if (!match) return theme.fg("muted", line);
  const [, lead, role, name = "", rest = ""] = match;
  const roleColor: UiColor = INTERACTIVE_ROLES.has(role!) ? "accent" : role === "link" ? "mdLink" : role === "heading" ? "mdHeading" : "dim";
  const nameColor: UiColor = role === "StaticText" ? "muted" : "text";
  return theme.fg("dim", lead!) + theme.fg(roleColor, role!) + theme.fg(nameColor, name) + theme.fg("dim", rest);
}

function consoleLine(theme: UiTheme, line: string): string {
  if (/^\[error\]|^✗/.test(line)) return theme.fg("error", line);
  if (/^\[warn(ing)?\]/.test(line)) return theme.fg("warning", line);
  return theme.fg("muted", line);
}

function networkLine(theme: UiTheme, line: string): string {
  const match = line.match(NETWORK_LINE);
  if (!match) return theme.fg("muted", line);
  const [, id, method, url, type, status] = match;
  const tone: UiColor = /^2\d\d$/.test(status!) ? "success" : /^3\d\d$/.test(status!) ? "muted" : "error";
  return `${theme.fg(tone, status!.padEnd(4))}${theme.fg("muted", method!.padEnd(7))}${theme.fg("text", url!)}  ${theme.fg("dim", `${type} ${id}`)}`;
}

function a11yLine(theme: UiTheme, line: string): string {
  const impact = line.match(/^\[(critical|serious|moderate|minor)\]/)?.[1];
  if (impact) return theme.fg(impact === "critical" || impact === "serious" ? "error" : impact === "moderate" ? "warning" : "muted", line);
  if (/^\s+https?:\/\//.test(line)) return theme.fg("dim", line);
  return theme.fg("muted", line);
}

function vitalsLine(theme: UiTheme, line: string): string {
  return line
    .split(/(\b(?:ttfb|fcp|lcp|cls|inp):\s*(?:[\d.]+(?:ms|s)?|-))/)
    .map((part) => {
      const metric = part.match(/^(ttfb|fcp|lcp|cls|inp):\s*(.+)$/);
      return metric ? theme.fg("muted", `${metric[1]}: `) + theme.fg(vitalTone(metric[1]!, metric[2]!), metric[2]!) : theme.fg("dim", part);
    })
    .join("");
}

/** Colours a tool's raw output for the expanded view; markdown and code are drawn by pi. */
export function formatBody(theme: UiTheme, kind: BodyKind, body: string): string {
  const paint: Record<BodyKind, (line: string) => string> = {
    tree: (line) => treeLine(theme, line),
    console: (line) => consoleLine(theme, line),
    network: (line) => networkLine(theme, line),
    a11y: (line) => a11yLine(theme, line),
    vitals: (line) => vitalsLine(theme, line),
    markdown: (line) => line,
    code: (line) => line,
    text: (line) => theme.fg("muted", line),
  };
  const text = kind === "a11y" ? a11yText(body) : body;
  return text.split("\n").map(paint[kind]).join("\n");
}
