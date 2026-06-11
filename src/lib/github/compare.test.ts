import { describe, it, expect, vi } from 'vitest'
import { compareCommits } from './compare'
import { GithubApiError } from './types'
import { jsonResponse } from '../../test-helpers'

const REPO = { owner: 'acme', repo: 'widget' }

describe('compareCommits', () => {
  it('maps files including previousFilename from previous_filename', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      files: [
        { filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 },
        { filename: 'src/b.ts', status: 'renamed', previous_filename: 'src/old.ts', additions: 0, deletions: 0 },
        { filename: 'src/c.bin', status: 'added', additions: 0, deletions: 0 }, // no patch (binary)
      ],
    })))
    const files = await compareCommits(REPO, 'abc123', 'def456')

    expect(files).toHaveLength(3)
    expect(files[0]).toEqual({
      filename: 'src/a.ts',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-old\n+new',
      additions: 1,
      deletions: 1,
    })
    expect(files[1].previousFilename).toBe('src/old.ts')
    expect(files[1].filename).toBe('src/b.ts')
    expect(files[2].patch).toBeUndefined() // binary — no patch
  })

  it('returns empty array when files array is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ files: [] })))
    const files = await compareCommits(REPO, 'abc', 'def')
    expect(files).toEqual([])
  })

  it('handles missing files property (defensive fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})))
    const files = await compareCommits(REPO, 'abc', 'def')
    expect(files).toEqual([])
  })

  it('propagates 404 as GithubApiError with not-found kind', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))
    await expect(compareCommits(REPO, 'deadbeef', 'cafebabe')).rejects.toSatisfy(
      (e: unknown) => e instanceof GithubApiError && e.detail.kind === 'not-found',
    )
  })

  it('uses the correct GitHub compare URL format (base...head)', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ files: [] }))
    vi.stubGlobal('fetch', f)
    await compareCommits(REPO, 'base-sha', 'head-sha')
    const url = f.mock.calls[0][0] as string
    expect(url).toContain('/repos/acme/widget/compare/base-sha...head-sha')
  })

  it('maps all PrFile status values correctly', async () => {
    const rawFiles = [
      { filename: 'added.ts', status: 'added', additions: 5, deletions: 0 },
      { filename: 'removed.ts', status: 'removed', additions: 0, deletions: 3 },
      { filename: 'modified.ts', status: 'modified', patch: '@@', additions: 1, deletions: 1 },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ files: rawFiles })))
    const files = await compareCommits(REPO, 'a', 'b')
    expect(files.map(f => f.status)).toEqual(['added', 'removed', 'modified'])
  })
})
