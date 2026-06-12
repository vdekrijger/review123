import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gitlabProvider } from './gitlab'
import { setGitlabToken } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'

function makeUser(username: string) {
  return { username }
}

function makeMrItem(owner: string, repo: string, iid: number, title: string, updatedAt = '2024-01-01T10:00:00Z') {
  return {
    iid,
    title,
    updated_at: updatedAt,
    references: { full: `${owner}/${repo}!${iid}` },
    web_url: `https://gitlab.com/${owner}/${repo}/-/merge_requests/${iid}`,
  }
}

describe('gitlabProvider.getMyQueue', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns [] when unauthenticated', async () => {
    const result = await gitlabProvider.getMyQueue!()
    expect(result).toEqual([])
  })

  it('fetches /user then reviewer and author MRs, dedupes', async () => {
    setGitlabToken('glpat_test')

    const reviewMr = makeMrItem('group', 'proj', 1, 'Review me')
    const authorMr = makeMrItem('group', 'proj', 2, 'My MR')
    const dupMr = makeMrItem('group', 'proj', 1, 'Review me') // same as reviewMr

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = new URL(url)

      if (u.pathname === '/api/v4/user') {
        return Promise.resolve(jsonResponse(makeUser('testuser')))
      }
      if (u.searchParams.get('reviewer_username') === 'testuser') {
        return Promise.resolve(jsonResponse([reviewMr]))
      }
      if (u.searchParams.get('author_username') === 'testuser') {
        return Promise.resolve(jsonResponse([authorMr, dupMr]))
      }
      return Promise.resolve(jsonResponse([]))
    }))

    const queue = await gitlabProvider.getMyQueue!()

    expect(queue).toHaveLength(2)
    const byIid = Object.fromEntries(queue.map(q => [q.ref.number, q]))
    expect(byIid[1].authorIsMe).toBe(false)
    expect(byIid[2].authorIsMe).toBe(true)
    expect(byIid[1].ref).toMatchObject({ provider: 'gitlab', owner: 'group', repo: 'proj', number: 1 })
  })

  it('maps updatedAt from updated_at field', async () => {
    setGitlabToken('glpat_test')

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = new URL(url)
      if (u.pathname === '/api/v4/user') {
        return Promise.resolve(jsonResponse(makeUser('me')))
      }
      return Promise.resolve(jsonResponse([makeMrItem('g', 'r', 3, 'T', '2025-05-10T12:00:00Z')]))
    }))

    const queue = await gitlabProvider.getMyQueue!()
    // Both reviewer and author queries return the same item; deduped to 1
    expect(queue[0]?.updatedAt).toBe('2025-05-10T12:00:00Z')
  })
})
