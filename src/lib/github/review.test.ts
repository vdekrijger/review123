import { describe, it, expect, vi, beforeEach } from 'vitest'
import { submitReview, _resetInFlightForTest, type Verdict } from './review'
import type { PrRef } from './parse'
import type { Draft } from '../drafts/drafts.svelte'
import { jsonResponse } from '../../test-helpers'

const ref: PrRef = { owner: 'alice', repo: 'widgets', number: 42 }
const commitId = 'abc123def456'
const verdict: Verdict = 'APPROVE'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(body, headers, status)))
}

function makeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    prKey: 'alice/widgets#42',
    path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    body: 'Nice work',
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('submitReview', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetInFlightForTest()
  })

  // -------------------------------------------------------------------------
  // Request body shape
  // -------------------------------------------------------------------------

  it('zero-comment APPROVE body has NO comments key (EC-09a)', async () => {
    const f = mockFetch(200, { id: 1 })
    vi.stubGlobal('fetch', f)

    const result = await submitReview(ref, 'APPROVE', 'Looks good', [], commitId)

    expect(result).toEqual({ ok: true })
    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody).toEqual({ commit_id: commitId, body: 'Looks good', event: 'APPROVE' })
    expect('comments' in sentBody).toBe(false)
  })

  it('maps drafts to path/line/side/body — no position field (CH-02)', async () => {
    const f = mockFetch(200, { id: 2 })
    vi.stubGlobal('fetch', f)

    const draft = makeDraft({ path: 'lib/util.ts', line: 25, side: 'LEFT', body: 'Fix this' })
    await submitReview(ref, 'REQUEST_CHANGES', 'Some issues', [draft], commitId)

    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments).toEqual([{ path: 'lib/util.ts', line: 25, side: 'LEFT', body: 'Fix this' }])
    expect(sentBody.comments[0]).not.toHaveProperty('position')
  })

  it('includes multiple comment drafts with correct fields', async () => {
    const f = mockFetch(200, { id: 3 })
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'Comment A' }),
      makeDraft({ path: 'b.ts', line: 5, side: 'LEFT', body: 'Comment B' }),
    ]
    await submitReview(ref, 'COMMENT', 'Overall remarks', drafts, commitId)

    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments).toHaveLength(2)
    expect(sentBody.comments[0]).toEqual({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'Comment A' })
    expect(sentBody.comments[1]).toEqual({ path: 'b.ts', line: 5, side: 'LEFT', body: 'Comment B' })
  })

  it('POSTs to the correct endpoint', async () => {
    const f = mockFetch(200, {})
    vi.stubGlobal('fetch', f)

    await submitReview(ref, 'APPROVE', '', [], commitId)

    expect(f.mock.calls[0][0]).toBe('https://api.github.com/repos/alice/widgets/pulls/42/reviews')
    expect(f.mock.calls[0][1].method).toBe('POST')
  })

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  it('maps 401 to unauthorized with helpful message', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { message: 'Requires authentication' }))

    const result = await submitReview(ref, verdict, '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'unauthorized' })
    expect((result as { ok: false; message: string }).message.length).toBeGreaterThan(0)
  })

  it('maps 403 to forbidden', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { message: 'Forbidden' }, { 'X-RateLimit-Remaining': '42' }))

    const result = await submitReview(ref, verdict, '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'forbidden' })
  })

  it('maps 422 with "own pull request" to self-approve with verbatim message (EC-09e)', async () => {
    const githubMsg = 'Can not approve your own pull request'
    vi.stubGlobal('fetch', mockFetch(422, { message: githubMsg }))

    const result = await submitReview(ref, 'APPROVE', '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'self-approve', message: githubMsg })
  })

  it('maps other 422 to invalid-anchor with verbatim message (EC-09f)', async () => {
    const githubMsg = 'One or more of the lines you specified is invalid'
    vi.stubGlobal('fetch', mockFetch(422, { message: githubMsg }))

    const result = await submitReview(ref, verdict, '', [makeDraft()], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'invalid-anchor', message: githubMsg })
  })

  it('maps network failure to other', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    const result = await submitReview(ref, verdict, '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'other' })
    expect((result as { ok: false; message: string }).message.length).toBeGreaterThan(0)
  })

  it('maps rate-limited 403 to other', async () => {
    vi.stubGlobal('fetch', mockFetch(403, {}, {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '1781200000',
    }))

    const result = await submitReview(ref, verdict, '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'other' })
  })

  it('maps server error 5xx to other', async () => {
    vi.stubGlobal('fetch', mockFetch(500, { message: 'Internal Server Error' }))

    const result = await submitReview(ref, verdict, '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'other' })
  })

  // -------------------------------------------------------------------------
  // Double-submit guard (EC-09i)
  // -------------------------------------------------------------------------

  it('concurrent second call returns in-progress error WITHOUT a network call', async () => {
    let resolveFirst!: () => void
    const firstResponse = new Promise<Response>((res) => {
      resolveFirst = () => res(jsonResponse({ id: 99 }, {}, 200))
    })
    const f = vi.fn().mockReturnValue(firstResponse)
    vi.stubGlobal('fetch', f)

    // Fire first (not yet resolved)
    const first = submitReview(ref, 'APPROVE', 'A', [], commitId)
    // Fire second immediately (in-flight)
    const second = submitReview(ref, 'APPROVE', 'B', [], commitId)

    // Second should resolve immediately with the in-progress error
    const secondResult = await second
    expect(secondResult).toEqual({ ok: false, kind: 'other', message: 'A submission is already in progress.' })

    // Exactly one fetch call so far
    expect(f.mock.calls.length).toBe(1)

    // Resolve first
    resolveFirst()
    const firstResult = await first
    expect(firstResult).toEqual({ ok: true })
  })

  it('after completion a new submit works (flag cleared)', async () => {
    const f = mockFetch(200, { id: 10 })
    vi.stubGlobal('fetch', f)

    // First submit
    await submitReview(ref, 'APPROVE', '', [], commitId)
    // Second submit after first completes
    const result = await submitReview(ref, 'APPROVE', '', [], commitId)

    expect(result).toEqual({ ok: true })
    expect(f.mock.calls.length).toBe(2)
  })

  it('flag clears even after an error (finally guard)', async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({ id: 20 }, {}, 200)))
    vi.stubGlobal('fetch', f)

    // First submit fails
    await submitReview(ref, 'APPROVE', '', [], commitId)
    // Second submit should NOT be blocked
    const result = await submitReview(ref, 'APPROVE', '', [], commitId)

    expect(result).toEqual({ ok: true })
    expect(f.mock.calls.length).toBe(2)
  })
})
