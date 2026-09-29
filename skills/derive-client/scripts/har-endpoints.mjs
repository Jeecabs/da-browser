#!/usr/bin/env node
// Summarize HAR recordings into the API endpoints a derived client needs.
//
//   node <skill-dir>/scripts/har-endpoints.mjs <file.har> [more.har…]   numbered endpoint summary
//   node <skill-dir>/scripts/har-endpoints.mjs <file.har> --show 3      full detail for endpoint 3 (or a URL regex)
//   node <skill-dir>/scripts/har-endpoints.mjs <file.har> --all         skip the noise filter
//
// Zero dependencies. Secret-looking values (tokens, cookies, signatures) are masked in all output,
// so it is safe to read into context, unlike the raw HAR.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// ponytail: curated heuristics, not a blocklist service. `--all` bypasses them when something real gets dropped.
const NOISE_HOST =
  /(^|\.)(google-analytics|googletagmanager|doubleclick|googlesyndication|googleadservices|segment|sentry|datadoghq|browser-intake-datadoghq|intercom|intercomcdn|hotjar|mixpanel|amplitude|fullstory|heapanalytics|clarity|facebook|connect\.facebook|linkedin|ads-twitter|tiktok|posthog|launchdarkly|optimizely|newrelic|nr-data|bugsnag|logrocket|cloudflareinsights|pinterest|reddit|snapchat|bing|quantserve|scorecardresearch|onetrust|cookielaw|recaptcha|hcaptcha)\.[a-z.]+$/i;
const CACHE_BUSTER = /^(_rsc|_|_t|ts|cb|nocache|cache-?bust(er)?)$/i;
const NOISE_SUBDOMAIN = /^(telemetry|analytics|stats|metrics|collector|rum|beacon|tracking|logs?)[.-]/i;
const NOISE_PATH =
  /(^|\/)(collect|track|tracking|beacon|telemetry|analytics|pixel|rum|ping|isalive|health|healthz|heartbeat|monitoring|ingest|log|logs|cdn-cgi|_vercel\/(insights|speed-insights))(\/|$)/i;
const IGNORED_TYPES = /^(Ping|CSPViolationReport|Preflight|Image|Font|Stylesheet|Media|Script|Manifest|TextTrack)$/;
const API_TYPES = /^(Fetch|XHR|EventSource|WebSocket)$/;
const API_MIME = /json|graphql|protobuf|x-component|event-stream|ndjson/i;
const BROWSER_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control", "connection", "content-length", "content-type",
  "cookie", "dnt", "host", "origin", "pragma", "priority", "referer", "te", "upgrade-insecure-requests", "user-agent",
]);
const SECRET_NAME = /pass(word)?|secret|token|auth|session|sig(nature)?|api[-_]?key|credential|cookie|otp|csrf|xsrf|jwt|bearer|nonce/i;
const OPAQUE_VALUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9._~+/=-]{24,}$/;
const EMBEDDED_DATA = [
  ["__NEXT_DATA__", /id="__NEXT_DATA__"/],
  ["Next RSC flight", /self\.__next_f\.push/],
  ["__NUXT__", /__NUXT__|id="__NUXT_DATA__"/],
  ["JSON-LD", /application\/ld\+json/],
  ["Apollo state", /__APOLLO_STATE__/],
  ["initial state", /__(INITIAL|PRELOADED)_STATE__/],
  ["Remix context", /__remixContext/],
  ["SvelteKit data", /__sveltekit_/],
];

// Obvious id segments. Anything subtler is caught by the cross-sample diff in templatePaths.
const SEGMENT_PARAMS = [
  ["{int}", /^\d+$/],
  ["{uuid}", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["{hex}", /^[0-9a-f]{16,}$/i],
  ["{date}", /^\d{4}-\d{2}-\d{2}/],
  ["{token}", /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_-]{20,}$/i],
];
const ID_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,})$/i;

export function templateSegment(segment) {
  return SEGMENT_PARAMS.find(([, pattern]) => pattern.test(segment))?.[0] ?? segment;
}

