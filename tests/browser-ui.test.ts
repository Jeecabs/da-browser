import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pressBrowserKey } from "../src/agent-browser.ts";
import type { BrowserHost } from "../src/host.ts";
import { connectionHealth, createBrowserState } from "../src/state.ts";
import {
    a11yText,
    artifactName,
    BrowserTrail,
    browserChip,
    describeActivity,
    explainFailure,
    formatAddress,
    formatBody,
    presentResult,
    resultLine,
    snapshotChanges,
    snapshotLabel,
    TRAIL_TIMING,
} from "../src/browser-ui.ts";

const theme = { fg: (color: string, text: string) => `[${color}:${text}]` };
const plain = { fg: (_color: string, text: string) => text };
const now = 1_000_000;
const base = () => ({ ...createBrowserState("/tmp/project"), port: 9222 });
const live = () => ({ ...base(), connected: true, lastVerifiedAt: now });
const chip = (state: ReturnType<typeof base>) => browserChip(theme, state, connectionHealth(state, now), { link: false });

describe("browserChip", () => {
    it("hides itself until the browser has something to say", () => {
        assert.equal(chip(base()), undefined);
    });

    it("names the site the agent is parked on, with no lamp and no port", () => {
        const state = { ...live(), currentUrl: "https://www.linear.app/acme/issue/ENG-42" };
        assert.equal(chip(state), "[dim:da browser] [muted:linear.app]");
        assert.doesNotMatch(chip(state)!, /9222|cdp|●/);
    });

    it("links the site to the page", () => {
        const state = { ...live(), currentUrl: "https://linear.app/acme/issue/ENG-42" };
        const linked = browserChip(plain, state, "ok")!;
        assert.match(linked, /\x1b\]8;;https:\/\/linear\.app\/acme\/issue\/ENG-42/);
    });

    it("fades the site once the connection has not been verified recently", () => {
        const state = { ...live(), lastVerifiedAt: now - 10 * 60_000, currentUrl: "http://localhost:3000/x" };
        assert.equal(chip(state), "[dim:da browser] [dim:localhost:3000]");
    });

    it("says what is wrong in words", () => {
        assert.equal(chip({ ...base(), lastError: "No browser listening" }), "[dim:da browser] [error:offline]");
        assert.equal(chip({ ...live(), tabGoneTargetId: "T1" }), "[dim:da browser] [warning:tab closed]");
        assert.equal(chip({ ...live(), agentBrowserCompatible: false }), "[dim:da browser] [warning:update agent-browser]");
    });

    it("stays short enough for a shared status row", () => {
        const state = { ...live(), currentUrl: "https://a-very-long-subdomain.of-some-company.example.com/x" };
        assert.ok(chip(state)!.replace(/\[\w+:|\]/g, "").length <= 36);
    });

    it("lists captures still writing to disk", () => {
        const capture = { file: "/tmp/x", startedAt: now };
        assert.equal(chip({ ...live(), recording: capture, har: capture }), "[dim:da browser]  [error:rec]  [warning:har]");
    });
});

