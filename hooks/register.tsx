import type { EngineInterface, Register } from 'claude-code'

import {
  cleanupBrowserArtifacts,
  connectBrowser,
  stopCapturesNow,
  verifyConnection,
  CdpError,
} from '../src/agent-browser.ts'
import { attachesAgentBrowserOverCdp } from '../src/agent-browser-args.ts'
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
    markerAccent: 'coral',
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
  /** When it was written: $.store outlives sessions, so rows past ROW_TTL_MS are pruned. */
  at?: number
}

const ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000

const BASH_DENY = `${PLUGIN}: agent-browser over CDP from Bash bypasses this session's pinned tab. Use the ${PREFIX}browser_* tools (browser_connect, browser_open, browser_snapshot, ...) instead.`

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

/**
 * Off the start path, as pi does on start: probe the CLI version and the port, so state
 * restored from the store is checked rather than assumed, then prune old tool rows. Rows
 * written before rows were dated go too; their transcripts draw the engine's own row.
 */
async function startupChecks($: $): Promise<void> {
  const current = await ready($)
  const probe = await verifyConnection(await makeHost($), current).catch(() => undefined)
  if (probe && !probe.agentBrowserCompatible) {
    $.ui.toast(
      `da-browser requires agent-browser >=${probe.requiredAgentBrowserVersion}; found ${probe.agentBrowserVersion ?? 'not found'}. Run: npm i -g agent-browser@latest`,
    )
  }
  refreshChip($)
  await persist($)
  const now = Date.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('row:')) continue
    const row = (await $.store.get(key)) as StoredRow | undefined
    if (!row?.at || now - row.at > ROW_TTL_MS) await $.store.delete(key)
  }
}

/** The status line says where the browser is, in plain words; hidden with nothing to say. */
function refreshChip($: $): void {
  if (!state) return
  // Claude Code already labels the line with the plugin's name, so the chip skips its own.
  // The line is plain text: where pi colours a running capture (rec, trace, har), mark it.
  const plain = { fg: (_color: unknown, text: string) => (['rec', 'trace', 'har'].includes(text) ? `⏺ ${text}` : text) }
  const chip = chipText(plain, state, connectionHealth(state), undefined, false) || undefined
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
    $.clock.after(0, () => void startupChecks($).catch(() => {}))
    return started
  })

  // Every end, a /clear included, leaves this session's daemon behind, and its exit would
  // truncate a running capture: stop it while the ending session's id still names the daemon.
  // A /clear then goes on under a new session id with no session.start, so forget this
  // conversation's browser and let the next call load the new session's own state and tab.
  on('session.end', async ($, e, next) => {
    if (state && (state.recording || state.har || state.tracing)) {
      await stopCapturesNow({ ...(await makeHost($)), sessionId: e.sessionId }, state)
      await persist($)
    }
    if (e.reason === 'clear') {
      state = undefined
      snapshotCache = undefined
      snapshotComparable = false
      snapshotUrl = undefined
      lastChip = null
      $.ui.status(undefined)
    }
    return next(e)
  })

  for (const tool of BROWSER_TOOLS) {
    on('tool.call', { tool: `${PREFIX}${tool.name}` }, async ($, e) => {
      const current = await ready($)
      const host = await makeHost($)
      const { tool: _tool, tool_use_id: id, consent: _consent, agentId: _agentId, ...raw } = e as unknown as Input
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
        await $.store.set(`row:${id}`, { activity: activity.text, presentation, at: Date.now() })
        trail.end(id, true)
        return { result: text }
      } catch (error) {
        handleFailure(error)
        const message = error instanceof Error ? error.message : String(error)
        await $.store.set(`row:${id}`, { activity: activity.text, failure: explainFailure(message), at: Date.now() })
        trail.end(id, false)
        return { deny: message }
      } finally {
        pokeTrail($)
        refreshChip($)
        await persist($)
      }
    }).catch(($, _e, next) => ({ deny: `${PLUGIN}: ${next.error.message ?? next.error.kind}` }))
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
        await stopCapturesNow(host, current)
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
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (attachesAgentBrowserOverCdp(e.command) ? { deny: BASH_DENY } : next(e)))
    // A guard that fails refuses, rather than letting an unchecked command through.
    .catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: the Bash guard failed, so the command was refused.` }))

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
    const { Box, Text, Link } = $.ui.resolve(e)
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
    if (!presentation || presentation.facts.length + presentation.files.length === 0) return <Box />
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
        {presentation.files.map((file, index) => (
          <Text key={`file-${index}`} dimColor>
            {presentation.facts.length + index > 0 ? '  ' : ''}
            <Link href={encodeURI(`file://${file}`)} label={artifactName(file)} />
          </Text>
        ))}
      </Text>
    )
    // Only the terminal draws pictures, and only from a PNG file.
    const image = presentation.image
    if (!image?.endsWith('.png') || e.surface !== 'terminal') return line
    const { Image } = $.ui.resolve(e)
    // ponytail: a fixed box like pi's thumbnail; read the PNG's size if sheets look stretched.
    return (
      <Box flexDirection="column">
        {line}
        <Image source={{ file: image, format: 'png' }} columns={36} rows={12} alt={artifactName(image)} />
      </Box>
    )
  })
}
