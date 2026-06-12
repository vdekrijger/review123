import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sizeKey, getCachedSizes, fetchMissingSizes, type DiffSize } from './queueSizes'
import type { QueueItem } from '../provider/types'
import ghPullFixture from './__fixtures__/gh-pull.json'

function makeItem(
  provider: 'github' | 'gitlab',
  repo: string,
  number: number,
  updatedAt = '2026-06-01T12:00:00Z',
): QueueItem {
  return {
    ref: { provider, owner: 'org', repo, number },
    title: `PR ${number}`,
    authorIsMe: false,
    updatedAt,
  }
}

/** Deferred promise helper for concurrency assertions */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('queueSizes — lazy diff-size fetching for queue rows', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches sizes for GitHub items and reports them via onSize (fixture payload)', async () => {
    const item = makeItem('github', 'alpha', 7)
    const fetchPr = vi.fn(async () => ghPullFixture)
    const sizes = new Map<string, DiffSize>()

    await fetchMissingSizes([item], (key, size) => sizes.set(key, size), { fetchPr })

    expect(fetchPr).toHaveBeenCalledTimes(1)
    expect(fetchPr).toHaveBeenCalledWith(item.ref)
    expect(sizes.get(sizeKey(item))).toEqual({ additions: 142, deletions: 38 })
  })

  it('fetches in batches: the second batch only starts after the first resolves', async () => {
    const items = [1, 2, 3, 4].map((n) => makeItem('github', 'alpha', n))
    const gates = items.map(() => deferred<unknown>())
    let calls = 0
    const fetchPr = vi.fn(() => gates[calls++].promise)

    const done = fetchMissingSizes(items, () => {}, { fetchPr, batchSize: 2 })

    // Only the first batch is in flight until its promises settle
    await Promise.resolve()
    expect(fetchPr).toHaveBeenCalledTimes(2)

    gates[0].resolve(ghPullFixture)
    gates[1].resolve(ghPullFixture)
    await vi.waitFor(() => expect(fetchPr).toHaveBeenCalledTimes(4))

    gates[2].resolve(ghPullFixture)
    gates[3].resolve(ghPullFixture)
    await done
  })

  it('caps the number of fetches at the given cap', async () => {
    const items = [1, 2, 3, 4, 5].map((n) => makeItem('github', 'alpha', n))
    const fetchPr = vi.fn(async () => ghPullFixture)

    await fetchMissingSizes(items, () => {}, { fetchPr, cap: 3 })

    expect(fetchPr).toHaveBeenCalledTimes(3)
  })

  it('caches fetched sizes in sessionStorage: a second pass does not refetch', async () => {
    const item = makeItem('github', 'alpha', 7)
    const fetchPr = vi.fn(async () => ghPullFixture)

    await fetchMissingSizes([item], () => {}, { fetchPr })
    expect(fetchPr).toHaveBeenCalledTimes(1)

    await fetchMissingSizes([item], () => {}, { fetchPr })
    expect(fetchPr).toHaveBeenCalledTimes(1) // still 1 — served from cache

    expect(getCachedSizes([item])).toEqual({
      [sizeKey(item)]: { additions: 142, deletions: 38 },
    })
  })

  it('cache key includes updated_at: a newer updatedAt refetches', async () => {
    const stale = makeItem('github', 'alpha', 7, '2026-06-01T12:00:00Z')
    const fresh = makeItem('github', 'alpha', 7, '2026-06-02T08:00:00Z')
    const fetchPr = vi.fn(async () => ghPullFixture)

    await fetchMissingSizes([stale], () => {}, { fetchPr })
    await fetchMissingSizes([fresh], () => {}, { fetchPr })

    expect(fetchPr).toHaveBeenCalledTimes(2)
    // The fresh entry is cached; the stale one was pruned
    expect(getCachedSizes([fresh])).toEqual({
      [sizeKey(fresh)]: { additions: 142, deletions: 38 },
    })
    expect(getCachedSizes([stale])).toEqual({})
  })

  it('silent failure: a rejecting fetch neither throws nor reports a size', async () => {
    const ok = makeItem('github', 'alpha', 1)
    const bad = makeItem('github', 'alpha', 2)
    const fetchPr = vi.fn(async (ref: QueueItem['ref']) => {
      if (ref.number === 2) throw new Error('rate limited')
      return ghPullFixture
    })
    const sizes = new Map<string, DiffSize>()

    await expect(
      fetchMissingSizes([ok, bad], (key, size) => sizes.set(key, size), { fetchPr }),
    ).resolves.toBeUndefined()

    expect(sizes.has(sizeKey(ok))).toBe(true)
    expect(sizes.has(sizeKey(bad))).toBe(false)
    expect(getCachedSizes([bad])).toEqual({})
  })

  it('malformed payload (missing additions/deletions) is ignored and not cached', async () => {
    const item = makeItem('github', 'alpha', 7)
    const fetchPr = vi.fn(async () => ({ number: 7, title: 'no stats here' }))
    const onSize = vi.fn()

    await fetchMissingSizes([item], onSize, { fetchPr })

    expect(onSize).not.toHaveBeenCalled()
    expect(getCachedSizes([item])).toEqual({})
  })

  it('skips non-GitHub items (no per-item size source on the landing page)', async () => {
    const gl = makeItem('gitlab', 'beta', 3)
    const fetchPr = vi.fn(async () => ghPullFixture)

    await fetchMissingSizes([gl], () => {}, { fetchPr })

    expect(fetchPr).not.toHaveBeenCalled()
  })

  it('default fetcher is inert without GitHub auth — no network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const item = makeItem('github', 'alpha', 7)

    await fetchMissingSizes([item], () => {}) // no auth in localStorage

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('getCachedSizes ignores corrupt sessionStorage entries', async () => {
    const item = makeItem('github', 'alpha', 7)
    // Fetch once to learn nothing — instead seed garbage under every key shape
    sessionStorage.setItem(
      `review123:queue-size:${sizeKey(item)}@${item.updatedAt}`,
      'not json {',
    )
    expect(getCachedSizes([item])).toEqual({})
  })
})
