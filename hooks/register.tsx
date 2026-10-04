import type { EngineInterface, Register } from 'claude-code'

import {
  checkpointBrowserPage,
  cleanupBrowserArtifacts,
  clickBrowserElement,
  connectBrowser,
  fillBrowserElement,
  findBrowserElement,
  openBrowserPage,
  pressBrowserKey,
  readBrowserContent,
  snapshotBrowserPage,
  tabBrowser,
  runPinnedCommand,
  verifyConnection,
  type BrowserActionResult,
  type FindAction,
  type ReadArgsOptions,
  type TabAction,
} from '../src/agent-browser.ts'
import {
  artifactName,
  chipText,
  describeActivity,
  explainFailure,
  formatAddress,
  presentResult,
  snapshotLabel,
  TrailModel,
  type Fact,
  type Presentation,
} from '../src/browser-present.ts'
import { env } from '../src/env.ts'
import { prepareCompatArguments } from '../src/extension-utils.ts'
import type { BrowserHost, ExecResult } from '../src/host.ts'
import {
  browserSummaryWithVersion,
  connectionHealth,
  mergeBrowserState,
  resolveBrowserPort,
  serializeBrowserState,
  type BrowserState,
  type WaitMode,
} from '../src/state.ts'
import { CLAUDE_FAVICON_HREF } from './claude-favicon.ts'
import { handoffPending, handoffResultText, renderHandoffBand, runHandoff, type HandoffPorts } from './handoff.tsx'
import { FRAME_EVERY_MS, FRAME_KEY, live, nextFrameFile, renderView, stopView, takeViewport, VIEW_PANE } from './live.tsx'
import { handleFailure, PLUGIN, PREFIX, session } from './session.ts'

type $ = EngineInterface

// da-browser as a Claude Code mod. The browser core in ../src is shared with the pi
// extension; this file is the Claude Code host: its tools, /browser, and the same three
// surfaces pi has, each answering one question:
//   status line   where is the agent's browser?   static, hidden when idle
//   band          what is it doing right now?     above the prompt, only during a burst
//   tool rows     what did it do, what changed?   call line, then only new facts
// and two Claude Code can add: a live view of the tab drawn in the terminal (/browser view),
// and handoffs, where the agent asks the person to act or point in the browser.

const GUIDELINES = `# da-browser

The mcp__da-browser__browser_* tools drive the user's own authenticated Arc/Chromium through agent-browser, on one strictly pinned tab per session.

- Element refs (@eN) come from the latest snapshot and go stale after any DOM change. Re-snapshot, or use browser_find, after navigation, click or fill.
- Prefer browser_find when the target has a role, label, text, placeholder, alt, title or testid. It always performs its action; to look without acting use browser_snapshot.
- After browser_open or a submission the page is mid-load; the default waitMode is networkidle.
- This is the user's signed-in browser: never perform mutations the user did not ask for.
- On tab_gone, isolation worked: recover explicitly with browser_tab new, or browser_connect. Do not retry blindly.
- Never drive agent-browser through Bash with --cdp or connect; that bypasses the per-session tab pin.
- Hand the tab to the user with browser_handoff when a step needs them: logging in, a captcha, 2FA, a payment, or an element you cannot identify confidently ("which Edit button?"). With pick=true they click the element and you get its role, name and selector. Do not guess at credentials or ambiguous targets.`

const AGENT_PROMPT = `You drive the user's own signed-in browser for one self-contained web task, then report back.

${GUIDELINES}

Work in short loops: snapshot, act, re-snapshot. Keep snapshots in your own context; the caller wants the answer, not the page. Finish with a brief report: what you did, what you found (quote exact values), the final URL, and anything that needs the user. If a step needs the user (login, captcha, an ambiguous target), use browser_handoff rather than guessing.`


// ---------------------------------------------------------------------------
// The engine side. The validator follows $ only into functions declared in this file, so
// every call to the engine is here; live.tsx and handoff.tsx take plain values.
// ---------------------------------------------------------------------------

