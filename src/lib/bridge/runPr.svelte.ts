/**
 * bridge/runPr.svelte.ts — run this pull request against the app you already
 * have running.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 *
 * A deploy preview tells you what a change looks like on someone else's
 * infrastructure. It does not tell you what it does against YOUR database,
 * YOUR feature flags, YOUR seeded org, with YOUR debugger attached. For a
 * reviewer who already has the whole stack running on localhost, the useful
 * question is not "can I see a screenshot" but "can I click through this PR in
 * my own app".
 *
 * So: check the PR out IN the existing checkout, and let the dev stack that is
 * already running pick it up. Vite hot-reloads, Django autoreloads, and the
 * app on localhost is the pull request seconds later. No second stack, no
 * second database, no container.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE COST, STATED PLAINLY: this moves the user's working tree, which every
 * other bridge feature promised never to do. That promise was about the FIX
 * LOOP and it still holds. This is a different contract with its own flag
 * (`--allow-checkout`, never `--allow-write`), its own refusals, and a
 * recorded way home. The rules it enforces in this file:
 *
 *   1. It is offered ONLY when the bridge reports `capabilities.checkout`.
 *   2. A dirty tree blocks it until the user confirms a stash, having been
 *      shown the exact file list.
 *   3. Code from a fork — or code this build cannot PROVE is not from a fork —
 *      gets an explicit confirmation naming what running it means.
 *   4. There is always a way back, and the UI always says where back is.
 *
 * EVERY REFUSAL IS A NAMED REASON, never a bare boolean — the discipline
 * `decideGrounding` established in #242 and `decideFixReadiness` followed. The
 * UI must never have to reconstruct "why can't I do this?" from a false.
 */

import { classifyFetchFailure, requestSignals } from '../net/signals'
import { bridgeAvailable, bridgeCredentials, bridgeState } from './bridge.svelte'
import {
  CHECKOUT_REQUEST_TIMEOUT_MS,
  bridgeUrl,
  parseBridgeError,
  parseStackAction,
  parseStackResponse,
  type BridgeGitState,
  type BridgeStackAction,
  type BridgeStackApp,
  type BridgeStackPrior,
  type BridgeStackState,
} from './protocol'

// ---------------------------------------------------------------------------
// Readiness — may the action be offered at all, and if not, WHY
// ---------------------------------------------------------------------------

/**
 * Why checking this PR out is (or is not) available right now.
 *
 * - `ready`              — paired, `--allow-checkout` on, a clean tree, and we
 *                          are not already on this PR.
 * - `no-bridge`          — nothing paired, or it is not running. The ordinary
 *                          case, and not a complaint.
 * - `checkout-disabled`  — connected, but the bridge may not move the tree.
 *                          Only the person at the terminal can change that,
 *                          with `--allow-checkout`. NOT `--allow-write`.
 * - `route-missing`      — connected, but too old to have these routes.
 * - `no-repo-state`      — its root is not a git repository.
 * - `tree-dirty`         — uncommitted work. Offerable, but only through the
 *                          stash confirmation, which names the files.
 * - `already-on-pr`      — the checkout is already sitting on this PR's head.
 *                          Nothing to do, and the UI shows Restore instead.
 */
export type CheckoutReason =
  | 'ready'
  | 'no-bridge'
  | 'checkout-disabled'
  | 'route-missing'
  | 'no-repo-state'
  | 'tree-dirty'
  | 'already-on-pr'

export interface CheckoutReadiness {
  /** True only for `ready`. `tree-dirty` is NOT ready — it needs a stash first. */
  ready: boolean
  reason: CheckoutReason
  /** The bridge's current branch, for the sentences. Null when detached/unknown. */
  branch: string | null
  /** The bridge's head sha, or null when there is no repo state. */
  bridgeHead: string | null
  /** Uncommitted paths, when `reason` is 'tree-dirty'. Empty otherwise. */
  dirtyPaths: string[]
  dirtyCount: number
  /** The recorded way home, when one exists. Drives the Restore action. */
  prior: BridgeStackPrior | null
}

