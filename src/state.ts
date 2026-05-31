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
  currentUrl?: string;
  currentDomain?: string;
  dashboardUrl?: string;
  lastAction?: string;
  lastSnapshotAt?: number;
  lastSnapshotFile?: string;
  lastScreenshotFile?: string;
  lastEvalFile?: string;
  lastError?: string;
  recording?: BrowserRecordingState;
  tracing?: BrowserRecordingState;
}

export function createBrowserState(
  cwd: string,
  port = resolveBrowserPort(),
  dashboardPort = resolveBrowserDashboardPort(),
): BrowserState {
  const slug = `${sanitizeSegment(basename(cwd) || "project")}-${hashString(cwd)}`;
  const artifactDir = join(os.tmpdir(), "pi-browser-ops", slug);

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
    currentUrl: persisted.currentUrl,
    currentDomain: persisted.currentDomain,
    dashboardUrl: persisted.dashboardUrl,
    lastAction: persisted.lastAction,
    lastSnapshotAt: persisted.lastSnapshotAt,
    lastSnapshotFile: persisted.lastSnapshotFile,
    lastScreenshotFile: persisted.lastScreenshotFile,
    lastEvalFile: persisted.lastEvalFile,
    lastError: persisted.lastError,
    recording: cloneRecording(persisted.recording),
    tracing: cloneRecording(persisted.tracing),
  };
}

export function serializeBrowserState(state: BrowserState): Record<string, unknown> {
  return {
    port: state.port,
    dashboardPort: state.dashboardPort,
    connected: state.connected,
    currentUrl: state.currentUrl,
    currentDomain: state.currentDomain,
    dashboardUrl: state.dashboardUrl,
    lastAction: state.lastAction,
    lastSnapshotAt: state.lastSnapshotAt,
    lastSnapshotFile: state.lastSnapshotFile,
    lastScreenshotFile: state.lastScreenshotFile,
    lastEvalFile: state.lastEvalFile,
    lastError: state.lastError,
    recording: state.recording ? { ...state.recording } : undefined,
    tracing: state.tracing ? { ...state.tracing } : undefined,
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

export function browserStatusText(state: BrowserState): string {
  const dot = state.connected ? "\u25CF" : "\u25CB";
  const label = state.currentDomain ?? (state.connected ? `cdp:${state.port}` : "idle");
  return `${dot} ${label}`;
}

export function browserWidgetLines(state: BrowserState): string[] {
  const dot = state.connected ? "\u25CF" : "\u25CB";
  const status = state.connected ? "connected" : "disconnected";
  const lines = [`${dot} browser  ${status}`];

  if (state.currentDomain) {
    lines.push(`  ${state.currentDomain}`);
  }
  if (state.lastAction) {
    lines.push(`  ${state.lastAction}  ${formatRelativeTime(state.lastSnapshotAt)}`);
  }
  if (state.recording || state.tracing) {
    const flags = [state.recording ? "rec" : null, state.tracing ? "trace" : null]
      .filter((s): s is string => Boolean(s))
      .join(" ");
    lines.push(`  ${flags}`);
  }
  if (state.lastError) {
    lines.push(`  ! ${truncateErrorLine(state.lastError)}`);
  }

  return lines;
}

export function browserSummary(state: BrowserState): string {
  const dot = state.connected ? "\u25CF" : "\u25CB";
  const lines = [
    `${dot} ${state.connected ? "connected" : "disconnected"}  cdp:${state.port}`,
    `  url       ${state.currentUrl ?? "-"}`,
    `  domain    ${state.currentDomain ?? "-"}`,
    `  action    ${state.lastAction ?? "-"}`,
    `  snapshot  ${formatRelativeTime(state.lastSnapshotAt)}`,
    `  artifacts ${state.artifactDir}`,
  ];

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
