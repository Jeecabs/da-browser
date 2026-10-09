import {
  auditAccessibility,
  checkpointBrowserPage,
  clickBrowserElement,
  connectBrowser,
  debugBrowserPage,
  evalInBrowser,
  exportCookies,
  fillBrowserElement,
  findBrowserElement,
  getBrowserInfo,
  harBrowser,
  isBrowserState,
  navigateBrowser,
  openBrowserPage,
  pressBrowserKey,
  reactBrowser,
  readBrowserContent,
  recordBrowser,
  runBrowserCommand,
  scrollBrowserPage,
  selectBrowserOption,
  setBrowser,
  snapshotBrowserPage,
  tabBrowser,
  traceBrowser,
  verifyConnection,
  vitalsBrowser,
  waitInBrowser,
  type BrowserActionResult,
} from "./agent-browser.ts";
import { prepareCompatArguments } from "./extension-utils.ts";
import type { BrowserHost } from "./host.ts";
import { browserSummaryWithVersion, resolveBrowserPort, type BrowserState } from "./state.ts";

// The browser tools, once, for both hosts: pi registers them in index.ts, the Claude Code
// mod in hooks/register.tsx. Plain JSON schema, so neither typebox nor Node is needed here.

type Input = Record<string, any>;

export interface BrowserToolSpec {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  compat?: Parameters<typeof prepareCompatArguments>[1];
  /** Input fixes beyond compat, applied after it. */
  prepare?(args: Input): Input;
  run(host: BrowserHost, state: BrowserState, input: Input): Promise<BrowserActionResult>;
}

/** Compat aliases and string coercion, then the tool's own fixes: the same in both hosts. */
export function prepareBrowserInput(spec: BrowserToolSpec, args: unknown): Input {
  const prepared = spec.compat ? prepareCompatArguments<Input>(args, spec.compat) : (args as Input);
  return spec.prepare ? spec.prepare(prepared) : prepared;
}

export const BROWSER_GUIDELINES = [
  "Element refs (@eN) come from snapshots. Elements that survive a same-document update keep their refs; a replaced element or a navigation invalidates them. Re-snapshot after navigation, or when an action on a ref fails.",
  "Prefer browser_find when the target has a role, label, text, placeholder, alt, title or testid; it saves a snapshot round-trip. It always performs its action; to look without acting, use browser_snapshot or browser_get.",
  "After browser_open, browser_nav or a submission the page is mid-load. Rely on waitMode networkidle (the default), or follow up with browser_wait on text, urlPattern, load or fn rather than plain milliseconds.",
  "This is the user's own signed-in browser: never perform mutations the user did not ask for.",
  "For quick churn that needs no login, such as checking local dev pages or public sites, browser_connect engine=obscura switches to a fast headless browser that is signed out. browser_connect without engine switches back to the user's browser.",
  "On tab_gone, strict isolation worked: the pinned tab closed and no other tab was adopted. Recover explicitly with browser_tab new, browser_tab list then switch by targetId, or browser_connect; do not retry blindly.",
];

const WAIT_MODE = { type: "string", enum: ["none", "load", "networkidle"] };
const REF = { type: "string", description: "Interactive element ref like @e12 or e12" };
const LABEL = { type: "string", description: "Optional artifact label for saved output" };

