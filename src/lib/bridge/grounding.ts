/**
 * bridge/grounding.ts — the ONE seam that decides where a review's code comes
 * from, and the only module that calls `/v1/files` or `/v1/search`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE, AND WHY IT IS THIS STRICT
 *
 * The bridge serves the working tree RIGHT NOW. Nothing guarantees that tree
 * is the pull request being read: the user may have switched branches, be
 * mid-rebase, or have a checkout from last month. Serving `main`'s copy of a
 * file while the reviewer reasons about PR #123 produces findings about code
 * the PR does not contain — confidently, with line numbers, and with no way for
 * anyone to tell. That is strictly worse than not having the bridge at all.
 *
 * So local grounding is used ONLY when the bridge's `head` sha equals the PR's
 * head sha. Every other case — no bridge, an older bridge without the routes,
 * a root that is not a repo, a different sha, a failed call mid-review — falls
 * back to the provider API and SAYS SO. There is no partial credit, no "close
 * enough", and no silent degradation.
 *
 * A DIRTY tree with a matching head IS used: the user may be mid-work, and
 * reviewing what they are actually about to push is the point. But it is
 * flagged once and honestly, because a finding grounded in uncommitted code is
 * a real possibility the reviewer should know about.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ONE SEAM, ONE CACHE. Every consumer — the context packer, the deep-review
 * tools, the symbol repo-search — asks `currentGrounding(headSha)` the same
 * question and reads through the same per-head file cache below. Nothing else
 * in the app knows the bridge has files.
 */

import { bridgeAvailable, bridgeCredentials, bridgeState } from './bridge.svelte'
import {
  bridgeUrl,
  parseFilesResponse,
  parseSearchResponse,
  type BridgeCapabilities,
  type BridgeGitState,
  type BridgeSearchMatch,
} from './protocol'

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type GroundingMode = 'local' | 'github'

/**
 * Why grounding landed where it did. Every value maps to a sentence the user
 * can act on — there is deliberately no generic "unavailable".
 */
export type GroundingReason =
  /** Head matches and the tree is clean. The good case. */
  | 'local-clean'
  /** Head matches but there are uncommitted changes. Used, and flagged. */
  | 'local-dirty'
  /** No bridge paired, or it is not running. The ordinary default. */
  | 'no-bridge'
  /** Connected, but too old to have `/v1/files` and `/v1/search`. */
  | 'route-missing'
  /** Connected, but its root is not a repo (or git could not answer). */
  | 'no-repo-state'
  /** Connected to a checkout sitting on a different commit. */
  | 'head-mismatch'
  /** Local grounding worked, then a call failed mid-review. */
  | 'call-failed'

export interface GroundingStatus {
  mode: GroundingMode
  reason: GroundingReason
  /** True only when `mode` is 'local' AND the tree has uncommitted changes. */
  dirty: boolean
  /** The bridge's branch, for the mismatch sentence. Null when unknown. */
  branch: string | null
  /** The bridge's head sha, or null when there is no bridge state to compare. */
  bridgeHead: string | null
  /** The PR's head sha this decision was made against. */
  prHead: string
}

/** What `decideGrounding` needs to know. Injected so the rule is pure. */
export interface BridgeSnapshot {
  connected: boolean
  capabilities: BridgeCapabilities | null
  git: BridgeGitState | null
}

/**
 * THE RULE, as a pure function over a snapshot. Every branch of it is a named
 * reason, so the UI never has to reconstruct "why" from a boolean.
 */
export function decideGrounding(snapshot: BridgeSnapshot, prHead: string): GroundingStatus {
  const base = { prHead, branch: snapshot.git?.branch ?? null, bridgeHead: snapshot.git?.head ?? null }

  if (!snapshot.connected || snapshot.capabilities === null) {
    return { ...base, mode: 'github', reason: 'no-bridge', dirty: false }
  }
  // Route readiness, not a guess: a bridge predating the grounding release
  // answers /v1/health but 404s these routes.
  if (!snapshot.capabilities.files || !snapshot.capabilities.search) {
    return { ...base, mode: 'github', reason: 'route-missing', dirty: false }
  }
  if (snapshot.git === null) {
    return { ...base, mode: 'github', reason: 'no-repo-state', dirty: false }
  }
  // The comparison the whole feature rests on. Case-insensitive because a sha
  // is hex; length-exact because a prefix match would accept the wrong commit.
  if (snapshot.git.head.toLowerCase() !== prHead.toLowerCase()) {
    return { ...base, mode: 'github', reason: 'head-mismatch', dirty: false }
  }
  return {
    ...base,
    mode: 'local',
    reason: snapshot.git.dirty ? 'local-dirty' : 'local-clean',
    dirty: snapshot.git.dirty,
  }
}

