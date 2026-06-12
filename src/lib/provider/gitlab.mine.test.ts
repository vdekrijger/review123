/**
 * src/lib/provider/gitlab.mine.test.ts — account-scoped review mining (GitLab).
 *
 * Covers gitlabProvider.getMyAccountReviewComments:
 *   - account mode uses GET /events?action=commented (self-scoped — the events
 *     endpoint returns only the authenticated user's own events)
 *   - filters to MergeRequest notes (excludes Issue notes and system notes)
 *   - maps note bodies, strips long code fences, caps at `cap`
 *   - paginates up to 3 pages and stops on an empty page
 *   - surfaces a clear error on rate limit (429)
 *   - repoFilter delegates to the project-scoped MR-notes path
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gitlabProvider } from './gitlab'
import { setGitlabToken } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'

// ---------------------------------------------------------------------------
// Fixtures — shaped after the GitLab events API payload
// (GET /events returns { action_name, target_type, note?, ... })
// ---------------------------------------------------------------------------

function makeNoteEvent(body: string, noteableType: 'MergeRequest' | 'Issue', overrides: Record<string, unknown> = {}) {
  return {
    id: Math.floor(Math.random() * 100000),
    action_name: 'commented on',
    target_type: 'DiffNote',
    note: {
      id: Math.floor(Math.random() * 100000),
      body,
      noteable_type: noteableType,
      system: false,
      ...overrides,
    },
  }
}

function rateLimitResponse(): Response {
  return new Response(JSON.stringify({ message: 'rate limited' }), {
    status: 429,
    headers: { 'Retry-After': '60' },
  })
}

/** Routes fetch calls by URL predicate; unmatched URLs 404. */
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
  setGitlabToken('glpat_test')
})

describe('gitlabProvider.getMyAccountReviewComments — account mode', () => {
  it('method exists on the gitlab provider (capability)', () => {
    expect(typeof gitlabProvider.getMyAccountReviewComments).toBe('function')
  })

  it('fetches self events with action=commented', async () => {
    const calls = stubFetchRoutes([
      [u => u.includes('/events'), () => jsonResponse([])],
    ])

    await expect(gitlabProvider.getMyAccountReviewComments!(150)).resolves.toEqual([])

    const eventsCall = calls.find(u => u.includes('/events'))!
    expect(eventsCall).toBeDefined()
    expect(eventsCall).toContain('/api/v4/events')
    expect(eventsCall).toContain('action=commented')
  })

  it('keeps MergeRequest notes and excludes Issue notes and system notes', async () => {
    stubFetchRoutes([
      [u => u.includes('/events') && u.endsWith('&page=1'), () => jsonResponse([
        makeNoteEvent('mr review note', 'MergeRequest'),
        makeNoteEvent('issue note — excluded', 'Issue'),
        makeNoteEvent('system note — excluded', 'MergeRequest', { system: true }),
      ])],
      [u => u.includes('/events'), () => jsonResponse([])],
    ])

    const result = await gitlabProvider.getMyAccountReviewComments!(150)
    expect(result).toEqual(['mr review note'])
  })

  it('strips code fences longer than 10 lines from note bodies', async () => {
    const longFence = '```\n' + Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n') + '\n```'
    stubFetchRoutes([
      [u => u.includes('/events') && u.endsWith('&page=1'), () => jsonResponse([
        makeNoteEvent(`Keep.\n${longFence}\nAlso keep.`, 'MergeRequest'),
      ])],
      [u => u.includes('/events'), () => jsonResponse([])],
    ])

    const result = await gitlabProvider.getMyAccountReviewComments!(150)
    expect(result[0]).toContain('Keep.')
    expect(result[0]).not.toContain('l11')
  })

  it('caps at `cap` comments and stops paginating once reached', async () => {
    const page = Array.from({ length: 10 }, (_, i) => makeNoteEvent(`note ${i}`, 'MergeRequest'))
    const calls = stubFetchRoutes([
      [u => u.includes('/events'), () => jsonResponse(page)],
    ])

    const result = await gitlabProvider.getMyAccountReviewComments!(5)
    expect(result).toHaveLength(5)
    expect(calls.filter(u => u.includes('/events'))).toHaveLength(1)
  })

  it('paginates up to 3 pages maximum', async () => {
    const page = [makeNoteEvent('n', 'MergeRequest')]
    const calls = stubFetchRoutes([
      [u => u.includes('/events'), () => jsonResponse(page)],
    ])

    await gitlabProvider.getMyAccountReviewComments!(150)
    expect(calls.filter(u => u.includes('/events'))).toHaveLength(3)
  })

  it('stops on an empty page', async () => {
    const calls = stubFetchRoutes([
      [u => u.includes('/events') && u.endsWith('&page=1'), () => jsonResponse([
        makeNoteEvent('only note', 'MergeRequest'),
      ])],
      [u => u.includes('/events'), () => jsonResponse([])],
    ])

    const result = await gitlabProvider.getMyAccountReviewComments!(150)
    expect(result).toEqual(['only note'])
    expect(calls.filter(u => u.includes('/events'))).toHaveLength(2)
  })

  it('surfaces a clear error on rate limit', async () => {
    stubFetchRoutes([
      [u => u.includes('/events'), () => rateLimitResponse()],
    ])

    await expect(gitlabProvider.getMyAccountReviewComments!(150))
      .rejects.toThrow(/rate limit/i)
  })
})

describe('gitlabProvider.getMyAccountReviewComments — repoFilter mode', () => {
  it('delegates to the project-scoped MR-notes path and skips /events', async () => {
    const pid = encodeURIComponent('group/proj')
    const calls = stubFetchRoutes([
      [u => u.endsWith('/user'), () => jsonResponse({ username: 'alice' })],
      [u => u.includes(`/projects/${pid}/merge_requests?`), () => jsonResponse([{ iid: 7 }])],
      [u => u.includes(`/projects/${pid}/merge_requests/7/notes`), () => jsonResponse([
        { author: { username: 'alice' }, body: 'project-scoped note', system: false },
        { author: { username: 'bob' }, body: 'excluded', system: false },
      ])],
    ])

    const result = await gitlabProvider.getMyAccountReviewComments!(150, { owner: 'group', repo: 'proj' })
    expect(result).toEqual(['project-scoped note'])
    expect(calls.some(u => u.includes('/api/v4/events'))).toBe(false)
  })
})
