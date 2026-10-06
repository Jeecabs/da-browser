import assert from "node:assert/strict";
import test from "node:test";

import { recordBrowser, stopCapturesNow, tabBrowser, verifyConnection } from "../src/agent-browser.ts";
import { agentBrowserSessionName } from "../src/agent-browser-args.ts";
import type { BrowserHost, ExecResult } from "../src/host.ts";
import { createBrowserState, type BrowserState } from "../src/state.ts";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
const failed = (error: string): ExecResult => ({ stdout: JSON.stringify({ success: false, data: null, error }), stderr: "", code: 1 });
const envelope = (data: unknown) => ok(JSON.stringify({ success: true, data }));

/** A host whose agent-browser answers per command; every call is kept for assertions. */
function fakeHost(answer: (args: string[]) => ExecResult | undefined) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const host = {
    calls,
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      if (command === "agent-browser" && args[0] === "--version") return ok("agent-browser 0.38.1");
      if (command === "lsof") return ok("Arc 1 user 1u IPv4 TCP 127.0.0.1:9222 (LISTEN)");
      if (command === "curl") return ok(args.some((arg) => arg.endsWith("/json/list")) ? "[]" : "{}");
      return answer(args) ?? ok();
    },
    writeFile: async () => {},
    writePrivateFile: async () => {},
    ensureDir: async () => {},
    cwd: "/repo",
    homeDir: "/home",
    sessionId: "session",
    sessionPrefix: "pi",
  };
  return host as typeof host & BrowserHost;
}

function recordingState(extra: Partial<BrowserState> = {}): BrowserState {
  return { ...createBrowserState("/repo"), connected: true, targetId: "T1", ...extra };
}

const has = (args: string[], ...words: string[]) => words.every((word) => args.includes(word));

test("a stop that finds no recording clears the stale state instead of failing", async () => {
  const state = recordingState({ recording: { file: "/tmp/take.webm", startedAt: Date.now() - 5_000 } });
  const host = fakeHost((args) => (has(args, "record", "stop") ? failed("No recording in progress") : undefined));
  const result = await recordBrowser(host, state, { action: "stop" });
  assert.equal(state.recording, undefined);
  assert.equal((result.diagnostics as Record<string, unknown>).lost, true);
  assert.match(result.summary, /No recording was running.*\/tmp\/take\.webm may be missing or truncated/);
});

test("a stop that fails still clears the recording, as agent-browser does", async () => {
  const state = recordingState({ recording: { file: "/tmp/take.webm", startedAt: Date.now() } });
  const host = fakeHost((args) => (has(args, "record", "stop") ? failed("ffmpeg write failed: Broken pipe") : undefined));
  await assert.rejects(recordBrowser(host, state, { action: "stop" }), /ffmpeg write failed/);
  assert.equal(state.recording, undefined);
});

test("a stop warns when the video is one still frame", async () => {
  const state = recordingState({ recording: { file: "/tmp/take.webm", startedAt: Date.now() - 6_000 } });
  const host = fakeHost((args) =>
    has(args, "record", "stop") ? envelope({ path: "/tmp/take.webm", frames: 195, capturedFrames: 1, fps: 30 }) : undefined,
  );
  const result = await recordBrowser(host, state, { action: "stop" });
  assert.equal((result.diagnostics as Record<string, unknown>).stillFrame, true);
  assert.match(result.summary, /one still frame/);

  const moving = fakeHost((args) =>
    has(args, "record", "stop") ? envelope({ path: "/tmp/take.webm", frames: 45, capturedFrames: 4, fps: 30 }) : undefined,
  );
  const fine = await recordBrowser(moving, recordingState({ recording: { file: "/tmp/take.webm", startedAt: Date.now() } }), { action: "stop" });
  assert.equal((fine.diagnostics as Record<string, unknown>).stillFrame, false);
  assert.doesNotMatch(fine.summary, /Warning/);

  // Hidden mid-take: it painted a few frames first, so only the tab's visibility tells.
  const hiddenLate = fakeHost((args) => {
    if (args.includes("document.visibilityState")) return ok('"hidden"');
    if (has(args, "record", "stop")) return envelope({ path: "/tmp/take.webm", frames: 208, capturedFrames: 2, fps: 30 });
    return undefined;
  });
  const froze = await recordBrowser(hiddenLate, recordingState({ recording: { file: "/tmp/take.webm", startedAt: Date.now() } }), { action: "stop" });
  assert.equal((froze.diagnostics as Record<string, unknown>).hiddenAtStop, true);
  assert.match(froze.summary, /in the background when the take ended/);
});

