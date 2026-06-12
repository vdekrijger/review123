import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchAllQueues, _resetQueueCacheForTest } from './queue'
import type { ReviewProvider, QueueItem } from './types'

function makeProvider(id: string, hasQueue: boolean, authConfigured: boolean, queueResult: QueueItem[] = []): ReviewProvider {
  return {
    id: id as 'github' | 'gitlab' | 'bitbucket',
    displayName: id,
    capabilities: { resolvedThreads: false, checks: false, suggestions: false, atomicReview: false, compare: false, selfReviewBlocked: false },
    parseUrl: () => ({ ok: false, error: 'not impl' }),
    getPrMeta: async () => { throw new Error('not impl') },
    getPrFiles: async () => [],
    getFileAtRef: async () => null,
    getCiSummary: async () => ({ total: 0, passed: 0, failed: 0, pending: 0, failures: [] }),
    getComments: async () => [],
    getResolvedCommentIds: async () => new Set(),
    getCommits: async () => [],
    compareCommits: async () => [],
    submitReview: async () => ({ ok: true }),
    authState: () => ({ configured: authConfigured, hint: '' }),
    ...(hasQueue ? { getMyQueue: vi.fn().mockResolvedValue(queueResult) } : {}),
  }
}

describe('fetchAllQueues', () => {
  beforeEach(() => {
    _resetQueueCacheForTest()
  })

  it('returns empty array when no providers have getMyQueue', async () => {
    const providers = [makeProvider('bitbucket', false, true)]
    const result = await fetchAllQueues(providers)
    expect(result).toEqual([])
  })

  it('skips providers with auth not configured', async () => {
    const p = makeProvider('github', true, false)
    const result = await fetchAllQueues([p])
    expect(result).toEqual([])
    expect(p.getMyQueue).not.toHaveBeenCalled()
  })

  it('fetches from multiple providers in parallel and merges results', async () => {
    const ghItem: QueueItem = {
      ref: { provider: 'github', owner: 'o', repo: 'r', number: 1 },
      title: 'GH PR',
      authorIsMe: false,
      updatedAt: '2024-01-01T00:00:00Z',
    }
    const glItem: QueueItem = {
      ref: { provider: 'gitlab', owner: 'g', repo: 'p', number: 2 },
      title: 'GL MR',
      authorIsMe: true,
      updatedAt: '2024-01-02T00:00:00Z',
    }

    const gh = makeProvider('github', true, true, [ghItem])
    const gl = makeProvider('gitlab', true, true, [glItem])
    const bb = makeProvider('bitbucket', false, true)

    const result = await fetchAllQueues([gh, gl, bb])
    expect(result).toHaveLength(2)
    expect(result).toContainEqual(ghItem)
    expect(result).toContainEqual(glItem)
  })

  it('silently ignores provider failures and returns results from others', async () => {
    const failProvider: ReviewProvider = {
      ...makeProvider('github', true, true, []),
      getMyQueue: vi.fn().mockRejectedValue(new Error('network error')),
    }
    const okItem: QueueItem = {
      ref: { provider: 'gitlab', owner: 'g', repo: 'p', number: 3 },
      title: 'GL MR',
      authorIsMe: false,
      updatedAt: '2024-01-01T00:00:00Z',
    }
    const gl = makeProvider('gitlab', true, true, [okItem])

    const result = await fetchAllQueues([failProvider, gl])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(okItem)
  })

  it('returns cached results on second call without fetching again', async () => {
    const item: QueueItem = {
      ref: { provider: 'github', owner: 'o', repo: 'r', number: 1 },
      title: 'PR',
      authorIsMe: false,
      updatedAt: '2024-01-01T00:00:00Z',
    }
    const gh = makeProvider('github', true, true, [item])

    await fetchAllQueues([gh])
    await fetchAllQueues([gh])

    // getMyQueue should only have been called once (cached)
    expect(gh.getMyQueue).toHaveBeenCalledTimes(1)
  })
})
