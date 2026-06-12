import { describe, it, expect, vi, beforeEach } from 'vitest'
import { githubProvider } from './github'
import { saveGithubAuth } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'

function makeSearchResponse(items: Array<{ number: number; title: string; updated_at: string; repository_url: string }>) {
  return { total_count: items.length, items }
}

function makePrItem(owner: string, repo: string, number: number, title: string, updated_at = '2024-01-01T10:00:00Z') {
  return {
    number,
    title,
    updated_at,
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
  }
}

describe('githubProvider.getMyQueue', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns [] when unauthenticated', async () => {
    // No auth in settings
    const result = await githubProvider.getMyQueue!()
    expect(result).toEqual([])
  })

  it('fetches review-requested and authored PRs and dedupes', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })

    const reviewItem = makePrItem('org', 'repo', 1, 'PR for review')
    const authorItem = makePrItem('org', 'repo', 2, 'My PR')
    const dupItem = makePrItem('org', 'repo', 1, 'PR for review') // same as reviewItem

    let call = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      call++
      if (call === 1) {
        // review-requested query
        return Promise.resolve(jsonResponse(makeSearchResponse([reviewItem])))
      }
      // author query — includes a dupe of reviewItem
      return Promise.resolve(jsonResponse(makeSearchResponse([authorItem, dupItem])))
    }))

    const queue = await githubProvider.getMyQueue!()

    // reviewItem → authorIsMe=false; authorItem → authorIsMe=true; dupItem deduped
    expect(queue).toHaveLength(2)
    const byNumber = Object.fromEntries(queue.map(q => [q.ref.number, q]))
    expect(byNumber[1].authorIsMe).toBe(false)
    expect(byNumber[2].authorIsMe).toBe(true)
    expect(byNumber[2].title).toBe('My PR')
    expect(byNumber[1].ref).toMatchObject({ provider: 'github', owner: 'org', repo: 'repo', number: 1 })
  })

  it('maps updatedAt from updated_at field', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse(makeSearchResponse([makePrItem('o', 'r', 5, 'T', '2025-06-01T08:00:00Z')])))
    ))

    const queue = await githubProvider.getMyQueue!()
    expect(queue[0]?.updatedAt).toBe('2025-06-01T08:00:00Z')
  })
})

describe('githubProvider.getViewerLogin', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns the authenticated login from GET /user', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    const f = vi.fn().mockResolvedValue(jsonResponse({ login: 'octocat' }))
    vi.stubGlobal('fetch', f)
    expect(await githubProvider.getViewerLogin!()).toBe('octocat')
    expect(String(f.mock.calls[0][0])).toContain('/user')
  })

  it('returns null when /user has no login', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    expect(await githubProvider.getViewerLogin!()).toBeNull()
  })
})

describe('githubProvider.capabilities', () => {
  it('blocks self-review (GitHub rejects approving your own PR with 422)', () => {
    expect(githubProvider.capabilities.selfReviewBlocked).toBe(true)
  })
})
