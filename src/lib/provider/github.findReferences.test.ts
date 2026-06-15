/**
 * githubProvider.findReferences tests (Plan G — harness depth).
 *
 * Coverage: symbol-boundary matching (substring-only fragments dropped), file
 * dedup + ranking by match count, no-match handling, and the auth requirement.
 * GitLab/Bitbucket do NOT implement findReferences (capability by method
 * presence) — asserted in their own files; the deep-review toolkit returns an
 * honest "not available" result for those (deepReview.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { githubProvider } from './github'
import { gitlabProvider } from './gitlab'
import { bitbucketProvider } from './bitbucket'
import { saveGithubAuth } from '../settings/settings'
import { jsonResponse } from '../../test-helpers'

const REPO = { owner: 'org', repo: 'repo' }

function searchResult(items: Array<{ path: string; fragments: string[] }>) {
  return {
    total_count: items.length,
    items: items.map((it) => ({
      path: it.path,
      text_matches: it.fragments.map((f) => ({ fragment: f })),
    })),
  }
}

describe('githubProvider.findReferences', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
  })

  it('keeps only whole-word matches and drops substring-only fragments', async () => {
    // Searching "config": "useConfig"/"configure" are substrings, not the
    // identifier `config` on a word boundary, and must be dropped.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(searchResult([
      { path: 'src/a.ts', fragments: ['const config = loadConfig()'] }, // whole-word `config`
      { path: 'src/b.ts', fragments: ['const c = configure(x)'] },      // substring only
    ]))))

    const out = await githubProvider.findReferences!(REPO, 'config')
    expect(out).toContain('src/a.ts')
    expect(out).not.toContain('src/b.ts')
  })

  it('dedups to one block per file and ranks files by match count', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(searchResult([
      { path: 'src/few.ts', fragments: ['foo()'] },
      { path: 'src/many.ts', fragments: ['foo(1)', 'const x = foo', 'return foo'] },
    ]))))

    const out = await githubProvider.findReferences!(REPO, 'foo')
    // The file with more matches is ranked first.
    expect(out.indexOf('src/many.ts')).toBeLessThan(out.indexOf('src/few.ts'))
    // Match counts surfaced per file.
    expect(out).toContain('src/many.ts (3)')
    expect(out).toContain('src/few.ts (1)')
  })

  it('reports no references when the API returns nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ total_count: 0, items: [] })))
    const out = await githubProvider.findReferences!(REPO, 'nope')
    expect(out).toContain('No references')
  })

  it('reports no EXACT references when only substring matches come back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(searchResult([
      { path: 'src/a.ts', fragments: ['configure()'] }, // substring of "config"
    ]))))
    const out = await githubProvider.findReferences!(REPO, 'config')
    expect(out).toContain('No exact references')
  })

  it('escapes regex metacharacters in the symbol (no ReDoS / crash on $-names)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(searchResult([
      { path: 'src/a.ts', fragments: ['$state(0)'] },
    ]))))
    const out = await githubProvider.findReferences!(REPO, '$state')
    expect(out).toContain('src/a.ts')
  })
})

describe('findReferences capability gating (GitHub-only in v1)', () => {
  it('gitlab and bitbucket do NOT implement findReferences', () => {
    expect(gitlabProvider.findReferences).toBeUndefined()
    expect(bitbucketProvider.findReferences).toBeUndefined()
  })
})