/** What `decideCheckout` needs to know. Injected so the rule stays pure. */
export interface CheckoutSnapshot {
  connected: boolean
  /** `capabilities.checkout` — the bridge's `--allow-checkout` flag. */
  checkoutEnabled: boolean
  /** True once the bridge has answered `/v1/stack` at all. */
  routeAvailable: boolean
  stack: BridgeStackState | null
}

/**
 * THE READINESS RULE, as a pure function over a snapshot.
 *
 * `already-on-pr` is checked BEFORE `tree-dirty` on purpose. Someone sitting
 * on the PR with edits in progress is in a perfectly good state — they checked
 * it out and started poking at it — and telling them "your tree is dirty"
 * there would read as an error when nothing is wrong.
 */
export function decideCheckout(snapshot: CheckoutSnapshot, prHead: string): CheckoutReadiness {
  const stack = snapshot.stack
  const base = {
    ready: false,
    branch: stack?.git?.branch ?? null,
    bridgeHead: stack?.git?.head ?? null,
    dirtyPaths: [] as string[],
    dirtyCount: 0,
    prior: stack?.prior ?? null,
  }

  if (!snapshot.connected) return { ...base, reason: 'no-bridge' }
  if (!snapshot.routeAvailable) return { ...base, reason: 'route-missing' }
  if (!snapshot.checkoutEnabled) return { ...base, reason: 'checkout-disabled' }
  if (stack === null || stack.git === null) return { ...base, reason: 'no-repo-state' }

  if (stack.git.head.toLowerCase() === prHead.toLowerCase()) {
    return { ...base, reason: 'already-on-pr' }
  }
  if (stack.git.dirty) {
    return {
      ...base,
      reason: 'tree-dirty',
      dirtyPaths: stack.dirtyPaths,
      dirtyCount: stack.dirtyCount,
    }
  }
  return { ...base, ready: true, reason: 'ready' }
}

/** First 7 characters of a sha, the way every git UI shows one. */
export function short(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 7)
}

/** One honest sentence per reason. Never hedges, never invents a cause. */
export function describeCheckout(readiness: CheckoutReadiness): string {
  switch (readiness.reason) {
    case 'ready':
      return 'Check this pull request out in your local repo, so the dev server you already have running serves it.'
    case 'no-bridge':
      return 'Pair a local bridge to run this pull request against your own app.'
    case 'checkout-disabled':
      // Names the RIGHT flag, and rules out the adjacent one, because someone
      // who already passed --allow-write will otherwise assume they are done.
      return 'The paired bridge may not change your working tree. Restart it with --allow-checkout to let review123 check this pull request out there. (--allow-write does not enable this — it grants the fix loop, which only writes in an isolated worktree.)'
    case 'route-missing':
      return 'The paired bridge is too old to check a pull request out. Update it and restart.'
    case 'no-repo-state':
      return 'The paired bridge is not serving a git repository, so there is nothing to check a pull request out into.'
    case 'tree-dirty':
      return `Your checkout has ${readiness.dirtyCount} uncommitted change${readiness.dirtyCount === 1 ? '' : 's'}. Nothing will be touched until you choose to stash them.`
    case 'already-on-pr':
      return readiness.prior?.branch == null
        ? 'Your checkout is already on this pull request.'
        : `Your checkout is already on this pull request. You can restore ${readiness.prior.branch} when you are done.`
  }
}

// ---------------------------------------------------------------------------
// Trust — whose code is about to run on this machine
// ---------------------------------------------------------------------------

