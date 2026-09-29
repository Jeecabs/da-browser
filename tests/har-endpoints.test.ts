import assert from "node:assert/strict";
import test from "node:test";

import {
  analyze,
  describeValue,
  formatDetail,
  formatSummary,
  inferShape,
  renderShape,
  templatePaths,
} from "../skills/derive-client/scripts/har-endpoints.mjs";

const PAGE = "https://shop.example.com/search";
const JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString("base64url")}.sig`;

function entry(url: string, opts: { method?: string; type?: string; body?: unknown; response?: unknown; headers?: Record<string, string> } = {}) {
  const parsed = new URL(url);
  return {
    _resourceType: opts.type ?? "Fetch",
    startedDateTime: "2026-09-29T00:00:00.000Z",
    request: {
      method: opts.method ?? "GET",
      url,
      headers: Object.entries({ Referer: PAGE, ...opts.headers }).map(([name, value]) => ({ name, value })),
      queryString: [...parsed.searchParams].map(([name, value]) => ({ name, value })),
      postData: opts.body === undefined ? undefined : { mimeType: "application/json", text: JSON.stringify(opts.body) },
    },
    response: {
      status: 200,
      content: {
        mimeType: typeof opts.response === "string" ? "text/html" : "application/json",
        text: typeof opts.response === "string" ? opts.response : JSON.stringify(opts.response ?? {}),
      },
    },
  };
}

test("templatePaths templates ids and diffed slugs but never plain route words", () => {
  const paths = templatePaths([
    "/api/items/42",
    "/api/items/7",
    "/api/users/3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
    "/api/products/red-shoe/reviews",
    "/api/products/blue-hat/reviews",
    "/api/users",
    "/api/orders",
  ]);
  assert.equal(paths.get("/api/items/42"), "/api/items/{int}");
  assert.equal(paths.get("/api/users/3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"), "/api/users/{uuid}");
  assert.equal(paths.get("/api/products/red-shoe/reviews"), "/api/products/{slug}/reviews");
  assert.equal(paths.get("/api/users"), "/api/users");
  assert.equal(paths.get("/api/orders"), "/api/orders");
});

test("inferShape marks fields missing from some samples optional and collapses id-keyed maps", () => {
  const shape = inferShape([
    { items: [{ id: 1, name: "a" }, { id: 2 }], next: "c2" },
    { items: [], byId: { "101": { ok: true }, "102": { ok: false }, "103": { ok: true } } },
  ]);
  assert.equal(
    renderShape(shape),
    "{ items: { id: number; name?: string }[]; next?: string; byId?: Record<string, { ok: boolean }> }",
  );
});

test("describeValue reveals JWT expiry and harmless values but masks secrets", () => {
  const at = Date.parse("2026-09-29T00:00:00Z");
  assert.match(describeValue("authorization", `Bearer ${JWT}`, at), /^Bearer <JWT, exp 2030-03-17T17:46:40\.000Z \(\d+d after capture\)>$/);
  assert.equal(describeValue("x-csrf-token", "abc", at), "<masked, 3 chars>");
  assert.equal(describeValue("x-api", "k3".repeat(15), at), "<masked, 30 chars>");
  assert.equal(describeValue("x-api", "k3".repeat(15), at, () => "Document"), "<masked, 30 chars, in page HTML>");
  assert.equal(describeValue("x-api", "k3".repeat(15), at, () => "Script"), `${"k3".repeat(15)} (public: in page JS)`);
  assert.equal(describeValue("content-type", "application/x-www-form-urlencoded", at), "application/x-www-form-urlencoded");
  assert.equal(describeValue("x-requested-with", "XMLHttpRequest", at), "XMLHttpRequest");
});

test("analyze keeps the site's API, splits RPC operations, and drops noise", () => {
  const entries = [
    entry("https://shop.example.com/api/search?query=cats&page=1&limit=20", { response: { hits: [{ id: 1 }], total: 1 } }),
    entry("https://shop.example.com/api/search?query=dogs&page=2&limit=20", { response: { hits: [], total: 0, cursor: "x" } }),
    entry("https://shop.example.com/graphql", { method: "POST", body: { operationName: "Cart", variables: {} }, headers: { authorization: `Bearer ${JWT}` } }),
    entry("https://shop.example.com/graphql", { method: "POST", body: { query: "mutation AddItem { add }" }, headers: { authorization: `Bearer ${JWT}` } }),
    entry("https://www.google-analytics.com/g/collect?v=2", { method: "POST" }),
    entry("https://shop.example.com/cdn-cgi/rum", { method: "POST" }),
    entry("https://shop.example.com/relay/e/?ip=0&ver=1.333.0&compression=gzip-js", { method: "POST" }),
    entry("https://shop.example.com/p/blue-hat?_rsc=zk9y", { response: "0:[]" }),
    entry("https://shop.example.com/p/red-shoe", { type: "Document", response: '<script id="__NEXT_DATA__" type="application/json">{}</script>' }),
  ];
  const result = analyze(entries);

  assert.equal(result.site, "example.com");
  assert.deepEqual(
    result.endpoints.map((ep: { key: string }) => ep.key),
    [
      "GET https://shop.example.com/api/search",
      "POST https://shop.example.com/graphql op=Cart",
      "POST https://shop.example.com/graphql op=AddItem",
      "GET https://shop.example.com/p/blue-hat",
    ],
  );
  const search = result.endpoints[0];
  assert.deepEqual(
    search.params.map((p: { name: string; varies: boolean }) => `${p.name}:${p.varies}`),
    ["query:true", "page:true", "limit:false"],
  );
  assert.equal(renderShape(search.responseShape), "{ hits: { id: number }[]; total: number; cursor?: string }");
  assert.deepEqual([...result.noise], [["www.google-analytics.com", 1], ["shop.example.com", 2]]);
  assert.equal(result.endpoints[3].params[0].cacheBuster, true);
  assert.deepEqual(result.documents[0].markers, ["__NEXT_DATA__"]);

  const output = formatSummary(result, { files: ["t.har"], entries: entries.length }) + result.endpoints.map(formatDetail).join("\n");
  assert.ok(!output.includes(JWT.split(".")[1]), "JWT payload must never be printed");
  assert.match(output, /authorization: Bearer <JWT, exp 2030/);
});
