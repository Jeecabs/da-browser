import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

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
  navigateBrowser,
  openBrowserPage,
  pressBrowserKey,
  runBrowserCommand,
  scrollBrowserPage,
  selectBrowserOption,
  snapshotBrowserPage,
  waitInBrowser,
  type BrowserActionResult,
} from "./agent-browser.js";
import {
  browserStatusText,
  browserSummary,
  createBrowserState,
  mergeBrowserState,
  resolveBrowserPort,
  serializeBrowserState,
  type BrowserState,
  type WaitMode,
} from "./state.js";
import { prepareCompatArguments } from "./extension-utils.js";

const WAIT_MODE_SCHEMA = StringEnum(["none", "load", "networkidle"] as const);
const SCROLL_DIRECTION_SCHEMA = StringEnum(["up", "down", "left", "right"] as const);
const NAV_ACTION_SCHEMA = StringEnum(["back", "forward", "reload"] as const);
const BROWSER_GET_SCHEMA = StringEnum(["text", "html", "value", "attr", "title", "url", "count", "box", "styles"] as const);
const BROWSER_DEBUG_SCHEMA = StringEnum(["console", "errors", "network-requests"] as const);
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
const CUSTOM_STATE_TYPE = "browser-ops-state";

const BROWSER_GUIDELINES = [
  "Browser element refs (@eN) come from the most recent snapshot and become stale after any DOM mutation. Re-snapshot or use browser_find after navigation, click, or fill.",
  "Prefer browser_find over snapshot+click when the target is described by role, label, text, placeholder, alt, title, or testid — it avoids a snapshot round-trip.",
  "For heavy SPAs, scope browser_snapshot with selector (CSS subtree) or depth to keep context small. interactiveOnly already filters non-interactive nodes by default.",
  "After browser_open, browser_nav, or any submission, the page is mid-load. Rely on waitMode='networkidle' (default) or follow up with browser_wait on a known selector for slow apps.",
  "Use browser_checkpoint after important mutations to save a screenshot + interactive snapshot pair for verification and recovery.",
  "The connected browser is the user's authenticated Arc session — do not perform mutations the user did not ask for.",
];

