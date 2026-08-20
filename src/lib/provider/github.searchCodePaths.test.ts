/**
 * githubProvider.searchCodePaths tests (Tier 2 symbol navigation).
 *
 * Coverage: query encoding (symbol + repo qualifier, URI-encoded), the
 * structured path-list result (deduped, capped at 10), auth header presence,
 * error propagation (rate limit), and capability gating — GitLab/Bitbucket do
 * NOT implement searchCodePaths (capability by method presence), so the
 * symbol popover honestly omits the "Search repo" action for them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { githubProvider } from './github'
import { gitlabProvider } from './gitlab'
import { bitbucketProvider } from './bitbucket'
import { saveGithubAuth } from '../settings/settings'
import { GithubApiError } from '../github/types'
import { jsonResponse } from '../../test-helpers'

const REPO = { owner: 'org', repo: 'repo' }

function searchResult(paths: string[]) {
  return { total_count: paths.length, items: paths.map((path) => ({ path })) }
}

describe('githubProvider.searchCodePaths', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
  })

  it('queries /search/code with the URI-encoded symbol + repo qualifier', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(searchResult(['src/a.ts'])))
    vi.stubGlobal('fetch', fetchMock)

    await githubProvider.searchCodePaths!(REPO, 'compute$Total')

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/search/code?q=')
    expect(url).toContain(encodeURIComponent('compute$Total repo:org/repo'))
    expect(url).toContain('per_page=10')
    // Authed request (GitHub rejects unauthenticated code search).
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test')
  })

  it('returns the matched paths in order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(searchResult(['src/b.ts', 'src/a.ts']))))
    const paths = await githubProvider.searchCodePaths!(REPO, 'foo')
    expect(paths).toEqual(['src/b.ts', 'src/a.ts'])
  })

  it('dedupes repeated paths and caps the result at 10', async () => {
    const many = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(searchResult(['src/dup.ts', 'src/dup.ts', ...many]))))
    const paths = await githubProvider.searchCodePaths!(REPO, 'foo')
    expect(paths).toHaveLength(10)
    expect(paths.filter((p) => p === 'src/dup.ts')).toHaveLength(1)
  })

  it('returns [] when the API has no matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ total_count: 0, items: [] })))
    expect(await githubProvider.searchCodePaths!(REPO, 'nope')).toEqual([])
  })

  it('propagates rate-limit errors as GithubApiError for the caller to surface', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { message: 'API rate limit exceeded' },
      { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1755600000' },
      403,
    )))
    await expect(githubProvider.searchCodePaths!(REPO, 'foo')).rejects.toThrow(GithubApiError)
  })
})

describe('searchCodePaths capability gating (GitHub-only in v1)', () => {
  it('gitlab and bitbucket do NOT implement searchCodePaths', () => {
    expect(gitlabProvider.searchCodePaths).toBeUndefined()
    expect(bitbucketProvider.searchCodePaths).toBeUndefined()
  })
})