async function ready($: $): Promise<BrowserState> {
  if (session.state) return session.state
  // Each name is spelled out: the engine lists the variables a mod reads.
  const read: Record<string, string | undefined> = {
    TMPDIR: await $.env.get('TMPDIR'),
    HOME: await $.env.get('HOME'),
    PI_BROWSER_PORT: await $.env.get('PI_BROWSER_PORT'),
    AGENT_BROWSER_PORT: await $.env.get('AGENT_BROWSER_PORT'),
    ARC_REMOTE_DEBUG_PORT: await $.env.get('ARC_REMOTE_DEBUG_PORT'),
    PI_BROWSER_DASHBOARD_PORT: await $.env.get('PI_BROWSER_DASHBOARD_PORT'),
    PI_BROWSER_CONTROL_BANNER: await $.env.get('PI_BROWSER_CONTROL_BANNER'),
    PI_BROWSER_LOCAL_HOSTS: await $.env.get('PI_BROWSER_LOCAL_HOSTS'),
    PI_BROWSER_LOCAL_TIMEOUT_MS: await $.env.get('PI_BROWSER_LOCAL_TIMEOUT_MS'),
    PI_BROWSER_LOCAL_SETTLE_MS: await $.env.get('PI_BROWSER_LOCAL_SETTLE_MS'),
    DA_BROWSER_INPUT_MODE: await $.env.get('DA_BROWSER_INPUT_MODE'),
  }
  for (const [key, value] of Object.entries(read)) if (value !== undefined) env[key] = value
  const [cwd, id] = await Promise.all([$.session.cwd(), $.session.id()])
  session.storeKey = `state:${id}`
  session.state = mergeBrowserState(cwd, await $.store.get(session.storeKey))
  return session.state
}

async function persist($: $): Promise<void> {
  if (session.state) await $.store.set(session.storeKey, serializeBrowserState(session.state))
}

/**
 * The host the core runs on: $.process and $.fs in place of pi.exec and node:fs.
 *
 * Given the dispatch's signal, commands run through $.process.spawn, whose child dies when
 * the dispatch is abandoned, so Esc stops a long wait or a hung page instead of leaving it
 * running for up to ten minutes. Without one (a timer's frame grab) they use $.process.run.
 */
async function makeHost($: $, signal?: AbortSignal): Promise<BrowserHost> {
  const [cwd, sessionId] = await Promise.all([$.session.cwd(), $.session.id()])
  return {
    exec: (command, args, { timeout }) =>
      signal ? spawnCommand($, [command, ...args], timeout, signal) : runCommand($, [command, ...args], timeout),
    writeFile: (path, text) => $.fs.write(path, text),
    async writePrivateFile(path, text) {
      // umask before the file exists, so it is never readable by anyone else, even briefly.
      const ran = await $.process.run(
        ['/bin/sh', '-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1" && chmod 600 "$1"', 'sh', path],
        { stdin: text },
      )
      if (ran.exitCode !== 0) throw new Error(`Could not write ${path}: ${ran.stderr.trim()}`)
    },
    async ensureDir(path) {
      await $.process.run(['mkdir', '-p', path])
    },
    cwd,
    homeDir: env.HOME ?? '',
    sessionId,
    sessionPrefix: 'cc',
    markerFaviconHref: CLAUDE_FAVICON_HREF,
  }
}

async function runCommand($: $, argv: string[], timeout: number): Promise<ExecResult> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: Math.min(Math.max(timeout, 1000), 600_000) })
    return { stdout: ran.stdout, stderr: ran.stderr, code: ran.exitCode }
  } catch (error) {
    // $.process.run rejects on a timeout or a command that cannot start; pi.exec reports
    // both as a failed run, which is what the core's classifier expects.
    return { stdout: '', stderr: error instanceof Error ? error.message : String(error), code: 1, killed: true }
  }
}

