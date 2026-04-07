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
  openBrowserPage,
  selectBrowserOption,
  snapshotBrowserPage,
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

const WAIT_MODE_SCHEMA = StringEnum(["none", "load", "networkidle"] as const);
const CUSTOM_STATE_TYPE = "browser-ops-state";

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
          ctx.ui.notify("Removed Arc auth export and marked browser as disconnected.", "info");
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
      "Use this tool before dashboard automation when browser auth has not been initialized in the current session.",
    ],
    parameters: Type.Object({
      port: Type.Optional(Type.Number({ description: "Optional remote debugging port. Defaults to PI_BROWSER_PORT or 9222." })),
    }),
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
    description: "Capture a page snapshot, defaulting to interactive elements only",
    promptSnippet: "Inspect the current page and collect fresh element refs before clicking or filling",
    parameters: Type.Object({
      interactiveOnly: Type.Optional(Type.Boolean({ description: "Capture only interactive elements", default: true })),
      label: Type.Optional(Type.String({ description: "Optional artifact label" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await snapshotBrowserPage(
          pi,
          state,
          ctx,
          params.interactiveOnly ?? true,
          params.label ?? "snapshot",
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
    parameters: Type.Object({
      ref: Type.String({ description: "Interactive element ref like @e12 or e12" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
      resnapshot: Type.Optional(Type.Boolean({ description: "Capture a fresh interactive snapshot after clicking", default: true })),
    }),
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
    name: "browser_fill",
    label: "Browser Fill",
    description: "Fill a browser input element by @ref",
    parameters: Type.Object({
      ref: Type.String({ description: "Interactive element ref like @e12 or e12" }),
      text: Type.String({ description: "Text to fill into the target input" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
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
    parameters: Type.Object({
      ref: Type.String({ description: "Interactive element ref like @e12 or e12" }),
      option: Type.String({ description: "Visible option text or value to select" }),
      waitMode: Type.Optional(WAIT_MODE_SCHEMA),
    }),
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
    name: "browser_eval",
    label: "Browser Eval",
    description: "Run JavaScript in the current page for structured extraction or page diagnostics",
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