export const BROWSER_TOOLS: BrowserToolSpec[] = [
  {
    name: "browser_status",
    label: "Browser Status",
    description:
      "Probe agent-browser compatibility, live CDP state, and the known strict session-to-tab binding (session, targetId, tab_gone metadata). It actively probes the port, so trust it over assumptions about connection state.",
    promptSnippet: "Inspect the browser automation state before continuing a multi-step dashboard task",
    parameters: { type: "object", properties: {} },
    async run(host, state) {
      const probe = await verifyConnection(host, state).catch(() => undefined);
      return { summary: browserSummaryWithVersion(state, probe), diagnostics: { probe } };
    },
  },
  {
    name: "browser_connect",
    label: "Browser Connect",
    description:
      "Connect a strictly tab-pinned agent-browser session to Arc or Chromium using a smart-default remote debugging port. Use it before dashboard automation when the browser has not been connected in this session. engine=obscura switches every browser tool to a headless Obscura browser instead.",
    promptSnippet: "Connect browser automation to the user's existing authenticated browser session",
    parameters: {
      type: "object",
      properties: {
        port: { type: "number", description: "Optional remote debugging port. Defaults to PI_BROWSER_PORT or 9222." },
        engine: {
          type: "string",
          enum: ["arc", "obscura"],
          description:
            "arc (default): the user's signed-in browser. obscura: a fast headless browser with no cookies or logins and gaps in accessibility and screenshot fidelity, for quick checks on local dev or public pages.",
        },
      },
    },
    compat: { aliases: { debugPort: "port" }, numberFields: ["port"] },
    run(host, state, input) {
      state.engine = input.engine === "obscura" ? "obscura" : undefined;
      if (typeof input.port === "number") state.port = resolveBrowserPort(input.port);
      return connectBrowser(host, state);
    },
  },
  {
    name: "browser_open",
    label: "Browser Open",
    description:
      "Open a URL in agent-browser and optionally wait for the page to settle. For React/Next.js debugging, set enableReactDevtools=true, then use browser_react.",
    promptSnippet: "Open a dashboard or app URL before interacting with it",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to open" },
        waitMode: WAIT_MODE,
        enableReactDevtools: {
          type: "boolean",
          description: "Inject the React DevTools hook before this navigation so browser_react commands work on the page",
        },
      },
      required: ["url"],
    },
    compat: {
      aliases: { reactDevtools: "enableReactDevtools", react: "enableReactDevtools" },
      booleanFields: ["enableReactDevtools"],
    },
    run: (host, state, input) =>
      openBrowserPage(host, state, input.url, input.waitMode ?? "networkidle", { enableReactDevtools: input.enableReactDevtools }),
  },
  {
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Capture a page snapshot, defaulting to interactive elements only. Scope with selector or depth on heavy SPAs, and set delta=true when re-snapshotting the same page to get only the changes.",
    promptSnippet: "Inspect the current page and collect fresh element refs before clicking or filling",
    parameters: {
      type: "object",
      properties: {
        interactiveOnly: { type: "boolean", description: "Capture only interactive elements", default: true },
        includeUrls: { type: "boolean", description: "Include href URLs on link elements" },
        compact: { type: "boolean", description: "Remove empty structural elements" },
        depth: { type: "number", description: "Limit accessibility tree depth" },
        selector: { type: "string", description: "Scope snapshot to a CSS selector subtree" },
        delta: {
          type: "boolean",
          description: "Return only what changed since the last snapshot with the same options (refs stay valid)",
        },
        full: { type: "boolean", description: "With delta, force a full tree and reset the baseline" },
        label: { type: "string", description: "Optional artifact label" },
      },
    },
    compat: {
      aliases: { interactive: "interactiveOnly", urls: "includeUrls", scope: "selector", css: "selector", maxDepth: "depth" },
      booleanFields: ["interactiveOnly", "includeUrls", "compact", "delta", "full"],
      numberFields: ["depth"],
    },
    run: (host, state, input) =>
      snapshotBrowserPage(host, state, input.interactiveOnly ?? true, input.label ?? "snapshot", {
        urls: input.includeUrls,
        compact: input.compact,
        depth: input.depth,
        selector: input.selector,
        delta: input.delta,
        full: input.full,
      }),
  },
  {
    name: "browser_read",
    label: "Browser Read",
    description:
      "Fetch agent-readable text from a URL with markdown/llms.txt-aware fallbacks, or read the rendered active browser tab when url is omitted. Use it for docs, articles, and text pages: a URL read needs no browser_connect, and a tab read keeps auth and client state.",
    promptSnippet: "Read docs, articles, or active-page text through agent-browser's read command",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch. Omit to read the rendered active browser tab." },
        filter: { type: "string", description: "Narrow matching heading sections, llms links/sections, or outline headings" },
        outline: { type: "boolean", description: "Return a compact heading outline for one page" },
        llms: { type: "string", enum: ["index", "full"] },
        requireMd: { type: "boolean", description: "Fail unless the server returns markdown" },
        raw: { type: "boolean", description: "Return the raw response body without HTML extraction" },
        json: { type: "boolean", description: "Return structured metadata instead of only content" },
        timeoutMs: { type: "number", description: "Request timeout in milliseconds" },
        maxOutput: { type: "number", description: "Maximum output characters before agent-browser truncates" },
        allowedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Allowed domain patterns for explicit URL reads only, e.g. example.com or *.example.com",
        },
        contentBoundaries: { type: "boolean", description: "Wrap page output in boundary markers" },
        label: LABEL,
      },
    },
    compat: {
      aliases: { href: "url", timeout: "timeoutMs", requireMarkdown: "requireMd", domains: "allowedDomains" },
      booleanFields: ["outline", "requireMd", "raw", "json", "contentBoundaries"],
      numberFields: ["timeoutMs", "maxOutput"],
    },
    prepare: (args) =>
      typeof args.allowedDomains === "string"
        ? { ...args, allowedDomains: args.allowedDomains.split(",").map((entry: string) => entry.trim()).filter(Boolean) }
        : args,
    run: (host, state, input) => readBrowserContent(host, state, input),
  },
  {
    name: "browser_click",
    label: "Browser Click",
    description: "Click an interactive element by its @ref and optionally resnapshot afterward",
    promptSnippet: "Click a specific interactive element ref from the latest browser snapshot",
    parameters: {
      type: "object",
      properties: {
        ref: REF,
        waitMode: WAIT_MODE,
        resnapshot: { type: "boolean", description: "Capture a fresh interactive snapshot after clicking", default: true },
        human: {
          type: "boolean",
          description: "Approach along a curved, eased pointer path even when DA_BROWSER_INPUT_MODE is instant; the default mode already does",
        },
      },
      required: ["ref"],
    },
    compat: {
      aliases: { element: "ref", selector: "ref", wait: "waitMode", reSnapshot: "resnapshot" },
      booleanFields: ["resnapshot", "human"],
    },
    run: (host, state, input) =>
      clickBrowserElement(host, state, input.ref, input.waitMode ?? "networkidle", input.resnapshot ?? true, input.human ?? false),
  },
  {
    name: "browser_find",
    label: "Browser Find",
    description:
      "Find an element by role/text/label/placeholder/alt/title/testid (or first/last/nth CSS) and perform an action on it in one step. Always acts — use browser_snapshot to inspect without acting.",
    promptSnippet:
      "Find an element by semantic locator (role, label, text, etc.) and click, fill, hover or check it in one call",
    parameters: {
      type: "object",
      properties: {
        locator: { type: "string", enum: ["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"] },
        value: { type: "string", description: "Role/text/label/placeholder/alt/title/testid value, or CSS selector for first/last/nth" },
        action: { type: "string", enum: ["click", "fill", "hover", "check"] },
        nthIndex: { type: "number", description: "0-based match index, required when locator is nth" },
        text: { type: "string", description: "Text to fill (action fill)" },
        name: { type: "string", description: "Accessible-name filter (role locator only)" },
        exact: { type: "boolean", description: "Require exact text/name match" },
        waitMode: WAIT_MODE,
        resnapshot: { type: "boolean", description: "Capture a fresh interactive snapshot after a mutating action", default: true },
      },
      required: ["locator", "value", "action"],
    },
    compat: {
      aliases: { role: "value", element: "value", index: "nthIndex" },
      booleanFields: ["exact", "resnapshot"],
      numberFields: ["nthIndex"],
    },
    run: (host, state, input) =>
      findBrowserElement(host, state, {
        locator: input.locator,
        value: input.value,
        action: input.action,
        nthIndex: input.nthIndex,
        text: input.text,
        name: input.name,
        exact: input.exact,
        waitMode: input.waitMode,
        resnapshot: input.resnapshot,
      }),
  },
  {
    name: "browser_fill",
    label: "Browser Fill",
    description: "Fill a browser input element by @ref",
    parameters: {
      type: "object",
      properties: { ref: REF, text: { type: "string", description: "Text to fill into the target input" }, waitMode: WAIT_MODE },
      required: ["ref", "text"],
    },
    compat: { aliases: { element: "ref", selector: "ref", value: "text", wait: "waitMode" } },
    run: (host, state, input) => fillBrowserElement(host, state, input.ref, input.text, input.waitMode ?? "none"),
  },
  {
    name: "browser_select",
    label: "Browser Select",
    description: "Select a value on a browser control by @ref",
    parameters: {
      type: "object",
      properties: { ref: REF, option: { type: "string", description: "Visible option text or value to select" }, waitMode: WAIT_MODE },
      required: ["ref", "option"],
    },
    compat: { aliases: { element: "ref", selector: "ref", value: "option", wait: "waitMode" } },
    run: (host, state, input) => selectBrowserOption(host, state, input.ref, input.option, input.waitMode ?? "none"),
  },
  {
    name: "browser_press",
    label: "Browser Press",
    description: "Press a browser key such as Enter, Tab, Escape, or Control+a",
    promptSnippet: "Press keyboard keys in the current browser page",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "Key to press, e.g. Enter, Tab, Escape, Control+a" }, waitMode: WAIT_MODE },
      required: ["key"],
    },
    compat: { aliases: { value: "key" } },
    run: (host, state, input) => pressBrowserKey(host, state, input.key, input.waitMode ?? "none"),
  },
  {
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the current page (or a scrollable container) up, down, left, or right",
    promptSnippet: "Scroll the browser page or a container to reveal more content",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        pixels: { type: "number", description: "Optional number of pixels to scroll" },
        containerSelector: { type: "string", description: "CSS selector of a scrollable container to scroll instead of the page" },
        waitMode: WAIT_MODE,
      },
      required: ["direction"],
    },
    compat: { aliases: { selector: "containerSelector", container: "containerSelector" }, numberFields: ["pixels"] },
    run: (host, state, input) =>
      scrollBrowserPage(host, state, input.direction, input.pixels, input.waitMode ?? "none", input.containerSelector),
  },
  {
    name: "browser_wait",
    label: "Browser Wait",
    description:
      "Wait for page state — a selector/ref (optionally reaching visible/hidden/detached), text appearing, a URL glob, a load state, a JS condition, or plain milliseconds. Pick exactly one mode.",
    promptSnippet: "Wait for browser page state (selector, text, URL pattern, load state, or JS condition) before continuing",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Selector or @ref to wait for" },
        state: { type: "string", enum: ["visible", "hidden", "attached", "detached"] },
        ms: { type: "number", description: "Plain time wait in milliseconds (last resort)" },
        text: { type: "string", description: "Wait until this text appears on the page (substring match)" },
        urlPattern: { type: "string", description: "Wait until the URL matches a glob like **/dashboard" },
        load: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] },
        fn: { type: "string", description: "Wait until this JS expression is truthy" },
        timeoutMs: { type: "number", description: "Wait timeout in milliseconds (default 25000)" },
      },
    },
    compat: {
      aliases: { target: "selector", ref: "selector", url: "urlPattern", timeout: "timeoutMs" },
      numberFields: ["ms", "timeoutMs"],
    },
    prepare(args) {
      // Legacy target form packed selectors and millisecond waits into one string field.
      if (typeof args.selector === "number") return { ...args, selector: undefined, ms: args.selector };
      if (typeof args.selector === "string" && /^\d+$/.test(args.selector.trim())) {
        return { ...args, selector: undefined, ms: Number(args.selector.trim()) };
      }
      return args;
    },
    run: (host, state, input) => waitInBrowser(host, state, input),
  },
  {
    name: "browser_nav",
    label: "Browser Navigation",
    description:
      "Navigate browser history, reload, or pushstate (SPA client-side navigation — auto-detects the Next.js router, no full page load)",
    promptSnippet: "Go back, forward, reload, or SPA-navigate the browser page",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["back", "forward", "reload", "pushstate"] },
        url: { type: "string", description: "Target URL/path, required when action is pushstate" },
        waitMode: WAIT_MODE,
      },
      required: ["action"],
    },
    run: (host, state, input) => navigateBrowser(host, state, input.action, input.waitMode ?? "networkidle", input.url),
  },
  {
    name: "browser_get",
    label: "Browser Get",
    description:
      "Read structured browser information such as text, html, value, attr, title, url, count, box, styles, or cdp-url",
    promptSnippet: "Extract browser text, URL, title, element value, attributes, counts, boxes, or styles",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["text", "html", "value", "attr", "title", "url", "count", "box", "styles", "cdp-url"] },
        selector: { type: "string", description: "Optional selector or @ref" },
        attrName: { type: "string", description: "Attribute name when what is attr" },
        label: LABEL,
      },
      required: ["what"],
    },
    compat: { aliases: { ref: "selector", attribute: "attrName", name: "attrName" } },
    run: (host, state, input) => getBrowserInfo(host, state, input.what, input.selector, input.attrName, input.label ?? "get"),
  },
  {
    name: "browser_debug",
    label: "Browser Debug",
    description:
      "Read browser console logs, page errors, or network requests (filterable by URL pattern, resource type, method, or status; network-request fetches one request's full detail by id)",
    promptSnippet: "Inspect browser console logs, page errors, or network requests for diagnostics",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["console", "errors", "network-requests", "network-request"] },
        clear: { type: "boolean", description: "Clear entries after reading when supported" },
        filter: { type: "string", description: "Network request URL filter pattern" },
        type: { type: "string", description: "Resource type filter, comma-separated (e.g. xhr,fetch,document)" },
        method: { type: "string", description: "HTTP method filter (e.g. POST)" },
        status: { type: "string", description: "Status filter (e.g. 200, 2xx, 400-499)" },
        requestId: { type: "string", description: "Request id for kind network-request" },
        label: LABEL,
      },
      required: ["kind"],
    },
    compat: { aliases: { id: "requestId" }, booleanFields: ["clear"] },
    run: (host, state, input) =>
      debugBrowserPage(host, state, input.kind, {
        clear: input.clear,
        filter: input.filter,
        type: input.type,
        method: input.method,
        status: input.status,
        requestId: input.requestId,
        label: input.label,
      }),
  },
  {
    name: "browser_command",
    label: "Browser Command",
    description:
      "Run a raw agent-browser command using structured args. The active CDP port is prepended automatically; do not include --cdp. alert and beforeunload dialogs are auto-accepted; answer confirm and prompt dialogs with ['dialog', 'accept'] or ['dialog', 'dismiss'].",
    promptSnippet: "Use any agent-browser CLI feature not covered by typed browser tools",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string", description: "agent-browser CLI argument" },
          description: "Argument array, e.g. ['press', 'Enter'] or ['tab', 'list']",
        },
        timeoutMs: { type: "number", description: "Timeout in milliseconds, clamped between 1000 and 300000" },
        label: LABEL,
      },
      required: ["args"],
    },
    compat: { numberFields: ["timeoutMs"] },
    run: (host, state, input) => runBrowserCommand(host, state, input.args, input.timeoutMs, input.label ?? "command"),
  },
  {
    name: "browser_eval",
    label: "Browser Eval",
    description: "Run JavaScript in the current page for structured extraction or page diagnostics",
    parameters: {
      type: "object",
      properties: { script: { type: "string", description: "JavaScript source to evaluate in the current page" }, label: LABEL },
      required: ["script"],
    },
    run: (host, state, input) => evalInBrowser(host, state, input.script, input.label ?? "eval"),
  },
  {
    name: "browser_tab",
    label: "Browser Tab",
    description:
      "List, open, close, or switch browser tabs. Use per-daemon ids (t1, t2, …), labels, or durable CDP targetIds from list; positional integers are not accepted. Use a targetId when a handle must survive a daemon restart.",
    promptSnippet: "Manage browser tabs when an action opens a popup or you need to coordinate across tabs",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "close", "switch"] },
        url: { type: "string", description: "URL to open when action is 'new'" },
        label: { type: "string", description: "Memorable label for the new tab (action 'new'), e.g. docs" },
        tab: { type: "string", description: "Tab id like t2, label, or durable CDP targetId for 'switch' (required) and 'close' (optional)" },
      },
      required: ["action"],
    },
    compat: { aliases: { index: "tab", id: "tab", tabId: "tab" } },
    // Old habits (and the pre-0.26 CLI) used numeric indices; stringify so the builder
    // can coerce digits to stable t-ids.
    prepare: (args) => (typeof args.tab === "number" ? { ...args, tab: String(args.tab) } : args),
    run: (host, state, input) => tabBrowser(host, state, { action: input.action, url: input.url, label: input.label, tab: input.tab }),
  },
  {
    name: "browser_is",
    label: "Browser Is",
    description:
      "Boolean assertions for visible/enabled/checked — returns structured details.result. Use it instead of regex-matching browser_get text.",
    promptSnippet: "Assert that a selector is visible/enabled/checked without parsing browser_get text",
    parameters: {
      type: "object",
      properties: {
        check: { type: "string", enum: ["visible", "enabled", "checked"] },
        selector: { type: "string", description: "CSS selector or @ref to test" },
      },
      required: ["check", "selector"],
    },
    compat: { aliases: { ref: "selector" } },
    run: (host, state, input) => isBrowserState(host, state, { check: input.check, selector: input.selector }),
  },
  {
    name: "browser_set",
    label: "Browser Set",
    description:
      "Configure browser settings: viewport (with optional retina scale), device emulation, geolocation, offline mode, media (color-scheme/reduced-motion), extra HTTP headers, or basic-auth credentials",
    promptSnippet: "Change viewport, device profile, geo, offline state, media preferences, headers, or credentials for the browser",
    parameters: {
      type: "object",
      properties: {
        setting: { type: "string", enum: ["viewport", "device", "geo", "offline", "media", "headers", "credentials"] },
        width: { type: "number", description: "Viewport width (required when setting='viewport')" },
        height: { type: "number", description: "Viewport height (required when setting='viewport')" },
        scale: { type: "number", description: "Device scale factor, e.g. 2 for retina (setting='viewport')" },
        device: { type: "string", description: "Device name (required when setting='device')" },
        latitude: { type: "number", description: "Latitude (required when setting='geo')" },
        longitude: { type: "number", description: "Longitude (required when setting='geo')" },
        offline: { type: "boolean", description: "Offline state (required when setting='offline')" },
        media: { type: "string", enum: ["dark", "light"] },
        reducedMotion: { type: "boolean", description: "Emulate prefers-reduced-motion: reduce" },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "Extra HTTP headers (setting='headers')" },
        username: { type: "string", description: "Basic-auth username (setting='credentials')" },
        password: { type: "string", description: "Basic-auth password (setting='credentials')" },
      },
      required: ["setting"],
    },
    compat: {
      aliases: { lat: "latitude", lng: "longitude", lon: "longitude", user: "username", pass: "password" },
      numberFields: ["width", "height", "scale", "latitude", "longitude"],
      booleanFields: ["offline", "reducedMotion"],
    },
    run: (host, state, input) =>
      setBrowser(host, state, {
        setting: input.setting,
        width: input.width,
        height: input.height,
        scale: input.scale,
        device: input.device,
        latitude: input.latitude,
        longitude: input.longitude,
        offline: input.offline,
        media: input.media,
        reducedMotion: input.reducedMotion,
        headers: input.headers,
        username: input.username,
        password: input.password,
      }),
  },
  {
    name: "browser_har",
    label: "Browser HAR",
    description:
      "Start or stop a HAR network capture. Text response bodies are embedded by default; all includes base64 binary bodies; none records metadata only. HARs can contain cookies, authorization headers, and response bodies: keep them temporary and inspect before sharing. They omit the Cookie request header; export session cookies with browser_cookies, never by printing them.",
    promptSnippet: "Capture browser network traffic and response bodies as a HAR artifact",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop"] },
        content: { type: "string", enum: ["text", "all", "none"] },
        label: { type: "string", description: "Label used for the .har artifact path" },
      },
      required: ["action"],
    },
    compat: { aliases: { mode: "content", bodyMode: "content" } },
    run: (host, state, input) => harBrowser(host, state, { action: input.action, content: input.content, label: input.label }),
  },
  {
    name: "browser_cookies",
    label: "Browser Cookies",
    description:
      "Export the controlled tab's cookies to a private JSON file (mode 600) for a derived HTTP client to load. Only cookies sent to the current page URL are included, so open the API's origin first. Values never enter context: the result lists names, scope, flags, and expiry.",
    promptSnippet: "Export session cookies to a private file without exposing their values",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Output file (~ expands). Defaults to the artifact dir. Keep it out of version control." },
        label: { type: "string", description: "Label for the default artifact path" },
      },
    },
    run: (host, state, input) => exportCookies(host, state, { path: input.path, label: input.label }),
  },
  {
    name: "browser_record",
    label: "Browser Record",
    description:
      "Start, restart, or stop video recording of the controlled tab for QA artifact capture. Start records the tab in place: no new tab or context, and refs stay valid. A hidden tab is brought to the front first, since Chrome does not paint background tabs and the video would freeze. Navigation is followed; switching tabs is not, so use restart to film another tab. cursor=true draws the pointer and click ripples into the video; contactSheet=true also saves a timestamped PNG summary that is far cheaper to inspect than the video; url films a cold page load from its first frame. A take left idle for an hour is lost with its daemon.",
    promptSnippet: "Capture a video of the page during a workflow for visual verification",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "restart"] },
        label: { type: "string", description: "Label used to name the recording file under artifactDir" },
        format: { type: "string", enum: ["webm", "mp4"] },
        fps: { type: "number", description: "Capture rate 1-60; 30 by default, 60 for motion-heavy takes" },
        cursor: { type: "boolean", description: "Render an animated pointer and click ripple into the video" },
        contactSheet: { type: "boolean", description: "Also save a timestamped PNG summary of the visual changes" },
        contactSheetThreshold: { type: "number", description: "Pixel-change ratio (0-1) that selects a sheet frame; implies contactSheet" },
        url: { type: "string", description: "Navigate the controlled tab here and start once it loads (start and restart)" },
      },
      required: ["action"],
    },
    compat: {
      aliases: { frameRate: "fps", sheet: "contactSheet", showCursor: "cursor" },
      booleanFields: ["cursor", "contactSheet"],
      numberFields: ["fps", "contactSheetThreshold"],
    },
    run: (host, state, input) =>
      recordBrowser(host, state, {
        action: input.action,
        label: input.label,
        format: input.format,
        fps: input.fps,
        cursor: input.cursor,
        contactSheet: input.contactSheet,
        contactSheetThreshold: input.contactSheetThreshold,
        url: input.url,
      }),
  },
  {
    name: "browser_trace",
    label: "Browser Trace",
    description: "Start or stop a Playwright-style trace (.zip) for the current browser context",
    promptSnippet: "Capture a Playwright trace bundle for diagnostics and replay",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop"] },
        label: { type: "string", description: "Label used to name the trace zip under artifactDir" },
      },
      required: ["action"],
    },
    run: (host, state, input) => traceBrowser(host, state, { action: input.action, label: input.label }),
  },
  {
    name: "browser_checkpoint",
    label: "Browser Checkpoint",
    description:
      "Save a screenshot plus an interactive snapshot for verification and recovery, after an important mutation. annotate=true overlays numbered labels keyed to @eN refs (for vision use) and includes the legend. In a loop, ifChanged=true and delta=true skip the unchanged screenshot and tree.",
    promptSnippet: "Capture a verification checkpoint after an important browser mutation",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short label describing what is being verified" },
        annotate: { type: "boolean", description: "Overlay numbered ref labels on the screenshot and include the legend" },
        ifChanged: { type: "boolean", description: "Skip writing the screenshot when the page looks identical to the last capture" },
        threshold: {
          type: "number",
          description: "Pixel-change ratio (0-1) below which the page counts as unchanged; implies ifChanged",
        },
        delta: { type: "boolean", description: "Return only the snapshot changes since the last checkpoint" },
      },
      required: ["label"],
    },
    compat: { booleanFields: ["annotate", "ifChanged", "delta"], numberFields: ["threshold"] },
    run: (host, state, input) =>
      checkpointBrowserPage(host, state, input.label, {
        annotate: input.annotate,
        ifChanged: input.ifChanged,
        threshold: input.threshold,
        delta: input.delta,
      }),
  },
  {
    name: "browser_react",
    label: "Browser React",
    description:
      "Inspect React internals on the current page: component tree, per-fiber props/hooks/state (inspect), re-render profiling (renders-start/renders-stop), or Suspense boundary classification (suspense). Requires the page to have been opened with browser_open enableReactDevtools=true. browser_vitals and browser_nav pushstate work on any page without the hook.",
    promptSnippet: "Inspect the React component tree, fiber props/hooks/state, re-render profile, or Suspense boundaries",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["tree", "inspect", "renders-start", "renders-stop", "suspense"] },
        fiberId: { type: "number", description: "Fiber id from react tree output (required for inspect)" },
        onlyDynamic: { type: "boolean", description: "Hide static boundaries in suspense output" },
        label: LABEL,
      },
      required: ["command"],
    },
    compat: { aliases: { id: "fiberId", fiber: "fiberId" }, numberFields: ["fiberId"], booleanFields: ["onlyDynamic"] },
    run: (host, state, input) =>
      reactBrowser(host, state, { command: input.command, fiberId: input.fiberId, onlyDynamic: input.onlyDynamic, label: input.label }),
  },
  {
    name: "browser_a11y",
    label: "Browser Accessibility",
    description:
      "Run an embedded axe-core accessibility audit on the active page or a URL, with optional WCAG tag filtering and selector scoping. Incomplete checks still need manual review.",
    promptSnippet: "Audit a page for accessibility violations and incomplete manual checks",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to and audit. Omit to audit the current page." },
        tags: { type: "array", items: { type: "string" }, description: "Axe/WCAG tags, e.g. wcag2a and wcag2aa" },
        selector: { type: "string", description: "CSS selector that scopes the audit to one subtree" },
        label: { type: "string", description: "Optional artifact label for a large report" },
      },
    },
    compat: { aliases: { href: "url", scope: "selector", wcagTags: "tags" } },
    prepare: (args) =>
      typeof args.tags === "string"
        ? { ...args, tags: args.tags.split(",").map((tag: string) => tag.trim()).filter(Boolean) }
        : args,
    run: (host, state, input) => auditAccessibility(host, state, input),
  },
  {
    name: "browser_vitals",
    label: "Browser Vitals",
    description:
      "Measure Core Web Vitals (LCP, CLS, TTFB, FCP, INP) plus React hydration timing for the current page or a given URL",
    promptSnippet: "Measure Core Web Vitals and hydration timing for performance diagnostics",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL to measure (omit to measure the current page)" } },
    },
    run: (host, state, input) => vitalsBrowser(host, state, input.url),
  },
];