describe("BrowserTrail", () => {
    const at = (clock: { t: number }) => new BrowserTrail(() => clock.t);

    it("renders nothing at rest", () => {
        assert.deepEqual(at({ t: now }).lines(theme, 120), []);
    });

    it("shows finished steps, then the running one in motion", () => {
        const clock = { t: now };
        const trail = at(clock);
        trail.begin("1", describeActivity("browser_open", { url: "https://linear.app/a" }));
        trail.end("1", true);
        trail.begin("2", describeActivity("browser_find", { value: "Save changes", action: "click" }));
        assert.deepEqual(trail.lines(theme, 200, "linear.app/a"), [
            ' [muted:da browser]  [muted:open linear.app][borderMuted: › ][accent:∙ click "Save changes"]   [dim:linear.app/a]',
        ]);
        assert.equal(trail.nextDelay(), 120);
    });

    it("marks failures in red", () => {
        const trail = at({ t: now });
        trail.begin("1", describeActivity("browser_click", { ref: "@e4" }));
        trail.end("1", false);
        assert.match(trail.lines(theme, 120)[0]!, /\[error:✗ click @e4\]/);
    });

    it("lingers, fades, then disappears", () => {
        const clock = { t: now };
        const trail = at(clock);
        trail.begin("1", describeActivity("browser_press", { key: "Enter" }));
        trail.end("1", true);
        assert.equal(trail.nextDelay(), TRAIL_TIMING.lingerMs);
        clock.t += TRAIL_TIMING.lingerMs;
        assert.match(trail.lines(theme, 120)[0]!, /^ \[dim:da browser\]  \[dim:press Enter\]$/);
        clock.t += TRAIL_TIMING.drainMs;
        assert.deepEqual(trail.lines(theme, 120), []);
        assert.equal(trail.nextDelay(), undefined);
    });

    it("starts a fresh trail after the last one faded", () => {
        const clock = { t: now };
        const trail = at(clock);
        trail.begin("1", describeActivity("browser_press", { key: "Enter" }));
        trail.end("1", true);
        clock.t += TRAIL_TIMING.lingerMs + TRAIL_TIMING.drainMs;
        trail.begin("2", describeActivity("browser_scroll", { direction: "down" }));
        assert.doesNotMatch(trail.lines(plain, 120)[0]!, /press Enter/);
    });

    it("keeps the newest steps when the row is narrow", () => {
        const trail = at({ t: now });
        for (let i = 0; i < 8; i++) {
            trail.begin(String(i), describeActivity("browser_find", { value: `Step number ${i}`, action: "click" }));
            trail.end(String(i), true);
        }
        const [line] = trail.lines(plain, 60, "example.com/page");
        assert.ok(line!.length <= 60);
        assert.match(line!, /^ da browser  … › .*"Step number 7"(   example\.com\/page)?$/);
    });
});

describe("describeActivity", () => {
    it("never echoes typed text, scripts, or credentials", () => {
        const secret = "hunter2";
        const calls: Array<[string, Record<string, unknown>]> = [
            ["browser_fill", { ref: "@e3", text: secret }],
            ["browser_find", { value: "Password", action: "fill", text: secret }],
            ["browser_eval", { script: `fetch("/x?k=${secret}")` }],
            ["browser_set", { setting: "credentials", username: "me", password: secret }],
            ["browser_set", { setting: "headers", headers: { Authorization: secret } }],
        ];
        for (const [tool, params] of calls) assert.doesNotMatch(describeActivity(tool, params).text, /hunter2/, tool);
    });

    it("reads like a short instruction", () => {
        assert.equal(describeActivity("browser_open", { url: "https://www.figma.com/file/abc" }).text, "open figma.com");
        assert.equal(describeActivity("browser_wait", { ms: 2500 }).text, "wait 3s");
        assert.equal(describeActivity("browser_wait", { text: "Saved" }).text, 'wait for "Saved"');
        assert.equal(describeActivity("browser_nav", { action: "back" }).text, "go back");
        assert.equal(describeActivity("browser_scroll", { direction: "up" }).motion, "up");
        assert.equal(describeActivity("browser_checkpoint", { label: "after save" }).text, 'checkpoint "after save"');
        assert.equal(describeActivity("browser_record", { action: "stop" }).text, "stop recording");
    });

    it("names elements from the latest snapshot", () => {
        const snapshot = '- button "Merge pull request" [ref=e12]\n- textbox [ref=e3]';
        const labelFor = (ref: string) => snapshotLabel(snapshot, ref);
        assert.equal(describeActivity("browser_click", { ref: "@e12" }, labelFor).text, 'click "Merge pull request"');
        assert.equal(describeActivity("browser_fill", { ref: "@e3", text: "x" }, labelFor).text, "type into textbox");
        assert.equal(describeActivity("browser_click", { ref: "@e99" }, labelFor).text, "click @e99");
    });
});

describe("snapshotLabel", () => {
    it("reads names, falls back to roles, and ignores unknown refs", () => {
        const snapshot = '- link "Say \\"hi\\"" [ref=e4]\n- textbox [ref=e3]\n- heading "Settings" [level=1, ref=e1]';
        assert.equal(snapshotLabel(snapshot, "e4"), '"Say "hi""');
        assert.equal(snapshotLabel(snapshot, "@e1"), '"Settings"');
        assert.equal(snapshotLabel(snapshot, "@e3"), "textbox");
        assert.equal(snapshotLabel(snapshot, "@e99"), undefined);
        assert.equal(snapshotLabel(snapshot, "@e1]"), undefined);
    });
});

