import os from "node:os";
import { basename, join } from "node:path";

export type WaitMode = "none" | "load" | "networkidle";

export interface BrowserState {
  port: number;
  artifactDir: string;
  authFile: string;
  connected: boolean;
  currentUrl?: string;
  currentDomain?: string;
  lastAction?: string;
  lastSnapshotAt?: number;
  lastSnapshotFile?: string;
  lastScreenshotFile?: string;
  lastEvalFile?: string;
  lastError?: string;
}

export function createBrowserState(cwd: string, port = resolveBrowserPort()): BrowserState {
  const slug = `${sanitizeSegment(basename(cwd) || "project")}-${hashString(cwd)}`;
  const artifactDir = join(os.tmpdir(), "pi-browser-ops", slug);

  return {
    port,
    artifactDir,
    authFile: join(artifactDir, "arc-auth.json"),
    connected: false,
  };
}

export function mergeBrowserState(cwd: string, input: unknown, port = resolveBrowserPort()): BrowserState {
  const base = createBrowserState(cwd, port);
  if (!input || typeof input !== "object") return base;

  const persisted = input as Partial<BrowserState>;
  const resolvedPort = resolveBrowserPort(typeof persisted.port === "number" ? persisted.port : port);
  return {
    ...base,
    port: resolvedPort,
    connected: Boolean(persisted.connected),
    currentUrl: persisted.currentUrl,
    currentDomain: persisted.currentDomain,
    lastAction: persisted.lastAction,
    lastSnapshotAt: persisted.lastSnapshotAt,
    lastSnapshotFile: persisted.lastSnapshotFile,
    lastScreenshotFile: persisted.lastScreenshotFile,
    lastEvalFile: persisted.lastEvalFile,
    lastError: persisted.lastError,
  };
}

export function serializeBrowserState(state: BrowserState): Record<string, unknown> {
  return {
    port: state.port,
    connected: state.connected,
    currentUrl: state.currentUrl,
    currentDomain: state.currentDomain,
    lastAction: state.lastAction,
    lastSnapshotAt: state.lastSnapshotAt,
    lastSnapshotFile: state.lastSnapshotFile,
    lastScreenshotFile: state.lastScreenshotFile,
    lastEvalFile: state.lastEvalFile,
    lastError: state.lastError,
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

export function browserStatusText(state: BrowserState): string {
  const parts = [
    state.connected ? "browser connected" : "browser disconnected",
    state.currentDomain ? `domain ${state.currentDomain}` : `port ${state.port}`,
  ];

  if (state.lastAction) parts.push(`last ${state.lastAction}`);
  return parts.join(" | ");
}

export function browserWidgetLines(state: BrowserState): string[] {
  const lines = [
    "browser-ops",
    `status: ${state.connected ? "connected" : "disconnected"}`,
    `domain: ${state.currentDomain ?? "-"}`,
    `url: ${state.currentUrl ?? "-"}`,
    `last action: ${state.lastAction ?? "-"}`,
    `last snapshot: ${formatRelativeTime(state.lastSnapshotAt)}`,
    `artifact dir: ${state.artifactDir}`,
  ];

  if (state.lastError) lines.push(`last error: ${state.lastError}`);
  return lines;
}

export function browserSummary(state: BrowserState): string {
  const lines = [
    `Connection: ${state.connected ? "connected" : "disconnected"}`,
    `Current URL: ${state.currentUrl ?? "-"}`,
    `Current domain: ${state.currentDomain ?? "-"}`,
    `Last action: ${state.lastAction ?? "-"}`,
    `Last snapshot: ${formatRelativeTime(state.lastSnapshotAt)}`,
    `Artifact dir: ${state.artifactDir}`,
    `Auth export: ${state.authFile}`,
  ];

  if (state.lastError) lines.push(`Last error: ${state.lastError}`);
  return lines.join("\n");
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
    return new URL(url).hostname || undefined;
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

function formatRelativeTime(timestamp?: number): string {
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