/**
 * Template a set of `/a/b/c` paths. Obvious ids come from SEGMENT_PARAMS; beyond that, paths
 * that differ in exactly one slug-like segment (has a digit or -_.) collapse to `{slug}`.
 * Plain words never collapse, so /api/users and /api/orders stay separate endpoints.
 * Returns Map<originalPath, templatedPath>.
 */
export function templatePaths(paths) {
  const segs = new Map([...new Set(paths)].map((p) => [p, p.split("/").map(templateSegment)]));
  const length = Math.max(0, ...[...segs.values()].map((s) => s.length));
  for (let i = 0; i < length; i++) {
    const buckets = new Map();
    for (const [path, s] of segs) {
      if (s.length <= i || s[i].startsWith("{")) continue;
      const key = `${s.length}|${s.map((part, j) => (j === i ? "*" : part)).join("/")}`;
      buckets.set(key, [...(buckets.get(key) ?? []), path]);
    }
    for (const group of buckets.values()) {
      const values = new Set(group.map((path) => segs.get(path)[i]));
      if (values.size > 1 && [...values].every((v) => /[\d_.-]/.test(v))) {
        for (const path of group) segs.get(path)[i] = "{slug}";
      }
    }
  }
  return new Map([...segs].map(([path, s]) => [path, s.join("/")]));
}

// ---------- shape inference: merge JSON samples into a TypeScript-ish type ----------

function newShape() {
  return { types: new Set(), fields: new Map(), objects: 0, items: null, values: null };
}

export function addSample(shape, value) {
  if (value === null) shape.types.add("null");
  else if (Array.isArray(value)) {
    shape.types.add("array");
    shape.items ??= newShape();
    for (const item of value.slice(0, 50)) addSample(shape.items, item);
  } else if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length >= 3 && keys.every((key) => ID_KEY.test(key))) {
      shape.types.add("record"); // id-keyed map: one value type, not N fields
      shape.values ??= newShape();
      for (const item of Object.values(value).slice(0, 50)) addSample(shape.values, item);
      return shape;
    }
    shape.types.add("object");
    shape.objects++;
    for (const key of keys) {
      let field = shape.fields.get(key);
      if (!field) shape.fields.set(key, (field = { shape: newShape(), count: 0 }));
      field.count++;
      addSample(field.shape, value[key]);
    }
  } else shape.types.add(typeof value);
  return shape;
}

export function inferShape(samples) {
  const shape = newShape();
  for (const sample of samples) addSample(shape, sample);
  return shape;
}

/** Fields missing from some samples render as optional (`key?:`). */
export function renderShape(shape, { depth = 3, maxKeys = 12, pretty = false } = {}, level = 0) {
  const parts = [...shape.types].map((type) => {
    if (type === "array") {
      const inner = shape.items?.types.size ? renderShape(shape.items, { depth, maxKeys, pretty }, level) : "unknown";
      return /[|&]/.test(inner) && !inner.startsWith("{") ? `(${inner})[]` : `${inner}[]`;
    }
    if (type === "record") return `Record<string, ${renderShape(shape.values, { depth, maxKeys, pretty }, level + 1)}>`;
    if (type !== "object") return type;
    if (level >= depth) return "{…}";
    const entries = [...shape.fields].slice(0, maxKeys).map(([key, field]) => {
      const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      const optional = field.count < shape.objects ? "?" : "";
      return `${name}${optional}: ${renderShape(field.shape, { depth, maxKeys, pretty }, level + 1)}`;
    });
    if (shape.fields.size > maxKeys) entries.push(`…${shape.fields.size - maxKeys} more`);
    if (entries.length === 0) return "{}";
    if (!pretty) return `{ ${entries.join("; ")} }`;
    const pad = "  ".repeat(level + 1);
    return `{\n${entries.map((entry) => `${pad}${entry};`).join("\n")}\n${"  ".repeat(level)}}`;
  });
  return parts.join(" | ") || "unknown";
}

// ---------- secrets ----------

