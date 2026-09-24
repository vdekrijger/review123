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
 *
 * ── THE BROWSER IS A GATE TOO ──
 * A page on `https://www.review123.dev` reaching `http://127.0.0.1` is a
 * LOCAL NETWORK request, and Chrome 142+ requires the user's permission for
 * one (Local Network Access, which replaced the older Private Network Access
 * preflight). Without it the fetch rejects in about a millisecond with a plain
 * `TypeError: Failed to fetch` — the same error a refused connection gives —
 * and NOTHING reaches the bridge. That is why `ProbeFailure` below is a
 * taxonomy rather than one `unreachable`: telling someone whose bridge is
 * running to "start the bridge" is worse than saying nothing.
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
  type BridgeGitState,
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
  /**
   * The served tree's state, or null when it could not be established (not a
   * repo, no commits, an older bridge). Local grounding compares `head`
   * against the PR's head sha and refuses to guess when this is null.
   */
  repoState: BridgeGitState | null
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
    repoState: null,
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
  get git(): BridgeGitState | null {
    return holder.repoState
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

/**
 * THE FAILURE TAXONOMY — a NAMED reason per cause, never a bare boolean.
 *
 * Same discipline as `decideGrounding` in ./grounding.ts: every branch is a
 * name the UI turns into one sentence the user can act on, so no surface ever
 * has to reconstruct "why" from "it didn't work".
 *
 * It exists because the old union had ONE failure for four different problems.
 * `{ kind: 'unreachable' }` produced "Nothing answered on 127.0.0.1:7321.
 * Start the bridge in your repo, then try again." for a bridge that was
 * running the whole time — sending the user to fix the one thing that was
 * already fine. The four causes and their four different fixes:
 *
 *   the browser refused to send it    → grant the permission
 *   nothing is listening on that port → start the bridge
 *   something answered, unreadably    → update the bridge / check the port
 *   the token is wrong                → copy the current token
 */
type ProbeFailure =
  /**
   * The BROWSER blocked the request; the bridge never saw a byte of it.
   *
   * Chrome 142+ ships Local Network Access: a page on a public origin may not
   * reach a loopback or private address without the user's permission. Until
   * it is granted the fetch rejects in single-digit milliseconds with a plain
   * `TypeError: Failed to fetch`, indistinguishable from "no server there"
   * except by asking the Permissions API — which is exactly what
   * `classifyUnreachable` does.
   */
  | { kind: 'local-network-blocked'; permission: 'denied' | 'prompt' }
  /** Nothing is listening on that port: the connection was refused. */
  | { kind: 'not-listening' }
  /**
   * Something IS listening and answered, but the browser would not let this
   * page read the answer — the classic shape of an origin the bridge's
   * allowlist does not carry (its 403 deliberately has no CORS headers).
   */
  | { kind: 'origin-refused' }
  /** The call failed and nothing narrowed it down. The copy says both things. */
  | { kind: 'unreachable' }
  /** It answered nothing inside the probe budget. */
  | { kind: 'timeout' }
  /** Something aborted the probe — not a failure of the bridge. */
  | { kind: 'cancelled' }
  | { kind: 'unauthorized' }
  | { kind: 'protocol'; protocol: number }
  | { kind: 'malformed' }
  | { kind: 'http'; status: number }

type ProbeResult = { ok: true; health: BridgeHealth } | { ok: false; failure: ProbeFailure }

/**
 * Chrome's Local Network Access permission, and its shipped alias. Queried in
 * order; the first name the browser recognises wins. A browser that has
 * neither (Firefox, Safari, jsdom) does not gate local requests this way, and
 * answers `unknown`.
 */
const LOCAL_NETWORK_PERMISSION_NAMES = ['local-network-access', 'local-network'] as const

export type LocalNetworkPermission = 'granted' | 'denied' | 'prompt' | 'unknown'

/**
 * Has this page been allowed to reach the user's local network?
 *
 * `unknown` means "this browser does not answer that question", NOT "no" — it
 * is what every non-Chromium engine returns, and the caller must not turn it
 * into a claim.
 */
export async function localNetworkPermission(): Promise<LocalNetworkPermission> {
  const api = globalThis.navigator?.permissions
  if (typeof api?.query !== 'function') return 'unknown'
  for (const name of LOCAL_NETWORK_PERMISSION_NAMES) {
    try {
      // The cast is the point of the loop: these names are not in lib.dom's
      // PermissionName union yet, and querying an unknown name THROWS.
      const status = await api.query({ name } as unknown as PermissionDescriptor)
      if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
        return status.state
      }
    } catch {
      // Not a name this browser knows. Try the next one.
    }
  }
  return 'unknown'
}

