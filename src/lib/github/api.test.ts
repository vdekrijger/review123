import { describe, it, expect, vi } from 'vitest'
import { getPrMeta, getPrFiles, getFileAtRef } from './api'
import { jsonResponse } from '../../test-helpers'

const META = {
  title: 'T', state: 'open', merged: false, body: null,
  base: { sha: 'b1' }, head: { sha: 'h1' },
  changed_files: 2,
}

describe('github api', () => {
  it('getPrMeta maps fields incl. repo privacy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...META, base: { ...META.base, repo: { private: true, full_name: 'a/b' } },
      head: { ...META.head, repo: { full_name: 'a/b' } },
      user: { login: 'octocat' },
    })))
    const meta = await getPrMeta({ owner: 'a', repo: 'b', number: 1 })
    expect(meta).toEqual({
      title: 'T', state: 'open', merged: false, body: null,
      baseSha: 'b1', headSha: 'h1', private: true, changedFiles: 2,
      authorLogin: 'octocat',
      headRepo: 'a/b', baseRepo: 'a/b', repoRelation: 'same-repo',
    })
  })

  it('getPrMeta maps a missing PR author to authorLogin null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(META)))
    const meta = await getPrMeta({ owner: 'a', repo: 'b', number: 1 })
    expect(meta.authorLogin).toBeNull()
  })

  // ---- Where the code comes from (fork detection) -------------------------
  // Shapes taken from the live API, not from the OpenAPI description — see the
  // RawPr comment: the description types `head.repo` as non-nullable and the
  // API returns null anyway.

  describe('getPrMeta head/base repository identity', () => {
    async function metaFor(pr: Record<string, unknown>) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(pr)))
      return getPrMeta({ owner: 'a', repo: 'b', number: 1 })
    }

    it('calls a branch in the repository itself SAME-REPO', async () => {
      const meta = await metaFor({
        ...META,
        base: { sha: 'b1', repo: { private: false, full_name: 'sveltejs/svelte' } },
        head: { sha: 'h1', repo: { full_name: 'sveltejs/svelte' } },
      })
      expect(meta).toMatchObject({
        headRepo: 'sveltejs/svelte', baseRepo: 'sveltejs/svelte', repoRelation: 'same-repo',
      })
    })

    it('calls a branch in someone else\'s repository a FORK', async () => {
      const meta = await metaFor({
        ...META,
        base: { sha: 'b1', repo: { private: false, full_name: 'sveltejs/svelte' } },
        head: { sha: 'h1', repo: { full_name: 'Dextheking1/svelte' } },
      })
      expect(meta).toMatchObject({
        headRepo: 'Dextheking1/svelte', baseRepo: 'sveltejs/svelte', repoRelation: 'fork',
      })
    })

    // A DELETED fork. GitHub keeps the `repo` key and sets it to null — 155 of
    // the first 500 closed PRs on nodejs/node look exactly like this. Nothing
    // is proven, so nothing is assumed.
    it('is UNKNOWN when head.repo is null (the fork was deleted)', async () => {
      const meta = await metaFor({
        ...META,
        base: { sha: 'b1', repo: { private: false, full_name: 'nodejs/node' } },
        head: { sha: 'h1', repo: null, label: 'mathiasbynens:patch-1' },
      })
      expect(meta.headRepo).toBeNull()
      expect(meta.baseRepo).toBe('nodejs/node')
      expect(meta.repoRelation).toBe('unknown')
    })

    // Old cached response / a payload that simply omits the field.
    it('is UNKNOWN when the payload carries no repo identities at all', async () => {
      const meta = await metaFor(META)
      expect(meta.headRepo).toBeNull()
      expect(meta.baseRepo).toBeNull()
      expect(meta.repoRelation).toBe('unknown')
    })

    it('never reads a half-known pair as same-repo', async () => {
      const meta = await metaFor({
        ...META,
        base: { sha: 'b1', repo: { private: false } }, // repo present, full_name absent
        head: { sha: 'h1', repo: { full_name: 'a/b' } },
      })
      expect(meta.repoRelation).toBe('unknown')
    })
  })

  it('getPrFiles traverses pagination via Link header (EC-05i)', async () => {
    const page1 = jsonResponse([
      { filename: 'a.ts', status: 'modified', patch: '@@', additions: 1, deletions: 0 },
      { filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed', additions: 3, deletions: 0, patch: '@@' },
    ], {
      Link: '<https://api.github.com/repos/a/b/pulls/1/files?page=2>; rel="next"',
    })
    const page2 = jsonResponse([{ filename: 'b.bin', status: 'added', additions: 0, deletions: 0 }])
    const f = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)
    vi.stubGlobal('fetch', f)
    const files = await getPrFiles({ owner: 'a', repo: 'b', number: 1 })
    expect(files.map(x => x.filename)).toEqual(['a.ts', 'new.ts', 'b.bin'])
    // previous_filename (wire) maps to previousFilename (camelCase)
    expect(files[1].previousFilename).toBe('old.ts')
    expect(files[2].patch).toBeUndefined() // EC-05j binary has no patch
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('getFileAtRef decodes base64 content (handles multibyte)', async () => {
    const utf8 = 'héllo ✓\n'
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(utf8)))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ content: b64, encoding: 'base64' })))
    expect(await getFileAtRef({ owner: 'a', repo: 'b' }, 'src/x.ts', 'h1')).toBe(utf8)
  })

  it('getFileAtRef returns null for missing file (EC-16g groundwork)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))
    expect(await getFileAtRef({ owner: 'a', repo: 'b' }, 'gone.ts', 'b1')).toBeNull()
  })

  it('getFileAtRef URL-encodes path segments but keeps slashes', async () => {
    const f = vi.fn().mockResolvedValue(jsonResponse({ content: btoa('x'), encoding: 'base64' }))
    vi.stubGlobal('fetch', f)
    await getFileAtRef({ owner: 'a', repo: 'b' }, 'src/has space/f#1.ts', 'h1')
    const url = f.mock.calls[0][0] as string
    expect(url).toContain('/contents/src/has%20space/f%231.ts?ref=h1')
  })

  it('getPrFiles stops at MAX_PAGES (50) when Link always returns next — no infinite loop', async () => {
    // Every response returns a next Link pointing to the same "next page" URL
    const nextLink = 'https://api.github.com/repos/a/b/pulls/1/files?page=2'
    // Return a fresh Response object each call — Response body can only be read once
    const f = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([{ filename: 'x.ts', status: 'modified', patch: '@@', additions: 1, deletions: 0 }]),
          { status: 200, headers: { Link: `<${nextLink}>; rel="next"` } },
        ),
      ),
    )
    vi.stubGlobal('fetch', f)
    const files = await getPrFiles({ owner: 'a', repo: 'b', number: 1 })
    // Should have stopped at exactly 50 pages
    expect(f).toHaveBeenCalledTimes(50)
    // Each page has 1 file
    expect(files).toHaveLength(50)
  })
})