/**
 * How much this build can PROVE about where the pull request's code came from.
 *
 * - `same-repo`   — proven to come from the repository itself. The smooth path.
 * - `fork`        — proven to come from a fork. Explicit confirmation, naming
 *                   the risk.
 * - `unverified`  — this build cannot tell. SAME confirmation as a fork.
 *
 * WHY `unverified` IS TREATED LIKE A FORK, AND WHY IT IS THE ANSWER TODAY.
 *
 * Checking a ref out and letting a dev stack autoreload it IS running that
 * code — `postinstall` scripts, config files, test fixtures and all. For a
 * fork that is a stranger's code running against the user's real database.
 *
 * The provider layer does not currently carry the head-repo / base-repo pair
 * that would settle the question (`PrMeta` has no such field, across three
 * providers), so `repos` is absent at every call site in this build and the
 * answer is `unverified` everywhere. That is deliberate rather than
 * unfinished: an unknown provenance must never render as the reassuring
 * answer, exactly as `parseGitState` defaults `dirty` to true. Wiring the real
 * field in later turns the smooth path on for same-repo branches WITHOUT
 * loosening anything here — this function already handles it.
 */
export type CheckoutTrust = 'same-repo' | 'fork' | 'unverified'

export interface CheckoutTrustInput {
  /**
   * The PR's head and base repository identities, when the provider supplies
   * them (e.g. "octocat/hello" and "octocat/hello"). Absent → `unverified`.
   */
  repos?: { head: string | null; base: string | null }
}

/** THE TRUST RULE, as a pure function. */
export function decideCheckoutTrust(input: CheckoutTrustInput): CheckoutTrust {
  const repos = input.repos
  if (repos == null) return 'unverified'
  const { head, base } = repos
  // Either side missing is not evidence of sameness, so it is not treated as any.
  if (typeof head !== 'string' || head === '') return 'unverified'
  if (typeof base !== 'string' || base === '') return 'unverified'
  return head.toLowerCase() === base.toLowerCase() ? 'same-repo' : 'fork'
}

/** Does this trust level require an explicit, risk-naming confirmation? */
export function trustNeedsConfirmation(trust: CheckoutTrust): boolean {
  return trust !== 'same-repo'
}

/** The sentence shown in the confirmation. Names what running the code means. */
export function describeCheckoutTrust(trust: CheckoutTrust): string {
  switch (trust) {
    case 'same-repo':
      return 'This branch lives in the repository itself.'
    case 'fork':
      return 'This pull request comes from a FORK. Checking it out runs its code on your machine — your dev server will load it, and any install or build step in it will run, against your real local database and credentials. Only continue if you have read this diff and trust its author.'
    case 'unverified':
      return 'review123 cannot confirm whether this pull request comes from a fork, so it is treated as if it does. Checking it out runs its code on your machine — your dev server will load it, and any install or build step in it will run, against your real local database and credentials. Only continue if you have read this diff and trust its author.'
  }
}

// ---------------------------------------------------------------------------
// Where the preview panel should point
// ---------------------------------------------------------------------------

/**
 * Which source the preview panel frames.
 *
 * - `local`  — the checkout is on this PR AND the dev server answers. The best
 *              case: the reviewer is clicking through the real thing.
 * - `deploy` — a deploy preview exists. The pre-existing behaviour, unchanged
 *              and never removed: local is an addition, not a replacement.
 * - `none`   — neither, and the panel says which of the two was missing.
 */
export type PreviewSourceKind = 'local' | 'deploy' | 'none'

/**
 * Why the panel is showing what it is showing.
 *
 * `local-not-running` and `local-not-checked-out` are DIFFERENT things to tell
 * someone: one means "start your dev server", the other means "check the PR
 * out first". Collapsing them into "no local preview" would leave the user
 * guessing which.
 */
export type PreviewSourceReason =
  | 'local-live'
  | 'deploy-only'
  | 'local-not-checked-out'
  | 'local-not-running'
  | 'nothing'

export interface PreviewSource {
  kind: PreviewSourceKind
  reason: PreviewSourceReason
  /** The URL to frame. Null when `kind` is 'none'. */
  url: string | null
}