/** First 7 characters of a sha, the way every git UI shows one. */
export function short(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 7)
}

/**
 * One honest sentence for the UI. Never hedges, never says "may have" when the
 * bridge told us exactly what is going on.
 */
export function describeGrounding(status: GroundingStatus): string {
  switch (status.reason) {
    case 'local-clean':
      return 'Reading code from your local checkout — no rate limit, and the whole repo rather than just the diff.'
    case 'local-dirty':
      return 'Reading code from your local checkout, which has uncommitted changes — a finding may be grounded in code that is in no commit of this PR.'
    case 'no-bridge':
      return 'Reading code from GitHub. Pair a local bridge to read your own checkout instead.'
    case 'route-missing':
      return 'Reading code from GitHub: the paired bridge is too old to serve files. Update it and restart.'
    case 'no-repo-state':
      return 'Reading code from GitHub: the paired bridge is not serving a git repository, so its files cannot be matched to this PR.'
    case 'head-mismatch':
      return status.branch === null
        ? `Reading code from GitHub: your checkout is at ${short(status.bridgeHead)}; this PR is at ${short(status.prHead)}.`
        : `Reading code from GitHub: your checkout is on ${status.branch} at ${short(status.bridgeHead)}; this PR is at ${short(status.prHead)}.`
    case 'call-failed':
      return 'Reading code from GitHub: the local bridge stopped answering part-way through, so grounding fell back.'
  }
}

// ---------------------------------------------------------------------------
// The mid-review fallback latch
// ---------------------------------------------------------------------------

/**
 * Head shas whose local grounding FAILED mid-review.
 *
 * A bridge can be killed while a review runs. When a local call fails, the
 * caller falls back to the provider for that read — but the next read must not
 * cheerfully try the bridge again and stall on another timeout, and the UI
 * must stop claiming local grounding. So the head is latched here and every
 * later decision for it reads 'call-failed'.
 *
 * Keyed by head sha rather than being a single flag, so a failure while
 * reviewing one PR does not silently disable the bridge for the next one.
 */
const failedHeads = new Set<string>()

/** Record that a local grounding call failed for this head. Idempotent. */
export function noteGroundingFailure(prHead: string): void {
  failedHeads.add(prHead.toLowerCase())
}

/** The live decision for `prHead`, latch included. */
export function currentGrounding(prHead: string): GroundingStatus {
  const decided = decideGrounding(
    {
      connected: bridgeState.status === 'connected',
      capabilities: bridgeState.capabilities,
      git: bridgeState.git,
    },
    prHead,
  )
  if (decided.mode === 'local' && failedHeads.has(prHead.toLowerCase())) {
    return { ...decided, mode: 'github', reason: 'call-failed', dirty: false }
  }
  return decided
}

/** Is local grounding live for this PR right now? */
export function groundingIsLocal(prHead: string): boolean {
  return currentGrounding(prHead).mode === 'local'
}

// ---------------------------------------------------------------------------
// Agentic readiness — the same shape of question, one route further on
// ---------------------------------------------------------------------------

/**
 * Why deep (agentic) review over the bridge is or is not available RIGHT NOW.
 *
 * A named reason rather than a boolean, for exactly the reason the grounding
 * decision above is: every value maps to a sentence the user can act on, and
 * the UI must never reconstruct "why" from a false.
 */
export type BridgeAgenticReason =
  /** A paired, connected bridge that understands `InferRequest.agentic`. */
  | 'ready'
  /** No bridge paired, or it is not running. */
  | 'no-bridge'
  /** Connected, but predating the agentic release — it would answer tool-less. */
  | 'route-missing'

export interface BridgeAgenticStatus {
  ready: boolean
  reason: BridgeAgenticReason
}

/**
 * THE RULE, as a pure function over a snapshot — testable without a live bridge.
 *
 * `route-missing` is the case this function exists for. `agentic` is an ADDITIVE
 * request field, so an older bridge does not reject it: it ignores it, runs the
 * ordinary tool-less completion, and answers 200 with a perfectly good
 * single-pass review. Offering deep review against such a bridge would therefore
 * not fail loudly — it would quietly return a shallow answer labelled deep. So
 * availability is decided from the CAPABILITY, before anything is offered, and
 * never inferred from a successful call.
 */
export function decideBridgeAgentic(snapshot: BridgeSnapshot): BridgeAgenticStatus {
  if (!snapshot.connected || snapshot.capabilities === null) {
    return { ready: false, reason: 'no-bridge' }
  }
  if (!snapshot.capabilities.inferAgentic) return { ready: false, reason: 'route-missing' }
  return { ready: true, reason: 'ready' }
}