export function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0].startsWith("eyJ")) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function relative(ms) {
  const abs = Math.abs(ms);
  const text = abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 172_800_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return ms < 0 ? `${text} before capture` : `${text} after capture`;
}

/**
 * Where a value was shipped to the browser: "Script" or "Document", else undefined.
 * A value inside static JS reached every visitor, so it is app config (Algolia search keys,
 * Firebase apiKey, client ids), not a session secret, and is shown in clear. HTML can be
 * per-user, so values found only there stay masked with a hint. JWTs are never revealed.
 */
export function pageSourceCheck(entries) {
  const bodies = entries
    .filter((e) => e._resourceType === "Script" || e._resourceType === "Document")
    .map((e) => [e._resourceType, bodyText(e.response?.content) ?? ""])
    .filter(([, body]) => body);
  const cache = new Map();
  return (value) => {
    if (value.length < 8 || decodeJwt(value)) return undefined;
    if (!cache.has(value)) {
      const hit = bodies.find(([type, body]) => type === "Script" && body.includes(value)) ?? bodies.find(([, body]) => body.includes(value));
      cache.set(value, hit?.[0]);
    }
    return cache.get(value);
  };
}

/** Describe a header/param value without revealing secrets. `atMs` is the capture time, for JWT expiry. */
export function describeValue(name, value, atMs, pageSource = () => undefined) {
  const bearer = /^(Bearer|Token|Basic)\s+(.+)$/i.exec(value);
  const token = bearer ? bearer[2] : value;
  const prefix = bearer ? `${bearer[1]} ` : "";
  const jwt = decodeJwt(token);
  const source = pageSource(token);
  if (source === "Script") return `${value} (public: in page JS)`;
  if (jwt) return `${prefix}<JWT${typeof jwt.exp === "number" ? `, exp ${new Date(jwt.exp * 1000).toISOString()} (${relative(jwt.exp * 1000 - atMs)})` : ", no exp"}>`;
  if (bearer || SECRET_NAME.test(name) || OPAQUE_VALUE.test(value)) {
    return `${prefix}<masked, ${token.length} chars${source === "Document" ? ", in page HTML" : ""}>`;
  }
  return truncate(value, 60);
}

function maskDeep(value, pageSource = () => undefined) {
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, pageSource));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        typeof v === "string" && SECRET_NAME.test(key) && pageSource(v) !== "Script" ? `<masked, ${v.length} chars>` : maskDeep(v, pageSource),
      ]),
    );
  }
  if (typeof value === "string" && decodeJwt(value)) return "<JWT>";
  return value;
}

// ---------- HAR parsing ----------

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value;
}

function bodyText(content) {
  if (!content?.text) return undefined;
  return content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
}

function parseJson(text) {
  if (!text || !/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ponytail: naive eTLD+1 (knows co.uk-style SLDs only); swap in a public-suffix list if it misgroups a site.
export function baseDomain(host) {
  const parts = host.split(".");
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1))) return host;
  const n = /^(co|com|net|org|gov|edu|ac)$/.test(parts.at(-2)) && parts.at(-1).length === 2 ? 3 : 2;
  return parts.slice(-n).join(".");
}

function classify(entry, site) {
  const url = new URL(entry.request.url);
  const type = entry._resourceType ?? "";
  const mime = entry.response?.content?.mimeType ?? "";
  if (!/^https?:$/.test(url.protocol) || entry.request.method === "OPTIONS") return "skip";
  const firstParty = baseDomain(url.hostname) === site;
  // PostHog is often reverse-proxied through an arbitrary first-party path; its query signature survives.
  const posthog = url.searchParams.has("ver") && /^(gzip-js|base64)$/.test(url.searchParams.get("compression") ?? "");
  if ((!firstParty && NOISE_HOST.test(url.hostname)) || NOISE_SUBDOMAIN.test(url.hostname) || NOISE_PATH.test(url.pathname) || posthog || type === "Ping") {
    return "noise";
  }
  if (type === "Document" || (!type && /html/.test(mime) && entry.request.method === "GET")) return "document";
  if (IGNORED_TYPES.test(type)) return "skip";
  if (API_TYPES.test(type) || API_MIME.test(mime)) return "api";
  return "skip";
}