/**
 * Is ANYTHING listening on that port?
 *
 * A `no-cors` request is not subject to the origin allowlist: the browser
 * sends it, hands back an opaque response we cannot read, and — crucially —
 * only REJECTS when the connection itself failed. That is the one honest way a
 * page can tell "the bridge refused my origin" from "there is no bridge",
 * since both surface as the same `TypeError` on the real probe.
 *
 * It is a diagnosis-only call: it never runs on the silent path, and its
 * result is never treated as a successful connection.
 */
async function somethingIsListening(port: number): Promise<boolean> {
  const { effectiveSignal } = requestSignals(null, BRIDGE_PROBE_TIMEOUT_MS)
  try {
    await fetch(bridgeUrl(port, '/v1/health'), {
      method: 'GET',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: effectiveSignal,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Turn a bare `TypeError: Failed to fetch` into the most specific true thing
 * we can say — and no more specific than that.
 *
 * The browser gives the page one error for four causes, so this asks two
 * further questions whose answers ARE distinguishable, and stops at
 * `unreachable` when they do not settle it rather than guessing.
 */
async function classifyUnreachable(port: number): Promise<ProbeFailure> {
  const permission = await localNetworkPermission()
  // A definite no from the browser. Nothing left the machine, so nothing about
  // the bridge can be inferred — and telling the user to start it would be the
  // original bug.
  if (permission === 'denied' || permission === 'prompt') {
    return { kind: 'local-network-blocked', permission }
  }
  const listening = await somethingIsListening(port)
  if (listening) return { kind: 'origin-refused' }
  // Only a browser that CONFIRMED the request was allowed out can turn "the
  // connection failed" into "nothing is there". `unknown` cannot, so it says
  // both possibilities instead of picking the likelier one.
  return permission === 'granted' ? { kind: 'not-listening' } : { kind: 'unreachable' }
}

/** Options for `probeBridge`. */
export interface ProbeOptions {
  /**
   * Spend extra calls working out WHY a failure happened.
   *
   * False on the silent mount probe, and that is deliberate: the module's
   * promise is that a user with no bridge running pays for one refused
   * connection and nothing else. Only a probe the user ASKED for — pasting a
   * token and pressing Connect — surfaces a reason, so only that one pays for
   * finding it.
   */
  diagnose?: boolean
}

/**
 * One `GET /v1/health`. Never throws — every outcome is a ProbeResult, so no
 * caller can accidentally let a missing bridge become an unhandled rejection
 * or a visible error.
 */
export async function probeBridge(
  token: string,
  port: number,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
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
    // A timeout and a cancellation ARE distinguishable from the error itself,
    // so they are named from it. Everything else is the ambiguous
    // `TypeError: Failed to fetch`, which only further questions can narrow.
    const kind = classifyFetchFailure(err, timeoutSignal)
    if (kind === 'timeout') return { ok: false, failure: { kind: 'timeout' } }
    if (kind === 'cancelled') return { ok: false, failure: { kind: 'cancelled' } }
    if (options.diagnose !== true) return { ok: false, failure: { kind: 'unreachable' } }
    return { ok: false, failure: await classifyUnreachable(port) }
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

/** This page's own origin, for the sentence that has to name it. */
function pageOrigin(): string {
  return globalThis.location?.origin ?? 'this page'
}

/** Human copy for a failure the user asked for by clicking Connect. */
export function describeProbeFailure(failure: ProbeFailure, port: number): string {
  switch (failure.kind) {
    case 'local-network-blocked':
      // Two states, one fix, but a different first sentence: "prompt" means
      // the user has never been asked, "denied" means they (or the browser on
      // their behalf) already said no and a retry alone will not help.
      return (
        (failure.permission === 'denied'
          ? `Your browser is blocking this page from reaching 127.0.0.1:${port}, so the request never left it — the bridge never saw it, and starting it again will not help. `
          : `Your browser has not yet allowed this page to reach 127.0.0.1:${port}, so the request never left it — the bridge never saw it. `) +
        'Chrome asks with “Look for and connect to any device on your local network”; choose Allow and press Connect again. ' +
        'If no prompt appears, open the icon to the left of the address bar → Site settings → Local network access → Allow.'
      )
    case 'not-listening':
      return `Nothing is listening on 127.0.0.1:${port}. Start the bridge in your repo, then try again.`
    case 'origin-refused':
      return `Something is listening on 127.0.0.1:${port} but it would not answer ${pageOrigin()}. If that is the bridge, it is an older build that does not allow this origin — download it again (the command is below) and restart it.`
    case 'unreachable':
      return `Could not reach 127.0.0.1:${port}. Either nothing is listening there, or this browser blocked the request to your local network — in which case the bridge, if it is running, never saw it.`
    case 'timeout':
      return `127.0.0.1:${port} did not answer within ${Math.round(BRIDGE_PROBE_TIMEOUT_MS / 1000)}s. A bridge on this machine answers in milliseconds, so something else is probably on that port.`
    case 'cancelled':
      return 'The connection attempt was cancelled before it finished. Press Connect to try again.'
    case 'unauthorized':
      return 'That token was rejected, so the bridge is running and reachable — only the token is wrong. It mints a fresh one every time it starts (unless you pass --token-file), so copy the one it printed most recently.'
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
  holder.repoState = health.git
  holder.version = health.version
  holder.error = null
  holder.port = port
  holder.paired = true
}

function applyDisconnected(): void {
  holder.status = 'disconnected'
  holder.capabilities = null
  holder.root = null
  holder.repoState = null
  holder.version = null
}

/**
 * THE ONE SOURCE for "where is the served checkout right now".
 *
 * `holder.repoState` is that fact, and `/v1/health` is not the only route that
 * learns it: `/v1/stack` re-reads the tree on demand, and `/v1/checkout` and
 * `/v1/restore` MOVE it and report where they put it. Before this existed each
 * of those updated a second holder in runPr.svelte.ts, and the two diverged the
 * instant the app moved the user's tree — the top bar read the fresh one and
 * said "Checked out here" while the fix panel and the Inspect header read the
 * one from page load and said the checkout was somewhere else. Three surfaces,
 * one working tree, three stories.
 *
 * So every route that learns the fact writes it HERE, and every surface reads
 * it from here. Guarded on `connected` so a response that lands after the user
 * disconnected cannot resurrect a tree state for a bridge that is gone.
 */
export function noteRepoState(git: BridgeGitState | null): void {
  if (holder.status !== 'connected') return
  holder.repoState = git
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

  // `diagnose` ONLY here: this is the one probe whose failure is shown, so it
  // is the one probe that may spend an extra call finding out what to say.
  const result = await probeBridge(trimmed, holder.port, { diagnose: true })
  if (!result.ok) {
    holder.status = 'error'
    holder.error = describeProbeFailure(result.failure, holder.port)
    holder.capabilities = null
    holder.root = null
    holder.repoState = null
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

/**
 * FOR TESTS ONLY: put the module in the CONNECTED state with these
 * capabilities, without a fetch round trip.
 *
 * It exists for the consumers that only care WHICH capabilities are live —
 * deepReview.ts's harness gate, most of all, whose whole job is to read
 * `inferAgentic` before offering deep review. Driving those through
 * connectBridge would make every such test a health-payload fixture test
 * instead, and the payload parsing is already covered where it belongs.
 */
export function _setBridgeConnectedForTest(capabilities: BridgeCapabilities): void {
  holder.status = 'connected'
  holder.capabilities = capabilities
  holder.paired = true
}

/** FOR TESTS ONLY: reset module state so each test starts from a clean slate. */
export function _resetBridgeForTest(): void {
  const fresh = initialHolder()
  holder.status = fresh.status
  holder.capabilities = fresh.capabilities
  holder.root = fresh.root
  holder.repoState = fresh.repoState
  holder.version = fresh.version
  holder.error = fresh.error
  holder.port = fresh.port
  holder.paired = fresh.paired
}