export default function (pi: ExtensionAPI) {
  let state = createBrowserState(process.cwd());

  const refreshUi = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const t = ctx.ui.theme;
    const dot = state.connected ? t.fg("success", "\u25CF") : t.fg("dim", "\u25CB");
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
    refreshUi(ctx);
    throw error instanceof Error ? error : new Error(message);
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
          refreshUi(ctx);
          ctx.ui.notify(browserSummary(state), "info");
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

  pi.registerTool({
    name: "browser_status",
    label: "Browser Status",
    description: "Show the current browser automation state and artifact locations",
    promptSnippet: "Inspect the browser automation state before continuing a multi-step dashboard task",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      refreshUi(ctx);
      return {
        content: [{ type: "text", text: browserSummary(state) }],
        details: {
          browserState: serializeBrowserState(state),
        },
      };
    },
  });

  pi.registerTool({
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

  pi.registerTool({
    name: "browser_open",
    label: "Browser Open",
    description: "Open a URL in agent-browser and optionally wait for the page to settle",
    promptSnippet: "Open a dashboard or app URL before interacting with it",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: "Absolute URL to open" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await openBrowserPage(pi, state, ctx, params.url, (params.waitMode ?? "networkidle") as WaitMode);
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Capture a page snapshot, defaulting to interactive elements only. Scope with selector or depth on heavy SPAs.",
    promptSnippet: "Inspect the current page and collect fresh element refs before clicking or filling",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      interactiveOnly: Type.Optional(Type.Boolean({ description: "Capture only interactive elements", default: true })),
      compact: Type.Optional(Type.Boolean({ description: "Remove empty structural elements" })),
      depth: Type.Optional(Type.Number({ description: "Limit accessibility tree depth" })),
      selector: Type.Optional(Type.String({ description: "Scope snapshot to a CSS selector subtree" })),
      label: Type.Optional(Type.String({ description: "Optional artifact label" })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        aliases: { interactive: "interactiveOnly", scope: "selector", css: "selector", maxDepth: "depth" },
        booleanFields: ["interactiveOnly", "compact"],
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
          { compact: params.compact, depth: params.depth, selector: params.selector },
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  pi.registerTool({
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

  pi.registerTool({
    name: "browser_find",
    label: "Browser Find",
    description:
      "Locate elements by role/text/label/placeholder/alt/title/testid (or first/last/nth) and optionally act on them in one step. Replaces snapshot+click when the target is semantically describable.",
    promptSnippet:
      "Find an element by semantic locator (role, label, text, etc.) and click/fill/type/hover/focus/check/uncheck it in one call",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      locator: BROWSER_FIND_LOCATOR_SCHEMA,
      value: Type.String({
        description: "Role/text/label/placeholder/alt/title/testid value, CSS selector for first/last, or index for nth",
      }),
      action: Type.Optional(
        Type.String({
          description:
            "Action to perform on the match: click, fill, type, hover, focus, check, uncheck. Omit to just locate and return matched refs.",
        }),
      ),
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
        aliases: { role: "value", element: "value" },
        booleanFields: ["exact", "resnapshot"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await findBrowserElement(pi, state, ctx, {
          locator: params.locator as string,
          value: params.value,
          action: params.action,
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

  pi.registerTool({
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

  pi.registerTool({
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

  pi.registerTool({
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

  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the current page up, down, left, or right",
    promptSnippet: "Scroll the browser page to reveal more content",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      direction: SCROLL_DIRECTION_SCHEMA,
      pixels: Type.Optional(Type.Number({ description: "Optional number of pixels to scroll" })),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
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
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for a selector/ref to appear or for a number of milliseconds",
    promptSnippet: "Wait for browser page state before continuing automation",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      target: Type.String({ description: "Selector/ref like @e12, CSS selector, or milliseconds like 2000" }),
    }),
    prepareArguments(args) {
      const prepared = prepareCompatArguments(args, {
        aliases: { selector: "target", ref: "target", ms: "target" },
      }) as { target?: unknown };
      if (prepared && typeof prepared === "object" && typeof prepared.target === "number") {
        return { ...prepared, target: String(prepared.target) } as { target: string };
      }
      return prepared as { target: string };
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await waitInBrowser(pi, state, ctx, params.target);
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: "browser_nav",
    label: "Browser Navigation",
    description: "Navigate browser history or reload the current page",
    promptSnippet: "Go back, forward, or reload the browser page",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      action: NAV_ACTION_SCHEMA,
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await navigateBrowser(
          pi,
          state,
          ctx,
          params.action as "back" | "forward" | "reload",
          (params.waitMode ?? "networkidle") as WaitMode,
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: "browser_get",
    label: "Browser Get",
    description: "Read structured browser information such as text, html, value, attr, title, url, count, box, or styles",
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
          params.what as "text" | "html" | "value" | "attr" | "title" | "url" | "count" | "box" | "styles",
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

  pi.registerTool({
    name: "browser_debug",
    label: "Browser Debug",
    description: "Read browser console logs, page errors, or network requests",
    promptSnippet: "Inspect browser console logs, page errors, or network requests for diagnostics",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      kind: BROWSER_DEBUG_SCHEMA,
      clear: Type.Optional(Type.Boolean({ description: "Clear entries after reading when supported" })),
      filter: Type.Optional(Type.String({ description: "Optional network request filter pattern" })),
      label: Type.Optional(Type.String({ description: "Optional artifact label for saved output" })),
    }),
    prepareArguments(args) {
      return prepareCompatArguments(args, {
        booleanFields: ["clear"],
      });
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await debugBrowserPage(
          pi,
          state,
          ctx,
          params.kind as "console" | "errors" | "network-requests",
          { clear: params.clear, filter: params.filter, label: params.label },
        );
        refreshUi(ctx);
        return toolResponse(result);
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  pi.registerTool({
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

  pi.registerTool({
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

  pi.registerTool({
    name: "browser_checkpoint",
    label: "Browser Checkpoint",
    description: "Save a screenshot plus an interactive snapshot for verification and recovery",
    promptSnippet: "Capture a verification checkpoint after an important browser mutation",
    promptGuidelines: BROWSER_GUIDELINES,
    parameters: Type.Object({
      label: Type.String({ description: "Short label describing what is being verified" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await checkpointBrowserPage(pi, state, ctx, params.label);
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
