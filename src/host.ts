// What the browser core needs from whoever runs it. pi implements it with pi.exec and
// node:fs (pi-host.ts); the Claude Code mod implements it with $.process and $.fs.
// Nothing in the core imports Node or a host package, so both can load it.

import type { ControlledTabAccent } from "./controlled-tab.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface BrowserHost {
  /** Runs a command by argv, no shell. Cancellation belongs to the host's own signal. */
  exec(command: string, args: string[], options: { timeout: number }): Promise<ExecResult>;
  /** Writes a text file, creating its directories. */
  writeFile(path: string, text: string): Promise<void>;
  /** Writes a file only the user can read (directory 700, file 600), never briefly wider. */
  writePrivateFile(path: string, text: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  cwd: string;
  homeDir: string;
  /** The host session's id; hashed into the agent-browser daemon session name. */
  sessionId: string;
  /** Names the host in the daemon session (`pi-…`, `cc-…`) so sessions never share one. */
  sessionPrefix: string;
  /** The controlled tab's favicon, so a glance at the tab says which agent drives it. */
  markerFaviconHref?: string;
  /** Matches the page's edge glow to the host's favicon. Defaults to pi blue. */
  markerAccent?: ControlledTabAccent;
}