async function spawnCommand($: $, argv: string[], timeout: number, signal: AbortSignal): Promise<ExecResult> {
  const child = $.process.spawn({ argv })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const timer = $.clock.after(timeout, () => {
    timedOut = true
    void child.return(undefined as never)
  })
  try {
    for await (const piece of child) {
      if (piece.stream === 'stderr') stderr += piece.text
      else stdout += piece.text
    }
    const { code } = await child.result
    return { stdout, stderr, code: code ?? 1, killed: code === null }
  } catch (error) {
    if (signal.aborted) return { stdout, stderr: 'Interrupted.', code: 130, killed: true }
    if (timedOut) return { stdout, stderr: `${stderr}\nTimed out after ${timeout}ms.`, code: 1, killed: true }
    return { stdout, stderr: error instanceof Error ? error.message : String(error), code: 1, killed: true }
  } finally {
    timer.cancel()
  }
}

/** Waits without spending the hook's own budget: a $.process call is free, a clock wait is not. */
async function pause($: $, ms: number): Promise<void> {
  await $.process.run(['sleep', String(ms / 1000)], { timeoutMs: ms + 5000 })
}

/** The status line says where the browser is, in plain words; hidden with nothing to say. */
function refreshChip($: $): void {
  const state = session.state
  if (!state) return
  // Claude Code already labels the line with the plugin's name, so the chip skips its own.
  const chip = chipText({ fg: (_color, text) => text }, state, connectionHealth(state), undefined, false) || undefined
  if (chip === session.lastChip) return
  session.lastChip = chip
  $.ui.status(chip)
}

async function handoffPorts($: $, signal?: AbortSignal): Promise<HandoffPorts> {
  return {
    host: await makeHost($, signal),
    cleanupHost: await makeHost($),
    redraw: () => $.ui.invalidate('ui.render'),
    toast: text => $.ui.toast(text),
    pause: ms => pause($, ms),
    signal,
  }
}

async function openView($: $): Promise<void> {
  live.open = true
  live.address = formatAddress(session.state?.currentUrl)
  await $.ui.open({ id: VIEW_PANE, title: 'browser' })
  live.timer?.cancel()
  live.timer = $.clock.every(FRAME_EVERY_MS, () => void grabFrame($))
  await measureViewport($)
  await grabFrame($)
}

async function closeView($: $): Promise<void> {
  stopView()
  await $.ui.close({ id: VIEW_PANE })
}

/** The viewport's aspect, read again after each browser call: navigation or a resize. */
async function measureViewport($: $): Promise<void> {
  const state = session.state
  if (!live.open || !state?.connected) return
  takeViewport(await runPinnedCommand(await makeHost($), state, ['eval', 'JSON.stringify([innerWidth, innerHeight])'], 10_000, { allowFailure: true }))
}

