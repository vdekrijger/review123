/**
 * src/lib/github/queueSignals.ts — CI state, unresolved conversations, diff size
 * and base-branch standing for a WHOLE queue, in one GraphQL request per batch.
 *
 * WHY THIS IS NOT REST. The landing queue is ~35 rows across two sections, and
 * each row already cost one REST call for its diff stats. Adding CI status and
 * an unresolved-conversation count the same way would have been three calls per
 * row — roughly 105 requests to draw one page, against a 5000/hour REST budget
 * shared with the review flow, the mining passes and the preview detection.
 *
 * GraphQL answers all four for every row at once, and it does so out of a
 * SEPARATE 5000-points/hour budget, so the queue stops competing with the rest
 * of the app for the REST allowance entirely. `threads.ts` already speaks
 * GraphQL against the same endpoint with the same auth; this is that pattern,
 * widened from one PR to a batch.
 *
 * SHAPE. One aliased `repository(...)` selection per PR:
 *
 *     query {
 *       p0: repository(owner: "posthog", name: "posthog") {
 *         viewerPermission
 *         pullRequest(number: 21902) {
 *           additions deletions mergeable headRefOid
 *           reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } }
 *           commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
 *         }
 *       }
 *       p1: repository(...) { ... }
 *     }
 *
 * Batched at BATCH_SIZE aliases per request, so a 35-row queue is two requests.
 *
 * COUNTING UNRESOLVED CONVERSATIONS, and the bug this does not repeat. #272
 * counted resolved COMMENT ids and had to be corrected, because
 * `getResolvedCommentIds` returns every comment in a thread including replies —
 * a five-reply conversation counted as five. The unit of an "unresolved
 * conversation" is the THREAD, so this counts `reviewThreads` nodes with
 * `isResolved: false` and never looks at comments at all. A thread with fifty
 * replies is one.
 *
 * `first: 100` is the page cap GitHub allows. A PR with more review threads than
 * that reports `truncated: true` and the count is a FLOOR, which the UI renders
 * as `100+` rather than as a wrong number.
 *
 * MERGE STATE lives in a SECOND, SEPARATE query (fetchMergeStates). GitHub still
 * documents `PullRequest.mergeStateStatus` as requiring the merge-info preview
 * media type, and an unknown field is a VALIDATION error — which nulls `data`
 * for the entire document. Keeping it out of the main query means that if the
 * preview ever goes away, the cost is the Update-branch affordance, not every
 * signal on the page. `mergeable` (core schema, no preview) carries the conflict
 * case in the main query, so a conflict is still reported either way.
 */

import { getSettings } from '../settings/settings'
import type { PrRef } from './parse'

const GRAPHQL_URL = 'https://api.github.com/graphql'

/** Aliased PRs per GraphQL document. A 35-row queue is two requests. */
const BATCH_SIZE = 20

/** GitHub's per-page cap on a `reviewThreads` connection. */
const THREAD_PAGE = 100

const TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * 'none' means the query ANSWERED and this PR has no checks configured at all.
 * A `null` ci on QueueSignal means the query could not answer. They render the
 * same (nothing), and they are still different facts.
 */
export type CiState = 'passing' | 'failing' | 'running' | 'none'

/**
 * Where the PR stands against its base branch.
 *  - 'current'    — nothing to update.
 *  - 'behind'     — base has moved on; `canUpdate` is whether this viewer may
 *                   push to it (repo permission WRITE or better).
 *  - 'conflicted' — a real conflict. NOT resolvable server-side, so no button.
 *  - 'unknown'    — GitHub has not computed mergeability yet, or we did not ask.
 */
export type BaseState =
  | { kind: 'current' }
  | { kind: 'behind'; canUpdate: boolean }
  | { kind: 'conflicted' }
  | { kind: 'unknown' }

export interface QueueSignal {
  /** null when the query could not answer for this PR. */
  ci: CiState | null
  /** Count of UNRESOLVED review THREADS (never comments). null when unknown. */
  unresolved: number | null
  /** True when more threads exist than one page holds — `unresolved` is a floor. */
  unresolvedTruncated: boolean
  /** Diff size from the same query — replaces the per-row REST fetch. */
  size: { additions: number; deletions: number } | null
  base: BaseState
  /** Head SHA, passed to update-branch as `expected_head_sha` (race guard). */
  headOid: string | null
}

/** Key shared with the queue's other per-row maps: "owner/repo#number". */
export function refKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

