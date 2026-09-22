/**
 * bridge.svelte.ts — the browser half of the optional local bridge.
 *
 * Connection state machine, capability store, token persistence, and the
 * `bridgeAvailable()` helper other modules will consult once the follow-up PRs
 * route work through the bridge. NOTHING in the app depends on it today: with
 * no bridge paired, this module makes ZERO network requests and the app behaves
 * exactly as it did before.
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
  DEFAULT_BRIDGE_PORT,
  PROTOCOL_VERSION,
  bridgeUrl,
  parseHealth,
  type BridgeCapabilities,
  type BridgeCapability,
  type BridgeHealth,
} from './protocol'

/** localStorage key holding the pairing token + port. */
export const BRIDGE_STORAGE_KEY = 'review123:bridge'

/**
 * Probe budget. Deliberately short: a bridge is a process on this machine, so
 * it answers in single-digit milliseconds or it is not there. Waiting longer
 * would only delay the settings page for people who have no bridge.
 */
export const BRIDGE_PROBE_TIMEOUT_MS = 2_500

export type BridgeStatus = 'disconnected' | 'pairing' | 'connected' | 'error'

/** What we persist. The token is a local-process credential, not a secret key. */
export interface StoredBridge {
  token: string
  port: number
}

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
// Persistence
// ---------------------------------------------------------------------------

/**
 * The stored pairing, or null. Never throws: Safari private mode and blocked
 * site data both make localStorage access throw, and a bridge that cannot
 * remember its token must degrade to "not paired", not to a broken settings
 * page.
 */
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

function writeStoredBridge(value: StoredBridge): void {
  try {
    localStorage.setItem(BRIDGE_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage is a convenience here: the in-memory connection still works for
    // this session, the user just re-pastes the token next time.
  }
}

function clearStoredBridge(): void {
  try {
    localStorage.removeItem(BRIDGE_STORAGE_KEY)
  } catch {
    // ignore — see writeStoredBridge
  }
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
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
 * Can the bridge serve `capability` right now?
 *
 * ALWAYS false unless a bridge is connected, so every caller degrades to the
 * existing hosted path by default. For `files` and `search` this tracks the
 * bridge's own route-readiness flag; for `inference` it means "at least one CLI
 * was detected". NOTE: `/v1/infer` itself answers 501 in protocol v1 — the
 * inference PR ships the route and its caller together.
 */
export function bridgeAvailable(capability: BridgeCapability): boolean {
  if (holder.status !== 'connected' || holder.capabilities === null) return false
  if (capability === 'inference') return holder.capabilities.inference.length > 0
  return holder.capabilities[capability]
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
