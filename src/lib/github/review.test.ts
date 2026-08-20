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

    expect(result).toEqual({ ok: true, posted: { inline: 0, fileLevel: 0, bodyFolded: 0 } })
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

  it('prepends the 🤖 AI-suggested marker for AI-authored drafts; hand-written stays verbatim', async () => {
    const f = mockFetch(200, { id: 4 })
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'a.ts', line: 1, side: 'RIGHT', body: 'Use a constant.', aiAuthored: true, aiReviewer: 'Security' }),
      makeDraft({ path: 'b.ts', line: 5, side: 'LEFT', body: 'My own note.' }),
    ]
    await submitReview(ref, 'COMMENT', 'Overall', drafts, commitId)

    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments[0].body).toBe('🤖 _AI-suggested · Security_\n\nUse a constant.')
    expect(sentBody.comments[1].body).toBe('My own note.')
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

  it('maps 422 with "own pull request" to self-approve with a friendly message (EC-09e)', async () => {
    const githubMsg = 'Can not approve your own pull request'
    vi.stubGlobal('fetch', mockFetch(422, { message: githubMsg }))

    const result = await submitReview(ref, 'APPROVE', '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'self-approve' })
    const { message } = result as { ok: false; message: string }
    // Friendly explanation instead of GitHub's terse 422 body
    expect(message).toMatch(/doesn't allow approving or requesting changes on your own pull request/i)
    // Tells the user the way out
    expect(message).toMatch(/comment/i)
  })

  it('maps 422 with "own pull request" on REQUEST_CHANGES to self-approve too', async () => {
    vi.stubGlobal('fetch', mockFetch(422, { message: 'Can not request changes on your own pull request' }))

    const result = await submitReview(ref, 'REQUEST_CHANGES', '', [], commitId)

    expect(result).toMatchObject({ ok: false, kind: 'self-approve' })
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
    expect(firstResult).toMatchObject({ ok: true })
  })

  it('after completion a new submit works (flag cleared)', async () => {
    const f = mockFetch(200, { id: 10 })
    vi.stubGlobal('fetch', f)

    // First submit
    await submitReview(ref, 'APPROVE', '', [], commitId)
    // Second submit after first completes
    const result = await submitReview(ref, 'APPROVE', '', [], commitId)

    expect(result).toMatchObject({ ok: true })
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

    expect(result).toMatchObject({ ok: true })
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
// Off-diff re-routing — was the pinning repro for "one off-diff comment 422s
// the ENTIRE review, losing the valid comments too". Now asserts the fix:
// pre-submit split + file-level re-route + review-body fold + 422 retry net.
// ---------------------------------------------------------------------------
describe('submitReview — off-diff comment re-routing (was: whole-review 422 repro)', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetInFlightForTest()
  })

  // The patch for src/foo.ts: RIGHT lines 1..4, LEFT lines 1..3.
  const PATCH = '@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+added2\n context'
  const filesFixture = [{ filename: 'src/foo.ts', patch: PATCH }]

  const REVIEWS_URL = 'https://api.github.com/repos/alice/widgets/pulls/42/reviews'
  const COMMENTS_URL = 'https://api.github.com/repos/alice/widgets/pulls/42/comments'

  /** GitHub-like: 422 the review POST when any comment line is off-diff (>4). */
  function githubLikeFetch() {
    return vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === REVIEWS_URL && init.method === 'POST') {
        const sent = JSON.parse(init.body as string) as { comments?: { line: number }[] }
        const bad = (sent.comments ?? []).some((c) => c.line > 4)
        return Promise.resolve(
          bad
            ? jsonResponse({
                message: 'Unprocessable Entity',
                errors: [
                  {
                    resource: 'PullRequestReviewComment',
                    code: 'custom',
                    field: 'pull_request_review_thread.line',
                    message: 'pull_request_review_thread.line must be part of the diff',
                  },
                ],
              }, {}, 422)
            : jsonResponse({ id: 77 }, {}, 200),
        )
      }
      // File-level comment posts + review PUT succeed
      return Promise.resolve(jsonResponse({ id: 1 }, {}, 200))
    })
  }

  it('off-diff draft is split out pre-submit: review POST carries only the inline comment; off-diff posts as a file-level comment', async () => {
    const f = githubLikeFetch()
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'src/foo.ts', line: 3, side: 'RIGHT', body: 'Valid — line is in the diff' }),
      makeDraft({ path: 'src/foo.ts', line: 99, side: 'RIGHT', body: 'Off-diff — line 99 is NOT in the diff' }),
    ]
    const result = await submitReview(ref, 'COMMENT', 'Overall', drafts, commitId, filesFixture)

    expect(result).toEqual({ ok: true, posted: { inline: 1, fileLevel: 1, bodyFolded: 0 } })

    // Call 1: review POST with ONLY the anchorable comment
    expect(f.mock.calls[0][0]).toBe(REVIEWS_URL)
    const reviewBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(reviewBody.comments).toHaveLength(1)
    expect(reviewBody.comments[0].line).toBe(3)

    // Call 2: the off-diff draft as a file-level comment with the line prefix
    expect(f.mock.calls.length).toBe(2)
    expect(f.mock.calls[1][0]).toBe(COMMENTS_URL)
    const fileComment = JSON.parse(f.mock.calls[1][1].body as string)
    expect(fileComment).toMatchObject({
      subject_type: 'file',
      path: 'src/foo.ts',
      commit_id: commitId,
    })
    expect(fileComment.line).toBeUndefined()
    expect(fileComment.body).toBe(
      '**Re: line 99** _(line not in the current diff)_ — Off-diff — line 99 is NOT in the diff',
    )
  })

  it('LEFT-side and range anchoring both respect the split (range with off-diff endpoint → file comment)', async () => {
    const f = githubLikeFetch()
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'src/foo.ts', line: 2, side: 'LEFT', body: 'Old-side line 2 is in-diff' }),
      makeDraft({ path: 'src/foo.ts', line: 90, startLine: 3, side: 'RIGHT', body: 'Range end off-diff' }),
    ]
    const result = await submitReview(ref, 'COMMENT', '', drafts, commitId, filesFixture)

    expect(result).toEqual({ ok: true, posted: { inline: 1, fileLevel: 1, bodyFolded: 0 } })
    const reviewBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(reviewBody.comments).toEqual([
      { path: 'src/foo.ts', line: 2, side: 'LEFT', body: 'Old-side line 2 is in-diff' },
    ])
    const fileComment = JSON.parse(f.mock.calls[1][1].body as string)
    expect(fileComment.body).toContain('**Re: lines 3–90**')
  })

  it('draft on a file with NO patch (binary) → file-level comment', async () => {
    const f = githubLikeFetch()
    vi.stubGlobal('fetch', f)

    const drafts = [makeDraft({ path: 'logo.png', line: 1, side: 'RIGHT', body: 'On a binary' })]
    const result = await submitReview(ref, 'COMMENT', 'x', drafts, commitId, [
      ...filesFixture,
      { filename: 'logo.png', patch: undefined },
    ])

    expect(result).toEqual({ ok: true, posted: { inline: 0, fileLevel: 1, bodyFolded: 0 } })
    const reviewBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect('comments' in reviewBody).toBe(false)
  })

  it('AI-authored off-diff draft keeps the 🤖 attribution inside the prefixed body', async () => {
    const f = githubLikeFetch()
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'src/foo.ts', line: 99, side: 'RIGHT', body: 'Use a constant.', aiAuthored: true, aiReviewer: 'Security' }),
    ]
    await submitReview(ref, 'COMMENT', 'x', drafts, commitId, filesFixture)

    const fileComment = JSON.parse(f.mock.calls[1][1].body as string)
    expect(fileComment.body).toBe(
      '**Re: line 99** _(line not in the current diff)_ — 🤖 _AI-suggested · Security_\n\nUse a constant.',
    )
  })

  it('file-level comment POST failure → folded into the review body via PUT (never dropped)', async () => {
    const f = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === COMMENTS_URL) {
        return Promise.resolve(jsonResponse({ message: 'Unprocessable Entity' }, {}, 422))
      }
      if (url.endsWith('/reviews/77') && init.method === 'PUT') {
        return Promise.resolve(jsonResponse({ id: 77 }, {}, 200))
      }
      return Promise.resolve(jsonResponse({ id: 77 }, {}, 200))
    })
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'src/foo.ts', line: 3, side: 'RIGHT', body: 'Inline one' }),
      makeDraft({ path: 'src/foo.ts', line: 99, side: 'RIGHT', body: 'Off-diff one' }),
    ]
    const result = await submitReview(ref, 'COMMENT', 'Overall', drafts, commitId, filesFixture)

    expect(result).toEqual({ ok: true, posted: { inline: 1, fileLevel: 0, bodyFolded: 1 } })

    const putCall = f.mock.calls.find((c) => (c[0] as string).endsWith('/reviews/77') && (c[1] as RequestInit).method === 'PUT')
    expect(putCall).toBeDefined()
    const putBody = JSON.parse(putCall![1].body as string)
    expect(putBody.body).toContain('#### Comments on lines outside the diff')
    expect(putBody.body).toContain('**src/foo.ts:99** — Off-diff one')
    expect(putBody.body).toContain('Overall')
  })

  it('file-level failure AND body-fold failure → ok:false, honest message, nothing silently lost', async () => {
    const f = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === REVIEWS_URL && init.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 77 }, {}, 200))
      }
      // comments POST and review PUT both fail
      return Promise.resolve(jsonResponse({ message: 'nope' }, {}, 500))
    })
    vi.stubGlobal('fetch', f)

    const drafts = [makeDraft({ path: 'src/foo.ts', line: 99, side: 'RIGHT', body: 'Off-diff' })]
    const result = await submitReview(ref, 'COMMENT', 'x', drafts, commitId, filesFixture)

    expect(result).toMatchObject({ ok: false, kind: 'other' })
    const { message } = result as { ok: false; message: string }
    expect(message).toContain('Your review was posted')
    expect(message).toContain('src/foo.ts:99')
  })

  it('no files provided → no split (legacy behavior): every draft rides the review POST', async () => {
    const f = mockFetch(200, { id: 5 })
    vi.stubGlobal('fetch', f)

    const drafts = [makeDraft({ path: 'src/foo.ts', line: 99999, side: 'RIGHT' })]
    const result = await submitReview(ref, 'COMMENT', 'x', drafts, commitId)

    expect(result).toEqual({ ok: true, posted: { inline: 1, fileLevel: 0, bodyFolded: 0 } })
    const sentBody = JSON.parse(f.mock.calls[0][1].body as string)
    expect(sentBody.comments).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Resilience net — the review POST 422s DESPITE the split (stale patch vs
// server state): one retry with offenders re-routed, or body-folded when
// GitHub's payload doesn't identify them.
// ---------------------------------------------------------------------------
describe('submitReview — 422 retry net', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetInFlightForTest()
  })

  const REVIEWS_URL = 'https://api.github.com/repos/alice/widgets/pulls/42/reviews'
  const COMMENTS_URL = 'https://api.github.com/repos/alice/widgets/pulls/42/comments'
  const PATCH = '@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+added2\n context'
  const filesFixture = [{ filename: 'src/foo.ts', patch: PATCH }, { filename: 'src/bar.ts', patch: PATCH }]

  it('422 identifying comments[i] → that comment re-routes to a file-level comment; retry succeeds', async () => {
    let reviewPosts = 0
    const f = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === REVIEWS_URL && init.method === 'POST') {
        reviewPosts++
        if (reviewPosts === 1) {
          return Promise.resolve(jsonResponse({
            message: 'Unprocessable Entity',
            errors: [{ resource: 'PullRequestReviewComment', message: 'comments[1] line must be part of the diff' }],
          }, {}, 422))
        }
        return Promise.resolve(jsonResponse({ id: 77 }, {}, 200))
      }
      return Promise.resolve(jsonResponse({ id: 1 }, {}, 200))
    })
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'Fine' }),
      makeDraft({ path: 'src/bar.ts', line: 3, side: 'RIGHT', body: 'Server says off-diff' }),
    ]
    const result = await submitReview(ref, 'COMMENT', 'x', drafts, commitId, filesFixture)

    expect(result).toEqual({ ok: true, posted: { inline: 1, fileLevel: 1, bodyFolded: 0 } })
    expect(reviewPosts).toBe(2)

    // Retry carried only the surviving inline comment
    const retryBody = JSON.parse(f.mock.calls[1][1].body as string)
    expect(retryBody.comments).toEqual([
      { path: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'Fine' },
    ])
    // The offender went out as a file-level comment
    const fileCall = f.mock.calls.find((c) => c[0] === COMMENTS_URL)
    expect(fileCall).toBeDefined()
    expect(JSON.parse(fileCall![1].body as string).path).toBe('src/bar.ts')
  })

  it('422 identifying a path in errors[] → all comments on that path re-route', async () => {
    let reviewPosts = 0
    const f = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === REVIEWS_URL && init.method === 'POST') {
        reviewPosts++
        if (reviewPosts === 1) {
          return Promise.resolve(jsonResponse({
            message: 'Unprocessable Entity',
            errors: [{ resource: 'PullRequestReviewComment', path: 'src/bar.ts', message: 'line must be part of the diff' }],
          }, {}, 422))
        }
        return Promise.resolve(jsonResponse({ id: 77 }, {}, 200))
      }
      return Promise.resolve(jsonResponse({ id: 1 }, {}, 200))
    })
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'Fine' }),
      makeDraft({ path: 'src/bar.ts', line: 3, side: 'RIGHT', body: 'Stale anchor' }),
    ]
    const result = await submitReview(ref, 'COMMENT', 'x', drafts, commitId, filesFixture)

    expect(result).toEqual({ ok: true, posted: { inline: 1, fileLevel: 1, bodyFolded: 0 } })
  })

  it('unidentifiable 422 → ONE retry with all line comments folded into the review body', async () => {
    let reviewPosts = 0
    const f = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === REVIEWS_URL && init.method === 'POST') {
        reviewPosts++
        if (reviewPosts === 1) {
          return Promise.resolve(jsonResponse({ message: 'Unprocessable Entity' }, {}, 422))
        }
        return Promise.resolve(jsonResponse({ id: 77 }, {}, 200))
      }
      return Promise.resolve(jsonResponse({ id: 1 }, {}, 200))
    })
    vi.stubGlobal('fetch', f)

    const drafts = [
      makeDraft({ path: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'One' }),
      makeDraft({ path: 'src/bar.ts', line: 3, side: 'RIGHT', body: 'Two' }),
    ]
    const result = await submitReview(ref, 'COMMENT', 'Overall', drafts, commitId, filesFixture)

    expect(result).toEqual({ ok: true, posted: { inline: 0, fileLevel: 0, bodyFolded: 2 } })
    expect(reviewPosts).toBe(2)

    const retryBody = JSON.parse(f.mock.calls[1][1].body as string)
    expect('comments' in retryBody).toBe(false)
    expect(retryBody.body).toContain('#### Comments on lines outside the diff')
    expect(retryBody.body).toContain('**src/foo.ts:2** — One')
    expect(retryBody.body).toContain('**src/bar.ts:3** — Two')
  })

  it('retry is capped at ONE: a second 422 surfaces as invalid-anchor', async () => {
    const f = mockFetch(422, { message: 'Unprocessable Entity' })
    vi.stubGlobal('fetch', f)

    const drafts = [makeDraft({ path: 'src/foo.ts', line: 2, side: 'RIGHT' })]
    const result = await submitReview(ref, 'COMMENT', 'x', drafts, commitId, filesFixture)

    expect(result).toMatchObject({ ok: false, kind: 'invalid-anchor' })
    expect(f.mock.calls.length).toBe(2) // initial + exactly one retry
  })

  it('"own pull request" 422 is NOT retried (self-approve mapping unchanged)', async () => {
    const f = mockFetch(422, { message: 'Can not approve your own pull request' })
    vi.stubGlobal('fetch', f)

    const drafts = [makeDraft({ path: 'src/foo.ts', line: 2, side: 'RIGHT' })]
    const result = await submitReview(ref, 'APPROVE', '', drafts, commitId, filesFixture)

    expect(result).toMatchObject({ ok: false, kind: 'self-approve' })
    expect(f.mock.calls.length).toBe(1)
  })

  it('422 with NO comments in flight is not retried', async () => {
    const f = mockFetch(422, { message: 'Some other validation error' })
    vi.stubGlobal('fetch', f)

    const result = await submitReview(ref, 'COMMENT', 'x', [], commitId, filesFixture)

    expect(result).toMatchObject({ ok: false, kind: 'invalid-anchor' })
    expect(f.mock.calls.length).toBe(1)
  })

  it('double-submit guard stays closed across the retry + re-route sequence', async () => {
    let reviewPosts = 0
    const f = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url === REVIEWS_URL && init.method === 'POST') {
        reviewPosts++
        if (reviewPosts === 1) {
          return Promise.resolve(jsonResponse({ message: 'Unprocessable Entity' }, {}, 422))
        }
        return Promise.resolve(jsonResponse({ id: 77 }, {}, 200))
      }
      return Promise.resolve(jsonResponse({ id: 1 }, {}, 200))
    })
    vi.stubGlobal('fetch', f)

    const drafts = [makeDraft({ path: 'src/foo.ts', line: 2, side: 'RIGHT' })]
    const first = submitReview(ref, 'COMMENT', 'x', drafts, commitId, filesFixture)
    const second = await submitReview(ref, 'COMMENT', 'x', drafts, commitId, filesFixture)

    expect(second).toEqual({ ok: false, kind: 'other', message: 'A submission is already in progress.' })
    const firstResult = await first
    expect(firstResult.ok).toBe(true)

    // And the guard clears afterwards
    const third = await submitReview(ref, 'COMMENT', 'x', [], commitId, filesFixture)
    expect(third.ok).toBe(true)
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
