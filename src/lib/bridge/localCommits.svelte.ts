/**
 * localCommits.svelte.ts — which commits the paired repository already HAS.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The fix loop's precondition is CONTAINMENT, not equality. `git worktree add`
 * materialises the PR head out of the local object store, so the question is
 * "does this repository have that commit?" — a question only the bridge can
 * answer, and one the browser has to have an answer to SYNCHRONOUSLY, because
 * `decideFixReadiness` is a pure function a `$derived` calls while rendering a
 * row.
 *
 * So the answer is fetched asynchronously and CACHED here, and the rule reads
 * the cache. Nothing in this module decides anything: it is a reactive record
 * of what `POST /v1/commits` said, with three states the caller must keep apart.
 *
 *   true  — the bridge answered, and it has that commit.
 *   false — the bridge answered, and it does NOT. A real, specific refusal.
 *   null  — nobody has answered. Not asked yet, the bridge is gone, or it
 *           predates the route. The caller must NOT read this as `false`; it
 *           falls back to the older HEAD-equality test instead, which is what
 *           keeps an older bridge behaving exactly as it did before.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY THE TRUTH IS IN A PLAIN MAP AND THE REACTIVITY IS A COUNTER.
 *
 * Callers populate this from an `$effect` and read it from a `$derived`. If
 * `ensureLocalCommits` subscribed to the same state it writes, the effect would
 * re-run itself forever. Keeping the answers in a non-reactive `Map` and
 * publishing a `$state` version counter makes the direction of the dependency
 * explicit: readers subscribe, the writer does not.
 *
 * THE CACHE BELONGS TO ONE BRIDGE. Commits are a fact about ONE repository, so
 * the whole map is dropped the moment the connected bridge's root or port
 * changes. A cached "yes" from the last checkout the user paired would be a
 * confident wrong answer, which is the one thing a readiness rule cannot be.
 */

import { bridgeAvailable, bridgeCredentials, bridgeState } from './bridge.svelte'
import { requestSignals } from '../net/signals'
import {
  COMMITS_PATH,
  MAX_COMMIT_PROBE_SHAS,
  bridgeUrl,
  parseCommitsResponse,
} from './protocol'

/**
 * Probe budget. The same reasoning as `BRIDGE_PROBE_TIMEOUT_MS`: this is a
 * handful of `rev-parse` calls on this machine, so it answers in milliseconds
 * or something is wrong — and a readiness question nobody is waiting on must
 * not hold a socket open behind the user's back.
 */
export const COMMIT_PROBE_TIMEOUT_MS = 5_000

/** A 40-hex commit id. Anything else is not a sha and is never sent. */
const SHA_RE = /^[0-9a-f]{40}$/

/** What `POST /v1/commits` said, per sha. NOT reactive — see the header. */
const answers = new Map<string, boolean>()

/** Shas already asked about since the last invalidation. Also not reactive. */
const asked = new Set<string>()

/** Which bridge the two collections above describe. */
let owner: string | null = null

/** Bumped on every write, so readers can subscribe without the writer doing so. */
const store = $state({ version: 0 })

/** The connected bridge's identity: a cached answer belongs to exactly one. */
function currentOwner(): string | null {
  if (bridgeState.status !== 'connected') return null
  return `${bridgeState.root ?? ''}|${bridgeState.port}`
}

/** Drop everything. Called when the bridge we were describing is not the one. */
function clear(): void {
  answers.clear()
  asked.clear()
  store.version += 1
}

/**
 * Forget every ABSENT answer, keeping the present ones.
 *
 * Called after something has changed what the object store holds — a checkout,
 * which fetches. "Present" is not invalidated because git does not lose commits
 * behind the user's back, and re-asking about the rows that already said yes
 * would spend a request to learn what we know.
 */
export function forgetAbsentCommits(): void {
  for (const [sha, present] of answers) {
    if (!present) {
      answers.delete(sha)
      asked.delete(sha)
    }
  }
  store.version += 1
}

/**
 * What the bridge said about `sha`, or null when nobody has answered.
 *
 * Reactive: reading this inside a `$derived` re-runs it when a probe lands.
 */
