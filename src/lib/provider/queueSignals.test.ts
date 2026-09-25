/**
 * src/lib/provider/queueSignals.test.ts — the signals fan-out.
 *
 * The assertion that matters most here is the NEGATIVE one: a provider without
 * getQueueSignals contributes nothing and is never asked. That is what "declare
 * a capability rather than assuming GitHub" buys — GitLab and Bitbucket rows go
 * through the same code path and simply come back unannotated, the way they come
 * back without resolved-thread markers.
 */
import { describe, it, expect, vi } from 'vitest'
import { fetchAllQueueSignals } from './queueSignals'
import { queueKey } from './queue'
import { sizeKey } from '../landing/queueSizes'
import type { ReviewProvider, QueueItem, QueueSignal } from './types'

function signal(over: Partial<QueueSignal> = {}): QueueSignal {
  return {
    ci: 'passing',
    unresolved: 0,
    threads: 0,
    unresolvedTruncated: false,
    size: null,
    base: { kind: 'unknown' },
    headOid: null,
    ...over,
  }
}

function makeProvider(
  id: 'github' | 'gitlab' | 'bitbucket',
  getQueueSignals?: ReviewProvider['getQueueSignals'],
): ReviewProvider {
  return {
    id,
    displayName: id,
    capabilities: { resolvedThreads: false, checks: false, suggestions: false, atomicReview: false, compare: false, commentReplies: false, selfReviewBlocked: false },
    parseUrl: () => ({ ok: false, error: 'not impl' }),
    prWebUrl: () => '',
    getPrMeta: async () => { throw new Error('not impl') },
    getPrFiles: async () => [],
    getFileAtRef: async () => null,
    getCiSummary: async () => ({ total: 0, passed: 0, failed: 0, pending: 0, failures: [] }),
    getComments: async () => [],
    getResolvedCommentIds: async () => new Set(),
    getCommits: async () => [],
    compareCommits: async () => [],
    submitReview: async () => ({ ok: true }),
    authState: () => ({ configured: true, hint: '' }),
    ...(getQueueSignals ? { getQueueSignals } : {}),
  }
}

function item(provider: 'github' | 'gitlab', number: number, authorIsMe = false): QueueItem {
  return {
    ref: { provider, owner: 'o', repo: 'r', number },
    title: `PR ${number}`,
    authorIsMe,
    updatedAt: '2024-01-01T00:00:00Z',
  }
}

describe('fetchAllQueueSignals', () => {
  it('returns nothing for a provider that declares no signals capability', async () => {
    const gl = makeProvider('gitlab')
    const result = await fetchAllQueueSignals([gl], [item('gitlab', 1)])
    expect(result).toEqual({})
  })

  it('never calls a provider that has no getQueueSignals', async () => {
    // There is no method to spy on, so the proof is that the call resolves at
    // all rather than throwing on an undefined call.
    const bb = makeProvider('bitbucket')
    await expect(fetchAllQueueSignals([bb], [item('gitlab', 1)])).resolves.toEqual({})
  })

  it('asks each provider only about its OWN rows', async () => {
    const ghSpy = vi.fn().mockResolvedValue({})
    const gh = makeProvider('github', ghSpy)
    const gl = makeProvider('gitlab')

    await fetchAllQueueSignals([gh, gl], [item('github', 1), item('gitlab', 2), item('github', 3)])

    const [items] = ghSpy.mock.calls[0] as [QueueItem[]]
    expect(items.map((i) => i.ref.number)).toEqual([1, 3])
  })

  it('forwards only the merge-state subset that belongs to that provider', async () => {
    const ghSpy = vi.fn().mockResolvedValue({})
    const gh = makeProvider('github', ghSpy)
    const mine = item('github', 1, true)
    const theirs = item('github', 2)
    const otherProvidersMine = item('gitlab', 9, true)

    await fetchAllQueueSignals([gh], [mine, theirs, otherProvidersMine], [mine, otherProvidersMine])

    const [, mergeItems] = ghSpy.mock.calls[0] as [QueueItem[], QueueItem[]]
    expect(mergeItems).toEqual([mine])
  })

  it('merges answers from several providers into one map', async () => {
    const ghItem = item('github', 1)
    const glItem = item('gitlab', 2)
    const gh = makeProvider('github', async () => ({ [queueKey(ghItem)]: signal({ ci: 'failing' }) }))
    const gl = makeProvider('gitlab', async () => ({ [queueKey(glItem)]: signal({ ci: 'running' }) }))

    const result = await fetchAllQueueSignals([gh, gl], [ghItem, glItem])
    expect(result[queueKey(ghItem)].ci).toBe('failing')
    expect(result[queueKey(glItem)].ci).toBe('running')
  })

  it('a failing provider costs only its own rows', async () => {
    const ghItem = item('github', 1)
    const glItem = item('gitlab', 2)
    const gh = makeProvider('github', async () => { throw new Error('rate limited') })
    const gl = makeProvider('gitlab', async () => ({ [queueKey(glItem)]: signal() }))

    const result = await fetchAllQueueSignals([gh, gl], [ghItem, glItem])
    expect(result[queueKey(ghItem)]).toBeUndefined()
    expect(result[queueKey(glItem)]).toBeDefined()
  })

  it('makes no calls for an empty queue', async () => {
    const ghSpy = vi.fn().mockResolvedValue({})
    await fetchAllQueueSignals([makeProvider('github', ghSpy)], [])
    expect(ghSpy).not.toHaveBeenCalled()
  })

  it('skips a row whose provider is not in the registry', async () => {
    const result = await fetchAllQueueSignals([makeProvider('github', async () => ({}))], [item('gitlab', 1)])
    expect(result).toEqual({})
  })
})

describe('the queue key', () => {
  it('is ONE function, so a signal cannot land on a different row than its size', async () => {
    // The signals map and the sizes map are looked up with each other's keys in
    // Landing.svelte. Two implementations that agree today and drift tomorrow
    // would put a PR's CI state on a different PR's row, silently.
    expect(sizeKey).toBe(queueKey)
  })

  it('qualifies by provider, so two providers’ PR #1 are different rows', () => {
    expect(queueKey(item('github', 1))).not.toBe(queueKey(item('gitlab', 1)))
    expect(queueKey(item('github', 1))).toBe('github:o/r#1')
  })
})