/** An RPC-style discriminator so one URL serving many operations splits into one endpoint each. */
function operationOf(request, body) {
  const url = new URL(request.url);
  const action = header(request.headers, "next-action");
  if (action) return `server-action ${action.slice(0, 12)}`;
  const ops = (Array.isArray(body) ? body : [body ?? Object.fromEntries(url.searchParams)])
    .map((op) => {
      if (!op || typeof op !== "object") return undefined;
      if (typeof op.operationName === "string" && op.operationName) return op.operationName;
      if (typeof op.query === "string" && /^\s*(query|mutation|subscription|fragment|\{)/.test(op.query)) {
        return /^\s*(?:query|mutation|subscription)\s+(\w+)/.exec(op.query)?.[1] ?? "anonymous";
      }
      if (op.jsonrpc && typeof op.method === "string") return op.method;
      return undefined;
    })
    .filter(Boolean);
  return ops.length ? `op=${ops.join("+")}` : "";
}

function leaves(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value)) leaves(v, prefix ? `${prefix}.${key}` : key, out);
  } else if (prefix) out.set(prefix, JSON.stringify(value));
  return out;
}

function formParams(text) {
  return [...new URLSearchParams(text)].map(([name, value]) => ({ name, value }));
}

export function analyze(entries, { all = false } = {}) {
  // The site is whatever the pages were on: documents, plus the Referer of every call, which
  // covers SPA recordings that never navigate after capture starts.
  const hostCounts = new Map();
  for (const entry of entries) {
    const isDocument = entry._resourceType === "Document" || /html/.test(entry.response?.content?.mimeType ?? "");
    for (const raw of [isDocument ? entry.request.url : undefined, header(entry.request.headers, "referer")]) {
      if (!raw) continue;
      try {
        const base = baseDomain(new URL(raw).hostname);
        hostCounts.set(base, (hostCounts.get(base) ?? 0) + 1);
      } catch {}
    }
  }
  const site = [...hostCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  const api = [];
  const documents = [];
  const noise = new Map();
  for (const entry of entries) {
    let kind;
    try {
      kind = classify(entry, site);
    } catch {
      continue;
    }
    if (all && kind === "noise") kind = "api";
    if (kind === "api") api.push(entry);
    else if (kind === "document") documents.push(entry);
    else if (kind === "noise") {
      const host = new URL(entry.request.url).hostname;
      noise.set(host, (noise.get(host) ?? 0) + 1);
    }
  }

  const pageSource = pageSourceCheck(entries);
  const templated = templatePaths(api.map((entry) => new URL(entry.request.url).pathname));
  const groups = new Map();
  for (const entry of api) {
    const url = new URL(entry.request.url);
    const text = entry.request.postData?.text;
    const body = parseJson(text);
    const path = templated.get(url.pathname);
    const op = operationOf(entry.request, body);
    const key = [entry.request.method, `${url.origin}${path}`, op].filter(Boolean).join(" ");
    let group = groups.get(key);
    if (!group) {
      groups.set(key, (group = { method: entry.request.method, origin: url.origin, path, op, firstParty: baseDomain(url.hostname) === site, entries: [] }));
    }
    group.entries.push(entry);
  }

  const endpoints = [...groups.values()]
    .sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || a.entries[0].startedDateTime.localeCompare(b.entries[0].startedDateTime))
    .map((group, i) => summarizeGroup(group, i + 1, pageSource));

  return { site, endpoints, documents: summarizeDocuments(documents), noise, headers: summarizeHeaders(api, pageSource) };
}

