import { readFile } from "node:fs/promises";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

import {
  cleanupBrowserArtifacts,
  connectBrowser,
  verifyConnection,
  CdpError,
  type BrowserActionResult,
} from "./agent-browser.ts";
import {
  browserSummaryWithVersion,
  connectionHealth,
  createBrowserState,
  mergeBrowserState,
  resolveBrowserPort,
  serializeBrowserState,
} from "./state.ts";
import { BROWSER_GUIDELINES, BROWSER_TOOLS, prepareBrowserInput } from "./browser-tools.ts";
import { piHost } from "./pi-host.ts";
import {
  BrowserTrail,
  browserCallLine,
  browserChip,
  describeActivity,
  formatAddress,
  presentResult,
  snapshotLabel,
  TrailWidget,
} from "./browser-ui.ts";
import { renderBrowserResult } from "./browser-result-renderer.ts";

const CUSTOM_STATE_TYPE = "browser-ops-state";

export default function (pi: ExtensionAPI) {
  let state = createBrowserState(process.cwd());

  // The chip says where the browser is; the trail row shows each step as it runs; tool
  // rows keep the same words in the transcript. See browser-ui.ts.
  const trail = new BrowserTrail();
  let trailWidget: TrailWidget | undefined;
  const callTexts = new Map<string, string>();
  let lastChip: string | undefined | null = null;

  // Every snapshot is saved by snapshotBrowserPage, so the newest file is the one the
  // model's @eN refs came from. Read it once per snapshot to name what is being clicked.
  let snapshotCache: { file: string; text: string } | undefined;
  // Scoped and delta snapshots describe part of a page, and a snapshot of another URL
  // describes another page; neither is diffed.
  let snapshotComparable = false;
  let snapshotUrl: string | undefined;
  const latestSnapshot = async (): Promise<string | undefined> => {
    const file = state.lastSnapshotFile;
    if (!file) return undefined;
    if (snapshotCache?.file !== file) {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text === undefined) return undefined;
      snapshotCache = { file, text };
    }
    return snapshotCache.text;
  };

  const refreshUi = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    // Each setStatus makes Lohan's Land re-layout the whole footer, so only send changes.
    const chip = browserChip(ctx.ui.theme, state, connectionHealth(state));
    if (chip === lastChip) return;
    lastChip = chip;
    ctx.ui.setStatus("browser-ops", chip);
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
    // A strict pin failure means Chrome is still connected but no page is bound. Preserve
    // the recovery identifiers and show a warning state instead of claiming browser-down.
    if (error instanceof CdpError && error.kind === "tab-gone") {
      state.connected = true;
      state.targetId = undefined;
      state.tabGoneTargetId = error.targetId ?? state.tabGoneTargetId;
      state.tabGoneLastUrl = error.lastUrl ?? state.tabGoneLastUrl;
      state.currentUrl = undefined;
      state.currentDomain = undefined;
    } else if (error instanceof CdpError && (error.kind === "browser-down" || error.kind === "target-gone")) {
      state.connected = false;
    }
    refreshUi(ctx);
    throw error instanceof Error ? error : new Error(message);
  };

  const registerBrowserTool = <TParams extends TSchema, TDetails = unknown, TState = unknown>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void => {
    pi.registerTool({
      renderResult: renderBrowserResult,
      renderCall: (args, theme, context) => {
        const text = callTexts.get(context.toolCallId) ?? describeActivity(tool.name, args as Record<string, unknown>).text;
        const line = browserCallLine(theme, text);
        return new Text(context.expanded ? `${line}\n${theme.fg("dim", `${tool.name} ${JSON.stringify(args)}`)}` : line, 0, 0);
      },
      ...tool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const input = params as Record<string, unknown>;
        const snapshot = await latestSnapshot();
        const before = { url: state.currentUrl, snapshot, comparable: snapshotComparable && snapshotUrl === state.currentUrl };
        const snapshotFileBefore = state.lastSnapshotFile;
        const labelFor = (ref: string) => (snapshot ? snapshotLabel(snapshot, ref) : undefined);
        const activity = describeActivity(tool.name, input, labelFor);
        callTexts.set(toolCallId, activity.text);
        trail.begin(toolCallId, activity);
        trailWidget?.poke();
        const startedAt = Date.now();
        let ok = false;
        try {
          const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
          ok = true;

          const freshSnapshot = state.lastSnapshotFile !== snapshotFileBefore;
          if (freshSnapshot) {
            const partial = Boolean(input.selector || input.depth || input.delta);
            snapshotComparable = !((tool.name === "browser_snapshot" || tool.name === "browser_checkpoint") && partial);
            snapshotUrl = state.currentUrl;
          }
          const after = {
            url: state.currentUrl,
            snapshot: freshSnapshot ? await latestSnapshot() : undefined,
            comparable: snapshotComparable,
          };
          const details = result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
          const text = result.content.find((block) => block.type === "text");
          const presentation = presentResult({
            tool: tool.name,
            params: input,
            text: text?.type === "text" ? text.text : "",
            details,
            before,
            after,
            durationMs: Date.now() - startedAt,
            snapshotFiles: [snapshotFileBefore, state.lastSnapshotFile].filter((file): file is string => Boolean(file)),
          });
          return { ...result, details: { ...details, presentation } as TDetails };
        } finally {
          trail.end(toolCallId, ok);
          trailWidget?.poke();
          refreshUi(ctx);
        }
      },
    });
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
    callTexts.clear();
    trail.reset();
    lastChip = null;
    snapshotCache = undefined;
    snapshotComparable = false;
    snapshotUrl = undefined;
    if (ctx.hasUI) {
      // Mounted once so the row keeps its place among the widgets above the editor; it
      // renders nothing until the agent touches the browser.
      ctx.ui.setWidget("da-browser-trail", (tui, theme) => {
        trailWidget?.dispose();
        trailWidget = new TrailWidget(tui, theme, trail, () => formatAddress(state.currentUrl));
        return trailWidget;
      });
    }
    // Probe both the CLI version and CDP port on every start. Persisted compatibility can
    // be stale after either da-browser or the globally installed CLI changes.
    try {
      const probe = await verifyConnection(piHost(pi, ctx), state);
      if (!probe.agentBrowserCompatible && ctx.hasUI) {
        const installed = probe.agentBrowserVersion ?? "not found";
        ctx.ui.notify(
          `da-browser requires agent-browser >=${probe.requiredAgentBrowserVersion}; found ${installed}. Run: npm i -g agent-browser@latest`,
          "warning",
        );
      }
    } catch {
      /* keep session startup usable if the probe itself fails */
    }
    refreshUi(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    trailWidget?.dispose();
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

          const result = await connectBrowser(piHost(pi, ctx), state);
          applyActionResult(result, ctx);
          persistCommandState();
          return;
        }

        if (subcommand === "status") {
          const probe = await verifyConnection(piHost(pi, ctx), state).catch(() => undefined);
          refreshUi(ctx);
          persistCommandState();
          ctx.ui.notify(browserSummaryWithVersion(state, probe), "info");
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

  for (const spec of BROWSER_TOOLS) {
    registerBrowserTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      promptSnippet: spec.promptSnippet,
      promptGuidelines: BROWSER_GUIDELINES,
      // Plain JSON schema: pi validates and coerces it like typebox; the cast is for the types.
      parameters: spec.parameters as unknown as TSchema,
      prepareArguments: (args) => prepareBrowserInput(spec, args),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const result = await spec.run(piHost(pi, ctx), state, params as Record<string, unknown>);
          refreshUi(ctx);
          return toolResponse(result);
        } catch (error) {
          return handleFailure(ctx, error);
        }
      },
    });
  }

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
