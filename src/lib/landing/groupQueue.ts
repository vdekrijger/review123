/**
 * src/lib/landing/groupQueue.ts — per-repo grouping for the review queue.
 *
 * The landing page renders every queue list under compact repo headers with
 * the rows beneath — a single-repo list gets one header, multi-repo lists get
 * one per repo. groupByRepo buckets items by provider+owner/repo, preserving
 * first-seen group order and the item order within each group.
 */

import type { QueueItem } from '../provider/types'

export interface RepoGroup {
  /** Stable unique key: "provider:owner/repo" */
  key: string
  provider: QueueItem['ref']['provider']
  owner: string
  repo: string
  items: QueueItem[]
}

export function groupByRepo(items: QueueItem[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>()
  for (const item of items) {
    const { provider, owner, repo } = item.ref
    const key = `${provider}:${owner}/${repo}`
    let group = groups.get(key)
    if (!group) {
      group = { key, provider, owner, repo, items: [] }
      groups.set(key, group)
    }
    group.items.push(item)
  }
  return [...groups.values()]
}
