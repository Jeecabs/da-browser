// Plays da-browser's TUI surfaces through a typical browser burst, laid out like
// Lohan's Land: the trail row above the editor, the status row below it.
// Run: pnpm preview:tui   (ctrl+c to stop)
import { connectionHealth, createBrowserState } from "../src/state.ts";
import { BrowserTrail, browserChip, describeActivity, formatAddress, snapshotLabel } from "../src/browser-ui.ts";

const palette = {
  accent: "#8abeb7",
  success: "#b5bd68",
  warning: "#ffff00",
  error: "#cc6666",
  dim: "#666666",
  muted: "#808080",
  text: "#c5c8c6",
  borderMuted: "#505050",
};
const rgb = (hex) => hex.match(/\w\w/g).map((pair) => parseInt(pair, 16)).join(";");
const theme = { fg: (color, text) => `\x1b[38;2;${rgb(palette[color])}m${text}\x1b[39m` };
const width = Math.min(process.stdout.columns || Number(process.env.COLUMNS) || 100, 110);

const state = createBrowserState(process.cwd());
const trail = new BrowserTrail();
const snapshot = ['- textbox "Display name" [ref=e7]', '- button "Save changes" [ref=e12]'].join("\n");
const labelFor = (ref) => snapshotLabel(snapshot, ref);
let running = 0;

const step = (ms, tool, params, ok = true, after = () => {}) => [ms, () => {
  const id = String(++running);
  state.connected = true;
  state.lastVerifiedAt = Date.now();
  trail.begin(id, describeActivity(tool, params, labelFor));
  return () => {
    trail.end(id, ok);
    after();
  };
}];
const pause = (ms, enter = () => {}) => [ms, () => (enter(), undefined)];
const goTo = (url) => () => {
  state.currentUrl = url;
  state.currentDomain = new URL(url).hostname;
};

const script = [
  pause(1500),
  step(900, "browser_connect", {}),
  step(1300, "browser_open", { url: "http://localhost:3000/settings/profile" }, true, goTo("http://localhost:3000/settings/profile")),
  step(900, "browser_snapshot", {}),
  step(1600, "browser_fill", { ref: "@e7", text: "never shown" }),
  step(700, "browser_click", { ref: "@e12" }),
  step(1400, "browser_wait", { text: "Saved" }),
  step(900, "browser_checkpoint", { label: "after save" }),
  pause(5000),
  step(1200, "browser_open", { url: "https://linear.app/acme/issue/ENG-42" }, true, goTo("https://linear.app/acme/issue/ENG-42")),
  step(800, "browser_find", { value: "Mark as done", action: "click" }, false),
  pause(5500, () => {
    state.tabGoneTargetId = "T1";
  }),
  pause(2500, () => {
    state.tabGoneTargetId = undefined;
    state.connected = false;
    state.lastError = "No browser listening";
  }),
];

const neighbours = (chip) => {
  const parts = [`${theme.fg("success", "●")} ${theme.fg("muted", "whiskd arc")}`, `${theme.fg("success", "")}${theme.fg("dim", " da bridge")}`];
  if (chip) parts.push(chip);
  parts.push(theme.fg("dim", "(^_^)"));
  return parts.join(" / ");
};
const border = theme.fg("borderMuted", "─".repeat(width));

let index = 0;
let sceneEndsAt = 0;
let finish;
process.stdout.write("\x1b[?25l\n\n\n\n\n");
process.on("SIGINT", () => {
  process.stdout.write("\x1b[?25h\n");
  process.exit(0);
});

setInterval(() => {
  const now = Date.now();
  if (now >= sceneEndsAt) {
    finish?.();
    if (index % script.length === 0) {
      Object.assign(state, createBrowserState(process.cwd()));
      trail.reset();
    }
    const [ms, enter] = script[index % script.length];
    finish = enter();
    sceneEndsAt = now + ms;
    index++;
  }
  const [trailLine = ""] = trail.lines(theme, width, formatAddress(state.currentUrl));
  const chip = browserChip(theme, state, connectionHealth(state, now));
  const rows = [trailLine, border, theme.fg("dim", " >"), border, ` ${neighbours(chip)}`];
  process.stdout.write(`\x1b[${rows.length}A` + rows.map((row) => `\r\x1b[2K${row}\n`).join(""));
}, 40);
