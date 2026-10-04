import type { ElementTable } from 'claude-code'

import { runPinnedCommand } from '../src/agent-browser.ts'
import {
  describePicked,
  handoffShowScript,
  HANDOFF_CLEAR_SCRIPT,
  HANDOFF_POLL_SCRIPT,
  parseHandoffPoll,
  type HandoffPageResult,
} from '../src/handoff-scripts.ts'
import type { BrowserHost } from '../src/host.ts'
import type { BrowserState } from '../src/state.ts'

// Handing the browser to the person. The agent cannot log in, pass a captcha, or know which
// of twelve "Edit" buttons was meant; the person can, in seconds. A handoff puts the ask
// where they look (a bar across the page, a band above the prompt) and waits, at no cost to
// the hook's budget, until they press Done, pick an element in the page, or cancel.

const POLL_MS = 400
const LIMIT_MS = 15 * 60_000

export type HandoffOutcome =
  | { status: 'done'; url?: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'picked'; text: string; url?: string }

/** What a handoff needs from the engine, built by register.tsx. */
export interface HandoffPorts {
  /** Runs the page's commands; its children die with the dispatch on Esc. */
  host: BrowserHost
  /** Takes the bar down after the dispatch is gone, so it never outlives the handoff. */
  cleanupHost: BrowserHost
  redraw(): void
  toast(text: string): void
  /** A wait that does not spend the hook's budget. */
  pause(ms: number): Promise<void>
  signal?: AbortSignal
}

interface Pending {
  ask: string
  pick: boolean
  answer?: 'done' | 'cancel'
}

let pending: Pending | undefined

export function handoffPending(): boolean {
  return pending !== undefined
}

export async function runHandoff(ports: HandoffPorts, state: BrowserState, ask: string, pick: boolean): Promise<HandoffOutcome> {
  if (pending) throw new Error('A handoff is already waiting for the user.')
  if (!state.connected || !state.targetId) throw new Error('No pinned tab. Call browser_connect first.')
  const { host, cleanupHost, signal } = ports
  await runPinnedCommand(host, state, ['eval', handoffShowScript(ask, pick)], 15_000)
  pending = { ask, pick }
  ports.redraw()
  ports.toast(pick ? 'Claude asks you to point at something in the browser' : 'Claude needs you in the browser')

  let page: HandoffPageResult | undefined
  let answer: Pending['answer']
  const deadline = Date.now() + LIMIT_MS
  try {
    while (!pending.answer && !signal?.aborted && Date.now() < deadline) {
      if (pick) {
        page = parseHandoffPoll(await runPinnedCommand(host, state, ['eval', HANDOFF_POLL_SCRIPT], 10_000, { allowFailure: true }))
        if (page) break
      }
      await ports.pause(POLL_MS)
    }
  } finally {
    answer = pending.answer
    pending = undefined
    ports.redraw()
    if (page?.status !== 'picked') await runPinnedCommand(cleanupHost, state, ['eval', HANDOFF_CLEAR_SCRIPT], 10_000, { allowFailure: true })
  }

  const url = (await runPinnedCommand(cleanupHost, state, ['get', 'url'], 10_000, { allowFailure: true })).trim() || undefined
  if (url) state.currentUrl = url
  if (page?.status === 'picked') return { status: 'picked', text: describePicked(page.element), url }
  if (answer === 'done') return { status: 'done', url }
  const reason = signal?.aborted ? 'interrupted' : page ? 'cancelled in the page' : answer === 'cancel' ? 'cancelled' : 'timed out'
  return { status: 'cancelled', reason }
}

/** The model's view of how the handoff ended. */
export function handoffResultText(outcome: HandoffOutcome): string {
  const where = 'url' in outcome && outcome.url ? `The page is now ${outcome.url}.` : ''
  if (outcome.status === 'picked') return [outcome.text, where].filter(Boolean).join('\n')
  if (outcome.status === 'done') return ['The user says they are done.', where, 'Refs from before are stale: snapshot before acting.'].filter(Boolean).join(' ')
  return `The user did not complete the handoff (${outcome.reason}). Ask how they want to proceed rather than retrying it.`
}

/** The band while a handoff waits: the ask, and the buttons that answer it. */
export function renderHandoffBand(ui: ElementTable, redraw: () => void, address: string | undefined) {
  if (!pending) return undefined
  const current = pending
  const { Box, Button, Text } = ui
  const answer = (value: 'done' | 'cancel') => () => {
    current.answer = value
    redraw()
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="claude">{current.pick ? 'Point at it in the browser  ' : 'Claude needs you in the browser  '}</Text>
        <Text>{current.ask}</Text>
      </Box>
      <Box flexDirection="row">
        {current.pick ? null : <Button key="done" label="Done" hotkey="d" variant="primary" onPress={answer('done')} />}
        {current.pick ? null : <Text> </Text>}
        <Button key="cancel" label="Cancel" hotkey="c" onPress={answer('cancel')} />
        <Text dimColor>
          {'  '}
          {current.pick ? 'click the element in the tab, or Esc there' : 'click, or ctrl+x tab then d or c'}
          {address ? `   ${address}` : ''}
        </Text>
      </Box>
    </Box>
  )
}
