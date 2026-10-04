import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { BrowserHost, ExecResult } from "./host.ts";

/** The browser core's host under pi: pi.exec bound to the call's signal, and node:fs. */
export function piHost(pi: ExtensionAPI, ctx: ExtensionContext): BrowserHost {
  return {
    exec: (command, args, { timeout }) => pi.exec(command, args, { signal: ctx.signal, timeout }) as Promise<ExecResult>,
    async writeFile(path, text) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    },
    async writePrivateFile(path, text) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600 });
      await chmod(path, 0o600); // writeFile's mode only applies when it creates the file
    },
    async ensureDir(path) {
      await mkdir(path, { recursive: true });
    },
    cwd: ctx.cwd,
    homeDir: homedir(),
    sessionId: ctx.sessionManager.getSessionId(),
    sessionPrefix: "pi",
  };
}
