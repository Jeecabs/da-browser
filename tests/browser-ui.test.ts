import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { connectionHealth, createBrowserState } from "../src/state.ts";
import {
    BrowserTrail,
    browserChip,
    describeActivity,
    formatAddress,
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
        const snapshot = '- link "Say \\"hi\\"" [ref=e4]\n- textbox [ref=e3]';
        assert.equal(snapshotLabel(snapshot, "e4"), '"Say "hi""');
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
