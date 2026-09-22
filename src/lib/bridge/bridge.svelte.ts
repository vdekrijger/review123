/**
 * bridge.svelte.ts — the browser half of the optional local bridge.
 *
 * Connection state machine, capability store, and the readiness helpers other
 * modules consult before routing work through the bridge. The LLM transport is
 * the first real consumer (`bridge` provider in llm.ts).
 *
 * WITH NO BRIDGE PAIRED THIS MODULE MAKES ZERO NETWORK REQUESTS and the app
 * behaves exactly as it did before. That guarantee survived `initBridge()`
 * moving to app start: the very first thing it does is read the stored token,
 * and with none it returns without touching the network. A first-time visitor's
 * page load is byte-for-byte unchanged.
 *
 * THE PROBE IS SILENT. A bridge that is not running is the normal case — the
 * user closed the terminal, rebooted, or never started one. So a failed probe
 * produces `disconnected`, never an `error`, never a toast, and never an
 * analytics event. Only a probe the user ASKED for (pasting a token and
 * clicking Connect) can surface a failure, because there a failure is news.
 *
 *   disconnected ──connect()──▶ pairing ──ok──▶ connected
 *        ▲                         │              │
 *        │                         └──fail──▶ error
 *        └────────── disconnect() / silent probe failure ──────────┘
 *
 * Timeouts reuse net/signals.ts (#233/#234) rather than reinventing the
 * caller-signal-replaces-the-timeout bug those PRs fixed.
 */

import { track } from '../analytics/analytics'
import { classifyFetchFailure, requestSignals } from '../net/signals'
import {
  clearStoredBridge,
  isValidPort,
  readStoredBridge,
  writeStoredBridge,
  type StoredBridge,
} from './storage'
import {
  DEFAULT_BRIDGE_PORT,
  PROTOCOL_VERSION,
  bridgeUrl,
  parseHealth,
  type BridgeCapabilities,
  type BridgeCapability,
  type BridgeHealth,
} from './protocol'

/**
 * Persistence lives in `./storage` — a rune-free, analytics-free module, so the
 * LLM transport can read the pairing without importing this state machine.
 * Re-exported here so every existing importer keeps its one import site.
 */
export {
  BRIDGE_STORAGE_KEY,
  isValidPort,
  readStoredBridge,
  type StoredBridge,
} from './storage'

/**
 * Probe budget. Deliberately short: a bridge is a process on this machine, so
 * it answers in single-digit milliseconds or it is not there. Waiting longer
 * would only delay the settings page for people who have no bridge.
 */
export const BRIDGE_PROBE_TIMEOUT_MS = 2_500

export type BridgeStatus = 'disconnected' | 'pairing' | 'connected' | 'error'

interface BridgeHolder {
  status: BridgeStatus
  capabilities: BridgeCapabilities | null
  root: string | null
  version: string | null
  /** Only ever set by a USER-initiated connect. Silent probes leave it null. */
  error: string | null
  port: number
  /** True once a token has been stored, i.e. the user paired at least once. */
  paired: boolean
}

function initialHolder(): BridgeHolder {
  const stored = readStoredBridge()
  return {
    status: 'disconnected',
    capabilities: null,
    root: null,
    version: null,
    error: null,
    port: stored?.port ?? DEFAULT_BRIDGE_PORT,
    paired: stored !== null,
  }
}

const holder = $state<BridgeHolder>(initialHolder())

/** Read-only reactive view for components. */
export const bridgeState = {
  get status(): BridgeStatus {
    return holder.status
  },
  get capabilities(): BridgeCapabilities | null {
    return holder.capabilities
  },
  get root(): string | null {
    return holder.root
  },
  get version(): string | null {
    return holder.version
  },
  get error(): string | null {
    return holder.error
  },
  get port(): number {
    return holder.port
  },
  get paired(): boolean {
    return holder.paired
  },
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** Why a probe failed, in terms the settings UI can turn into a sentence. */
type ProbeFailure =
  | { kind: 'unreachable' }
  | { kind: 'unauthorized' }
  | { kind: 'protocol'; protocol: number }
  | { kind: 'malformed' }
  | { kind: 'http'; status: number }

type ProbeResult = { ok: true; health: BridgeHealth } | { ok: false; failure: ProbeFailure }

/**
 * One `GET /v1/health`. Never throws — every outcome is a ProbeResult, so no
 * caller can accidentally let a missing bridge become an unhandled rejection
 * or a visible error.
 */
export async function probeBridge(token: string, port: number): Promise<ProbeResult> {
  const { timeoutSignal, effectiveSignal } = requestSignals(null, BRIDGE_PROBE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(bridgeUrl(port, '/v1/health'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      // The bridge is bearer-token authenticated; never attach ambient cookies.
      credentials: 'omit',
      cache: 'no-store',
      signal: effectiveSignal,
    })
  } catch (err) {
    // A timeout, a cancellation and a refused connection all mean the same
    // thing to the user: no bridge here. classifyFetchFailure is reused so the
    // distinction stays available if a later PR wants it.
    void classifyFetchFailure(err, timeoutSignal)
    return { ok: false, failure: { kind: 'unreachable' } }
  }

  if (response.status === 401) return { ok: false, failure: { kind: 'unauthorized' } }
  if (!response.ok) return { ok: false, failure: { kind: 'http', status: response.status } }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, failure: { kind: 'malformed' } }
  }

  const health = parseHealth(body)
  if (health === null) return { ok: false, failure: { kind: 'malformed' } }
  if (health.protocol !== PROTOCOL_VERSION) {
    return { ok: false, failure: { kind: 'protocol', protocol: health.protocol } }
  }
  return { ok: true, health }
}