describe("formatAddress", () => {
    it("drops scheme, www, query and trailing slash", () => {
        assert.equal(formatAddress("https://www.example.com/"), "example.com");
        assert.equal(formatAddress("http://localhost:3000/settings?tab=1#x"), "localhost:3000/settings");
    });

    it("keeps the host and last segments of long paths", () => {
        assert.equal(formatAddress("https://github.com/acme/some-long-repository/pull/12"), "github.com/…/pull/12");
    });

    it("ignores pages without a host", () => {
        assert.equal(formatAddress("about:blank"), undefined);
        assert.equal(formatAddress(undefined), undefined);
    });
});

// Fixtures are real agent-browser 0.38.1 output from a local probe page.
const SNAPSHOT_BEFORE = [
    '- heading "Settings" [level=1, ref=e1]',
    '- textbox "Display name" [ref=e3]',
    '- button "Save changes" [ref=e2]',
].join("\n");
const SNAPSHOT_AFTER = [
    '- heading "Settings" [level=1, ref=e1]',
    '- textbox "Display name" [ref=e3]',
    '- dialog "Confirm" [ref=e4]',
    '- button "Discard" [ref=e5]',
    '- button "Keep editing" [ref=e6]',
].join("\n");
const NETWORK = [
    "[6A73FF49] GET http://127.0.0.1:8765/ (Document) 200",
    "[84879.2] GET http://127.0.0.1:8765/missing.png (Image) 404",
    "[84879.4] GET http://127.0.0.1:8765/api.json (Fetch) 200",
    "[84879.5] GET http://127.0.0.1:8765/nope (Fetch) 404",
].join("\n");
const VITALS = "url: http://127.0.0.1:8765/\nttfb: 0.4ms  fcp: 16ms  lcp: 3.1s  cls: 0.3  inp: -\nlcp: element: h1";
const A11Y = [
    "url: http://127.0.0.1:8765/",
    "axe-core: 4.12.1  violations: 4  incomplete: 0  passes: 17",
    "",
    "[serious] html-has-lang: <html> element must have a lang attribute (1 node)",
    "[critical] image-alt: Images must have alternative text (1 node)",
    "[moderate] region: All page content should be contained by landmarks (3 nodes)",
].join("\n");

const view = (url: string, snapshot?: string, comparable = true) => ({ url, snapshot, comparable });
const present = (tool: string, overrides: Partial<Parameters<typeof presentResult>[0]> = {}) =>
    presentResult({
        tool,
        params: {},
        text: "Summary.",
        details: {},
        before: view("http://app.test/a"),
        after: view("http://app.test/a"),
        durationMs: 200,
        snapshotFiles: [],
        ...overrides,
    });
const facts = (presentation: ReturnType<typeof presentResult>) => presentation.facts.map((fact) => `${fact.tone}:${fact.text}`);

describe("snapshotChanges", () => {
    it("reports controls that appeared and disappeared, ignoring refs", () => {
        assert.deepEqual(snapshotChanges(SNAPSHOT_BEFORE, SNAPSHOT_AFTER), {
            added: ['dialog "Confirm"', 'button "Discard"', 'button "Keep editing"'],
            removed: ['button "Save changes"'],
        });
    });

    it("sees no change when only text changed, which is why it never claims nothing happened", () => {
        assert.deepEqual(snapshotChanges(SNAPSHOT_BEFORE, SNAPSHOT_BEFORE.replace("ref=e2", "ref=e9")), { added: [], removed: [] });
    });
});

