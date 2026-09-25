/**
 * src/lib/provider/queue.ts — fan-out fetcher for the "Your review queue" feature.
 *
 * Fetches QueueItem[] from all registered providers that:
 *   1. expose getMyQueue (capability implied by method presence)
 *   2. have auth configured (provider.authState().configured === true)
 *
 * Results are cached in-memory per provider per session. The cache is never
 * invalidated automatically — call _resetQueueCacheForTest() in tests or
 * expose a refreshQueue() that calls _resetQueueCacheForTest() first.
 */

import type { ReviewProvider, QueueItem } from './types'

/**
 * THE key for every per-row map the landing queue keeps — diff sizes, CI and
 * unresolved-conversation signals, in-flight prepare rows.
 *
 * It lives here, in the module that produces QueueItems, rather than in one of
 * the consumers: two consumers each building "the same" key by hand is how they
 * end up subtly different (one with the provider prefix, one without) and how a
 * signal lands on the wrong row.
 */
export function queueKey(item: QueueItem): string {
  const { provider, owner, repo, number } = item.ref
  return `${provider}:${owner}/${repo}#${number}`
}

// In-memory session cache: provider id → QueueItem[]
const _cache = new Map<string, QueueItem[]>()

/**
 * FOR TESTS ONLY (and for the Refresh button): clear the cache.
 */
export function _resetQueueCacheForTest(): void {
  _cache.clear()
}

/**
 * Fetch queue items from all eligible providers in parallel.
 * Per-provider failures are silently swallowed — the caller gets partial results.
 */
export async function fetchAllQueues(providers: ReviewProvider[]): Promise<QueueItem[]> {
  const eligible = providers.filter(
    (p) => typeof p.getMyQueue === 'function' && p.authState().configured,
  )

  const results = await Promise.all(
    eligible.map(async (p) => {
      if (_cache.has(p.id)) {
        return _cache.get(p.id)!
      }
      try {
        const items = await p.getMyQueue!()
        _cache.set(p.id, items)
        return items
      } catch {
        // Silent failure — return empty for this provider
        return []
      }
    }),
  )

  return results.flat()
}
