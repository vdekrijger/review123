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