function summarizeGroup(group, index, pageSource) {
  const params = new Map();
  const pathValues = new Map();
  const requestBodies = [];
  const bodyLeaves = new Map(); // "variables.q" -> Set of JSON-encoded values; the POST twin of query-param variance
  const responses = [];
  const statuses = new Map();
  const mimes = new Set();
  const templateParts = group.path.split("/");

  for (const entry of group.entries) {
    const url = new URL(entry.request.url);
    url.pathname.split("/").forEach((segment, i) => {
      if (templateParts[i]?.startsWith("{")) pathValues.set(i, new Set([...(pathValues.get(i) ?? []), segment]));
    });
    const text = entry.request.postData?.text;
    const body = parseJson(text); // checked first: some APIs send JSON as form-urlencoded to skip CORS preflight
    const form = body === undefined && /x-www-form-urlencoded/.test(entry.request.postData?.mimeType ?? "") ? formParams(text ?? "") : [];
    for (const { name, value } of [...(entry.request.queryString ?? []), ...form]) {
      const param = params.get(name) ?? { values: new Set(), count: 0 };
      param.values.add(value);
      param.count++;
      params.set(name, param);
    }
    if (body !== undefined) {
      requestBodies.push(body);
      for (const [name, value] of leaves(body)) bodyLeaves.set(name, new Set([...(bodyLeaves.get(name) ?? []), value]));
    }
    else if (text && !form.length) requestBodies.push(`<${entry.request.postData?.mimeType || "body"}, ${text.length} chars>`);

    const status = entry.response?.status ?? 0;
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    const mime = (entry.response?.content?.mimeType ?? "").split(";")[0];
    if (mime) mimes.add(mime);
    const json = parseJson(bodyText(entry.response?.content));
    if (json !== undefined && status < 400) responses.push(json);
  }

  // A templated segment that held one value across several calls is a constant (e.g. an API version).
  const constant = (i) => group.entries.length > 1 && pathValues.get(i)?.size === 1;
  const path = templateParts.map((part, i) => (constant(i) ? [...pathValues.get(i)][0] : part)).join("/");
  const at = Date.parse(group.entries[0].startedDateTime) || Date.now();
  return {
    index,
    key: [group.method, `${group.origin}${path}`, group.op].filter(Boolean).join(" "),
    method: group.method,
    url: `${group.origin}${path}`,
    firstParty: group.firstParty,
    calls: group.entries.length,
    statuses,
    mimes,
    pageSource,
    pathValues: [...pathValues].filter(([i]) => !constant(i)).map(([i, values]) => ({ segment: templateParts[i], values: [...values] })),
    params: [...params].map(([name, { values, count }]) => ({
      name,
      optional: count < group.entries.length,
      varies: values.size > 1,
      cacheBuster: CACHE_BUSTER.test(name),
      values: [...values].map((value) => describeValue(name, value, at, pageSource)),
    })),
    bodyVaries: [...bodyLeaves]
      .filter(([, values]) => values.size > 1)
      .map(([name, values]) => ({ name, values: [...values].map((value) => describeValue(name.split(".").at(-1), value, at, pageSource)) })),
    requestShape: requestBodies.some((b) => typeof b !== "string") ? inferShape(requestBodies.filter((b) => typeof b !== "string")) : null,
    requestNote: requestBodies.find((b) => typeof b === "string"),
    responseShape: responses.length ? inferShape(responses) : null,
    responseSamples: responses.length,
    entries: group.entries,
  };
}

function summarizeHeaders(api, pageSource) {
  const byName = new Map();
  for (const entry of api) {
    const at = Date.parse(entry.startedDateTime) || Date.now();
    for (const { name, value } of entry.request.headers ?? []) {
      const lower = name.toLowerCase();
      if (BROWSER_HEADERS.has(lower) || lower.startsWith("sec-") || lower.startsWith(":")) continue;
      const seen = byName.get(lower) ?? { name: lower, values: new Set(), calls: 0, described: describeValue(lower, value, at, pageSource) };
      seen.values.add(value);
      seen.calls++;
      byName.set(lower, seen);
    }
  }
  return [...byName.values()].sort((a, b) => b.calls - a.calls);
}