/** Human copy for a failure the user asked for by clicking Connect. */
export function describeProbeFailure(failure: ProbeFailure, port: number): string {
  switch (failure.kind) {
    case 'unreachable':
      return `Nothing answered on 127.0.0.1:${port}. Start the bridge in your repo, then try again.`
    case 'unauthorized':
      return 'That token was rejected. The bridge mints a new one every time it starts — copy the latest one.'
    case 'protocol':
      return `That bridge speaks protocol v${failure.protocol}; this build of review123 speaks v${PROTOCOL_VERSION}. Update the bridge.`
    case 'malformed':
      return `Something answered on 127.0.0.1:${port}, but it was not a review123 bridge.`
    case 'http':
      return `The bridge answered with HTTP ${failure.status}.`
  }
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

function applyHealth(health: BridgeHealth, port: number): void {
  holder.status = 'connected'
  holder.capabilities = health.capabilities
  holder.root = health.root
  holder.version = health.version
  holder.error = null
  holder.port = port
  holder.paired = true
}

function applyDisconnected(): void {
  holder.status = 'disconnected'
  holder.capabilities = null
  holder.root = null
  holder.version = null
}

/**
 * USER-INITIATED pairing: store the token, probe, and report the outcome.
 * Returns true on success. A failure lands in `error` — this is the ONE path
 * where a failure is visible, because the user just asked for it.
 */
export async function connectBridge(token: string, port: number = DEFAULT_BRIDGE_PORT): Promise<boolean> {
  const trimmed = token.trim()
  holder.port = isValidPort(port) ? port : DEFAULT_BRIDGE_PORT
  if (trimmed === '') {
    holder.status = 'error'
    holder.error = 'Paste the pairing token the bridge printed when it started.'
    return false
  }

  holder.status = 'pairing'
  holder.error = null

  const result = await probeBridge(trimmed, holder.port)
  if (!result.ok) {
    holder.status = 'error'
    holder.error = describeProbeFailure(result.failure, holder.port)
    holder.capabilities = null
    holder.root = null
    holder.version = null
    // The token is NOT persisted on failure — a bad token should not come back
    // to haunt the next page load.
    return false
  }

  writeStoredBridge({ token: trimmed, port: holder.port })
  applyHealth(result.health, holder.port)
  track('bridge_connected', {
    inference_clis: result.health.capabilities.inference,
    has_files: result.health.capabilities.files,
  })
  return true
}

/**
 * SILENT re-probe on mount. Does NOTHING — no fetch at all — unless the user
 * has paired before, which is what keeps a first-time visitor's page load
 * byte-for-byte unchanged.
 *
 * A failure here means "the bridge isn't running right now", which is not an
 * error: the status goes back to `disconnected`, the stored token is KEPT (so
 * the next visit re-probes automatically), and nothing is surfaced or tracked.
 */
export async function initBridge(): Promise<void> {
  const stored = readStoredBridge()
  if (stored === null) {
    holder.paired = false
    return
  }
  holder.paired = true
  holder.port = stored.port
  holder.error = null

  const result = await probeBridge(stored.token, stored.port)
  if (!result.ok) {
    applyDisconnected()
    return
  }
  applyHealth(result.health, stored.port)
}

/** Forget the pairing entirely. */
export function disconnectBridge(): void {
  clearStoredBridge()
  applyDisconnected()
  holder.error = null
  holder.paired = false
  holder.port = DEFAULT_BRIDGE_PORT
}

// ---------------------------------------------------------------------------
// The helper other modules consult
// ---------------------------------------------------------------------------

/**
 * Is the bridge's `capability` ROUTE live right now?
 *
 * ALWAYS false unless a bridge is connected, so every caller degrades to the
 * existing hosted path by default. It tracks the bridge's own route-readiness
 * flag, which flips in the same release that implements the route — so a
 * `true` here can never mean "the route 501s".
 *
 * This answers readiness ONLY. "Which CLIs exist" is a different question with
 * a different accessor, `bridgeInferenceClis()`, because a single boolean
 * conflating the two is exactly the bug that would silently send an infer
 * request to a bridge with no CLI installed.
 */
export function bridgeAvailable(capability: BridgeCapability): boolean {
  if (holder.status !== 'connected' || holder.capabilities === null) return false
  return holder.capabilities[capability]
}

/**
 * The CLIs the connected bridge DETECTED on the user's PATH, in bridge order.
 * Empty when nothing is connected. Detection, not readiness — see above.
 */
export function bridgeInferenceClis(): string[] {
  if (holder.status !== 'connected' || holder.capabilities === null) return []
  return holder.capabilities.inference
}

/**
 * Can `cli` actually be run right now? BOTH halves must hold: the route exists
 * AND that CLI was detected. Every inference caller asks this one question
 * rather than assembling the two answers itself.
 */
export function bridgeCanInfer(cli: string): boolean {
  return bridgeAvailable('infer') && bridgeInferenceClis().includes(cli)
}

/** The stored credential, for the modules that will make bridge calls later. */
export function bridgeCredentials(): StoredBridge | null {
  return holder.status === 'connected' ? readStoredBridge() : null
}

/** FOR TESTS ONLY: reset module state so each test starts from a clean slate. */
export function _resetBridgeForTest(): void {
  const fresh = initialHolder()
  holder.status = fresh.status
  holder.capabilities = fresh.capabilities
  holder.root = fresh.root
  holder.version = fresh.version
  holder.error = fresh.error
  holder.port = fresh.port
  holder.paired = fresh.paired
}
