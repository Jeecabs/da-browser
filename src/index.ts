import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import {
  checkpointBrowserPage,
  cleanupBrowserArtifacts,
  clickBrowserElement,
  connectBrowser,
  evalInBrowser,
  fillBrowserElement,
  findBrowserElement,
  debugBrowserPage,
  getBrowserInfo,
  isBrowserState,
  navigateBrowser,
  openBrowserPage,
  pressBrowserKey,
  reactBrowser,
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
  CdpError,
  type BrowserActionResult,
  type BrowserGetWhat,
  type CaptureAction,
  type FindAction,
  type IsCheck,
  type ReactCommand,
  type SetSetting,
  type TabAction,
  type WaitArgsOptions,
} from "./agent-browser.js";
import {
  browserStatusText,
  browserSummary,
  connectionGlyph,
  connectionHealth,
  createBrowserState,
  mergeBrowserState,
  resolveBrowserPort,
  serializeBrowserState,
  type BrowserState,
  type WaitMode,
} from "./state.js";
import { prepareCompatArguments } from "./extension-utils.js";
import { renderCompactToolResult } from "./compact-tool-renderer.js";

const WAIT_MODE_SCHEMA = StringEnum(["none", "load", "networkidle"] as const);
const SCROLL_DIRECTION_SCHEMA = StringEnum(["up", "down", "left", "right"] as const);
const NAV_ACTION_SCHEMA = StringEnum(["back", "forward", "reload", "pushstate"] as const);
const BROWSER_GET_SCHEMA = StringEnum([
  "text",
  "html",
  "value",
  "attr",
  "title",
  "url",
  "count",
  "box",
  "styles",
  "cdp-url",
] as const);
const BROWSER_DEBUG_SCHEMA = StringEnum(["console", "errors", "network-requests", "network-request"] as const);
const BROWSER_FIND_LOCATOR_SCHEMA = StringEnum([
  "role",
  "text",
  "label",
  "placeholder",
  "alt",
  "title",
  "testid",
  "first",
  "last",
  "nth",
] as const);
const BROWSER_FIND_ACTION_SCHEMA = StringEnum(["click", "fill", "type", "hover", "focus", "check", "uncheck"] as const);
const BROWSER_TAB_ACTION_SCHEMA = StringEnum(["list", "new", "close", "switch"] as const);
const BROWSER_IS_CHECK_SCHEMA = StringEnum(["visible", "enabled", "checked"] as const);
const BROWSER_SET_SETTING_SCHEMA = StringEnum([
  "viewport",
  "device",
  "geo",
  "offline",
  "media",
  "headers",
  "credentials",
] as const);
const BROWSER_SET_MEDIA_SCHEMA = StringEnum(["dark", "light"] as const);
const BROWSER_CAPTURE_ACTION_SCHEMA = StringEnum(["start", "stop"] as const);
const BROWSER_WAIT_LOAD_SCHEMA = StringEnum(["load", "domcontentloaded", "networkidle"] as const);
const BROWSER_WAIT_STATE_SCHEMA = StringEnum(["visible", "hidden", "attached", "detached"] as const);
const BROWSER_REACT_COMMAND_SCHEMA = StringEnum([
  "tree",
  "inspect",
  "renders-start",
  "renders-stop",
  "suspense",
] as const);
const CUSTOM_STATE_TYPE = "browser-ops-state";

