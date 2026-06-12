/**
 * src/lib/landing/queueSizes.ts — lazy diff sizes (+adds −dels) for queue rows.
 *
 * GitHub search results don't include additions/deletions, so the landing page
 * fetches them per PR (GET /repos/:owner/:repo/pulls/:number) AFTER the queue
 * list has rendered — progressive enhancement: rows appear immediately, sizes
 * pop in as small batches resolve. Results are cached in sessionStorage keyed
 * by provider:owner/repo#number@updatedAt so a revisit within the session does
 * not refetch, while a PR update (new updatedAt) does. Failures (rate limit,
 * network) are silent — the row simply shows no size.
 *
 * GitLab/Bitbucket items are skipped: their list payloads carry no line counts
 * (GitLab's changes_count is a FILE count and our queue mapping doesn't fetch
 * it), so there is no cheap per-item size source for them here.
 */

import { ghFetch } from '../github/client'
import { getSettings } from '../settings/settings'
import type { QueueItem, PrRefX } from '../provider/types'

export interface DiffSize {
  additions: number
  deletions: number
}

const CACHE_PREFIX = 'review123:queue-size:'
/** PRs fetched concurrently per batch — small to stay polite to the API */
const DEFAULT_BATCH_SIZE = 4
/** Hard cap on fetches per pass — matches the max visible queue size
 *  (each provider query is per_page=20; awaiting + authored ≤ 40 per provider,
 *  but only GitHub items are fetched). */
const DEFAULT_CAP = 40

/** Stable per-row key: "provider:owner/repo#number" (no updatedAt — UI-facing). */
export function sizeKey(item: QueueItem): string {
  const { provider, owner, repo, number } = item.ref
  return `${provider}:${owner}/${repo}#${number}`
}

function cacheKey(item: QueueItem): string {
  return `${CACHE_PREFIX}${sizeKey(item)}@${item.updatedAt}`
}

function isDiffSize(raw: unknown): raw is DiffSize {
  if (typeof raw !== 'object' || raw === null) return false
  const obj = raw as Record<string, unknown>
  return typeof obj['additions'] === 'number' && typeof obj['deletions'] === 'number'
}

function readCache(item: QueueItem): DiffSize | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(item))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isDiffSize(parsed) ? { additions: parsed.additions, deletions: parsed.deletions } : null
  } catch {
    return null
  }
}

function writeCache(item: QueueItem, size: DiffSize): void {
  try {
    // Prune stale entries for the same PR (older updatedAt) so updates don't
    // accumulate dead keys within the session.
    const stalePrefix = `${CACHE_PREFIX}${sizeKey(item)}@`
    const current = cacheKey(item)
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (key && key.startsWith(stalePrefix) && key !== current) {
        sessionStorage.removeItem(key)
      }
    }
    sessionStorage.setItem(current, JSON.stringify(size))
  } catch {
    // sessionStorage unavailable/full — caching is best-effort
  }
}

/**
 * Synchronously collect already-cached sizes for the given items.
 * Keyed by sizeKey(item). Safe to call before render.
 */
export function getCachedSizes(items: QueueItem[]): Record<string, DiffSize> {
  const out: Record<string, DiffSize> = {}
  for (const item of items) {
    const cached = readCache(item)
    if (cached) out[sizeKey(item)] = cached
  }
  return out
}

type FetchPr = (ref: PrRefX) => Promise<unknown>

function defaultFetchPr(ref: PrRefX): Promise<unknown> {
  return ghFetch<unknown>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`)
}

/**
 * Fetch missing sizes for GitHub items in small sequential batches, reporting
 * each result through onSize as it arrives. Never throws; per-item failures
 * are silent (no size shown for that row). Call this UN-AWAITED after the
 * queue list renders — it must never block or delay the list.
 */
export async function fetchMissingSizes(
  items: QueueItem[],
  onSize: (key: string, size: DiffSize) => void,
  opts: { batchSize?: number; cap?: number; fetchPr?: FetchPr } = {},
): Promise<void> {
  const { batchSize = DEFAULT_BATCH_SIZE, cap = DEFAULT_CAP } = opts
  // The default fetcher is inert without a GitHub token: unauthenticated
  // calls would burn the anonymous rate limit for nothing (the queue itself
  // requires auth to be non-empty).
  const fetchPr = opts.fetchPr ?? (getSettings().githubAuth ? defaultFetchPr : null)
  if (!fetchPr) return

  const pending = items
    .filter((item) => item.ref.provider === 'github' && readCache(item) === null)
    .slice(0, cap)

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async (item) => {
        try {
          const raw = await fetchPr(item.ref)
          if (!isDiffSize(raw)) return // unexpected shape — silent
          const size: DiffSize = { additions: raw.additions, deletions: raw.deletions }
          writeCache(item, size)
          onSize(sizeKey(item), size)
        } catch {
          // Silent failure (rate limit, network, 404) — row shows no size
        }
      }),
    )
  }
}
