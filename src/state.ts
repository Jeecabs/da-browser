import os from "node:os";
import { basename, join } from "node:path";

export type WaitMode = "none" | "load" | "networkidle";

export interface BrowserRecordingState {
  file: string;
  startedAt: number;
}

export interface BrowserState {
  port: number;
  dashboardPort: number;
  artifactDir: string;
  connected: boolean;
  agentBrowserVersion?: string;
  agentBrowserCompatible?: boolean;
  currentUrl?: string;
  currentDomain?: string;
  dashboardUrl?: string;
  lastAction?: string;
  lastSnapshotAt?: number;
  lastSnapshotFile?: string;
  lastScreenshotFile?: string;
  lastEvalFile?: string;
  lastError?: string;
  // Wall-clock of the last call that proved the browser responded. Drives the "stale"
  // (◐) widget state so the connected dot stops claiming certainty it no longer has.
  lastVerifiedAt?: number;
  recording?: BrowserRecordingState;
  tracing?: BrowserRecordingState;
  har?: BrowserRecordingState;
}

// Result of actively probing the debugging port (vs. trusting in-memory state). Returned
// by verifyConnection and rendered in status output so "connected" is checkable, not just
// asserted.
export interface ConnectionProbe {
  portListening: boolean;
  pageTargets: number;
  attachedUrl?: string;
  browser?: string;
  agentBrowserVersion?: string;
  agentBrowserCompatible: boolean;
  requiredAgentBrowserVersion: string;
}

export function createBrowserState(
  cwd: string,
  port = resolveBrowserPort(),
  dashboardPort = resolveBrowserDashboardPort(),
): BrowserState {
  const slug = `${sanitizeSegment(basename(cwd) || "project")}-${hashString(cwd)}`;
  const artifactDir = join(os.tmpdir(), "da-browser", slug);

  return {
    port,
    dashboardPort,
    artifactDir,
    connected: false,
  };
}

export function mergeBrowserState(
  cwd: string,
  input: unknown,
  port = resolveBrowserPort(),
  dashboardPort = resolveBrowserDashboardPort(),
): BrowserState {
  const base = createBrowserState(cwd, port, dashboardPort);
  if (!input || typeof input !== "object") return base;

  const persisted = input as Partial<BrowserState>;
  const resolvedPort = resolveBrowserPort(typeof persisted.port === "number" ? persisted.port : port);
  const resolvedDashboardPort = resolveBrowserDashboardPort(
    typeof persisted.dashboardPort === "number" ? persisted.dashboardPort : dashboardPort,
  );
  return {
    ...base,
    port: resolvedPort,
    dashboardPort: resolvedDashboardPort,
    connected: Boolean(persisted.connected),
    agentBrowserVersion: persisted.agentBrowserVersion,
    agentBrowserCompatible:
      typeof persisted.agentBrowserCompatible === "boolean" ? persisted.agentBrowserCompatible : undefined,
    currentUrl: persisted.currentUrl,
    currentDomain: persisted.currentDomain,
    dashboardUrl: persisted.dashboardUrl,
    lastAction: persisted.lastAction,
    lastSnapshotAt: persisted.lastSnapshotAt,
    lastSnapshotFile: persisted.lastSnapshotFile,
    lastScreenshotFile: persisted.lastScreenshotFile,
    lastEvalFile: persisted.lastEvalFile,
    lastError: persisted.lastError,
    lastVerifiedAt: typeof persisted.lastVerifiedAt === "number" ? persisted.lastVerifiedAt : undefined,
    recording: cloneRecording(persisted.recording),
    tracing: cloneRecording(persisted.tracing),
    har: cloneRecording(persisted.har),
  };
}

export function serializeBrowserState(state: BrowserState): Record<string, unknown> {
  return {
    port: state.port,
    dashboardPort: state.dashboardPort,
    connected: state.connected,
    agentBrowserVersion: state.agentBrowserVersion,
    agentBrowserCompatible: state.agentBrowserCompatible,
    currentUrl: state.currentUrl,
    currentDomain: state.currentDomain,
    dashboardUrl: state.dashboardUrl,
    lastAction: state.lastAction,
    lastSnapshotAt: state.lastSnapshotAt,
    lastSnapshotFile: state.lastSnapshotFile,
    lastScreenshotFile: state.lastScreenshotFile,
    lastEvalFile: state.lastEvalFile,
    lastError: state.lastError,
    lastVerifiedAt: state.lastVerifiedAt,
    recording: state.recording ? { ...state.recording } : undefined,
    tracing: state.tracing ? { ...state.tracing } : undefined,
    har: state.har ? { ...state.har } : undefined,
  };
}

