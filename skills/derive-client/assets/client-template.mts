#!/usr/bin/env node
// __SITE__ client, derived from a browser recording on __DATE__ (da-browser derive-client skill).
// Internal API: unversioned and may change without notice. When `smoke` fails, re-record and re-derive.
//
//   node __FILE__ <command> [args…]    call one endpoint, print JSON
//   node __FILE__ smoke                 call every read endpoint once, check auth + shapes
//
// Auth: cookies exported by da-browser's browser_cookies tool. Never commit the cookie file.

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = "https://__HOST__";
const COOKIE_FILE = process.env.__ENV___COOKIES ?? join(homedir(), ".config", "__NAME__", "cookies.json");
const MIN_INTERVAL_MS = 1000; // polite pacing; lower only if the site clearly tolerates it
// Headers the API needs, found in step 5 by omission. agent-browser HARs omit accept/origin, so start with them.
const DEFAULT_HEADERS: Record<string, string> = {
  accept: "application/json",
  origin: BASE_URL,
  referer: `${BASE_URL}/`,
};

// ── transport ────────────────────────────────────────────────────────────────

type Cookie = { name: string; value: string; domain: string; path?: string; secure?: boolean; expires?: number };
type Query = Record<string, string | number | boolean | undefined>;

export class AuthError extends Error {}

const relogin = `Log in to ${BASE_URL} in the browser, open it in the controlled tab, then run browser_cookies with path "${COOKIE_FILE}".`;

let jar: Cookie[] | undefined;
function loadCookies(): Cookie[] {
  try {
    return JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
  } catch {
    throw new AuthError(`No cookies at ${COOKIE_FILE}. ${relogin}`);
  }
}

// CDP marks domain cookies with a leading dot; bare domains are host-only.
function cookieHeader(url: URL, cookies: Cookie[]): string {
  const now = Date.now() / 1000;
  return cookies
    .filter((c) => {
      const host = c.domain.startsWith(".")
        ? url.hostname === c.domain.slice(1) || url.hostname.endsWith(c.domain)
        : url.hostname === c.domain;
      const path = c.path ?? "/";
      const pathOk = url.pathname === path || (url.pathname.startsWith(path) && (path.endsWith("/") || url.pathname[path.length] === "/"));
      return host && pathOk && (!c.secure || url.protocol === "https:") && (!c.expires || c.expires < 0 || c.expires > now);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

let lastRequestAt = 0;
async function request<T>(method: string, path: string, opts: { query?: Query; json?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(opts.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...opts.headers };
  const cookie = cookieHeader(url, (jar ??= loadCookies()));
  if (cookie) headers.cookie = cookie;
  if (opts.json !== undefined) headers["content-type"] = "application/json";

  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();

    const res = await fetch(url, {
      method,
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      redirect: "manual", // a redirect is almost always "go log in"; following it hides the cause
    });
    const type = res.headers.get("content-type") ?? "";

    if (res.status === 429 && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, (retryAfter > 0 ? retryAfter : 5 * (attempt + 1)) * 1000));
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 419) {
      throw new AuthError(`${method} ${url.pathname} → ${res.status}. Session missing, expired, or a required header is absent. ${relogin}`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new AuthError(`${method} ${url.pathname} → redirected to ${res.headers.get("location")}. Usually an expired session. ${relogin}`);
    }
    if (!res.ok) throw new Error(`${method} ${url.pathname} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (type.includes("text/html") && DEFAULT_HEADERS.accept?.includes("json")) {
      throw new AuthError(`${method} ${url.pathname} returned HTML instead of JSON (login page or bot challenge). ${relogin}`);
    }
    return (type.includes("json") ? await res.json() : await res.text()) as T;
  }
}

// ── endpoints: one function per recorded flow, typed from har-endpoints --show ──

// EXAMPLE: delete from here to the CLI section and write the recorded flows instead.
export type SearchResult = { items: { id: number; title: string }[]; nextCursor?: string };

export function search(q: string, opts: { cursor?: string; limit?: number } = {}) {
  return request<SearchResult>("GET", "/api/search", { query: { q, ...opts } });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const commands: Record<string, (...args: string[]) => Promise<unknown>> = {
  search: (q, cursor) => search(q, { cursor }),
};

// Read-only calls with arguments seen in the recording. Never put writes here.
// The FIRST entry must be an auth canary: a call that 401s without cookies. Some endpoints
// quietly fall back to anonymous data instead, so a green smoke alone doesn't prove auth works.
const SMOKE: Record<string, string[]> = {
  search: ["cats"],
};

function preview(value: unknown): string {
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value && typeof value === "object") return `{ ${Object.keys(value).join(", ")} }`;
  return String(value).slice(0, 80);
}

async function smoke(): Promise<void> {
  let failed = 0;
  for (const [name, args] of Object.entries(SMOKE)) {
    try {
      console.log(`ok    ${name}  ${preview(await commands[name]!(...args))}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}  ${error instanceof Error ? error.message : error}`);
      if (error instanceof AuthError) break; // every later call would fail the same way
    }
  }
  const untested = Object.keys(commands).filter((name) => !(name in SMOKE));
  if (untested.length) console.log(`untested (writes or no sample args): ${untested.join(", ")}`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...args] = process.argv.slice(2);
  const run = name === "smoke" ? smoke() : name && commands[name] ? commands[name](...args).then((out) => console.log(JSON.stringify(out, null, 2))) : undefined;
  if (!run) {
    console.error(`Usage: node ${process.argv[1]} <${[...Object.keys(commands), "smoke"].join("|")}> [args…]`);
    process.exitCode = 2;
  }
  run?.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