const BROWSER_GUIDELINES = [
  "Browser element refs (@eN) come from the most recent snapshot and become stale after any DOM mutation. Re-snapshot or use browser_find after navigation, click, or fill.",
  "Prefer browser_find over snapshot+click when the target is described by role, label, text, placeholder, alt, title, or testid — it avoids a snapshot round-trip. browser_find ALWAYS performs its action; to inspect without acting, use browser_snapshot or browser_get.",
  "For heavy SPAs, scope browser_snapshot with selector (CSS subtree) or depth to keep context small. interactiveOnly already filters non-interactive nodes by default; includeUrls adds link hrefs without extra browser_get calls.",
  "After browser_open, browser_nav, or any submission, the page is mid-load. Rely on waitMode='networkidle' (default) or follow up with browser_wait — prefer its text/urlPattern/load/fn modes over raw millisecond waits.",
  "Tabs use stable string ids (t1, t2, …) plus optional labels — never positional integers. Get ids from browser_tab list; label tabs at creation for multi-tab flows.",
  "Use browser_checkpoint after important mutations to save a screenshot + interactive snapshot pair for verification and recovery; annotate=true adds numbered labels keyed to @eN refs for vision use.",
  "The connected browser is the user's authenticated Arc session — do not perform mutations the user did not ask for.",
  "browser_record start spawns a fresh browser context (cookies and localStorage preserved); re-snapshot before the next action.",
  "Use browser_is for boolean asserts (visible/enabled/checked) instead of regex-matching browser_get text.",
  "For React/Next.js debugging: browser_open with enableReactDevtools=true, then browser_react (tree/inspect/renders/suspense). browser_vitals and browser_nav pushstate work on any page without the hook.",
  "On a connection error: a lost tab is auto-retried once; if it still fails the browser is likely down — call browser_connect to re-establish the controlled tab, then retry. browser_status actively probes the port, so trust it over assumptions about connection state.",
  "alert/beforeunload dialogs are auto-accepted by agent-browser; for confirm/prompt dialogs use browser_command ['dialog','accept'] or ['dialog','dismiss'].",
];