async function grabFrame($: $): Promise<void> {
  const state = session.state
  live.connected = Boolean(state?.connected)
  if (!live.open || live.grabbing || !state?.connected || !state.targetId) return
  live.grabbing = true
  try {
    const file = nextFrameFile(state.artifactDir)
    // A miss (the tab mid-navigation, the browser busy) keeps the last frame.
    const out = await runPinnedCommand(await makeHost($), state, ['screenshot', file], 15_000, { allowFailure: true })
    if (!out) return
    live.generation += 1
    live.file = file
    const address = formatAddress(state.currentUrl)
    const source = { file, format: 'png' as const, generation: live.generation }
    const blit = address === live.address ? await $.ui.blit({ requestId: VIEW_PANE, key: FRAME_KEY, source }) : { deny: 'a new page' }
    live.address = address
    // Not mounted yet, a new size, or a new page to title: draw the pane afresh.
    if (blit.deny) $.ui.invalidate('ui.render')
  } finally {
    live.grabbing = false
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type Input = Record<string, any>

interface StoredRow {
  activity: string
  presentation?: Presentation
  failure?: { reason: string; hint?: string }
  screenshot?: string
}

interface RunContext {
  /** What a handoff needs from the engine, bound to this call's dispatch. */
  handoff(): Promise<HandoffPorts>
}

interface BrowserTool {
  name: string
  description: string
  properties: Record<string, unknown>
  required?: string[]
  compat?: Parameters<typeof prepareCompatArguments>[1]
  run(host: BrowserHost, state: BrowserState, input: Input, context: RunContext): Promise<BrowserActionResult>
}

const WAIT_MODE = { type: 'string', enum: ['none', 'load', 'networkidle'] }
const REF = { type: 'string', description: 'Interactive element ref like @e12 or e12' }

const TOOLS: BrowserTool[] = [
  {
    name: 'browser_status',
    description: 'Probe agent-browser compatibility, live CDP state, and the strict session-to-tab binding.',
    properties: {},
    async run(host, state) {
      const probe = await verifyConnection(host, state).catch(() => undefined)
      return { summary: browserSummaryWithVersion(state, probe), diagnostics: { probe } }
    },
  },
  {
    name: 'browser_connect',
    description: "Connect a strictly tab-pinned session to the user's Arc or Chromium over CDP.",
    properties: { port: { type: 'number', description: 'Remote debugging port. Defaults to PI_BROWSER_PORT or 9222.' } },
    compat: { aliases: { debugPort: 'port' }, numberFields: ['port'] },
    async run(host, state, input) {
      if (typeof input.port === 'number') state.port = resolveBrowserPort(input.port)
      return connectBrowser(host, state)
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in the controlled tab and optionally wait for the page to settle.',
    properties: { url: { type: 'string', description: 'Absolute URL to open' }, waitMode: WAIT_MODE },
    required: ['url'],
    run: (host, state, input) => openBrowserPage(host, state, input.url, (input.waitMode ?? 'networkidle') as WaitMode),
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture a page snapshot, interactive elements only by default. Scope with selector or depth on heavy SPAs; delta=true returns only changes since the last snapshot.',
    properties: {
      interactiveOnly: { type: 'boolean', description: 'Capture only interactive elements (default true)' },
      includeUrls: { type: 'boolean', description: 'Include href URLs on link elements' },
      depth: { type: 'number', description: 'Limit accessibility tree depth' },
      selector: { type: 'string', description: 'Scope snapshot to a CSS selector subtree' },
      delta: { type: 'boolean', description: 'Return only what changed since the last snapshot with the same options' },
      label: { type: 'string', description: 'Optional artifact label' },
    },
    compat: { aliases: { interactive: 'interactiveOnly', scope: 'selector' }, booleanFields: ['interactiveOnly', 'includeUrls', 'delta'], numberFields: ['depth'] },
    run: (host, state, input) =>
      snapshotBrowserPage(host, state, input.interactiveOnly ?? true, input.label ?? 'snapshot', {
        urls: input.includeUrls,
        depth: input.depth,
        selector: input.selector,
        delta: input.delta,
      }),
  },
  {
    name: 'browser_read',
    description: 'Fetch agent-readable text from a URL (markdown/llms.txt aware), or read the rendered controlled tab when url is omitted.',
    properties: {
      url: { type: 'string', description: 'URL to fetch. Omit to read the controlled tab.' },
      filter: { type: 'string', description: 'Narrow to matching heading sections' },
      outline: { type: 'boolean', description: 'Return a compact heading outline' },
    },
    run: (host, state, input) => readBrowserContent(host, state, input as ReadArgsOptions),
  },
  {
    name: 'browser_click',
    description: 'Click an element by its @ref from the latest snapshot; re-snapshots afterwards by default.',
    properties: { ref: REF, waitMode: WAIT_MODE, resnapshot: { type: 'boolean' } },
    required: ['ref'],
    compat: { aliases: { element: 'ref', selector: 'ref' }, booleanFields: ['resnapshot'] },
    run: (host, state, input) =>
      clickBrowserElement(host, state, input.ref, (input.waitMode ?? 'networkidle') as WaitMode, input.resnapshot ?? true, false),
  },
  {
    name: 'browser_find',
    description:
      'Find an element by role/text/label/placeholder/alt/title/testid (or first/last/nth CSS) and act on it in one step. Always acts.',
    properties: {
      locator: { type: 'string', enum: ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth'] },
      value: { type: 'string', description: 'Locator value, or a CSS selector for first/last/nth' },
      action: { type: 'string', enum: ['click', 'fill', 'type', 'hover', 'focus', 'check', 'uncheck'] },
      text: { type: 'string', description: 'Text for fill/type' },
      name: { type: 'string', description: 'Accessible-name filter (role locator only)' },
      nthIndex: { type: 'number' },
      exact: { type: 'boolean' },
      waitMode: WAIT_MODE,
      resnapshot: { type: 'boolean' },
    },
    required: ['locator', 'value', 'action'],
    compat: { aliases: { index: 'nthIndex' }, booleanFields: ['exact', 'resnapshot'], numberFields: ['nthIndex'] },
    run: (host, state, input) =>
      findBrowserElement(host, state, {
        locator: input.locator,
        value: input.value,
        action: input.action as FindAction,
        nthIndex: input.nthIndex,
        text: input.text,
        name: input.name,
        exact: input.exact,
        waitMode: input.waitMode as WaitMode | undefined,
        resnapshot: input.resnapshot,
      }),
  },
  {
    name: 'browser_fill',
    description: 'Fill an input by @ref.',
    properties: { ref: REF, text: { type: 'string' }, waitMode: WAIT_MODE },
    required: ['ref', 'text'],
    compat: { aliases: { element: 'ref', value: 'text' } },
    run: (host, state, input) => fillBrowserElement(host, state, input.ref, input.text, (input.waitMode ?? 'none') as WaitMode),
  },
  {
    name: 'browser_press',
    description: 'Press a key such as Enter, Tab, Escape or Control+a.',
    properties: { key: { type: 'string' }, waitMode: WAIT_MODE },
    required: ['key'],
    run: (host, state, input) => pressBrowserKey(host, state, input.key, (input.waitMode ?? 'none') as WaitMode),
  },
  {
    name: 'browser_tab',
    description: 'List, open, close or switch tabs by id (t1), label, or durable CDP targetId.',
    properties: {
      action: { type: 'string', enum: ['list', 'new', 'close', 'switch'] },
      url: { type: 'string' },
      label: { type: 'string' },
      tab: { type: 'string' },
    },
    required: ['action'],
    run: (host, state, input) => tabBrowser(host, state, { action: input.action as TabAction, url: input.url, label: input.label, tab: input.tab }),
  },
  {
    name: 'browser_checkpoint',
    description: 'Save a screenshot plus an interactive snapshot for verification. ifChanged=true skips an unchanged capture.',
    properties: {
      label: { type: 'string', description: 'What is being verified' },
      annotate: { type: 'boolean' },
      ifChanged: { type: 'boolean' },
      delta: { type: 'boolean' },
    },
    required: ['label'],
    compat: { booleanFields: ['annotate', 'ifChanged', 'delta'] },
    run: (host, state, input) =>
      checkpointBrowserPage(host, state, input.label, { annotate: input.annotate, ifChanged: input.ifChanged, delta: input.delta }),
  },
  {
    name: 'browser_handoff',
    description:
      'Hand the controlled tab to the user and wait for them: to log in, pass a captcha or 2FA, confirm a payment, or (pick=true) click the element they mean. The ask shows in the page and above their prompt. Returns when they press Done, pick, or cancel.',
    properties: {
      ask: { type: 'string', description: 'What you need them to do, in one short sentence' },
      pick: { type: 'boolean', description: 'Have them click an element; returns its role, name, text and CSS selector' },
    },
    required: ['ask'],
    compat: { aliases: { message: 'ask', prompt: 'ask' }, booleanFields: ['pick'] },
    async run(_host, state, input, context) {
      const outcome = await runHandoff(await context.handoff(), state, String(input.ask), Boolean(input.pick))
      return { summary: handoffResultText(outcome), diagnostics: { outcome } }
    },
  },
]

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

// Module state. A hot reload starts it over; the browser state itself is reloaded from
// $.store (session.ts), so only the in-flight trail and the snapshot cache are lost.
const trail = new TrailModel()
let trailTimer: { cancel(): void } | undefined

// Every snapshot is saved to a file, so the newest one names what a ref points at.
let snapshotCache: { file: string; text: string } | undefined
let snapshotComparable = false
let snapshotUrl: string | undefined

async function latestSnapshot($: $): Promise<string | undefined> {
  const file = session.state?.lastSnapshotFile
  if (!file) return undefined
  if (snapshotCache?.file !== file) {
    const text = await $.fs.read(file).catch(() => undefined)
    if (text === undefined) return undefined
    snapshotCache = { file, text }
  }
  return snapshotCache.text
}

/** The band redraws only for the next visible change: a motion frame, the fade, the end. */
function pokeTrail($: $): void {
  $.ui.invalidate('ui.render')
  trailTimer?.cancel()
  const delay = trail.nextDelay()
  if (delay !== undefined) trailTimer = $.clock.after(delay, () => pokeTrail($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ready($)
    for (const tool of TOOLS) {
      await $.tool.register({
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object', properties: tool.properties, required: tool.required ?? [] },
      })
    }
    await $.command.register({ name: 'browser', description: 'da-browser: connect [port] | status | view | pick | cleanup' })
    // A browser task is many snapshots deep; a subagent keeps them out of the main context.
    await $.agent.register({
      name: 'browser',
      description:
        "Drives the user's signed-in browser for a self-contained web task (find, read, fill, check something on a page) and reports back briefly, keeping page snapshots out of the main context.",
      prompt: AGENT_PROMPT,
      tools: TOOLS.map(tool => `${PREFIX}${tool.name}`),
      model: 'sonnet',
    })
    refreshChip($)
    return started
  })

  for (const tool of TOOLS) {
    on('tool.call', { tool: `${PREFIX}${tool.name}` }, async ($, e, next) => {
      const current = await ready($)
      const host = await makeHost($, next.signal)
      const { tool: _tool, tool_use_id: id, ...raw } = e as unknown as Input
      const input = tool.compat ? (prepareCompatArguments(raw, tool.compat) as Input) : raw

      const snapshot = await latestSnapshot($)
      const before = { url: current.currentUrl, snapshot, comparable: snapshotComparable && snapshotUrl === current.currentUrl }
      const snapshotFileBefore = current.lastSnapshotFile
      const activity = describeActivity(tool.name, input, ref => (snapshot ? snapshotLabel(snapshot, ref) : undefined))
      trail.begin(id, activity)
      pokeTrail($)
      const startedAt = Date.now()

      try {
        const result = await tool.run(host, current, input, { handoff: () => handoffPorts($, next.signal) })
        const freshSnapshot = current.lastSnapshotFile !== snapshotFileBefore
        if (freshSnapshot) {
          const partial = Boolean(input.selector || input.depth || input.delta)
          snapshotComparable = !((tool.name === 'browser_snapshot' || tool.name === 'browser_checkpoint') && partial)
          snapshotUrl = current.currentUrl
        }
        const text = [result.summary, result.contentText].filter(Boolean).join('\n\n')
        const presentation = presentResult({
          tool: tool.name,
          params: input,
          text,
          details: { ...result.diagnostics, artifacts: result.artifacts },
          before,
          after: { url: current.currentUrl, snapshot: freshSnapshot ? await latestSnapshot($) : undefined, comparable: snapshotComparable },
          durationMs: Date.now() - startedAt,
          snapshotFiles: [snapshotFileBefore, current.lastSnapshotFile].filter((file): file is string => Boolean(file)),
        })
        // A plugin tool's result is text the model reads; the row's facts live in the store,
        // keyed by the call, so a resumed transcript draws the same row.
        const screenshot = typeof result.diagnostics?.screenshotFile === 'string' ? result.diagnostics.screenshotFile : undefined
        await $.store.set(`row:${id}`, { activity: activity.text, presentation, screenshot })
        trail.end(id, true)
        return { result: text }
      } catch (error) {
        handleFailure(error)
        const message = error instanceof Error ? error.message : String(error)
        await $.store.set(`row:${id}`, { activity: activity.text, failure: explainFailure(message) })
        trail.end(id, false)
        return { deny: message }
      } finally {
        pokeTrail($)
        refreshChip($)
        await persist($)
        if (live.open) void measureViewport($).then(() => grabFrame($))
      }
    })
  }

  on('command.run', { command: 'browser' }, async ($, e, next) => {
    const current = await ready($)
    const host = await makeHost($)
    const [subcommand, ...rest] = e.args.trim().split(/\s+/)
    try {
      if (subcommand === 'connect') {
        const port = Number(rest[0])
        if (Number.isInteger(port) && port > 0) current.port = resolveBrowserPort(port)
        const result = await connectBrowser(host, current)
        return { text: result.summary }
      }
      if (subcommand === 'status') {
        const probe = await verifyConnection(host, current).catch(() => undefined)
        return { text: browserSummaryWithVersion(current, probe) }
      }
      if (subcommand === 'view') {
        if (live.open && rest[0] !== 'open') {
          await closeView($)
          return { text: 'Closed the live view.' }
        }
        await openView($)
        return { text: 'Opened the live view of the pinned tab.' }
      }
      if (subcommand === 'pick') {
        const ask = rest.join(' ') || 'Click the element you want to talk about'
        const outcome = await runHandoff(await handoffPorts($, next.signal), current, ask, true)
        if (outcome.status !== 'picked') return { text: `No element picked (${outcome.status === 'cancelled' ? outcome.reason : outcome.status}).` }
        // The pick goes into the prompt, for the person to ask about.
        await $.prompt.fill({ text: `${outcome.text}\n\n`, mode: 'insert' })
        return { text: 'Picked an element; it is in your prompt.' }
      }
      if (subcommand === 'cleanup') {
        await cleanupBrowserArtifacts(current)
        current.lastAction = 'cleanup'
        current.lastError = undefined
        return { text: `Marked browser as disconnected. Artifact files remain in ${current.artifactDir}.` }
      }
      return { text: 'Usage: /browser connect [port] | status | view | pick [what to pick] | cleanup' }
    } catch (error) {
      handleFailure(error)
      return { text: error instanceof Error ? error.message : String(error) }
    } finally {
      refreshChip($)
      await persist($)
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.some(name => name.startsWith(PREFIX))) return composed
    return { ...composed, sections: [...composed.sections, { id: `${PLUGIN}:guidelines`, text: GUIDELINES, scope: 'session' as const }] }
  })

  // Raw agent-browser over CDP skips the per-session pin and can take over another
  // session's tab. Version checks and other non-attaching commands still run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Only where agent-browser runs as a command (line start, or after ; & | ( ), so a
    // commit message or PR body that merely mentions it is not refused.
    const attaches =
      /(?:^|[;&|(]|\n)\s*(?:\w+=\S*\s+)*(?:npx\s+(?:-y\s+)?)?agent-browser\b[^\n;&|]*?(?:--cdp\b|--auto-connect\b|\sconnect\b)/.test(e.command)
    if (!attaches) return next(e)
    return {
      deny: `${PLUGIN}: agent-browser over CDP from Bash bypasses this session's pinned tab. Use the ${PREFIX}browser_* tools (browser_connect, browser_open, browser_snapshot, ...) instead.`,
    }
  })

  // The band: what the browser is doing right now, only during a burst.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const address = session.state ? formatAddress(session.state.currentUrl) : undefined
    if (handoffPending()) return renderHandoffBand($.ui.resolve(e), () => $.ui.invalidate('ui.render'), address) ?? next(e)
    const view = trail.view()
    if (!view) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const steps = view.steps.slice(-6)
    return (
      <Box flexDirection="row">
        <Text dimColor> da browser  </Text>
        {steps.length < view.steps.length ? <Text dimColor>… › </Text> : null}
        {steps.map((step, index) => (
          <Text
            key={`step-${index}`}
            color={view.draining ? undefined : step.status === 'failed' ? 'error' : step.status === 'running' ? 'claude' : undefined}
            dimColor={view.draining || step.status === 'done'}
          >
            {step.status === 'failed' ? `✗ ${step.text}` : step.status === 'running' ? (step.frameAfter ? `${step.text}${step.frame}` : `${step.frame} ${step.text}`) : step.text}
            {index < steps.length - 1 ? ' › ' : ''}
          </Text>
        ))}
        {address ? <Text dimColor>{`   ${address}`}</Text> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: VIEW_PANE }, async ($, e) => renderView($.ui.resolve(e), e.surface, e.props))

  on('ui.close', async ($, e, next) => {
    if (e.id === VIEW_PANE) stopView()
    return next(e)
  })

  // Tool rows answer "what did it do, what changed": the call in a few words on the
  // ToolUse row, then only new facts on the ToolResult row. The raw output (snapshots,
  // page text) goes to the model, never the transcript.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const tool = String(e.props.tool)
    if (!tool.startsWith(PREFIX)) return next(e)
    const { Text } = $.ui.resolve(e)
    const row = (await $.store.get(`row:${e.requestId}`)) as StoredRow | undefined
    const callText = row?.activity ?? describeActivity(tool.slice(PREFIX.length), e.props.input as Input).text
    return (
      <Text>
        <Text bold>browser</Text> {callText}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const tool = String(e.props.tool)
    if (!tool.startsWith(PREFIX)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const row = (await $.store.get(`row:${e.requestId}`)) as StoredRow | undefined
    if (!row) return next(e)
    if (row.failure) {
      return (
        <Text>
          <Text color="error">  {row.failure.reason}</Text>
          {row.failure.hint ? <Text dimColor>  {row.failure.hint}</Text> : null}
        </Text>
      )
    }
    const presentation = row.presentation
    const files = presentation?.files.map(file => artifactName(file)) ?? []
    if (!presentation || presentation.facts.length + files.length === 0) return <Box />
    const tone = (fact: Fact) => (fact.tone === 'success' || fact.tone === 'error' || fact.tone === 'warning' ? fact.tone : undefined)
    const line = (
      <Text>
        {'  '}
        {presentation.facts.map((fact, index) => (
          <Text key={`fact-${index}`} color={tone(fact)} dimColor={fact.tone === 'dim' || fact.tone === 'muted'}>
            {index > 0 ? '  ' : ''}
            {fact.text}
          </Text>
        ))}
        {files.map((file, index) => (
          <Text key={`file-${index}`} dimColor>
            {presentation.facts.length + index > 0 ? '  ' : ''}
            {file}
          </Text>
        ))}
      </Text>
    )
    // A checkpoint's screenshot is the evidence; show it small under the facts.
    if (!row.screenshot || e.surface !== 'terminal') return line
    const { Image } = $.ui.resolve(e as typeof e & { surface: 'terminal' })
    const columns = Math.min(64, Math.max(16, (e.viewport?.columns ?? 80) - 6))
    return (
      <Box flexDirection="column">
        {line}
        <Box paddingLeft={2}>
          <Image source={{ file: row.screenshot, format: 'png' }} columns={columns} rows={Math.round(columns / 3.4)} alt={artifactName(row.screenshot)} />
        </Box>
      </Box>
    )
  })
}
