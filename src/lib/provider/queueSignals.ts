/**
 * src/lib/provider/queueSignals.ts — fan-out for the queue's per-row signals.
 *
 * Mirrors queue.ts: group the queue by provider, ask each provider that HAS a
 * getQueueSignals for its own rows, merge the answers into one map keyed by
 * queueKey. A provider without the method contributes nothing and its rows
 * render no signals — the same way Bitbucket contributes no resolved-thread
 * markers rather than being special-cased at the call site.
 *
 * CAPABILITY BY METHOD PRESENCE, and why that rather than a boolean on
 * ProviderCapabilities. getMyQueue — the method these signals annotate — is
 * already declared that way, and the two cannot come apart: signals for a queue
 * a provider does not serve are unreachable code. A `queueSignals: true` flag
 * beside an absent method would be a claim the interface cannot keep, so the
 * method's presence IS the declaration. Nothing here, or in Landing.svelte,
 * ever branches on `provider.id === 'github'`.
 */

import { queueKey } from './queue'
import type { ReviewProvider, QueueItem } from './types'
import type { QueueSignal } from '../github/queueSignals'

export type { QueueSignal }

/**
 * Fetch signals for every row, from whichever provider owns it.
 *
 * `mergeStateItems` is the subset whose base standing should also be resolved —
 * pass the user's OWN open PRs. Resolving it for a PR the user cannot push to
 * costs a second request per batch to learn something no row will render.
 *
 * Never throws: a provider that fails contributes an empty map, exactly as
 * fetchAllQueues does, and the affected rows fall back to no signals.
 */
export async function fetchAllQueueSignals(
  providers: readonly ReviewProvider[],
  items: readonly QueueItem[],
  mergeStateItems: readonly QueueItem[] = [],
): Promise<Record<string, QueueSignal>> {
  const out: Record<string, QueueSignal> = {}
  if (items.length === 0) return out

  const byProvider = new Map<string, QueueItem[]>()
  for (const item of items) {
    const list = byProvider.get(item.ref.provider)
    if (list) list.push(item)
    else byProvider.set(item.ref.provider, [item])
  }

  const mergeKeys = new Set(mergeStateItems.map(queueKey))

  const results = await Promise.all(
    [...byProvider.entries()].map(async ([id, providerItems]) => {
      const provider = providers.find((p) => p.id === id)
      if (!provider || typeof provider.getQueueSignals !== 'function') return {}
      try {
        return await provider.getQueueSignals(
          providerItems,
          providerItems.filter((i) => mergeKeys.has(queueKey(i))),
        )
      } catch {
        return {}
      }
    }),
  )

  for (const result of results) Object.assign(out, result)
  return out
}