/** The live decision, against whatever bridge is paired right now. */
export function currentBridgeAgentic(): BridgeAgenticStatus {
  return decideBridgeAgentic({
    connected: bridgeState.status === 'connected',
    capabilities: bridgeState.capabilities,
    git: bridgeState.git,
  })
}

/**
 * One honest sentence for the UI, in the same voice as describeGrounding.
 * `ready` has no sentence: there is nothing to explain when it works.
 */
export function describeBridgeAgentic(status: BridgeAgenticStatus): string | null {
  switch (status.reason) {
    case 'ready':
      return null
    case 'no-bridge':
      return 'Deep review unavailable: no local bridge is paired — ran standard review.'
    case 'route-missing':
      return 'Deep review unavailable: your local bridge is too old to run the CLI with its tools — ran standard review. Update the bridge and restart it.'
  }
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/**
 * Per-call budget. The bridge is a process on this machine, so a read answers
 * in milliseconds; a search over a monorepo can take a second or two. Longer
 * than this and something is wrong, and waiting only delays the review — the
 * provider path is right there.
 */
export const GROUNDING_TIMEOUT_MS = 20_000

/** Paths per `/v1/files` call. Matches the bridge's own MAX_FILES_PER_REQUEST. */
export const GROUNDING_FILES_PER_CALL = 200

/** Thrown by the transport so callers can fall back without inspecting a body. */
export class BridgeGroundingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeGroundingError'
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const creds = bridgeCredentials()
  if (creds === null) throw new BridgeGroundingError('No bridge is connected.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GROUNDING_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(bridgeUrl(creds.port, path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Bearer-authenticated; never attach ambient cookies.
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch {
    throw new BridgeGroundingError(`The bridge did not answer ${path}.`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) throw new BridgeGroundingError(`The bridge answered ${response.status} for ${path}.`)
  try {
    return await response.json()
  } catch {
    throw new BridgeGroundingError(`The bridge sent an unreadable answer for ${path}.`)
  }
}

// ---------------------------------------------------------------------------
// Files — one cache, keyed by head sha, shared by every consumer
// ---------------------------------------------------------------------------

/**
 * `head → (path → content | null)`. Null means "the bridge says there is no
 * readable text there" (missing, a directory, or binary) — a settled answer,
 * cached, because re-asking would get the same one.
 *
 * Keyed by HEAD SHA so a second PR in the same session never reads the first
 * one's contents, and so the cache empties itself the moment the checkout
 * moves (a different head is a different key).
 */
const fileCache = new Map<string, Map<string, string | null>>()
/** In-flight batches, so two consumers asking for the same file share one call. */
const filesInFlight = new Map<string, Promise<void>>()

function cacheFor(prHead: string): Map<string, string | null> {
  const key = prHead.toLowerCase()
  let existing = fileCache.get(key)
  if (!existing) {
    existing = new Map()
    fileCache.set(key, existing)
  }
  return existing
}

/**
 * Read `paths` from the working tree, batched.
 *
 * Returns a map from EVERY requested path to its content or null. Throws
 * BridgeGroundingError when the bridge could not answer at all — the caller
 * then notes the failure and falls back. It never returns a half-answer that
 * a caller could mistake for "those files do not exist".
 */
export async function readLocalFiles(
  prHead: string,
  paths: readonly string[],
): Promise<Map<string, string | null>> {
  const cache = cacheFor(prHead)
  const wanted = [...new Set(paths)]
  const missing = wanted.filter((p) => !cache.has(p))

  for (let i = 0; i < missing.length; i += GROUNDING_FILES_PER_CALL) {
    const batch = missing.slice(i, i + GROUNDING_FILES_PER_CALL)
    const key = `${prHead.toLowerCase()}|${batch.join('\0')}`
    let pending = filesInFlight.get(key)
    if (!pending) {
      pending = fetchBatch(cache, batch).finally(() => filesInFlight.delete(key))
      filesInFlight.set(key, pending)
    }
    await pending
  }

  const out = new Map<string, string | null>()
  for (const path of paths) out.set(path, cache.get(path) ?? null)
  return out
}

async function fetchBatch(cache: Map<string, string | null>, batch: string[]): Promise<void> {
  const parsed = parseFilesResponse(await post('/v1/files', { paths: batch }))
  if (parsed === null) throw new BridgeGroundingError('The bridge sent a malformed /v1/files answer.')

  for (const file of parsed.files) cache.set(file.path, file.content)
  // Missing, binary and unreadable all mean the same thing to a consumer:
  // there is no text here. They are cached as null so the batch is not retried
  // on every task — but they are NOT errors, and must not fail the read.
  for (const path of parsed.missing) cache.set(path, null)
  for (const skip of parsed.skipped) cache.set(skip.path, null)
  // A path the bridge answered about in no bucket at all (an older or odd
  // build) is cached as null too, so it cannot leave the batch pending forever.
  for (const path of batch) if (!cache.has(path)) cache.set(path, null)
}

/** One file, through the same batch cache. */
export async function readLocalFile(prHead: string, path: string): Promise<string | null> {
  return (await readLocalFiles(prHead, [path])).get(path) ?? null
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Matches to ask the bridge for when a consumer wants ranked FILES. */
export const GROUNDING_SEARCH_MAX_RESULTS = 300

/** Files a path-shaped search reports back, matching the provider's own cap. */
export const GROUNDING_SEARCH_MAX_FILES = 10

export async function searchLocal(
  query: string,
  opts: { maxResults?: number; regex?: boolean } = {},
): Promise<{ matches: BridgeSearchMatch[]; truncated: boolean }> {
  const body: Record<string, unknown> = {
    query,
    maxResults: opts.maxResults ?? GROUNDING_SEARCH_MAX_RESULTS,
  }
  if (opts.regex === true) body['regex'] = true
  const parsed = parseSearchResponse(await post('/v1/search', body))
  if (parsed === null) throw new BridgeGroundingError('The bridge sent a malformed /v1/search answer.')
  return { matches: parsed.matches, truncated: parsed.truncated }
}

/**
 * The provider's `searchCodePaths` shape: matched FILE paths, deduped and
 * ranked by match count, capped the same way GitHub's is so the symbol-search
 * caller behaves identically whichever source answered.
 */
export async function searchLocalPaths(symbol: string): Promise<string[]> {
  const { matches } = await searchLocal(symbol)
  const counts = new Map<string, number>()
  for (const match of matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GROUNDING_SEARCH_MAX_FILES)
    .map(([path]) => path)
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Cap on files quoted in a tool-facing search result. */
const SEARCH_TEXT_MAX_FILES = 10
/** Cap on preview lines quoted per file. */
const SEARCH_TEXT_MAX_LINES_PER_FILE = 6

/**
 * Render matches the way the deep-review tools expect: grouped by file, ranked
 * by match count, with `path:line` on every quoted line.
 *
 * Deliberately richer than the provider's equivalent, which returns
 * context-free fragments with no line numbers — the local source knows exactly
 * where each hit is, and a reviewer that can cite `src/a.ts:41` is a reviewer
 * whose claim can be checked.
 */
function renderMatches(header: string, matches: BridgeSearchMatch[], truncated: boolean): string {
  if (matches.length === 0) return 'No matches found.'

  const byFile = new Map<string, BridgeSearchMatch[]>()
  for (const match of matches) {
    const list = byFile.get(match.path)
    if (list) list.push(match)
    else byFile.set(match.path, [match])
  }

  const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)
  const lines: string[] = [
    `${matches.length}${truncated ? '+' : ''} match(es) in ${byFile.size} file(s)${header}:`,
  ]
  for (const [path, hits] of ranked.slice(0, SEARCH_TEXT_MAX_FILES)) {
    lines.push(`## ${path}`)
    for (const hit of hits.slice(0, SEARCH_TEXT_MAX_LINES_PER_FILE)) {
      lines.push(`${path}:${hit.line}: ${hit.preview.trim()}`)
    }
    if (hits.length > SEARCH_TEXT_MAX_LINES_PER_FILE) {
      lines.push(`… and ${hits.length - SEARCH_TEXT_MAX_LINES_PER_FILE} more in this file`)
    }
  }
  if (ranked.length > SEARCH_TEXT_MAX_FILES) {
    lines.push(`… and ${ranked.length - SEARCH_TEXT_MAX_FILES} more file(s)`)
  }
  return lines.join('\n')
}

/** The deep-review `search_code` tool, answered locally. */
export async function searchLocalCode(query: string): Promise<string> {
  const { matches, truncated } = await searchLocal(query)
  return renderMatches(' (your local checkout)', matches, truncated)
}

/**
 * The deep-review `find_references` tool, answered locally.
 *
 * Symbol-BOUNDARY matching, like the provider's version: searching `config`
 * must not report every `configure`. The bridge takes a regex, so the boundary
 * is applied at the source instead of by filtering fragments afterwards.
 */
export async function findLocalReferences(symbol: string): Promise<string> {
  const pattern = `(^|[^\\w$])${escapeRegExp(symbol)}($|[^\\w$])`
  const { matches, truncated } = await searchLocal(pattern, { regex: true })
  if (matches.length === 0) return `No references to "${symbol}" found in your local checkout.`
  return renderMatches(` for "${symbol}" (your local checkout)`, matches, truncated)
}

/** FOR TESTS ONLY: drop every cached file and every failure latch. */
export function _resetGroundingForTest(): void {
  fileCache.clear()
  filesInFlight.clear()
  failedHeads.clear()
}