export function resolveBrowserPort(explicitPort?: number): number {
  if (isValidPort(explicitPort)) return explicitPort;

  const envValue =
    process.env.PI_BROWSER_PORT ??
    process.env.AGENT_BROWSER_PORT ??
    process.env.ARC_REMOTE_DEBUG_PORT;
  const envPort = Number(envValue);

  if (isValidPort(envPort)) return envPort;
  return 9222;
}

export function resolveBrowserDashboardPort(explicitPort?: number): number {
  if (isValidPort(explicitPort)) return explicitPort;

  const envPort = Number(process.env.PI_BROWSER_DASHBOARD_PORT);
  if (isValidPort(envPort)) return envPort;
  return 4848;
}

// The "agent is controlling this tab" banner is on by default. Set
// PI_BROWSER_CONTROL_BANNER to a falsy value (0/false/off/no/none/hidden) to
// suppress it — e.g. for a clean demo recording.
export function resolveControlBannerEnabled(): boolean {
  const raw = process.env.PI_BROWSER_CONTROL_BANNER?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no", "none", "hidden", "disable", "disabled"].includes(raw);
}

function cloneRecording(input?: BrowserRecordingState): BrowserRecordingState | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (typeof input.file !== "string" || typeof input.startedAt !== "number") return undefined;
  return { file: input.file, startedAt: input.startedAt };
}

// How long a verified connection stays "fresh" before the widget downgrades to \u25D0 stale.
// We never probe in the widget, so after this long we stop asserting the browser is alive.
const VERIFIED_STALE_MS = 5 * 60_000;

export type ConnectionHealth = "ok" | "suspect" | "down";

// Honest connection state: down when not connected, suspect when connected but not
// confirmed recently, ok otherwise. Keeps the dot from claiming \u25CF after the browser
// silently died. `now` is injectable for testing.
export function connectionHealth(state: BrowserState, now = Date.now()): ConnectionHealth {
  if (!state.connected) return "down";
  if (state.lastVerifiedAt !== undefined && now - state.lastVerifiedAt > VERIFIED_STALE_MS) {
    return "suspect";
  }
  return "ok";
}

export function connectionGlyph(health: ConnectionHealth): string {
  if (health === "ok") return "\u25CF";
  if (health === "suspect") return "\u25D0";
  return "\u25CB";
}

export function connectionWord(health: ConnectionHealth): string {
  if (health === "ok") return "connected";
  if (health === "suspect") return "stale";
  return "disconnected";
}

export function browserStatusText(state: BrowserState): string {
  const health = connectionHealth(state);
  const label = state.currentDomain ?? (state.connected ? `cdp:${state.port}` : "idle");
  return `${connectionGlyph(health)} ${label}`;
}

export function browserWidgetLines(state: BrowserState): string[] {
  const health = connectionHealth(state);
  const lines = [`${connectionGlyph(health)} browser  ${connectionWord(health)}`];

  if (state.currentDomain) {
    lines.push(`  ${state.currentDomain}`);
  }
  if (state.lastAction) {
    lines.push(`  ${state.lastAction}  ${formatRelativeTime(state.lastSnapshotAt)}`);
  }
  if (state.recording || state.tracing || state.har) {
    const flags = [state.recording ? "rec" : null, state.tracing ? "trace" : null, state.har ? "har" : null]
      .filter((s): s is string => Boolean(s))
      .join(" ");
    lines.push(`  ${flags}`);
  }
  if (state.lastError) {
    lines.push(`  ! ${truncateErrorLine(state.lastError)}`);
  }

  return lines;
}

function agentBrowserVersionSummary(probe: ConnectionProbe): string {
  const status = probe.agentBrowserCompatible ? "ok" : `requires >=${probe.requiredAgentBrowserVersion}`;
  return `agent-browser ${probe.agentBrowserVersion ?? "not found"}  ${status}`;
}

export function browserSummaryWithVersion(state: BrowserState, probe?: ConnectionProbe): string {
  const summary = browserSummary(state, probe);
  return probe ? `${summary}\n  cli       ${agentBrowserVersionSummary(probe)}` : summary;
}