// ---------------------------------------------------------------------------
// Query construction
//
// owner/repo go into the document as JSON string literals AND are validated
// against GitHub's own name charset first, so a hostile repository name cannot
// close the literal and append a selection. `number` is checked to be a
// positive integer. Anything that fails is dropped rather than escaped — a name
// GitHub cannot have issued is not a name worth querying.
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9._-]+$/

function isQueryable(ref: PrRef): boolean {
  return (
    NAME_RE.test(ref.owner) &&
    NAME_RE.test(ref.repo) &&
    Number.isInteger(ref.number) &&
    ref.number > 0
  )
}

function alias(i: number): string {
  return `p${i}`
}

function signalsDocument(refs: readonly PrRef[]): string {
  const parts = refs.map(
    (ref, i) => `  ${alias(i)}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)}) {
    viewerPermission
    pullRequest(number: ${ref.number}) {
      additions
      deletions
      mergeable
      headRefOid
      reviewThreads(first: ${THREAD_PAGE}) {
        pageInfo { hasNextPage }
        nodes { isResolved }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }`,
  )
  return `query {\n${parts.join('\n')}\n}`
}

function mergeStateDocument(refs: readonly PrRef[]): string {
  const parts = refs.map(
    (ref, i) => `  ${alias(i)}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)}) {
    pullRequest(number: ${ref.number}) { mergeStateStatus }
  }`,
  )
  return `query {\n${parts.join('\n')}\n}`
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * POST one GraphQL document. Never throws: every failure mode — no token, HTTP
 * error, unparseable body, network, timeout — resolves to null, and the caller
 * degrades to "could not answer" for that batch.
 *
 * A GraphQL response can carry BOTH `data` and `errors` (one alias failed, the
 * rest succeeded — a repo the token cannot see, say). `data` is returned in
 * that case rather than discarded, so one inaccessible repo does not blank the
 * signals for nineteen others.
 */
async function postGraphql(
  query: string,
  extraAccept?: string,
): Promise<Record<string, unknown> | null> {
  const auth = getSettings().githubAuth
  if (!auth) return null

  const accept = extraAccept
    ? `application/vnd.github+json, ${extraAccept}`
    : 'application/vnd.github+json'

  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: unknown }
    const data = json?.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    return data as Record<string, unknown>
  } catch {
    return null
  }
}

/** Split into BATCH_SIZE chunks. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface RepoNode {
  viewerPermission?: string | null
  pullRequest?: {
    additions?: number | null
    deletions?: number | null
    mergeable?: string | null
    headRefOid?: string | null
    reviewThreads?: {
      pageInfo?: { hasNextPage?: boolean | null } | null
      nodes?: Array<{ isResolved?: boolean | null } | null> | null
    } | null
    commits?: {
      nodes?: Array<{
        commit?: { statusCheckRollup?: { state?: string | null } | null } | null
      } | null> | null
    } | null
  } | null
}

/** Permissions that let the viewer push to the PR's branch. */
const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

/**
 * Map GitHub's rollup state onto the four states the queue renders.
 *
 * A MIXED result — nine green jobs and one red — arrives here as FAILURE,
 * because that is what the rollup of a mixed run is. The row says "failing",
 * which is the true and actionable read of a PR with a red check on it; the
 * per-check breakdown already lives on the review page's CI panel.
 *
 * An unrecognised state maps to null (cannot tell), never to a guess.
 */
function ciFromRollup(state: string | null | undefined, hasRollup: boolean): CiState | null {
  if (!hasRollup) return 'none'
  switch (state) {
    case 'SUCCESS':
      return 'passing'
    case 'PENDING':
    case 'EXPECTED':
      return 'running'
    case 'FAILURE':
    case 'ERROR':
      return 'failing'
    default:
      return null
  }
}

/**
 * One PR's parsed signals plus the viewer's push permission on its repo. The
 * permission is NOT part of QueueSignal: it only matters when the second pass
 * establishes that the PR is behind, and a field that is meaningless in three
 * of four base states does not belong on the public shape.
 */
interface ParsedNode {
  signal: QueueSignal
  canUpdate: boolean
}

