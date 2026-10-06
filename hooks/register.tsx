import type { EngineInterface, Register } from 'claude-code'

import {
  cleanupBrowserArtifacts,
  connectBrowser,
  verifyConnection,
  CdpError,
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
import { BROWSER_GUIDELINES, BROWSER_TOOLS, prepareBrowserInput } from '../src/browser-tools.ts'
import { env } from '../src/env.ts'
import { CLAUDE_FAVICON_HREF } from './claude-favicon.ts'
import type { BrowserHost } from '../src/host.ts'
import {
  browserSummaryWithVersion,
  connectionHealth,
  mergeBrowserState,
  resolveBrowserPort,
  serializeBrowserState,
  type BrowserState,
} from '../src/state.ts'

// da-browser as a Claude Code mod. The browser core in ../src is shared with the pi
// extension; this file is the Claude Code host: its tools, /browser, and the same three
// surfaces pi has, each answering one question:
//   status line   where is the agent's browser?   static, hidden when idle
//   band          what is it doing right now?     above the prompt, only during a burst
//   tool rows     what did it do, what changed?   call line, then only new facts

type $ = EngineInterface

const PLUGIN = 'da-browser'
const PREFIX = `mcp__${PLUGIN}__`

const GUIDELINES = `# da-browser

The mcp__da-browser__browser_* tools drive the user's own authenticated Arc/Chromium through agent-browser, on one strictly pinned tab per session.

${[...BROWSER_GUIDELINES, 'Never drive agent-browser through Bash with --cdp or connect; that bypasses the per-session tab pin.']
  .map(line => `- ${line}`)
  .join('\n')}`

// ---------------------------------------------------------------------------
// The host the core runs on: $.process and $.fs in place of pi.exec and node:fs
// ---------------------------------------------------------------------------

async function makeHost($: $): Promise<BrowserHost> {
  const [cwd, sessionId] = await Promise.all([$.session.cwd(), $.session.id()])
  return {
    async exec(command, args, { timeout }) {
      try {
        const ran = await $.process.run([command, ...args], { timeoutMs: Math.min(Math.max(timeout, 1000), 600_000) })
        return { stdout: ran.stdout, stderr: ran.stderr, code: ran.exitCode }
      } catch (error) {
        // $.process.run rejects on a timeout or a command that cannot start; pi.exec
        // reports both as a failed run, which is what the core's classifier expects.
        return { stdout: '', stderr: error instanceof Error ? error.message : String(error), code: 1, killed: true }
      }
    },
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

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type Input = Record<string, any>

interface StoredRow {
  activity: string
  presentation?: Presentation
  failure?: { reason: string; hint?: string }
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

// Module state. A hot reload starts it over; the browser state itself is reloaded from
// $.store, so only the in-flight trail and the snapshot cache are lost.
let state: BrowserState | undefined
let storeKey = ''
const trail = new TrailModel()
let trailTimer: { cancel(): void } | undefined
let lastChip: string | undefined | null = null

// Every snapshot is saved to a file, so the newest one names what a ref points at.
let snapshotCache: { file: string; text: string } | undefined
let snapshotComparable = false
let snapshotUrl: string | undefined

async function latestSnapshot($: $): Promise<string | undefined> {
  const file = state?.lastSnapshotFile
  if (!file) return undefined
  if (snapshotCache?.file !== file) {
    const text = await $.fs.read(file).catch(() => undefined)
    if (text === undefined) return undefined
    snapshotCache = { file, text }
  }
  return snapshotCache.text
}

async function ready($: $): Promise<BrowserState> {
  if (state) return state
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
  storeKey = `state:${id}`
  state = mergeBrowserState(cwd, await $.store.get(storeKey))
  return state
}

async function persist($: $): Promise<void> {
  if (state) await $.store.set(storeKey, serializeBrowserState(state))
}

/** The status line says where the browser is, in plain words; hidden with nothing to say. */
function refreshChip($: $): void {
  if (!state) return
  // Claude Code already labels the line with the plugin's name, so the chip skips its own.
  const chip = chipText({ fg: (_color, text) => text }, state, connectionHealth(state), undefined, false) || undefined
  if (chip === lastChip) return
  lastChip = chip
  $.ui.status(chip)
}

/** The band redraws only for the next visible change: a motion frame, the fade, the end. */
function pokeTrail($: $): void {
  $.ui.invalidate('ui.render')
  trailTimer?.cancel()
  const delay = trail.nextDelay()
  if (delay !== undefined) trailTimer = $.clock.after(delay, () => pokeTrail($))
}

function handleFailure(error: unknown): void {
  if (!state) return
  state.lastError = error instanceof Error ? error.message : String(error)
  if (error instanceof CdpError && error.kind === 'tab-gone') {
    state.connected = true
    state.targetId = undefined
    state.tabGoneTargetId = error.targetId ?? state.tabGoneTargetId
    state.tabGoneLastUrl = error.lastUrl ?? state.tabGoneLastUrl
    state.currentUrl = undefined
    state.currentDomain = undefined
  } else if (error instanceof CdpError && (error.kind === 'browser-down' || error.kind === 'target-gone')) {
    state.connected = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ready($)
    for (const tool of BROWSER_TOOLS) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.parameters })
    }
    await $.command.register({ name: 'browser', description: 'da-browser: connect [port] | status | cleanup' })
    refreshChip($)
    return started
  })

  for (const tool of BROWSER_TOOLS) {
    on('tool.call', { tool: `${PREFIX}${tool.name}` }, async ($, e) => {
      const current = await ready($)
      const host = await makeHost($)
      const { tool: _tool, tool_use_id: id, consent: _consent, ...raw } = e as unknown as Input
      const input = prepareBrowserInput(tool, raw)

      const snapshot = await latestSnapshot($)
      const before = { url: current.currentUrl, snapshot, comparable: snapshotComparable && snapshotUrl === current.currentUrl }
      const snapshotFileBefore = current.lastSnapshotFile
      const activity = describeActivity(tool.name, input, ref => (snapshot ? snapshotLabel(snapshot, ref) : undefined))
      trail.begin(id, activity)
      pokeTrail($)
      const startedAt = Date.now()

      try {
        const result = await tool.run(host, current, input)
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
        await $.store.set(`row:${id}`, { activity: activity.text, presentation })
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
      }
    })
  }

  on('command.run', { command: 'browser' }, async ($, e) => {
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
      if (subcommand === 'cleanup') {
        await cleanupBrowserArtifacts(current)
        current.lastAction = 'cleanup'
        current.lastError = undefined
        return { text: `Marked browser as disconnected. Artifact files remain in ${current.artifactDir}.` }
      }
      return { text: 'Usage: /browser connect [port] | status | cleanup' }
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
    const view = trail.view()
    if (!view) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const address = state ? formatAddress(state.currentUrl) : undefined
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
    return (
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
  })
}