function summarizeDocuments(documents) {
  return documents
    .map((entry) => {
      const html = bodyText(entry.response?.content) ?? "";
      const markers = EMBEDDED_DATA.filter(([, pattern]) => pattern.test(html)).map(([label]) => label);
      return { url: entry.request.url, status: entry.response?.status, markers };
    })
    .filter((doc) => doc.markers.length);
}

// ---------- output ----------

function formatStatuses(statuses) {
  return [...statuses].map(([status, count]) => (count > 1 ? `${status}×${count}` : String(status))).join(" ");
}

export function formatSummary(result, meta) {
  const lines = [`${meta.files.join(", ")}: ${meta.entries} requests, site ${result.site || "(unknown)"}`, ""];

  if (result.endpoints.length === 0) lines.push("No API calls found.", "");
  else lines.push(`Endpoints (${result.endpoints.length}):`);
  for (const ep of result.endpoints) {
    const where = ep.firstParty ? "" : "  [third-party]";
    lines.push(`[${ep.index}] ${ep.key}  ×${ep.calls}  ${formatStatuses(ep.statuses)}  ${[...ep.mimes].join(",")}${where}`);
    for (const { segment, values } of ep.pathValues) lines.push(`    path ${segment}: ${values.slice(0, 4).map((v) => truncate(v, 32)).join(", ")}`);
    if (ep.params.length) {
      const text = ep.params.map((p) =>
        p.cacheBuster
          ? `${p.name}~(cache-buster: omit or regenerate)`
          : `${p.name}${p.optional ? "?" : ""}${p.varies ? "~" : "="}${p.values.slice(0, 3).map((v) => truncate(v, 24)).join("|")}`,
      );
      lines.push(`    params: ${text.join("  ")}`);
    }
    if (ep.requestShape) lines.push(`    body: ${truncate(renderShape(ep.requestShape, { depth: 2, maxKeys: 8 }), 240)}`);
    if (ep.bodyVaries.length) lines.push(`    body varies: ${ep.bodyVaries.map((f) => `${f.name}~${f.values.slice(0, 3).map((v) => truncate(v, 24)).join("|")}`).join("  ")}`);
    else if (ep.requestNote) lines.push(`    body: ${ep.requestNote}`);
    if (ep.responseShape) lines.push(`    returns: ${truncate(renderShape(ep.responseShape, { depth: 2, maxKeys: 10 }), 300)}`);
  }
  if (result.endpoints.length) lines.push("    (params: name=constant, name~varies, name? optional)", "");

  if (result.headers.length) {
    lines.push("Non-browser request headers on API calls (replay candidates; test each by omission):");
    for (const h of result.headers) {
      const variance = h.values.size > 1 ? `varies (${h.values.size} distinct)` : "constant";
      lines.push(`  ${h.name}: ${h.described}  on ${h.calls} calls, ${variance}`);
    }
    lines.push("");
  }
  lines.push("Cookie headers are not recorded by agent-browser: export them with browser_cookies.", "");

  if (result.documents.length) {
    lines.push("Pages with embedded data (a client can GET the HTML and parse it):");
    for (const doc of result.documents.slice(0, 10)) lines.push(`  ${doc.status} ${doc.url}  ${doc.markers.join(", ")}`);
    lines.push("");
  }

  if (result.noise.size) {
    const hosts = [...result.noise].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([host, count]) => `${host}×${count}`);
    lines.push(`Filtered as noise: ${hosts.join(", ")}${result.noise.size > 6 ? ", …" : ""}  (--all to include)`);
  }
  return lines.join("\n");
}

