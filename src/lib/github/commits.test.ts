import { describe, it, expect, vi } from 'vitest'
import { getPrCommits } from './commits'
import { jsonResponse } from '../../test-helpers'

const REF = { owner: 'acme', repo: 'widget', number: 42 }

function makeRawCommit(sha: string, message: string, date = '2024-01-01T10:00:00Z') {
  return {
    sha,
    commit: {
      message,
      author: { date },
    },
  }
}

describe('getPrCommits — mapping', () => {
  it('maps sha, shortSha, first-line message, and authoredAt', async () => {
    const raw = [makeRawCommit('abcdef1234567', 'feat: add thing', '2024-06-01T12:00:00Z')]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(raw)))

    const commits = await getPrCommits(REF)

    expect(commits).toHaveLength(1)
    expect(commits[0]).toEqual({
      sha: 'abcdef1234567',
      shortSha: 'abcdef1',
      message: 'feat: add thing',
      authoredAt: '2024-06-01T12:00:00Z',
    })
  })

  it('maps multiple commits in order', async () => {
    const raw = [
      makeRawCommit('aaa0001', 'first commit', '2024-01-01T10:00:00Z'),
      makeRawCommit('bbb0002', 'second commit', '2024-01-02T10:00:00Z'),
      makeRawCommit('ccc0003', 'third commit', '2024-01-03T10:00:00Z'),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(raw)))

    const commits = await getPrCommits(REF)
    expect(commits).toHaveLength(3)
    expect(commits.map(c => c.shortSha)).toEqual(['aaa0001', 'bbb0002', 'ccc0003'])
  })

  it('truncates multiline message to first line only', async () => {
    const raw = [makeRawCommit('abc1234', 'feat: main title\n\nBody paragraph\n\nMore detail')]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(raw)))

    const commits = await getPrCommits(REF)
    expect(commits[0].message).toBe('feat: main title')
  })

  it('handles empty message gracefully', async () => {
    const raw = [makeRawCommit('abc1234', '')]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(raw)))

    const commits = await getPrCommits(REF)
    expect(commits[0].message).toBe('')
  })

  it('handles null author date gracefully', async () => {
    const raw = [{
      sha: 'abc1234',
      commit: { message: 'test', author: null },
    }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(raw)))

    const commits = await getPrCommits(REF)
    expect(commits[0].authoredAt).toBe('')
  })

  it('returns empty array for empty page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])))
    const commits = await getPrCommits(REF)
    expect(commits).toEqual([])
  })
})

describe('getPrCommits — pagination', () => {
  it('fetches page 1 with per_page=100', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', f)
    await getPrCommits(REF)
    const calledUrl = f.mock.calls[0][0] as string
    expect(calledUrl).toContain('per_page=100')
    expect(calledUrl).toContain(`/repos/${REF.owner}/${REF.repo}/pulls/${REF.number}/commits`)
  })

  it('follows Link rel=next header to page 2', async () => {
    const page1 = [makeRawCommit('sha0001', 'commit 1')]
    const page2 = [makeRawCommit('sha0002', 'commit 2')]
    const page1Url = `https://api.github.com/repos/${REF.owner}/${REF.repo}/pulls/${REF.number}/commits?per_page=100`
    const page2Url = `https://api.github.com/repos/${REF.owner}/${REF.repo}/pulls/${REF.number}/commits?per_page=100&page=2`

    const f = vi.fn((url: string) => {
      if (url === page1Url) {
        return Promise.resolve(new Response(JSON.stringify(page1), {
          headers: { Link: `<${page2Url}>; rel="next"` },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify(page2), { headers: {} }))
    })
    vi.stubGlobal('fetch', f)

    const commits = await getPrCommits(REF)
    expect(commits).toHaveLength(2)
    expect(commits[0].shortSha).toBe('sha0001')
    expect(commits[1].shortSha).toBe('sha0002')
  })

  it('stops at 3 pages (MAX_COMMIT_PAGES guard)', async () => {
    let pageCount = 0
    const makePageResponse = (pageNum: number, hasNext: boolean) => {
      const commits = [makeRawCommit(`sha${pageNum}000001`, `commit on page ${pageNum}`)]
      const headers: Record<string, string> = {}
      if (hasNext) {
        headers.Link = `<https://api.github.com/repos/${REF.owner}/${REF.repo}/pulls/${REF.number}/commits?page=${pageNum + 1}>; rel="next"`
      }
      return new Response(JSON.stringify(commits), { headers })
    }

    const f = vi.fn(() => {
      pageCount++
      // Always return a "has next" link so without the cap it would loop forever
      return Promise.resolve(makePageResponse(pageCount, true))
    })
    vi.stubGlobal('fetch', f)

    const commits = await getPrCommits(REF)
    expect(f).toHaveBeenCalledTimes(3) // capped at MAX_COMMIT_PAGES=3
    expect(commits).toHaveLength(3)
  })
})
