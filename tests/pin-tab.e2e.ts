import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import {
  agentBrowserSessionName,
  buildCdpInvocationArgs,
} from "../src/agent-browser-args.ts";

interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunOptions {
  expect?: number;
  label?: string;
  timeoutMs?: number;
}

const VICTIM_PI_SESSION = "pi-e2e-victim-session";
const PEER_PI_SESSION = "pi-e2e-peer-session";

function runAgentBrowser(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: RunOptions = {},
): Promise<CommandOutput> {
  const expectedCode = options.expect ?? 0;
  const label = options.label ?? args.join(" ");
  const timeoutMs = options.timeoutMs ?? 60_000;

  return new Promise((resolve, reject) => {
    const child = spawn("agent-browser", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${label}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== expectedCode) {
        reject(new Error(
          `${label}: expected exit ${expectedCode}, got ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 });
    });
  });
}

function parseJson(output: CommandOutput): Record<string, any> {
  return JSON.parse(output.stdout) as Record<string, any>;
}

function pinnedArgs(command: string[], port: number, piSessionId: string): string[] {
  return buildCdpInvocationArgs(command, port, piSessionId);
}

async function closeSession(
  env: NodeJS.ProcessEnv,
  session: string,
  namespace?: string,
): Promise<void> {
  const args = namespace
    ? ["--namespace", namespace, "--session", session, "close"]
    : ["--session", session, "close"];
  await runAgentBrowser(args, env, { label: `cleanup ${session}`, timeoutMs: 15_000 }).catch(() => {});
}

test("strict CDP pinning isolates Pi sessions, survives restart, and fails safe on tab loss", { timeout: 180_000 }, async () => {
  // Keep the Unix socket path deliberately short; macOS caps it at 103 bytes.
  const root = await mkdtemp("/tmp/da-browser-e2e-");
  const socketDir = `${root}/s`;
  await mkdir(socketDir);
  const env = {
    ...process.env,
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    NO_COLOR: "1",
  };

  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(request.url?.slice(1).toUpperCase() || "ROOT");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Self-validate the dynamic server before attributing any navigation error to CDP.
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "HEALTH");

  const victimSession = agentBrowserSessionName(VICTIM_PI_SESSION);
  const peerSession = agentBrowserSessionName(PEER_PI_SESSION);
  const diagnostics: Record<string, unknown> = { root, baseUrl };
  let passed = false;

  try {
    await runAgentBrowser(["--session", "host", "open", "about:blank", "--json"], env, {
      label: "launch isolated host browser",
    });
    const cdpUrl = parseJson(
      await runAgentBrowser(["--session", "host", "get", "cdp-url", "--json"], env),
    ).data.cdpUrl as string;
    const cdpPort = Number(new URL(cdpUrl).port);
    diagnostics.cdpPort = cdpPort;
    assert.ok(Number.isInteger(cdpPort) && cdpPort > 0);

    // Control the first open with plain direct CDP so server/browser failures are distinct
    // from strict pin setup failures.
    const direct = ["--namespace", "ctl", "--session", "direct", "--cdp", String(cdpPort)];
    await runAgentBrowser([...direct, "open", `${baseUrl}/direct`, "--json"], env, {
      label: "plain direct-CDP open",
    });
    assert.equal(
      parseJson(await runAgentBrowser([...direct, "get", "url", "--json"], env)).data.url,
      `${baseUrl}/direct`,
    );

    // Mirror browser_connect: the pin is applied before the first attach/probe.
    await runAgentBrowser(
      pinnedArgs(["get", "cdp-url", "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
      { label: "victim pin-before-attach" },
    );
    await runAgentBrowser(
      pinnedArgs(["open", `${baseUrl}/a`, "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
      { label: "extension-style pinned open" },
    );
    const victimTabs = parseJson(await runAgentBrowser(
      pinnedArgs(["tab", "list", "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
    )).data.tabs as Array<Record<string, unknown>>;
    const victimTarget = victimTabs.find((tab) => tab.active)?.targetId;
    diagnostics.victimTarget = victimTarget;
    assert.equal(typeof victimTarget, "string");

    await runAgentBrowser(
      pinnedArgs(["get", "cdp-url", "--json"], cdpPort, PEER_PI_SESSION),
      env,
      { label: "peer pin-before-attach" },
    );
    await runAgentBrowser(
      pinnedArgs(["open", `${baseUrl}/b`, "--json"], cdpPort, PEER_PI_SESSION),
      env,
      { label: "peer pinned open" },
    );
    const afterPeer = parseJson(await runAgentBrowser(
      pinnedArgs(["get", "url", "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
    )).data.url;
    diagnostics.afterPeer = afterPeer;
    assert.equal(afterPeer, `${baseUrl}/a`, "peer session must not steal victim's active tab");

    // Stop only the attached daemon. The durable .target binding must restore the same tab.
    await closeSession(env, victimSession, "da-browser");
    const afterRestart = parseJson(await runAgentBrowser(
      pinnedArgs(["get", "url", "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
      { label: "victim daemon restart restore" },
    )).data.url;
    diagnostics.afterRestart = afterRestart;
    assert.equal(afterRestart, `${baseUrl}/a`);
    const reboundTabs = parseJson(await runAgentBrowser(
      pinnedArgs(["tab", "list", "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
    )).data.tabs as Array<Record<string, unknown>>;
    assert.equal(reboundTabs.find((tab) => tab.active)?.targetId, victimTarget);

    // Close the victim target from a different session sharing the same browser.
    await runAgentBrowser(["--session", "host", "tab", "list", "--json"], env);
    await runAgentBrowser(["--session", "host", "tab", "close", String(victimTarget), "--json"], env, {
      label: "external target close",
    });
    const gone = parseJson(await runAgentBrowser(
      pinnedArgs(["get", "url", "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
      { expect: 1, label: "strict tab_gone" },
    ));
    diagnostics.tabGone = gone;
    assert.equal(gone.code, "tab_gone");
    assert.equal(gone.data.targetId, victimTarget);
    assert.equal(gone.data.lastUrl, `${baseUrl}/a`);

    // Recovery commands remain usable; tab new re-binds without adopting a neighbor.
    await runAgentBrowser(
      pinnedArgs(["tab", "list", "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
      { label: "tab list during tab_gone" },
    );
    const recovery = parseJson(await runAgentBrowser(
      pinnedArgs(["tab", "new", `${baseUrl}/recovered`, "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
      { label: "explicit tab recovery" },
    )).data;
    diagnostics.recovery = recovery;
    assert.equal(typeof recovery.targetId, "string");
    assert.notEqual(recovery.targetId, victimTarget);
    const recoveredUrl = parseJson(await runAgentBrowser(
      pinnedArgs(["get", "url", "--json"], cdpPort, VICTIM_PI_SESSION),
      env,
    )).data.url;
    diagnostics.recoveredUrl = recoveredUrl;
    assert.equal(recoveredUrl, `${baseUrl}/recovered`);
    passed = true;
  } catch (error) {
    console.error("da-browser pin-tab E2E diagnostics:\n" + JSON.stringify(diagnostics, null, 2));
    console.error(`E2E artifacts preserved at ${root}`);
    throw error;
  } finally {
    await closeSession(env, peerSession, "da-browser");
    await closeSession(env, victimSession, "da-browser");
    await closeSession(env, "direct", "ctl");
    await closeSession(env, "host");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (passed) await rm(root, { recursive: true, force: true });
  }
});
