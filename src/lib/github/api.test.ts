import { describe, it, expect, vi } from 'vitest'
import { getPrMeta, getPrFiles, getFileAtRef } from './api'

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers })
}

const META = {
  title: 'T', state: 'open', merged: false, body: null,
  base: { sha: 'b1' }, head: { sha: 'h1' },
  changed_files: 2,
}

describe('github api', () => {
  it('getPrMeta maps fields incl. repo privacy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      ...META, base: { ...META.base, repo: { private: true } },
    })))
    const meta = await getPrMeta({ owner: 'a', repo: 'b', number: 1 })
    expect(meta).toEqual({
      title: 'T', state: 'open', merged: false, body: null,
      baseSha: 'b1', headSha: 'h1', private: true, changedFiles: 2,
    })
  })

  it('getPrFiles traverses pagination via Link header (EC-05i)', async () => {
    const page1 = jsonResponse([{ filename: 'a.ts', status: 'modified', patch: '@@', additions: 1, deletions: 0 }], {
      Link: '<https://api.github.com/repos/a/b/pulls/1/files?page=2>; rel="next"',
    })
    const page2 = jsonResponse([{ filename: 'b.bin', status: 'added', additions: 0, deletions: 0 }])
    const f = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)
    vi.stubGlobal('fetch', f)
    const files = await getPrFiles({ owner: 'a', repo: 'b', number: 1 })
    expect(files.map(x => x.filename)).toEqual(['a.ts', 'b.bin'])
    expect(files[1].patch).toBeUndefined() // EC-05j binary has no patch
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
})