function browserSummary(state: BrowserState, probe?: ConnectionProbe): string {
  const health = connectionHealth(state);
  const verified = state.lastVerifiedAt ? `  verified ${formatRelativeTime(state.lastVerifiedAt)}` : "";
  const lines = [
    `${connectionGlyph(health)} ${connectionWord(health)}  cdp:${state.port}${verified}`,
    `  url       ${state.currentUrl ?? "-"}`,
    `  domain    ${state.currentDomain ?? "-"}`,
    `  action    ${state.lastAction ?? "-"}`,
    `  snapshot  ${formatRelativeTime(state.lastSnapshotAt)}`,
    `  artifacts ${state.artifactDir}`,
  ];

  // Probe details come from actively hitting the debugging port \u2014 the checkable truth
  // behind the asserted status above.
  if (probe) {
    lines.push(`  port      ${probe.portListening ? "listening" : "not listening"}`);
    lines.push(`  targets   ${probe.pageTargets} page${probe.pageTargets === 1 ? "" : "s"}`);
    if (probe.browser) lines.push(`  browser   ${probe.browser}`);
  }

  if (state.dashboardUrl) lines.push(`  dashboard ${state.dashboardUrl}`);
  if (state.recording) lines.push(`  recording ${state.recording.file}`);
  if (state.tracing) lines.push(`  tracing   ${state.tracing.file}`);
  if (state.lastError) lines.push(`  error     ${state.lastError}`);
  return lines.join("\n");
}

function truncateErrorLine(error: string, maxLen = 60): string {
  const first = error.split("\n")[0] ?? error;
  return first.length > maxLen ? first.slice(0, maxLen - 1) + "\u2026" : first;
}

export function normalizeRef(ref: string): string {
  return ref.trim().replace(/^@+/, "");
}

export function sanitizeArtifactLabel(label: string): string {
  const trimmed = label.trim().toLowerCase();
  const sanitized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return sanitized.replace(/^-|-$/g, "") || "artifact";
}

export function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return undefined;
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return `${parsed.hostname}:${parsed.port || "80"}`;
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

const DEFAULT_LOCAL_TIMEOUT_MS = 180_000;
const DEFAULT_LOCAL_SETTLE_MS = 30_000;

/**
 * True when the URL points at the local machine or a local dev server. agent-browser caps
 * each operation at a 60s default; slow dev servers (cold SSR, first compile, HMR) routinely
 * blow past that, so callers grant these targets a larger settle/wait budget — see
 * {@link localBrowserSettleMs} and {@link localBrowserTimeoutMs}.
 */
export function isLocalUrl(url?: string): boolean {
  if (!url) return false;
  try {
    return isLocalHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isLocalHostname(rawHostname: string): boolean {
  const hostname = rawHostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) return false;

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".test") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "::ffff:127.0.0.1"
  ) {
    return true;
  }

  if (isPrivateIpv4(hostname)) return true;

  return extraLocalHosts().some((extra) => hostname === extra || hostname.endsWith(`.${extra}`));
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const [a, b] = octets.map(Number);
  if (a > 255 || b > 255) return false;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  return false;
}

function extraLocalHosts(): string[] {
  const raw = process.env.PI_BROWSER_LOCAL_HOSTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^\[|\]$/g, ""))
    .filter(Boolean);
}

/**
 * Per-command timeout (ms) for explicit waits against local/dev-server targets, passed to
 * agent-browser's global --timeout flag. Override with PI_BROWSER_LOCAL_TIMEOUT_MS
 * (default 180000 = 3m).
 */
export function localBrowserTimeoutMs(): number {
  const value = Number(process.env.PI_BROWSER_LOCAL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LOCAL_TIMEOUT_MS;
}

/**
 * Cap (ms) for the automatic post-action settle on local targets — how long to wait for the
 * page to reach its load state before proceeding anyway. Kept smaller than
 * {@link localBrowserTimeoutMs} so pages that never go idle (polling/SSE) don't stall every
 * step. Override with PI_BROWSER_LOCAL_SETTLE_MS (default 30000 = 30s).
 */
export function localBrowserSettleMs(): number {
  const value = Number(process.env.PI_BROWSER_LOCAL_SETTLE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LOCAL_SETTLE_MS;
}

function sanitizeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "project";
}

function isValidPort(port?: number): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535;
}

function hashString(input: string): string {
  let hash = 5381;
  for (const char of input) {
    hash = (hash * 33) ^ char.charCodeAt(0);
  }
  return (hash >>> 0).toString(16);
}

export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "-";

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 1_000) return "just now";

  const seconds = Math.floor(deltaMs / 1_000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
