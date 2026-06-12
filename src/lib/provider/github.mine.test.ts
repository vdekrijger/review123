/**
 * src/lib/provider/github.mine.test.ts — account-scoped review mining (GitHub).
 *
 * Covers githubProvider.getMyAccountReviewComments:
 *   - resolves the authenticated login via GET /user
 *   - searches PRs the user commented on (GET /search/issues?q=type:pr commenter:LOGIN)
 *   - pulls per-PR review comments, filters to the user's own, maps bodies
 *   - caps PRs at 30 and comments at `cap`; strips long code fences
 *   - surfaces a clear error on 403 rate-limit
 *   - repoFilter delegates to the repo-scoped comments endpoint
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { githubProvider } from './github'
import { saveGithubAuth } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_FIXTURE = { login: 'alice', id: 1, name: 'Alice' }

function makeSearchItem(owner: string, repo: string, number: number) {
  return {
    number,
    title: `PR ${number}`,
    updated_at: '2026-01-01T10:00:00Z',
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
  }
}

function makeReviewComment(login: string, body: string) {
  return {
    id: Math.floor(Math.random() * 100000),
    user: { login },
    body,
    created_at: '2026-01-01T10:00:00Z',
    path: 'src/foo.ts',
  }
}

function rateLimitResponse(): Response {
  return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
    status: 403,
    headers: {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
    },
  })
}

/** Routes fetch calls by URL substring; unmatched URLs throw. */
function stubFetchRoutes(routes: Array<[match: (url: string) => boolean, respond: (url: string) => Response]>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    calls.push(url)
    for (const [match, respond] of routes) {
      if (match(url)) return Promise.resolve(respond(url))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }))
  return calls
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
})

describe('githubProvider.getMyAccountReviewComments — account mode', () => {
  it('method exists on the github provider (capability)', () => {
    expect(typeof githubProvider.getMyAccountReviewComments).toBe('function')
  })

  it('resolves login via /user then searches PRs the user commented on', async () => {
    const calls = stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/search/issues'), () => jsonResponse({ total_count: 0, items: [] })],
    ])

    await expect(githubProvider.getMyAccountReviewComments!(150)).resolves.toEqual([])

    expect(calls[0]).toContain('/user')
    const searchCall = calls.find(u => u.includes('/search/issues'))!
    expect(searchCall).toBeDefined()
    const q = decodeURIComponent(new URL(searchCall).searchParams.get('q') ?? '')
    expect(q).toContain('type:pr')
    expect(q).toContain('commenter:alice')
    expect(searchCall).toContain('sort=updated')
    expect(searchCall).toContain('per_page=30')
  })

  it('pulls per-PR review comments and filters to the authenticated login', async () => {
    stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/search/issues'), () => jsonResponse({
        total_count: 2,
        items: [makeSearchItem('org-a', 'repo-a', 1), makeSearchItem('org-b', 'repo-b', 2)],
      })],
      [u => u.includes('/repos/org-a/repo-a/pulls/1/comments'), () => jsonResponse([
        makeReviewComment('alice', 'alice on repo-a'),
        makeReviewComment('bob', 'bob comment — must be excluded'),
      ])],
      [u => u.includes('/repos/org-b/repo-b/pulls/2/comments'), () => jsonResponse([
        makeReviewComment('alice', 'alice on repo-b'),
      ])],
    ])

    const result = await githubProvider.getMyAccountReviewComments!(150)
    expect(result).toHaveLength(2)
    expect(result).toContain('alice on repo-a')
    expect(result).toContain('alice on repo-b')
    expect(result.some(c => c.includes('bob'))).toBe(false)
  })

  it('caps PR fetches at 30 even if search returns more items', async () => {
    const manyItems = Array.from({ length: 40 }, (_, i) => makeSearchItem('org', 'repo', i + 1))
    const calls = stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/search/issues'), () => jsonResponse({ total_count: 40, items: manyItems })],
      [u => u.includes('/pulls/'), () => jsonResponse([makeReviewComment('alice', 'hi')])],
    ])

    await githubProvider.getMyAccountReviewComments!(150)
    const prCalls = calls.filter(u => u.includes('/pulls/') && u.includes('/comments'))
    expect(prCalls.length).toBeLessThanOrEqual(30)
  })

  it('stops fetching and caps total comments at `cap`', async () => {
    const items = Array.from({ length: 10 }, (_, i) => makeSearchItem('org', 'repo', i + 1))
    const perPr = Array.from({ length: 5 }, (_, i) => makeReviewComment('alice', `c${i}`))
    stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/search/issues'), () => jsonResponse({ total_count: 10, items })],
      [u => u.includes('/pulls/'), () => jsonResponse(perPr)],
    ])

    const result = await githubProvider.getMyAccountReviewComments!(7)
    expect(result.length).toBeLessThanOrEqual(7)
  })

  it('strips code fences longer than 10 lines from comment bodies', async () => {
    const longFence = '```ts\n' + Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n') + '\n```'
    const body = `Keep this.\n${longFence}\nAnd this.`
    stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/search/issues'), () => jsonResponse({
        total_count: 1, items: [makeSearchItem('o', 'r', 1)],
      })],
      [u => u.includes('/pulls/1/comments'), () => jsonResponse([makeReviewComment('alice', body)])],
    ])

    const result = await githubProvider.getMyAccountReviewComments!(150)
    expect(result[0]).toContain('Keep this.')
    expect(result[0]).not.toContain('line 14')
  })

  it('skips PRs whose comment fetch fails (non-fatal)', async () => {
    stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/search/issues'), () => jsonResponse({
        total_count: 2,
        items: [makeSearchItem('o', 'broken', 1), makeSearchItem('o', 'good', 2)],
      })],
      [u => u.includes('/repos/o/broken/'), () => new Response('boom', { status: 500 })],
      [u => u.includes('/repos/o/good/pulls/2/comments'), () => jsonResponse([
        makeReviewComment('alice', 'still mined'),
      ])],
    ])

    const result = await githubProvider.getMyAccountReviewComments!(150)
    expect(result).toEqual(['still mined'])
  })

  it('surfaces a clear error when the search hits the rate limit', async () => {
    stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/search/issues'), () => rateLimitResponse()],
    ])

    await expect(githubProvider.getMyAccountReviewComments!(150))
      .rejects.toThrow(/rate limit/i)
  })

  it('surfaces a clear error when a per-PR fetch hits the rate limit', async () => {
    stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/search/issues'), () => jsonResponse({
        total_count: 1, items: [makeSearchItem('o', 'r', 1)],
      })],
      [u => u.includes('/pulls/1/comments'), () => rateLimitResponse()],
    ])

    await expect(githubProvider.getMyAccountReviewComments!(150))
      .rejects.toThrow(/rate limit/i)
  })
})

describe('githubProvider.getMyAccountReviewComments — repoFilter mode', () => {
  it('delegates to the repo-scoped comments endpoint and skips search', async () => {
    const calls = stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse(USER_FIXTURE)],
      [u => u.includes('/repos/myorg/myrepo/pulls/comments'), (u) => jsonResponse(
        u.endsWith('&page=1')
          ? [makeReviewComment('alice', 'repo-scoped comment'), makeReviewComment('bob', 'excluded')]
          : [],
      )],
    ])

    const result = await githubProvider.getMyAccountReviewComments!(150, { owner: 'myorg', repo: 'myrepo' })
    expect(result).toEqual(['repo-scoped comment'])
    expect(calls.some(u => u.includes('/search/issues'))).toBe(false)
    expect(calls.some(u => u.includes('/repos/myorg/myrepo/pulls/comments'))).toBe(true)
  })
})
