/**
 * src/lib/github/queueSignals.test.ts
 *
 * The batched queue-signals query. The load-bearing assertions are:
 *
 *   1. ONE request for a whole batch, not one per PR. That is the entire reason
 *      this module exists, so it is asserted as a request COUNT, not inferred.
 *   2. Unresolved conversations are counted as THREADS. #272 shipped a count of
 *      comment ids — which include replies — and a five-reply conversation
 *      counted as five. There is a test here whose only job is to fail if that
 *      comes back.
 *   3. Every "cannot answer" path returns nothing rather than a zero.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchQueueSignals, refKey } from './queueSignals'

const REF = (owner: string, repo: string, number: number) => ({ owner, repo, number })

function repoNode(pr: Record<string, unknown> | null, viewerPermission = 'WRITE') {
  return { viewerPermission, pullRequest: pr }
}

/** A pull-request node with sensible defaults, overridable per test. */
function prNode(over: Record<string, unknown> = {}) {
  return {
    additions: 10,
    deletions: 4,
    mergeable: 'MERGEABLE',
    headRefOid: 'abc123',
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...over,
  }
}

function mockGraphql(data: unknown, init: { ok?: boolean } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    json: async () => ({ data }),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('fetchQueueSignals', () => {
  beforeEach(() => {
    localStorage.clear()
    // Same token-seeding idiom as threads.test.ts — the module reads settings
    // straight out of localStorage, so that is where the auth guard is armed.
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_test', method: 'pat', scopes: [] } }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // -------------------------------------------------------------------------
  // The whole point: one request, not N
  // -------------------------------------------------------------------------

  it('asks for twenty PRs in ONE request instead of twenty', async () => {
    const refs = Array.from({ length: 20 }, (_, i) => REF('o', 'r', i + 1))
    const data: Record<string, unknown> = {}
    refs.forEach((_, i) => { data[`p${i}`] = repoNode(prNode()) })
    const fetchMock = mockGraphql(data)

    const out = await fetchQueueSignals(refs)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.size).toBe(20)
  })

  it('batches beyond the per-document cap rather than growing one huge query', async () => {
    const refs = Array.from({ length: 35 }, (_, i) => REF('o', 'r', i + 1))
    const fetchMock = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string }
      const aliases = [...body.query.matchAll(/^\s+p(\d+):/gm)].length
      const data: Record<string, unknown> = {}
      for (let i = 0; i < aliases; i++) data[`p${i}`] = repoNode(prNode())
      return { ok: true, json: async () => ({ data }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await fetchQueueSignals(refs)

    // 35 rows at 20 per document — two requests, where the old page cost 35
    // REST calls for the diff sizes alone.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(out.size).toBe(35)
  })

  it('hits the GraphQL endpoint with the bearer token, once', async () => {
    const fetchMock = mockGraphql({ p0: repoNode(prNode()) })
    await fetchQueueSignals([REF('o', 'r', 1)])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/graphql')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test')
  })

  // -------------------------------------------------------------------------
  // #272's bug, which this must not repeat
  // -------------------------------------------------------------------------

  it('counts unresolved THREADS, so a conversation with many replies counts once', async () => {
    // Three threads; one resolved. The unresolved two carry five and three
    // replies respectively — eight comments. The answer is TWO.
    mockGraphql({
      p0: repoNode(
        prNode({
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { isResolved: false },
              { isResolved: true },
              { isResolved: false },
            ],
          },
        }),
      ),
    })

    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.get(refKey(REF('o', 'r', 1)))?.unresolved).toBe(2)
  })

  it('reports zero unresolved when every thread is resolved', async () => {
    mockGraphql({
      p0: repoNode(
        prNode({
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [{ isResolved: true }, { isResolved: true }],
          },
        }),
      ),
    })
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.get(refKey(REF('o', 'r', 1)))?.unresolved).toBe(0)
  })

  it('marks the count as truncated when more threads exist than one page holds', async () => {
    mockGraphql({
      p0: repoNode(
        prNode({
          reviewThreads: {
            pageInfo: { hasNextPage: true },
            nodes: [{ isResolved: false }, { isResolved: false }],
          },
        }),
      ),
    })
    const signal = (await fetchQueueSignals([REF('o', 'r', 1)])).get(refKey(REF('o', 'r', 1)))
    expect(signal?.unresolved).toBe(2)
    // The count is a FLOOR, and the row renders it as "2+" rather than as a
    // number it cannot stand behind.
    expect(signal?.unresolvedTruncated).toBe(true)
  })

  // -------------------------------------------------------------------------
  // CI states
  // -------------------------------------------------------------------------

  it.each([
    ['SUCCESS', 'passing'],
    ['FAILURE', 'failing'],
    ['ERROR', 'failing'],
    ['PENDING', 'running'],
    ['EXPECTED', 'running'],
  ])('maps rollup %s to %s', async (state, expected) => {
    mockGraphql({
      p0: repoNode(prNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } })),
    })
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.get(refKey(REF('o', 'r', 1)))?.ci).toBe(expected)
  })

  it('a PR with no checks configured reports "none", not a failure and not a pass', async () => {
    mockGraphql({
      p0: repoNode(prNode({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })),
    })
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.get(refKey(REF('o', 'r', 1)))?.ci).toBe('none')
  })

  it('a rollup state GitHub has not taught us reports null rather than a guess', async () => {
    mockGraphql({
      p0: repoNode(
        prNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FUTURE_STATE' } } }] } }),
      ),
    })
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.get(refKey(REF('o', 'r', 1)))?.ci).toBeNull()
  })

  it('no commit node at all means "could not tell", which is not "no CI"', async () => {
    mockGraphql({ p0: repoNode(prNode({ commits: { nodes: [] } })) })
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.get(refKey(REF('o', 'r', 1)))?.ci).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Sizes (the fetch this query replaces)
  // -------------------------------------------------------------------------

  it('returns the diff size, so the per-row REST size fetch has nothing to do', async () => {
    mockGraphql({ p0: repoNode(prNode({ additions: 216, deletions: 179 })) })
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.get(refKey(REF('o', 'r', 1)))?.size).toEqual({ additions: 216, deletions: 179 })
  })

  // -------------------------------------------------------------------------
  // Base standing
  // -------------------------------------------------------------------------

  it('reports a conflict from `mergeable` alone, without the merge-state pass', async () => {
    mockGraphql({ p0: repoNode(prNode({ mergeable: 'CONFLICTING' })) })
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.get(refKey(REF('o', 'r', 1)))?.base).toEqual({ kind: 'conflicted' })
  })

  it('reports BEHIND with canUpdate when the viewer can push', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { p0: repoNode(prNode(), 'WRITE') } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { p0: { pullRequest: { mergeStateStatus: 'BEHIND' } } } }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const refs = [REF('o', 'r', 1)]
    const out = await fetchQueueSignals(refs, refs)
    expect(out.get(refKey(refs[0]))?.base).toEqual({ kind: 'behind', canUpdate: true })
  })

  it('reports BEHIND with canUpdate false for a repo the viewer can only read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { p0: repoNode(prNode(), 'READ') } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { p0: { pullRequest: { mergeStateStatus: 'BEHIND' } } } }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const refs = [REF('o', 'r', 1)]
    const out = await fetchQueueSignals(refs, refs)
    expect(out.get(refKey(refs[0]))?.base).toEqual({ kind: 'behind', canUpdate: false })
  })

  it('DIRTY from the merge-state pass is a conflict, never an update offer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { p0: repoNode(prNode()) } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { p0: { pullRequest: { mergeStateStatus: 'DIRTY' } } } }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const refs = [REF('o', 'r', 1)]
    const out = await fetchQueueSignals(refs, refs)
    expect(out.get(refKey(refs[0]))?.base).toEqual({ kind: 'conflicted' })
  })

  it.each(['CLEAN', 'BLOCKED', 'UNSTABLE', 'HAS_HOOKS'])(
    '%s means "not behind" — a check or review state is not a base that moved',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { p0: repoNode(prNode()) } }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { p0: { pullRequest: { mergeStateStatus: status } } } }),
        })
      vi.stubGlobal('fetch', fetchMock)

      const refs = [REF('o', 'r', 1)]
      const out = await fetchQueueSignals(refs, refs)
      expect(out.get(refKey(refs[0]))?.base).toEqual({ kind: 'current' })
    },
  )

  it('UNKNOWN mergeability stays unknown — no button on a PR GitHub has not judged', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { p0: repoNode(prNode({ mergeable: 'UNKNOWN' })) } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { p0: { pullRequest: { mergeStateStatus: 'UNKNOWN' } } } }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const refs = [REF('o', 'r', 1)]
    const out = await fetchQueueSignals(refs, refs)
    expect(out.get(refKey(refs[0]))?.base).toEqual({ kind: 'unknown' })
  })

  it('skips the merge-state request entirely when no ref asked for it', async () => {
    const fetchMock = mockGraphql({ p0: repoNode(prNode()) })
    await fetchQueueSignals([REF('o', 'r', 1)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('losing the merge-state query costs only the base standing, not every signal', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { p0: repoNode(prNode()) } }) })
      // The preview media type went away: a validation error nulls `data`.
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: null, errors: [{}] }) })
    vi.stubGlobal('fetch', fetchMock)

    const refs = [REF('o', 'r', 1)]
    const signal = (await fetchQueueSignals(refs, refs)).get(refKey(refs[0]))
    expect(signal?.ci).toBe('passing')
    expect(signal?.unresolved).toBe(0)
    expect(signal?.base).toEqual({ kind: 'unknown' })
  })

  // -------------------------------------------------------------------------
  // Cannot answer
  // -------------------------------------------------------------------------

  it('returns nothing at all without a token, and makes no request', async () => {
    localStorage.clear()
    const fetchMock = mockGraphql({})
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an HTTP failure yields no signals rather than zeroes', async () => {
    mockGraphql({}, { ok: false })
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.size).toBe(0)
  })

  it('a thrown fetch yields no signals rather than rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(fetchQueueSignals([REF('o', 'r', 1)])).resolves.toEqual(new Map())
  })

  it('a body that is not a GraphQL response yields no signals', async () => {
    // The shape an over-broad test route hands back when it answers everything
    // on api.github.com with `[]`.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))
    const out = await fetchQueueSignals([REF('o', 'r', 1)])
    expect(out.size).toBe(0)
  })

  it('one inaccessible repo does not blank the signals for the rest of the batch', async () => {
    // GraphQL answers with BOTH partial data and errors when one alias fails.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { p0: null, p1: repoNode(prNode({ additions: 7, deletions: 7 })) },
          errors: [{ message: 'Could not resolve to a Repository' }],
        }),
      }),
    )

    const refs = [REF('o', 'secret', 1), REF('o', 'open', 2)]
    const out = await fetchQueueSignals(refs)
    expect(out.has(refKey(refs[0]))).toBe(false)
    expect(out.get(refKey(refs[1]))?.size).toEqual({ additions: 7, deletions: 7 })
  })

  it('drops refs whose names GitHub could not have issued instead of escaping them', async () => {
    const fetchMock = mockGraphql({ p0: repoNode(prNode()) })
    const hostile = { owner: 'o") { x } y: repository(owner: "z', repo: 'r', number: 1 }
    const ok = REF('good', 'repo', 2)

    await fetchQueueSignals([hostile, ok])

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      query: string
    }
    expect(body.query).not.toContain('y: repository')
    expect(body.query).toContain('"good"')
  })
})
