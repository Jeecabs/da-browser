import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { isLocalUrl, localBrowserSettleMs, localBrowserTimeoutMs } from "../src/state.ts";

const TIMEOUT_ENV = "PI_BROWSER_LOCAL_TIMEOUT_MS";
const SETTLE_ENV = "PI_BROWSER_LOCAL_SETTLE_MS";
const HOSTS_ENV = "PI_BROWSER_LOCAL_HOSTS";

afterEach(() => {
    delete process.env[TIMEOUT_ENV];
    delete process.env[SETTLE_ENV];
    delete process.env[HOSTS_ENV];
});

describe("isLocalUrl", () => {
    it("treats localhost and its variants as local", () => {
        assert.equal(isLocalUrl("http://localhost:3000"), true);
        assert.equal(isLocalUrl("http://app.localhost:5173"), true);
        assert.equal(isLocalUrl("http://my-machine.local"), true);
        assert.equal(isLocalUrl("https://foo.test"), true);
    });

    it("treats loopback and unspecified addresses as local", () => {
        assert.equal(isLocalUrl("http://127.0.0.1:8080"), true);
        assert.equal(isLocalUrl("http://127.1.2.3"), true);
        assert.equal(isLocalUrl("http://0.0.0.0:4000"), true);
        assert.equal(isLocalUrl("http://[::1]:3000"), true);
    });

    it("treats private LAN ranges as local", () => {
        assert.equal(isLocalUrl("http://192.168.1.10:3000"), true);
        assert.equal(isLocalUrl("http://10.0.0.5"), true);
        assert.equal(isLocalUrl("http://172.16.0.1"), true);
        assert.equal(isLocalUrl("http://172.31.255.254"), true);
    });

    it("treats public hosts and out-of-range IPs as remote", () => {
        assert.equal(isLocalUrl("https://example.com"), false);
        assert.equal(isLocalUrl("https://artificialanalysis.ai"), false);
        assert.equal(isLocalUrl("http://8.8.8.8"), false);
        assert.equal(isLocalUrl("http://172.15.0.1"), false);
        assert.equal(isLocalUrl("http://172.32.0.1"), false);
    });

    it("returns false for missing or unparseable urls", () => {
        assert.equal(isLocalUrl(undefined), false);
        assert.equal(isLocalUrl(""), false);
        assert.equal(isLocalUrl("not a url"), false);
    });

    it("honours PI_BROWSER_LOCAL_HOSTS overrides (exact and suffix)", () => {
        process.env[HOSTS_ENV] = "dev.mycorp.com, internal";
        assert.equal(isLocalUrl("https://dev.mycorp.com"), true);
        assert.equal(isLocalUrl("https://api.internal"), true);
        assert.equal(isLocalUrl("https://internal"), true);
        assert.equal(isLocalUrl("https://notinternal.com"), false);
    });
});

describe("localBrowserTimeoutMs", () => {
    it("defaults to 180s", () => {
        assert.equal(localBrowserTimeoutMs(), 180_000);
    });

    it("respects a valid PI_BROWSER_LOCAL_TIMEOUT_MS override", () => {
        process.env[TIMEOUT_ENV] = "300000";
        assert.equal(localBrowserTimeoutMs(), 300_000);
    });

    it("falls back to the default for invalid overrides", () => {
        for (const bad of ["0", "-5", "abc", ""]) {
            process.env[TIMEOUT_ENV] = bad;
            assert.equal(localBrowserTimeoutMs(), 180_000);
        }
    });
});

describe("localBrowserSettleMs", () => {
    it("defaults to 30s", () => {
        assert.equal(localBrowserSettleMs(), 30_000);
    });

    it("respects a valid PI_BROWSER_LOCAL_SETTLE_MS override", () => {
        process.env[SETTLE_ENV] = "5000";
        assert.equal(localBrowserSettleMs(), 5_000);
    });

    it("falls back to the default for invalid overrides", () => {
        for (const bad of ["0", "-1", "nope", ""]) {
            process.env[SETTLE_ENV] = bad;
            assert.equal(localBrowserSettleMs(), 30_000);
        }
    });
});