export function commitPresence(sha: string): boolean | null {
  // Subscribe first, so a later write re-runs the reader even when the lookup
  // below currently misses.
  void store.version
  if (currentOwner() !== owner) return null
  const key = sha.toLowerCase()
  return answers.get(key) ?? null
}

/** True when the connected bridge can answer the containment question at all. */
export function canProbeCommits(): boolean {
  return bridgeState.status === 'connected' && bridgeAvailable('commits')
}

/** Shas worth sending: well-formed, deduped, and capped at the route's limit. */
function probeable(shas: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of shas) {
    if (typeof raw !== 'string') continue
    const sha = raw.toLowerCase()
    if (!SHA_RE.test(sha) || seen.has(sha)) continue
    seen.add(sha)
    out.push(sha)
    if (out.length === MAX_COMMIT_PROBE_SHAS) break
  }
  return out
}

/** In-flight shas, so two effects in one frame make one request, not two. */
const inFlight = new Set<string>()

/**
 * Ask the bridge about every sha in `shas` it has not already been asked about.
 *
 * NEVER THROWS AND NEVER REJECTS. Every failure — no bridge, an older bridge, a
 * refused request, a timeout — leaves the shas unanswered, which reads as
 * `null`, which sends the readiness rule back to the equality test. A probe
 * that cannot answer must never become an answer.
 *
 * Fire-and-forget by design: callers invoke it from an `$effect` and read the
 * result later through `commitPresence`.
 */
export async function ensureLocalCommits(shas: readonly string[]): Promise<void> {
  const here = currentOwner()
  if (here !== owner) {
    clear()
    owner = here
  }
  if (!canProbeCommits()) return

  const wanted = probeable(shas).filter((sha) => !asked.has(sha) && !inFlight.has(sha))
  if (wanted.length === 0) return
  await probe(wanted)
}

/**
 * Ask again about `shas`, whatever we were told before.
 *
 * For the surfaces where the user may have acted between renders: they ran a
 * fetch in their own terminal, or the panel has just come on screen after the
 * tree moved. The queue does NOT use this — it would re-ask about thirty-five
 * rows every time a signal landed.
 */
export async function refreshLocalCommits(shas: readonly string[]): Promise<void> {
  const here = currentOwner()
  if (here !== owner) {
    clear()
    owner = here
  }
  if (!canProbeCommits()) return

  const wanted = probeable(shas).filter((sha) => !inFlight.has(sha))
  if (wanted.length === 0) return
  await probe(wanted)
}

async function probe(shas: readonly string[]): Promise<void> {
  const stored = bridgeCredentials()
  if (stored === null) return
  for (const sha of shas) inFlight.add(sha)

  const { effectiveSignal } = requestSignals(null, COMMIT_PROBE_TIMEOUT_MS)
  let parsed: { present: string[] } | null = null
  try {
    const response = await fetch(bridgeUrl(stored.port, COMMITS_PATH), {
      method: 'POST',
      headers: { Authorization: `Bearer ${stored.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shas }),
      credentials: 'omit',
      cache: 'no-store',
      signal: effectiveSignal,
    })
    // A 404 is an older bridge, a 401 a stale token, a 400 a bug here. All
    // three mean the same to a caller: nothing was learned, so nothing is
    // recorded and the answer stays `null`.
    if (response.ok) parsed = parseCommitsResponse(await response.json())
  } catch {
    /* unreachable, blocked, timed out — nothing learned. */
  } finally {
    for (const sha of shas) inFlight.delete(sha)
  }
  if (parsed === null) return

  // A response that landed after the user re-paired describes a repository that
  // is no longer the one on screen. Drop it rather than cache it.
  if (currentOwner() !== owner) return

  const present = new Set(parsed.present)
  for (const sha of shas) {
    answers.set(sha, present.has(sha))
    asked.add(sha)
  }
  store.version += 1
}

/** FOR TESTS ONLY: forget everything, including which bridge it came from. */
export function _resetLocalCommitsForTest(): void {
  clear()
  inFlight.clear()
  owner = null
}