function parseRepoNode(node: RepoNode | null | undefined): ParsedNode | null {
  const pr = node?.pullRequest
  if (!pr) return null

  const threadNodes = pr.reviewThreads?.nodes
  let unresolved: number | null = null
  let unresolvedTruncated = false
  if (Array.isArray(threadNodes)) {
    // THREADS, not comments (#272). One conversation is one, however many
    // replies hang off it.
    unresolved = threadNodes.filter((t) => t !== null && t.isResolved === false).length
    unresolvedTruncated = pr.reviewThreads?.pageInfo?.hasNextPage === true
  }

  const rollupHolder = pr.commits?.nodes?.[0]?.commit
  const hasRollup = Boolean(rollupHolder && rollupHolder.statusCheckRollup)
  // No commit node at all means the query could not tell us — that is not the
  // same as "no CI configured", so it stays null.
  const ci = rollupHolder ? ciFromRollup(rollupHolder.statusCheckRollup?.state, hasRollup) : null

  const size =
    typeof pr.additions === 'number' && typeof pr.deletions === 'number'
      ? { additions: pr.additions, deletions: pr.deletions }
      : null

  const canUpdate = PUSH_PERMISSIONS.has(node?.viewerPermission ?? '')
  // CONFLICTING is decided here; BEHIND needs mergeStateStatus and is layered on
  // afterwards by applyMergeStates. MERGEABLE alone does NOT mean up to date.
  const base: BaseState = pr.mergeable === 'CONFLICTING' ? { kind: 'conflicted' } : { kind: 'unknown' }

  return {
    signal: {
      ci,
      unresolved,
      unresolvedTruncated,
      size,
      base,
      headOid: typeof pr.headRefOid === 'string' ? pr.headRefOid : null,
    },
    canUpdate,
  }
}

// ---------------------------------------------------------------------------
// fetchQueueSignals
// ---------------------------------------------------------------------------

/**
 * Fetch signals for every PR in `refs`.
 *
 * `mergeStateRefs` (a subset) additionally get their base standing resolved —
 * pass the user's OWN PRs, since "update this branch" is only ever offered on a
 * PR the user can push to.
 *
 * Never throws and never rejects: a PR the query could not answer for is simply
 * absent from the returned map, and the row renders no signals.
 */
export async function fetchQueueSignals(
  refs: readonly PrRef[],
  mergeStateRefs: readonly PrRef[] = [],
): Promise<Map<string, QueueSignal>> {
  const out = new Map<string, QueueSignal>()
  const queryable = refs.filter(isQueryable)
  if (queryable.length === 0) return out
  if (!getSettings().githubAuth) return out

  const canUpdateByKey = new Map<string, boolean>()

  for (const batch of chunk(queryable, BATCH_SIZE)) {
    const data = await postGraphql(signalsDocument(batch))
    if (!data) continue
    batch.forEach((ref, i) => {
      const parsed = parseRepoNode(data[alias(i)] as RepoNode | null | undefined)
      if (!parsed) return
      canUpdateByKey.set(refKey(ref), parsed.canUpdate)
      out.set(refKey(ref), parsed.signal)
    })
  }

  await applyMergeStates(out, canUpdateByKey, mergeStateRefs.filter(isQueryable))
  return out
}

/**
 * Second pass: resolve BEHIND / CLEAN for the refs that can act on it.
 *
 * `mergeStateStatus` is UNKNOWN until GitHub has computed mergeability, which it
 * does lazily. An UNKNOWN answer leaves the row at `unknown` — no button, no
 * claim — rather than guessing, because the one thing an Update button must not
 * do is appear on a PR that cannot be updated.
 */
async function applyMergeStates(
  signals: Map<string, QueueSignal>,
  canUpdateByKey: Map<string, boolean>,
  refs: readonly PrRef[],
): Promise<void> {
  if (refs.length === 0) return

  for (const batch of chunk(refs, BATCH_SIZE)) {
    const data = await postGraphql(
      mergeStateDocument(batch),
      'application/vnd.github.merge-info-preview+json',
    )
    if (!data) continue
    batch.forEach((ref, i) => {
      const node = data[alias(i)] as { pullRequest?: { mergeStateStatus?: string | null } | null } | null
      const status = node?.pullRequest?.mergeStateStatus
      const key = refKey(ref)
      const signal = signals.get(key)
      if (!signal || typeof status !== 'string') return
      if (status === 'DIRTY') {
        signal.base = { kind: 'conflicted' }
      } else if (status === 'BEHIND') {
        signal.base = { kind: 'behind', canUpdate: canUpdateByKey.get(key) === true }
      } else if (status === 'UNKNOWN') {
        // Leave whatever the mergeable field already established.
      } else {
        // CLEAN / BLOCKED / UNSTABLE / HAS_HOOKS / DRAFT — all mean "not behind".
        // BLOCKED and UNSTABLE are about review or check state, not about the
        // base having moved, so none of them is an update-branch offer.
        if (signal.base.kind !== 'conflicted') signal.base = { kind: 'current' }
      }
    })
  }
}