describe("presentResult", () => {
    it("shows what a click changed", () => {
        const result = present("browser_click", {
            before: view("http://app.test/a", SNAPSHOT_BEFORE),
            after: view("http://app.test/a", SNAPSHOT_AFTER),
        });
        assert.deepEqual(facts(result), ['success:+ dialog "Confirm"', 'success:+ button "Discard"', 'muted:− button "Save changes"', "dim:+1 more"]);
    });

    it("prefers navigation over a diff, and says nothing when nothing visible changed", () => {
        const navigated = present("browser_click", { after: view("https://linear.app/acme/issue/ENG-42", SNAPSHOT_AFTER) });
        assert.deepEqual(facts(navigated), ["muted:→ linear.app/acme/issue/ENG-42"]);
        assert.equal(navigated.facts[0]!.href, "https://linear.app/acme/issue/ENG-42");
        const quiet = present("browser_click", { before: view("http://app.test/a", SNAPSHOT_BEFORE), after: view("http://app.test/a", SNAPSHOT_BEFORE) });
        assert.deepEqual(facts(quiet), []);
    });

    it("never diffs scoped snapshots", () => {
        const scoped = present("browser_click", { before: view("http://app.test/a", SNAPSHOT_BEFORE, false), after: view("http://app.test/a", SNAPSHOT_AFTER) });
        assert.deepEqual(facts(scoped), []);
    });

    it("counts requests and failures", () => {
        const result = present("browser_debug", { params: { kind: "network-requests" }, text: `Collected browser network-requests.\n\n${NETWORK}` });
        assert.deepEqual(facts(result), ["muted:4 requests", "error:2 failed"]);
        assert.equal(result.bodyKind, "network");
    });

    it("counts console levels", () => {
        const result = present("browser_debug", { params: { kind: "console" }, text: "Collected browser console.\n\n[log] hello log\n[warning] careful\n[error] boom" });
        assert.deepEqual(facts(result), ["error:1 error", "warning:1 warning", "muted:1 log"]);
    });

    it("rates web vitals against Google's bands", () => {
        const result = present("browser_vitals", { text: `Measured web vitals.\n\n${VITALS}` });
        assert.deepEqual(facts(result), ["warning:LCP 3.1s", "error:CLS 0.3", "dim:INP –"]);
    });

    it("summarises accessibility audits by severity", () => {
        const result = present("browser_a11y", { text: `Accessibility audit.\n\n${A11Y}`, details: { counts: { violations: 4 } } });
        assert.deepEqual(facts(result), ["error:4 violations", "error:1 critical", "error:1 serious"]);
        assert.deepEqual(facts(present("browser_a11y", { details: { counts: { violations: 0 } } })), ["success:no violations"]);
    });

    it("gives values, titles and booleans directly", () => {
        assert.deepEqual(facts(present("browser_get", { text: "Read browser title.\n\nProbe page" })), ["text:Probe page"]);
        assert.deepEqual(facts(present("browser_is", { params: { check: "visible" }, details: { result: false } })), ["warning:not visible"]);
        const read = present("browser_read", { text: "Read page.\n\n# Getting started\n\nInstall the thing and run it." });
        assert.deepEqual(facts(read), ['text:"Getting started"', "muted:8 words"]);
        assert.equal(read.bodyKind, "markdown");
    });

    it("lists files worth opening and keeps snapshot dumps out", () => {
        const result = present("browser_checkpoint", {
            details: {
                changed: true,
                pixelChangeRatio: 0.12,
                screenshotFile: "/tmp/da-browser/x/2026-10-02T03-12-45-123Z-after-save.png",
                artifacts: ["/tmp/da-browser/x/2026-10-02T03-12-45-123Z-after-save.png", "/tmp/da-browser/x/snap.txt"],
            },
            snapshotFiles: ["/tmp/da-browser/x/snap.txt"],
        });
        assert.deepEqual(facts(result), ["accent:changed 12%"]);
        assert.deepEqual(result.files, ["/tmp/da-browser/x/2026-10-02T03-12-45-123Z-after-save.png"]);
        assert.equal(result.image, result.files[0]);
    });
});

describe("resultLine", () => {
    it("joins facts, slow durations and short file names", () => {
        const presentation = {
            facts: [{ text: "17 cookies saved", tone: "success" as const }],
            files: ["/tmp/da-browser/x/2026-10-02T03-12-45-123Z-cookies.json"],
            durationMs: 2400,
            summary: "",
            bodyKind: "text" as const,
        };
        assert.equal(resultLine(theme, presentation, { link: false }), "[success:17 cookies saved]  [dim:2.4s]  [dim:cookies.json]");
        assert.match(resultLine(plain, presentation), /\x1b\]8;;file:\/\/\/tmp\/da-browser\/x\/2026-10-02T03-12-45-123Z-cookies\.json/);
    });

    it("is empty for a quick plain success", () => {
        assert.equal(resultLine(theme, { facts: [], files: [], durationMs: 120, summary: "", bodyKind: "text" }), "");
    });
});