export default function (pi: ExtensionAPI) {
  let state = createBrowserState(process.cwd());

  const refreshUi = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const t = ctx.ui.theme;
    const health = connectionHealth(state);
    const color = health === "ok" ? "success" : health === "suspect" ? "warning" : "dim";
    const dot = t.fg(color, connectionGlyph(health));
    const label = state.currentDomain ?? (state.connected ? `cdp:${state.port}` : "idle");
    ctx.ui.setStatus("browser-ops", `${dot} ${t.fg("muted", label)}`);
  };

  const persistCommandState = (): void => {
    pi.appendEntry(CUSTOM_STATE_TYPE, { browserState: serializeBrowserState(state) });
  };

  const applyActionResult = (result: BrowserActionResult, ctx: ExtensionContext): void => {
    refreshUi(ctx);
    if (ctx.hasUI && result.summary) ctx.ui.notify(result.summary.split("\n")[0] ?? result.summary, "info");
  };

  const handleFailure = (ctx: ExtensionContext, error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    // A connection-level failure means the dot should stop claiming we're connected.
    // Action-level errors (bad selector, element not found) leave connected alone.
    if (error instanceof CdpError && (error.kind === "browser-down" || error.kind === "target-gone")) {
      state.connected = false;
    }
    refreshUi(ctx);
    throw error instanceof Error ? error : new Error(message);
  };

  const registerBrowserTool = <TParams extends TSchema, TDetails = unknown, TState = unknown>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void => {
    pi.registerTool({ renderResult: renderCompactToolResult, ...tool });
  };

  const loadStateFromSession = (ctx: ExtensionContext): void => {
    let restored: unknown;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_STATE_TYPE) {
        restored = entry.data && typeof entry.data === "object" ? (entry.data as { browserState?: unknown }).browserState : restored;
      }

      if (entry.type === "message" && entry.message.role === "toolResult") {
        const details = entry.message.details;
        if (details && typeof details === "object" && "browserState" in details) {
          restored = (details as { browserState?: unknown }).browserState;
        }
      }
    }

    state = mergeBrowserState(ctx.cwd, restored);
  };

  pi.on("session_start", async (_event, ctx) => {
    loadStateFromSession(ctx);
    // Restored state can claim "connected" from a previous session whose browser is long
    // gone. Revalidate against the live port so the first widget paint is honest.
    if (state.connected) {
      try {
        await verifyConnection(pi, state, ctx);
      } catch {
        /* leave restored state as-is if the probe itself fails */
      }
    }
    refreshUi(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await cleanupBrowserArtifacts(state);
  });

  pi.registerCommand("browser", {
    description: "Manage agent-browser connection, status, and cleanup",
    handler: async (args, ctx) => {
      const [subcommand] = args.trim().split(/\s+/, 1);

      try {
        if (!subcommand || subcommand === "help") {
          ctx.ui.notify("Usage: /browser connect [port] | status | cleanup", "info");
          refreshUi(ctx);
          return;
        }

        if (subcommand === "connect") {
          const tokens = args.trim().split(/\s+/).slice(1);
          const portArg = Number(tokens[0]);
          if (Number.isInteger(portArg) && portArg > 0) state.port = resolveBrowserPort(portArg);

          const result = await connectBrowser(pi, state, ctx);
          applyActionResult(result, ctx);
          persistCommandState();
          return;
        }

        if (subcommand === "status") {
          const probe = await verifyConnection(pi, state, ctx).catch(() => undefined);
          refreshUi(ctx);
          persistCommandState();
          ctx.ui.notify(browserSummary(state, probe), "info");
          return;
        }

        if (subcommand === "cleanup") {
          await cleanupBrowserArtifacts(state);
          state.lastAction = "cleanup";
          state.lastError = undefined;
          refreshUi(ctx);
          persistCommandState();
          ctx.ui.notify(`Marked browser as disconnected. Artifact files remain in ${state.artifactDir}.`, "info");
          return;
        }

        ctx.ui.notify(`Unknown /browser subcommand: ${subcommand}`, "warning");
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_status",
    label: "Browser Status",
    description: "Probe the live debugging port and show verified connection state, page-target count, browser version, and artifact locations",
    promptSnippet: "Inspect the browser automation state before continuing a multi-step dashboard task",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const probe = await verifyConnection(pi, state, ctx).catch(() => undefined);
      refreshUi(ctx);
      return {
        content: [{ type: "text", text: browserSummary(state, probe) }],
        details: {
          probe,
          browserState: serializeBrowserState(state),
        },
      };
    },
  });

  registerBrowserTool({
    name: "browser_connect",
    label: "Browser Connect",
    description: "Connect agent-browser to Arc or Chromium auth context using a smart-default remote debugging port",
    promptSnippet: "Connect browser automation to the user's existing authenticated browser session",
    promptGuidelines: [
      ...BROWSER_GUIDELINES,
      "Use browser_connect before dashboard automation when browser auth has not been initialized in the current session.",
    ],
    parameters: Type.Object({
      port: Type.Optional(Type.Number({ description: "Optional remote debugging port. Defaults to PI_BROWSER_PORT or 9222." })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { debugPort: "port" },
        numberFields: ["port"],
      });
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        if (typeof _params.port === "number") state.port = resolveBrowserPort(_params.port);
        const result = await connectBrowser(pi, state, ctx);
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_open",
    label: "Browser Open",
    description: "Open a URL in agent-browser and optionally wait for the page to settle",
    promptSnippet: "Open a dashboard or app URL before interacting with it",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to open" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
      enableReactDevtools: Type.Optional(
        Type.Boolean({
          description: "Inject the React DevTools hook before this navigation so browser_react commands work on the page",
        }),
      ),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { reactDevtools: "enableReactDevtools", react: "enableReactDevtools" },
        booleanFields: ["enableReactDevtools"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await openBrowserPage(pi, state, ctx, params.url, (params.waitMode ?? "networkidle") as WaitMode, {
          enableReactDevtools: params.enableReactDevtools,
        });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Capture a page snapshot, defaulting to interactive elements only. Scope with selector or depth on heavy SPAs.",
    promptSnippet: "Inspect the current page and collect fresh element refs before clicking or filling",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      interactiveOnly: Type.Optional(Type.Boolean({ description: "Capture only interactive elements", default: true })),
      includeUrls: Type.Optional(Type.Boolean({ description: "Include href URLs on link elements" })),
      compact: Type.Optional(Type.Boolean({ description: "Remove empty structural elements" })),
      depth: Type.Optional(Type.Number({ description: "Limit accessibility tree depth" })),
      selector: Type.Optional(Type.String({ description: "Scope snapshot to a CSS selector subtree" })),
      label: Type.Optional(Type.String({ description: "Optional artifact label" })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { interactive: "interactiveOnly", urls: "includeUrls", scope: "selector", css: "selector", maxDepth: "depth" },
        booleanFields: ["interactiveOnly", "includeUrls", "compact"],
        numberFields: ["depth"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await snapshotBrowserPage(
          pi,
          state,
          ctx,
          params.interactiveOnly ?? true,
          params.label ?? "snapshot",
          { urls: params.includeUrls, compact: params.compact, depth: params.depth, selector: params.selector },
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click an interactive element by its @ref and optionally resnapshot afterward",
    promptSnippet: "Click a specific interactive element ref from the latest browser snapshot",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      ref: Type.String({ description: "Interactive element ref like @e12 or e12" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
      resnapshot: Type.Optional(Type.Boolean({ description: "Capture a fresh interactive snapshot after clicking", default: true })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: {
          element: "ref",
          selector: "ref",
          wait: "waitMode",
          reSnapshot: "resnapshot",
        },
        booleanFields: ["resnapshot"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await clickBrowserElement(
          pi,
          state,
          ctx,
          params.ref,
          (params.waitMode ?? "networkidle") as WaitMode,
          params.resnapshot ?? true,
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_find",
    label: "Browser Find",
    description:
      "Find an element by role/text/label/placeholder/alt/title/testid (or first/last/nth CSS) and perform an action on it in one step. Always acts — use browser_snapshot to inspect without acting.",
    promptSnippet:
      "Find an element by semantic locator (role, label, text, etc.) and click/fill/type/hover/focus/check/uncheck it in one call",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      locator: BROWSER_FIND_LOCATOR_SCHEMA,
      value: Type.String({
        description: "Role/text/label/placeholder/alt/title/testid value, or CSS selector for first/last/nth",
      }),
      action: BROWSER_FIND_ACTION_SCHEMA,
      nthIndex: Type.Optional(Type.Number({ description: "0-based match index, required when locator is nth" })),
      text: Type.Optional(Type.String({ description: "Action argument for fill/type" })),
      name: Type.Optional(Type.String({ description: "Accessible-name filter (role locator only)" })),
      exact: Type.Optional(Type.Boolean({ description: "Require exact text/name match" })),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
      resnapshot: Type.Optional(
        Type.Boolean({ description: "Capture a fresh interactive snapshot after a mutating action", default: true }),
      ),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { role: "value", element: "value", index: "nthIndex" },
        booleanFields: ["exact", "resnapshot"],
        numberFields: ["nthIndex"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await findBrowserElement(pi, state, ctx, {
          locator: params.locator as string,
          value: params.value,
          action: params.action as FindAction,
          nthIndex: params.nthIndex,
          text: params.text,
          name: params.name,
          exact: params.exact,
          waitMode: params.waitMode as WaitMode | undefined,
          resnapshot: params.resnapshot,
        });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_fill",
    label: "Browser Fill",
    description: "Fill a browser input element by @ref",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      ref: Type.String({ description: "Interactive element ref like @e12 or e12" }),
      text: Type.String({ description: "Text to fill into the target input" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: {
          element: "ref",
          selector: "ref",
          value: "text",
          wait: "waitMode",
        },
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await fillBrowserElement(
          pi,
          state,
          ctx,
          params.ref,
          params.text,
          (params.waitMode ?? "none") as WaitMode,
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_select",
    label: "Browser Select",
    description: "Select a value on a browser control by @ref",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      ref: Type.String({ description: "Interactive element ref like @e12 or e12" }),
      option: Type.String({ description: "Visible option text or value to select" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: {
          element: "ref",
          selector: "ref",
          value: "option",
          wait: "waitMode",
        },
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await selectBrowserOption(
          pi,
          state,
          ctx,
          params.ref,
          params.option,
          (params.waitMode ?? "none") as WaitMode,
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_press",
    label: "Browser Press",
    description: "Press a browser key such as Enter, Tab, Escape, or Control+a",
    promptSnippet: "Press keyboard keys in the current browser page",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      key: Type.String({ description: "Key to press, e.g. Enter, Tab, Escape, Control+a" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { value: "key" },
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await pressBrowserKey(pi, state, ctx, params.key, (params.waitMode ?? "none") as WaitMode);
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the current page (or a scrollable container) up, down, left, or right",
    promptSnippet: "Scroll the browser page or a container to reveal more content",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      direction: SCROLL_DIRECTION_SCHEMA,
      pixels: Type.Optional(Type.Number({ description: "Optional number of pixels to scroll" })),
      containerSelector: Type.Optional(
        Type.String({ description: "CSS selector of a scrollable container to scroll instead of the page" }),
      ),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { selector: "containerSelector", container: "containerSelector" },
        numberFields: ["pixels"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await scrollBrowserPage(
          pi,
          state,
          ctx,
          params.direction as "up" | "down" | "left" | "right",
          params.pixels,
          (params.waitMode ?? "none") as WaitMode,
          params.containerSelector,
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_wait",
    label: "Browser Wait",
    description:
      "Wait for page state — a selector/ref (optionally reaching visible/hidden/detached), text appearing, a URL glob, a load state, a JS condition, or plain milliseconds. Pick exactly one mode.",
    promptSnippet: "Wait for browser page state (selector, text, URL pattern, load state, or JS condition) before continuing",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "Selector or @ref to wait for" })),
      state: Type.Optional(BROWSER_WAIT_STATE_SCHEMA),
      ms: Type.Optional(Type.Number({ description: "Plain time wait in milliseconds (last resort)" })),
      text: Type.Optional(Type.String({ description: "Wait until this text appears on the page (substring match)" })),
      urlPattern: Type.Optional(Type.String({ description: "Wait until the URL matches a glob like **/dashboard" })),
      load: Type.Optional(BROWSER_WAIT_LOAD_SCHEMA),
      fn: Type.Optional(Type.String({ description: "Wait until this JS expression is truthy" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds (default 25000)" })),
    }),
    prepareArguments(args) {
      const prepared = prepareCompatArguments(args, {
        aliases: { target: "selector", ref: "selector", url: "urlPattern", timeout: "timeoutMs" },
        numberFields: ["ms", "timeoutMs"],
      }) as Record<string, unknown>;
      // Legacy target form packed selectors and millisecond waits into one string field.
      if (typeof prepared.selector === "number") {
        return { ...prepared, selector: undefined, ms: prepared.selector };
      }
      if (typeof prepared.selector === "string" && /^\d+$/.test(prepared.selector.trim())) {
        return { ...prepared, selector: undefined, ms: Number(prepared.selector.trim()) };
      }
      return prepared;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await waitInBrowser(pi, state, ctx, params as WaitArgsOptions);
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_nav",
    label: "Browser Navigation",
    description:
      "Navigate browser history, reload, or pushstate (SPA client-side navigation — auto-detects the Next.js router, no full page load)",
    promptSnippet: "Go back, forward, reload, or SPA-navigate the browser page",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      action: NAV_ACTION_SCHEMA,
      url: Type.Optional(Type.String({ description: "Target URL/path, required when action is pushstate" })),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await navigateBrowser(
          pi,
          state,
          ctx,
          params.action as "back" | "forward" | "reload" | "pushstate",
          (params.waitMode ?? "networkidle") as WaitMode,
          params.url,
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_get",
    label: "Browser Get",
    description:
      "Read structured browser information such as text, html, value, attr, title, url, count, box, styles, or cdp-url",
    promptSnippet: "Extract browser text, URL, title, element value, attributes, counts, boxes, or styles",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      what: BROWSER_GET_SCHEMA,
      selector: Type.Optional(Type.String({ description: "Optional selector or @ref" })),
      attrName: Type.Optional(Type.String({ description: "Attribute name when what is attr" })),
      label: Type.Optional(Type.String({ description: "Optional artifact label for saved output" })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { ref: "selector", attribute: "attrName", name: "attrName" },
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await getBrowserInfo(
          pi,
          state,
          ctx,
          params.what as BrowserGetWhat,
          params.selector,
          params.attrName,
          params.label ?? "get",
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_debug",
    label: "Browser Debug",
    description:
      "Read browser console logs, page errors, or network requests (filterable by URL pattern, resource type, method, or status; network-request fetches one request's full detail by id)",
    promptSnippet: "Inspect browser console logs, page errors, or network requests for diagnostics",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      kind: BROWSER_DEBUG_SCHEMA,
      clear: Type.Optional(Type.Boolean({ description: "Clear entries after reading when supported" })),
      filter: Type.Optional(Type.String({ description: "Network request URL filter pattern" })),
      type: Type.Optional(Type.String({ description: "Resource type filter, comma-separated (e.g. xhr,fetch,document)" })),
      method: Type.Optional(Type.String({ description: "HTTP method filter (e.g. POST)" })),
      status: Type.Optional(Type.String({ description: "Status filter (e.g. 200, 2xx, 400-499)" })),
      requestId: Type.Optional(Type.String({ description: "Request id for kind network-request" })),
      label: Type.Optional(Type.String({ description: "Optional artifact label for saved output" })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { id: "requestId" },
        booleanFields: ["clear"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await debugBrowserPage(
          pi,
          state,
          ctx,
          params.kind as "console" | "errors" | "network-requests" | "network-request",
          {
            clear: params.clear,
            filter: params.filter,
            type: params.type,
            method: params.method,
            status: params.status,
            requestId: params.requestId,
            label: params.label,
          },
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_command",
    label: "Browser Command",
    description: "Run a raw agent-browser command using structured args. The active CDP port is prepended automatically; do not include --cdp.",
    promptSnippet: "Use any agent-browser CLI feature not covered by typed browser tools",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      args: Type.Array(Type.String({ description: "agent-browser CLI argument" }), {
        description: "Argument array, e.g. ['press', 'Enter'] or ['tab', 'list']",
      }),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds, clamped between 1000 and 300000" })),
      label: Type.Optional(Type.String({ description: "Optional artifact label for saved output" })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        numberFields: ["timeoutMs"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await runBrowserCommand(pi, state, ctx, params.args, params.timeoutMs, params.label ?? "command");
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_eval",
    label: "Browser Eval",
    description: "Run JavaScript in the current page for structured extraction or page diagnostics",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      script: Type.String({ description: "JavaScript source to evaluate in the current page" }),
      label: Type.Optional(Type.String({ description: "Optional artifact label for saved output" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await evalInBrowser(pi, state, ctx, params.script, params.label ?? "eval");
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_tab",
    label: "Browser Tab",
    description:
      "List, open, close, or switch browser tabs. Tabs have stable string ids (t1, t2, …) and optional labels — get them from list; positional integers are not accepted.",
    promptSnippet: "Manage browser tabs when an action opens a popup or you need to coordinate across tabs",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      action: BROWSER_TAB_ACTION_SCHEMA,
      url: Type.Optional(Type.String({ description: "URL to open when action is 'new'" })),
      label: Type.Optional(Type.String({ description: "Memorable label for the new tab (action 'new'), e.g. docs" })),
      tab: Type.Optional(
        Type.String({ description: "Stable tab id like t2 (or a label) for 'switch' (required) and 'close' (optional)" }),
      ),
    }),
    prepareArguments(args) {
      const prepared = prepareCompatArguments(args, {
        aliases: { index: "tab", id: "tab", tabId: "tab" },
      }) as Record<string, unknown>;
      // Old habits (and the pre-0.26 CLI) used numeric indices; stringify so the builder
      // can coerce digits to stable t-ids.
      const next = typeof prepared.tab === "number" ? { ...prepared, tab: String(prepared.tab) } : prepared;
      return next as { action: TabAction; url?: string; label?: string; tab?: string };
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await tabBrowser(pi, state, ctx, {
          action: params.action as TabAction,
          url: params.url,
          label: params.label,
          tab: params.tab,
        });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_is",
    label: "Browser Is",
    description: "Boolean assertions for visible/enabled/checked — returns structured details.result instead of text to regex-match",
    promptSnippet: "Assert that a selector is visible/enabled/checked without parsing browser_get text",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      check: BROWSER_IS_CHECK_SCHEMA,
      selector: Type.String({ description: "CSS selector or @ref to test" }),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { ref: "selector" },
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await isBrowserState(pi, state, ctx, {
          check: params.check as IsCheck,
          selector: params.selector,
        });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_set",
    label: "Browser Set",
    description:
      "Configure browser settings: viewport (with optional retina scale), device emulation, geolocation, offline mode, media (color-scheme/reduced-motion), extra HTTP headers, or basic-auth credentials",
    promptSnippet: "Change viewport, device profile, geo, offline state, media preferences, headers, or credentials for the browser",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      setting: BROWSER_SET_SETTING_SCHEMA,
      width: Type.Optional(Type.Number({ description: "Viewport width (required when setting='viewport')" })),
      height: Type.Optional(Type.Number({ description: "Viewport height (required when setting='viewport')" })),
      scale: Type.Optional(Type.Number({ description: "Device scale factor, e.g. 2 for retina (setting='viewport')" })),
      device: Type.Optional(Type.String({ description: "Device name (required when setting='device')" })),
      latitude: Type.Optional(Type.Number({ description: "Latitude (required when setting='geo')" })),
      longitude: Type.Optional(Type.Number({ description: "Longitude (required when setting='geo')" })),
      offline: Type.Optional(Type.Boolean({ description: "Offline state (required when setting='offline')" })),
      media: Type.Optional(BROWSER_SET_MEDIA_SCHEMA),
      reducedMotion: Type.Optional(Type.Boolean({ description: "Emulate prefers-reduced-motion: reduce" })),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: "Extra HTTP headers (setting='headers')" }),
      ),
      username: Type.Optional(Type.String({ description: "Basic-auth username (setting='credentials')" })),
      password: Type.Optional(Type.String({ description: "Basic-auth password (setting='credentials')" })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { lat: "latitude", lng: "longitude", lon: "longitude", user: "username", pass: "password" },
        numberFields: ["width", "height", "scale", "latitude", "longitude"],
        booleanFields: ["offline", "reducedMotion"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await setBrowser(pi, state, ctx, {
          setting: params.setting as SetSetting,
          width: params.width,
          height: params.height,
          scale: params.scale,
          device: params.device,
          latitude: params.latitude,
          longitude: params.longitude,
          offline: params.offline,
          media: params.media as "dark" | "light" | undefined,
          reducedMotion: params.reducedMotion,
          headers: params.headers,
          username: params.username,
          password: params.password,
        });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_record",
    label: "Browser Record",
    description: "Start or stop video recording (.webm) of the current browser context for QA artifact capture",
    promptSnippet: "Capture a video of the page during a workflow for visual verification",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      action: BROWSER_CAPTURE_ACTION_SCHEMA,
      label: Type.Optional(Type.String({ description: "Label used to name the recording file under artifactDir" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await recordBrowser(pi, state, ctx, {
          action: params.action as CaptureAction,
          label: params.label,
        });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_trace",
    label: "Browser Trace",
    description: "Start or stop a Playwright-style trace (.zip) for the current browser context",
    promptSnippet: "Capture a Playwright trace bundle for diagnostics and replay",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      action: BROWSER_CAPTURE_ACTION_SCHEMA,
      label: Type.Optional(Type.String({ description: "Label used to name the trace zip under artifactDir" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await traceBrowser(pi, state, ctx, {
          action: params.action as CaptureAction,
          label: params.label,
        });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_checkpoint",
    label: "Browser Checkpoint",
    description:
      "Save a screenshot plus an interactive snapshot for verification and recovery. annotate=true overlays numbered labels keyed to @eN refs (for vision use) and includes the legend.",
    promptSnippet: "Capture a verification checkpoint after an important browser mutation",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      label: Type.String({ description: "Short label describing what is being verified" }),
      annotate: Type.Optional(
        Type.Boolean({ description: "Overlay numbered ref labels on the screenshot and include the legend" }),
      ),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        booleanFields: ["annotate"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await checkpointBrowserPage(pi, state, ctx, params.label, { annotate: params.annotate });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_react",
    label: "Browser React",
    description:
      "Inspect React internals on the current page: component tree, per-fiber props/hooks/state (inspect), re-render profiling (renders-start/renders-stop), or Suspense boundary classification (suspense). Requires the page to have been opened with browser_open enableReactDevtools=true.",
    promptSnippet: "Inspect the React component tree, fiber props/hooks/state, re-render profile, or Suspense boundaries",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      command: BROWSER_REACT_COMMAND_SCHEMA,
      fiberId: Type.Optional(Type.Number({ description: "Fiber id from react tree output (required for inspect)" })),
      onlyDynamic: Type.Optional(Type.Boolean({ description: "Hide static boundaries in suspense output" })),
      label: Type.Optional(Type.String({ description: "Optional artifact label for saved output" })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { id: "fiberId", fiber: "fiberId" },
        numberFields: ["fiberId"],
        booleanFields: ["onlyDynamic"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await reactBrowser(pi, state, ctx, {
          command: params.command as ReactCommand,
          fiberId: params.fiberId,
          onlyDynamic: params.onlyDynamic,
          label: params.label,
        });
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  registerBrowserTool({
    name: "browser_vitals",
    label: "Browser Vitals",
    description:
      "Measure Core Web Vitals (LCP, CLS, TTFB, FCP, INP) plus React hydration timing for the current page or a given URL",
    promptSnippet: "Measure Core Web Vitals and hydration timing for performance diagnostics",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to measure (omit to measure the current page)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await vitalsBrowser(pi, state, ctx, params.url);
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  function toolResponse(result: BrowserActionResult) {
    const content = [result.summary, result.contentText].filter(Boolean).join("\n\n");

    return {
      content: [{ type: "text" as const, text: content }],
      details: {
        ...result.diagnostics,
        artifacts: result.artifacts,
        browserState: serializeBrowserState(state),
      },
    };
  }
}
