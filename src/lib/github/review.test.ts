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

  it('forbidden outcome includes PAT guidance for org OAuth-app restrictions (Fix-C)', async () => {
    const githubMsg = 'Resource not accessible by integration'
    vi.stubGlobal('fetch', mockFetch(403, { message: githubMsg }, { 'X-RateLimit-Remaining': '42' }))

    const result = await submitReview(ref, verdict, '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'forbidden' })
    const { message } = result as { ok: false; message: string }
    // Message starts with GitHub's verbatim text
    expect(message).toContain(githubMsg)
    // Message includes the PAT guidance
    expect(message).toContain('fine-grained PAT')
    expect(message).toContain('Settings → Advanced')
    expect(message).toContain('OAuth apps')
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

// ---------------------------------------------------------------------------
// Multi-line: start_line / start_side anchoring
// ---------------------------------------------------------------------------
describe('submitReview — multi-line comment anchoring', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetInFlightForTest()
  })

  it('multi-line draft (startLine < line) emits start_line and start_side', async () => {
    const f = mockFetch(200, { id: 5 })
    vi.stubGlobal('fetch', f)

    const draft = makeDraft({ path: 'src/foo.ts', line: 10, side: 'RIGHT', body: 'Range comment', startLine: 7 })
    await submitReview(ref, 'COMMENT', '', [draft], commitId)

    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments[0].start_line).toBe(7)
    expect(sentBody.comments[0].start_side).toBe('RIGHT')
    expect(sentBody.comments[0].line).toBe(10)
    expect(sentBody.comments[0].side).toBe('RIGHT')
  })

  it('single-line draft does NOT emit start_line or start_side', async () => {
    const f = mockFetch(200, { id: 6 })
    vi.stubGlobal('fetch', f)

    const draft = makeDraft({ path: 'src/foo.ts', line: 10, side: 'RIGHT', body: 'Single line' })
    await submitReview(ref, 'COMMENT', '', [draft], commitId)

    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments[0]).not.toHaveProperty('start_line')
    expect(sentBody.comments[0]).not.toHaveProperty('start_side')
  })

  it('draft with startLine === line does NOT emit start_line', async () => {
    const f = mockFetch(200, { id: 7 })
    vi.stubGlobal('fetch', f)

    const draft = makeDraft({ path: 'src/foo.ts', line: 5, side: 'RIGHT', body: 'Same line', startLine: 5 })
    await submitReview(ref, 'COMMENT', '', [draft], commitId)

    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments[0]).not.toHaveProperty('start_line')
  })

  it('suggestion fence body passes through UNMODIFIED in submitReview', async () => {
    const f = mockFetch(200, { id: 8 })
    vi.stubGlobal('fetch', f)

    const suggestionBody = '```suggestion\nconst x = newValue\n```'
    const draft = makeDraft({ path: 'src/foo.ts', line: 3, side: 'RIGHT', body: suggestionBody })
    await submitReview(ref, 'COMMENT', '', [draft], commitId)

    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments[0].body).toBe(suggestionBody)
  })
})

// ---------------------------------------------------------------------------
// Fix-B: two drafts on the same line submit as two separate comments
// ---------------------------------------------------------------------------
describe('submitReview — Fix-B same-line threaded drafts', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetInFlightForTest()
  })

  it('maps two drafts on the same line (n=0 and n=1) to two separate comments', async () => {
    const f = mockFetch(200, { id: 42 })
    vi.stubGlobal('fetch', f)

    const draft0 = makeDraft({ path: 'a.ts', line: 5, side: 'RIGHT', body: 'First comment', n: 0 })
    const draft1 = makeDraft({ path: 'a.ts', line: 5, side: 'RIGHT', body: 'Reply comment', n: 1 })

    await submitReview(ref, 'COMMENT', 'Overall', [draft0, draft1], commitId)

    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments).toHaveLength(2)
    expect(sentBody.comments[0]).toEqual({ path: 'a.ts', line: 5, side: 'RIGHT', body: 'First comment' })
    expect(sentBody.comments[1]).toEqual({ path: 'a.ts', line: 5, side: 'RIGHT', body: 'Reply comment' })
  })
})