describe("explainFailure", () => {
    it("turns agent-facing recovery text into a reason and a next step", () => {
        assert.deepEqual(explainFailure("The pinned browser tab is gone. Strict tab isolation prevented…\nRecover explicitly with browser_tab"), {
            reason: "tab closed",
            hint: "/browser connect opens a fresh one",
        });
        assert.equal(explainFailure("Arc is not reachable on CDP port 9222.\nQuit Arc and relaunch it with:").reason, "Arc not reachable");
        assert.deepEqual(explainFailure("Element @e9 not found"), { reason: "Element @e9 not found" });
    });
});

describe("formatBody", () => {
    it("colours snapshot trees by role", () => {
        assert.equal(
            formatBody(theme, "tree", '- button "Save changes" [ref=e2]'),
            '[dim:- ][accent:button][text: "Save changes"][dim: [ref=e2]]',
        );
    });

    it("lays out network requests by status", () => {
        assert.equal(
            formatBody(theme, "network", "[84879.5] GET http://127.0.0.1:8765/nope (Fetch) 404"),
            "[error:404 ][muted:GET    ][text:http://127.0.0.1:8765/nope]  [dim:Fetch 84879.5]",
        );
    });
});

describe("artifactName", () => {
    it("drops the timestamp prefix", () => {
        assert.equal(artifactName("/tmp/da-browser/x/2026-10-02T03-12-45-123Z-after-click-e12.txt"), "after-click-e12.txt");
    });
});

describe("fixes from a real-browser run", () => {
    it("names role lookups by their accessible name", () => {
        assert.equal(describeActivity("browser_find", { locator: "role", value: "button", name: "Save changes", action: "click" }).text, 'click button "Save changes"');
    });

    it("reads da-browser's JSON axe results", () => {
        const json = JSON.stringify({
            counts: { violations: 2 },
            violations: [
                { id: "image-alt", impact: "critical", help: "Images must have alternative text", helpUrl: "https://x/image-alt", nodes: [{ target: ["img"], impact: "critical" }] },
                { id: "region", impact: "moderate", help: "All page content should be contained by landmarks", nodes: [{ target: ["h1"] }, { target: ["img"] }] },
            ],
        });
        const result = present("browser_a11y", { text: `Accessibility audit: 2 violations.\n\n${json}`, details: { counts: { violations: 2 } } });
        assert.deepEqual(facts(result), ["error:2 violations", "error:1 critical"]);
        assert.match(a11yText(json), /^\[critical\] image-alt: Images must have alternative text \(1 node\)\n  https:\/\/x\/image-alt\n  - img\n\[moderate\] region/);
    });

    it("explains CLI failures by their stderr, not the command line", () => {
        const text = "Command failed: agent-browser --namespace da-browser --session pi-1 --pin-tab --cdp 9222 click @e99\nExit code: 1\nstderr:\n✗ Unknown ref: e99";
        assert.deepEqual(explainFailure(text), { reason: "Unknown ref: e99", hint: "refs go stale when the page changes; take a new snapshot" });
    });

    it("explains --json CLI failures by the error on stdout, keeping the details", async () => {
        const envelope = '{"success":false,"data":null,"error":"No recording in progress"}';
        const host = {
            exec: async (_command: string, args: string[]) =>
                args[0] === "--version" ? { stdout: "agent-browser 0.38.1", stderr: "", code: 0 } : { stdout: envelope, stderr: "", code: 1 },
            ensureDir: async () => {},
            sessionId: "s",
            sessionPrefix: "pi",
        } as unknown as BrowserHost;
        const error = await pressBrowserKey(host, base(), "Enter", "none").then(() => undefined, (failure: Error) => failure);
        assert.match(error!.message, /^agent-browser: No recording in progress\nCommand failed: agent-browser .*press Enter\n[\s\S]*stdout:\n\{"success":false/);
        assert.deepEqual(explainFailure(error!.message), { reason: "No recording in progress" });
    });
});