export interface PreviewSourceInput {
  /** True when the bridge's checkout is sitting on this PR's head. */
  onPrBranch: boolean
  /** The detected dev server, or null when no bridge/stack answer exists. */
  app: BridgeStackApp | null
  /** The deploy preview's URL, when one is ready. Null otherwise. */
  deployUrl: string | null
}

/**
 * THE SOURCE RULE, as a pure function.
 *
 * Local wins when it is genuinely live, because it is strictly more useful
 * than a deploy preview — it is this PR against the reviewer's own data. Every
 * other case falls back to the deploy preview, which is why that path is not
 * deleted and never becomes unreachable.
 */
export function decidePreviewSource(input: PreviewSourceInput): PreviewSource {
  const localLive = input.onPrBranch && input.app?.reachable === true && input.app.url !== null
  if (localLive) {
    return { kind: 'local', reason: 'local-live', url: input.app!.url }
  }
  if (input.deployUrl !== null && input.deployUrl !== '') {
    return { kind: 'deploy', reason: 'deploy-only', url: input.deployUrl }
  }
  if (!input.onPrBranch) return { kind: 'none', reason: 'local-not-checked-out', url: null }
  if (input.app !== null && !input.app.reachable) {
    return { kind: 'none', reason: 'local-not-running', url: null }
  }
  return { kind: 'none', reason: 'nothing', url: null }
}

/** One honest sentence for the panel's source line. */
export function describePreviewSource(source: PreviewSource, app: BridgeStackApp | null): string {
  switch (source.reason) {
    case 'local-live':
      return `Your local app at ${source.url} — running this pull request.`
    case 'deploy-only':
      return 'The deploy preview for this pull request.'
    case 'local-not-checked-out':
      return 'Check this pull request out locally to click through it in your own app.'
    case 'local-not-running':
      return app?.url == null
        ? 'This pull request is checked out locally, but the bridge could not tell where your dev server listens.'
        : `This pull request is checked out locally, but nothing is answering at ${app.url}. Start your dev server.`
    case 'nothing':
      return 'No deploy preview was found for this pull request.'
  }
}

// ---------------------------------------------------------------------------
// The reactive stack state
// ---------------------------------------------------------------------------

interface StackHolder {
  /** The last `/v1/stack` answer, or null when none has been read. */
  state: BridgeStackState | null
  /** True while a stack probe, checkout or restore is in flight. */
  busy: boolean
  /** The last action's failure sentence, or null. Cleared on the next attempt. */
  error: string | null
  /** The stash the last action created or applied, for the "it is safe" note. */
  stash: BridgeStackAction['stash']
}

const holder = $state<StackHolder>({ state: null, busy: false, error: null, stash: null })

/**
 * Read-only reactive view.
 *
 * Exposed as a module singleton, the same shape `bridgeState` uses, so any
 * component can read "is the app running locally" without it being threaded
 * through five levels of props. The outcomes panel in particular needs it and
 * is nowhere near this route's component tree.
 */
export const stackState = {
  get state(): BridgeStackState | null {
    return holder.state
  },
  get app(): BridgeStackApp | null {
    return holder.state?.app ?? null
  },
  get git(): BridgeGitState | null {
    return holder.state?.git ?? null
  },
  get prior(): BridgeStackPrior | null {
    return holder.state?.prior ?? null
  },
  get busy(): boolean {
    return holder.busy
  },
  get error(): string | null {
    return holder.error
  },
  get stash(): BridgeStackAction['stash'] {
    return holder.stash
  },
  /** Is the served checkout sitting on this PR's head right now? */
  onPrBranch(prHead: string): boolean {
    const head = holder.state?.git?.head
    return typeof head === 'string' && head.toLowerCase() === prHead.toLowerCase()
  },
}

