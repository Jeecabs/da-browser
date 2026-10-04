// The environment the core reads. A Node host shares process.env; a host without Node
// (the Claude Code mod) fills this record from its own environment at session start.
type Env = Record<string, string | undefined>;

export const env: Env = (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/** os.tmpdir() without Node: TMPDIR less its trailing slash, else /tmp. */
export function tmpDir(): string {
  return env.TMPDIR?.replace(/\/+$/, "") || "/tmp";
}