test("start brings a hidden controlled tab to the front, by its targetId", async () => {
  let visibility = "hidden";
  const host = fakeHost((args) => {
    if (args.includes("document.visibilityState")) return ok(`"${visibility}"`);
    if (has(args, "record", "start")) return envelope({ path: args[args.indexOf("start") + 1] });
    if (has(args, "get", "url")) return ok("https://example.com/");
    return undefined;
  });
  const exec = host.exec;
  host.exec = async (command, args, options) => {
    if (command === "curl" && args.some((arg) => arg.includes("/json/activate/"))) visibility = "visible";
    return exec(command, args, options);
  };
  const state = recordingState();
  const result = await recordBrowser(host, state, { action: "start", contactSheet: true });
  assert.ok(host.calls.some((call) => call.command === "curl" && call.args.some((arg) => arg.endsWith("/json/activate/T1"))));
  assert.equal((result.diagnostics as Record<string, unknown>).broughtForward, true);
  assert.match(result.summary, /Brought the controlled tab to the front/);
  assert.equal(state.recording?.contactSheet, true);
  assert.equal(state.lastAction, "record start");
});

test("restart reports the finished take and its contact sheet", async () => {
  const host = fakeHost((args) => {
    if (args.includes("document.visibilityState")) return ok('"visible"');
    if (has(args, "record", "restart")) return envelope({ previousPath: "/tmp/take-1.webm" });
    return undefined;
  });
  const state = recordingState({ recording: { file: "/tmp/take-1.webm", startedAt: Date.now(), contactSheet: true } });
  const result = await recordBrowser(host, state, { action: "restart", label: "take-2" });
  assert.deepEqual(result.artifacts, ["/tmp/take-1.webm", "/tmp/take-1.contact-sheet.png"]);
  assert.match(result.summary, /^Saved the previous take → \/tmp\/take-1\.webm/);
  assert.equal(state.recording?.contactSheet, undefined);
});

test("switching tabs mid-recording warns that the old tab is still being filmed", async () => {
  const host = fakeHost((args) => {
    if (has(args, "tab", "list")) return envelope({ tabs: [{ id: "t2", targetId: "T2", active: true, url: "https://b.example/" }] });
    if (has(args, "get", "url")) return ok("https://b.example/");
    return undefined;
  });
  const state = recordingState({ recording: { file: "/tmp/take.webm", startedAt: Date.now() } });
  const result = await tabBrowser(host, state, { action: "new", url: "https://b.example/" });
  assert.match(result.summary, /still filming the previous tab/);
});

test("stopCapturesNow stops each running capture and clears it", async () => {
  const host = fakeHost(() => undefined);
  const state = recordingState({
    recording: { file: "/tmp/take.webm", startedAt: 1 },
    har: { file: "/tmp/network.har", startedAt: 1 },
    tracing: { file: "/tmp/trace.zip", startedAt: 1 },
  });
  await stopCapturesNow(host, state);
  const sent = host.calls.filter((call) => call.command === "agent-browser").map((call) => call.args.join(" "));
  assert.ok(sent.some((args) => args.endsWith("record stop --json")));
  assert.ok(sent.some((args) => args.endsWith("network har stop /tmp/network.har")));
  assert.ok(sent.some((args) => args.endsWith("trace stop")));
  assert.deepEqual([state.recording, state.har, state.tracing], [undefined, undefined, undefined]);

  // A daemon that already exited took its captures with it; a stop would only respawn it.
  const gone = fakeHost((args) => (has(args, "session", "list") ? envelope({ sessions: [] }) : undefined));
  const orphaned = recordingState({ recording: { file: "/tmp/take.webm", startedAt: 1 } });
  await stopCapturesNow(gone, orphaned);
  assert.equal(orphaned.recording, undefined);
  assert.ok(!gone.calls.some((call) => call.args.includes("--cdp")), "no CDP call, so no daemon is respawned");
});

test("status notices a recording whose daemon exited, without respawning it first", async () => {
  const daemons = (sessions: string[]) =>
    fakeHost((args) => {
      if (has(args, "session", "list")) return envelope({ sessions });
      if (has(args, "tab", "list")) return envelope({ tabs: [{ id: "t1", targetId: "T1", active: true }] });
      return undefined;
    });

  const gone = daemons([]);
  const state = recordingState({ recording: { file: "/tmp/take.webm", startedAt: 1 } });
  await verifyConnection(gone, state);
  assert.equal(state.recording, undefined);
  assert.match(state.lastError ?? "", /daemon exited, so the recording in progress was lost/);
  const listAt = gone.calls.findIndex((call) => has(call.args, "session", "list"));
  const firstCdp = gone.calls.findIndex((call) => call.args.includes("--cdp"));
  assert.ok(listAt >= 0 && (firstCdp < 0 || listAt < firstCdp), "the daemon is asked about before a CDP call respawns it");

  const alive = recordingState({ recording: { file: "/tmp/take.webm", startedAt: 1 } });
  await verifyConnection(daemons([agentBrowserSessionName("session", "pi")]), alive);
  assert.ok(alive.recording, "a live daemon keeps its recording");
});