/** The live readiness for this PR, read from the connected bridge. */
export function currentCheckoutReadiness(prHead: string): CheckoutReadiness {
  return decideCheckout(
    {
      connected: bridgeState.status === 'connected',
      checkoutEnabled: bridgeAvailable('checkout'),
      // A bridge that has never answered /v1/stack is either too old or not
      // reachable; either way we have no state, and `route-missing` is the
      // honest thing to say rather than pretending the repo has none.
      routeAvailable: holder.state !== null,
      stack: holder.state,
    },
    prHead,
  )
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Why a stack call failed OUTRIGHT. Each maps to a different thing to do. */
export type StackFailureKind =
  | 'not-paired'
  | 'unreachable'
  | 'unauthorized'
  | 'checkout-disabled'
  | 'route-missing'
  | 'tree-dirty'
  | 'ref-unknown'
  | 'checkout-failed'
  | 'no-prior-state'
  | 'prior-gone'
  | 'moved-since'
  | 'untrusted-unacknowledged'
  | 'timeout'
  | 'cancelled'
  | 'bad-request'
  | 'malformed'
  | 'http'

export interface StackFailure {
  kind: StackFailureKind
  /** The bridge's own sentence, when it sent one. Never invented. */
  detail: string
  /** On `tree-dirty`: what a stash would move. */
  dirtyPaths: string[]
  dirtyCount: number
  status?: number
}

export type StackOutcome<T> = { ok: true; value: T } | { ok: false; failure: StackFailure }

/** Human copy for a failure. One actionable sentence each. */
export function describeStackFailure(failure: StackFailure): string {
  switch (failure.kind) {
    case 'not-paired':
      return 'No local bridge is paired. Open Settings → Local bridge and paste the pairing token the bridge printed.'
    case 'unreachable':
      return 'The local bridge stopped answering, so nothing was done. Your checkout is exactly as it was — restart the bridge and try again.'
    case 'unauthorized':
      return 'The local bridge rejected its pairing token. It mints a new one every time it starts — re-pair it in Settings → Local bridge.'
    case 'checkout-disabled':
      return failure.detail || 'The local bridge may not change your working tree. Restart it with --allow-checkout.'
    case 'route-missing':
      return 'This local bridge is too old to check a pull request out. Update it and restart.'
    case 'tree-dirty':
      return failure.detail || 'Your checkout has uncommitted changes, so nothing was touched.'
    case 'ref-unknown':
      return failure.detail || 'Your git remote does not have this pull request’s ref. Check that `origin` points at the right repository.'
    case 'checkout-failed':
      return failure.detail || 'git refused the checkout, so your tree is unchanged.'
    case 'no-prior-state':
      return failure.detail || 'The bridge has no record of a branch to restore for this repository.'
    case 'prior-gone':
      return failure.detail || 'The branch you were on no longer exists.'
    case 'moved-since':
      return failure.detail || 'Your checkout has moved since review123 checked this pull request out.'
    case 'untrusted-unacknowledged':
      return failure.detail || 'Checking this pull request out runs its code, and that has to be acknowledged explicitly.'
    case 'timeout':
      return 'Fetching the pull request took longer than the bridge’s budget and was stopped. Your checkout is unchanged.'
    case 'cancelled':
      return 'Cancelled. Your checkout is unchanged.'
    case 'bad-request':
      return failure.detail || 'The bridge refused the request.'
    case 'malformed':
      return 'The local bridge returned an answer this build could not read.'
    case 'http':
      return failure.detail || `The local bridge answered with HTTP ${failure.status ?? 'an error'}.`
  }
}

/** Map a non-2xx bridge response onto a named failure. */
function failureForStatus(
  status: number,
  parsed: ReturnType<typeof parseBridgeError>,
): StackFailure {
  const base = {
    detail: parsed.message,
    dirtyPaths: parsed.dirtyPaths,
    dirtyCount: parsed.dirtyCount,
    status,
  }
  if (status === 401) return { ...base, kind: 'unauthorized' }
  if (status === 404 && parsed.code === null) return { ...base, kind: 'route-missing' }
  switch (parsed.code) {
    case 'checkout-disabled':
      return { ...base, kind: 'checkout-disabled' }
    case 'tree-dirty':
      return { ...base, kind: 'tree-dirty' }
    case 'ref-unknown':
      return { ...base, kind: 'ref-unknown' }
    case 'checkout-failed':
      return { ...base, kind: 'checkout-failed' }
    case 'no-prior-state':
      return { ...base, kind: 'no-prior-state' }
    case 'prior-gone':
      return { ...base, kind: 'prior-gone' }
    case 'moved-since':
      return { ...base, kind: 'moved-since' }
    case 'untrusted-unacknowledged':
      return { ...base, kind: 'untrusted-unacknowledged' }
    case 'bad-request':
      return { ...base, kind: 'bad-request' }
    case 'timeout':
      return { ...base, kind: 'timeout' }
    default:
      // 403 with no recognised code is still an authorisation refusal; the
      // bridge uses it for origin and host too, and `detail` says which.
      if (status === 403) return { ...base, kind: 'checkout-disabled' }
      return { ...base, kind: 'http' }
  }
}

function emptyFailure(kind: StackFailureKind, detail = ''): StackFailure {
  return { kind, detail, dirtyPaths: [], dirtyCount: 0 }
}

/** One bridge call, returning a named outcome. Never throws. */
async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal | null; timeoutMs: number },
  parse: (value: unknown) => T | null,
): Promise<StackOutcome<T>> {
  const stored = bridgeCredentials()
  if (stored === null) return { ok: false, failure: emptyFailure('not-paired') }

  const { timeoutSignal, effectiveSignal } = requestSignals(init.signal ?? null, init.timeoutMs)
  let response: Response
  try {
    response = await fetch(bridgeUrl(stored.port, path), {
      method: init.method,
      headers: {
        Authorization: `Bearer ${stored.token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // Bearer-authenticated; never attach ambient cookies.
      credentials: 'omit',
      cache: 'no-store',
      signal: effectiveSignal,
    })
  } catch (err) {
    // A user cancellation and a dead bridge are DIFFERENT things to say, so
    // the shared classifier is used for its ANSWER rather than its side effect
    // (the mistake #233/#234 fixed).
    const classified = classifyFetchFailure(err, timeoutSignal)
    if (classified === 'timeout') return { ok: false, failure: emptyFailure('timeout') }
    if (classified === 'cancelled') return { ok: false, failure: emptyFailure('cancelled') }
    return { ok: false, failure: emptyFailure('unreachable') }
  }

  if (!response.ok) {
    let parsedError = parseBridgeError(null)
    try {
      parsedError = parseBridgeError(await response.json())
    } catch {
      /* a non-JSON body from something that is not our bridge */
    }
    return { ok: false, failure: failureForStatus(response.status, parsedError) }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, failure: emptyFailure('malformed') }
  }
  const value = parse(payload)
  if (value === null) return { ok: false, failure: emptyFailure('malformed') }
  return { ok: true, value }
}

/** Budget for the read-only `/v1/stack` probe. It is a process on this machine. */
export const STACK_PROBE_TIMEOUT_MS = 5_000

/**
 * Refresh `/v1/stack` into the reactive store.
 *
 * SILENT BY DESIGN, like `initBridge`'s probe: a bridge that is not running is
 * the normal case, and a failed refresh leaves the last known state alone
 * rather than blanking the panel or raising an error the user did not ask for.
 * Only the ACTIONS below surface failures, because there a failure is news.
 */
export async function refreshStack(signal?: AbortSignal | null): Promise<BridgeStackState | null> {
  if (bridgeState.status !== 'connected') {
    holder.state = null
    return null
  }
  const outcome = await call('/v1/stack', { method: 'GET', signal, timeoutMs: STACK_PROBE_TIMEOUT_MS }, parseStackResponse)
  if (!outcome.ok) {
    // A 404 means an older bridge without the route. Leaving `state` null is
    // exactly right: `decideCheckout` then reports `route-missing`.
    holder.state = null
    return null
  }
  holder.state = outcome.value
  return outcome.value
}

export interface CheckoutOptions {
  /** The provider-agnostic ref, e.g. "refs/pull/42/head". */
  ref: string
  /** Optional remote name. The bridge defaults to `origin`. */
  remote?: string
  /** The user confirmed the stash, having seen the file list. */
  stashDirty?: boolean
  signal?: AbortSignal | null
}

/**
 * Check the pull request out.
 *
 * `acknowledgeUntrusted` is sent as a literal `true` on every call — the
 * bridge requires it, and it is the browser's job to have ASKED first. The
 * asking lives in the UI, gated on `trustNeedsConfirmation`; this function is
 * reached only after the user said yes (or after the trust rule said no
 * confirmation was needed because the branch is provably same-repo).
 */
export async function checkoutPr(opts: CheckoutOptions): Promise<StackOutcome<BridgeStackAction>> {
  holder.busy = true
  holder.error = null
  try {
    const body: Record<string, unknown> = { ref: opts.ref, acknowledgeUntrusted: true }
    if (opts.remote !== undefined) body['remote'] = opts.remote
    if (opts.stashDirty === true) body['stashDirty'] = true

    const outcome = await call(
      '/v1/checkout',
      { method: 'POST', body, signal: opts.signal, timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS },
      parseStackAction,
    )
    return applyOutcome(outcome)
  } finally {
    holder.busy = false
  }
}

export interface RestoreOptions {
  stashDirty?: boolean
  detachToSha?: boolean
  acknowledgeMoved?: boolean
  restoreStash?: boolean
  signal?: AbortSignal | null
}

/** Put the checkout back where it was. */
export async function restoreCheckout(opts: RestoreOptions = {}): Promise<StackOutcome<BridgeStackAction>> {
  holder.busy = true
  holder.error = null
  try {
    const body: Record<string, unknown> = {}
    if (opts.stashDirty === true) body['stashDirty'] = true
    if (opts.detachToSha === true) body['detachToSha'] = true
    if (opts.acknowledgeMoved === true) body['acknowledgeMoved'] = true
    if (opts.restoreStash === true) body['restoreStash'] = true

    const outcome = await call(
      '/v1/restore',
      { method: 'POST', body, signal: opts.signal, timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS },
      parseStackAction,
    )
    return applyOutcome(outcome)
  } finally {
    holder.busy = false
  }
}

/**
 * Fold an action's result into the store.
 *
 * On success the tree state is updated FROM THE RESPONSE rather than re-probed:
 * the bridge just told us where it put things, and a second round trip could
 * only disagree with it. `dirtyPaths` is cleared because the action's own
 * response reports a tree it has just made clean.
 */
function applyOutcome(outcome: StackOutcome<BridgeStackAction>): StackOutcome<BridgeStackAction> {
  if (!outcome.ok) {
    holder.error = describeStackFailure(outcome.failure)
    // A dirty-tree refusal carries the file list; keep it so the confirmation
    // can name the files without another probe.
    if (outcome.failure.kind === 'tree-dirty' && holder.state !== null) {
      holder.state = {
        ...holder.state,
        dirtyPaths: outcome.failure.dirtyPaths,
        dirtyCount: outcome.failure.dirtyCount,
      }
    }
    return outcome
  }
  holder.error = null
  holder.stash = outcome.value.stash
  holder.state = {
    git: outcome.value.git,
    dirtyPaths: [],
    dirtyCount: 0,
    prior: outcome.value.prior,
    app: outcome.value.app,
    // The action succeeded, so the flag was on. Preserve what we knew rather
    // than inventing: an action response does not restate the capability.
    checkoutEnabled: holder.state?.checkoutEnabled ?? true,
  }
  return outcome
}

/** FOR TESTS ONLY: reset the module's state so each test starts clean. */
export function _resetStackForTest(): void {
  holder.state = null
  holder.busy = false
  holder.error = null
  holder.stash = null
}
