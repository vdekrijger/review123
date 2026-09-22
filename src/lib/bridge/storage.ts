/**
 * bridge/storage.ts — the persisted bridge pairing, and nothing else.
 *
 * Split out of `bridge.svelte.ts` on purpose. The connection STATE MACHINE is a
 * `$state` rune that also reports to analytics; the stored TOKEN is a plain
 * localStorage record. The LLM transport layer needs only the second one, and
 * pulling `bridge.svelte.ts` into `llm/` would drag a rune store and the
 * analytics SDK into every module that so much as asks "is a bridge paired?".
 *
 * Nothing here throws. Safari private mode and blocked site data both make
 * localStorage access throw, and a bridge that cannot remember its token must
 * degrade to "not paired", not to a broken settings page.
 */

import { DEFAULT_BRIDGE_PORT } from './protocol'

/** localStorage key holding the pairing token + port. */
export const BRIDGE_STORAGE_KEY = 'review123:bridge'

/** What we persist. The token is a local-process credential, not a secret key. */
export interface StoredBridge {
  token: string
  port: number
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** The stored pairing, or null. Never throws — see the module header. */
export function readStoredBridge(): StoredBridge | null {
  try {
    const raw = localStorage.getItem(BRIDGE_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const token = record['token']
    const port = record['port']
    if (typeof token !== 'string' || token === '') return null
    return { token, port: typeof port === 'number' && isValidPort(port) ? port : DEFAULT_BRIDGE_PORT }
  } catch {
    return null
  }
}

export function writeStoredBridge(value: StoredBridge): void {
  try {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage is a convenience here: the in-memory connection still works for
    // this session, the user just re-pastes the token next time.
  }
}

export function clearStoredBridge(): void {
  try {
    localStorage.removeItem(BRIDGE_STORAGE_KEY)
  } catch {
    // ignore — see writeStoredBridge
  }
}