export function formatDetail(ep) {
  const sample = ep.entries.find((entry) => (entry.response?.status ?? 0) < 400) ?? ep.entries[0];
  const at = Date.parse(sample.startedDateTime) || Date.now();
  const lines = [`[${ep.index}] ${ep.key}  ×${ep.calls}  ${formatStatuses(ep.statuses)}  ${[...ep.mimes].join(",")}`, ""];

  lines.push("Sample request (secrets masked):", `  ${sample.request.method} ${maskUrl(sample.request.url, at, ep.pageSource)}`);
  for (const { name, value } of sample.request.headers ?? []) {
    const lower = name.toLowerCase();
    if (lower.startsWith("sec-ch-") || lower === "user-agent") continue;
    const clear = BROWSER_HEADERS.has(lower) && !SECRET_NAME.test(lower);
    lines.push(`  ${lower}: ${clear ? value : describeValue(lower, value, at, ep.pageSource)}`);
  }
  const text = sample.request.postData?.text;
  if (text) {
    const json = parseJson(text);
    lines.push("", "  body:", indent(truncate(json === undefined ? text : JSON.stringify(maskDeep(json, ep.pageSource), null, 2), 2000), 4));
  }

  for (const { segment, values } of ep.pathValues) lines.push("", `Path ${segment} values: ${values.join(", ")}`);
  if (ep.params.length) {
    lines.push("", "Params:");
    for (const p of ep.params) lines.push(`  ${p.name}${p.optional ? " (optional)" : ""}: ${p.varies ? "varies" : "constant"}  ${p.values.join(" | ")}`);
  }
  if (ep.bodyVaries.length) {
    lines.push("", "Body fields that varied between calls (the inputs; everything else was constant):");
    for (const f of ep.bodyVaries) lines.push(`  ${f.name}: ${f.values.join(" | ")}`);
  }
  if (ep.requestShape) lines.push("", "Request body type:", indent(renderShape(ep.requestShape, { depth: 6, maxKeys: 60, pretty: true }), 2));
  if (ep.responseShape) {
    lines.push("", `Response type (merged over ${ep.responseSamples} sample${ep.responseSamples === 1 ? "" : "s"}; optional = missing in some):`);
    lines.push(indent(renderShape(ep.responseShape, { depth: 6, maxKeys: 60, pretty: true }), 2));
  }
  const body = bodyText(sample.response?.content);
  const json = parseJson(body);
  lines.push("", `Sample response (${sample.response?.status}, ${sample.response?.content?.mimeType || "no type"}):`);
  if (json !== undefined) lines.push(indent(truncate(JSON.stringify(maskDeep(json, ep.pageSource), null, 2), 3000), 2));
  else lines.push(body ? indent(truncate(body, 1500), 2) : "  (body not recorded; re-record with browser_har content 'text' or 'all')");
  const redirect = sample.response?.redirectURL;
  if (redirect) lines.push(`  redirect → ${redirect}`);
  return lines.join("\n");
}

function maskUrl(raw, at, pageSource) {
  const url = new URL(raw);
  for (const [name, value] of [...url.searchParams]) {
    if (pageSource(value) === "Script") continue;
    if (SECRET_NAME.test(name) || OPAQUE_VALUE.test(value) || decodeJwt(value)) url.searchParams.set(name, describeValue(name, value, at, pageSource));
  }
  try {
    return decodeURI(url.href);
  } catch {
    return url.href;
  }
}

function indent(text, spaces) {
  return text.replace(/^/gm, " ".repeat(spaces));
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { show: { type: "string" }, all: { type: "boolean", default: false } },
  });
  if (positionals.length === 0) {
    console.error(`Usage: node ${process.argv[1]} <file.har> [more.har…] [--show <n|url-regex>] [--all]`);
    process.exit(2);
  }
  const entries = positionals.flatMap((file) => JSON.parse(readFileSync(file, "utf8")).log?.entries ?? []);
  const result = analyze(entries, { all: values.all });
  if (values.show === undefined) {
    console.log(formatSummary(result, { files: positionals, entries: entries.length }));
    return;
  }
  const matches = /^\d+$/.test(values.show)
    ? result.endpoints.filter((ep) => ep.index === Number(values.show))
    : result.endpoints.filter((ep) => new RegExp(values.show, "i").test(ep.key));
  if (matches.length === 0) {
    console.error(`No endpoint matches ${values.show}. Run without --show to list them.`);
    process.exit(1);
  }
  console.log(matches.map(formatDetail).join(`\n\n${"─".repeat(60)}\n\n`));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
