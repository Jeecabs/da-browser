import { CdpError } from '../src/agent-browser.ts'
import type { BrowserState } from '../src/state.ts'

// What every part of the mod shares. The engine follows $ only into functions declared in
// register.tsx, so everything that calls the engine lives there; the modules beside it hold
// state and logic, and take what they need from it as plain values and callbacks.

export const PLUGIN = 'da-browser'
export const PREFIX = `mcp__${PLUGIN}__`

/**
 * The browser state for this session. A hot reload starts the module over; the state is
 * read back from $.store, so the binding to the pinned tab survives it.
 */
export const session: { state?: BrowserState; storeKey: string; lastChip: string | undefined | null } = {
  storeKey: '',
  lastChip: null,
}

export function handleFailure(error: unknown): void {
  const state = session.state
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
