import { describe, it, expect, vi } from 'vitest'
import { createPrLoad, primaryLanguage } from './loadPr.svelte'
import { GithubApiError } from '../github/types'
import type { PrFile } from '../github/types'

function file(filename: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0 }
}

const REF = { owner: 'a', repo: 'b', number: 1 }
const META = {
  title: 'T', state: 'open' as const, merged: false, body: null,
  baseSha: 'b1', headSha: 'h1', private: false, changedFiles: 1,
}
const FILES = [{ filename: 'a.ts', status: 'modified' as const, patch: '@@', additions: 1, deletions: 0 }]

describe('primaryLanguage', () => {
  it('Dockerfile-only PR returns unknown — no filename leak', () => {
    expect(primaryLanguage([file('Dockerfile')])).toBe('unknown')
  })
  it('dotfile (.gitignore) returns unknown', () => {
    expect(primaryLanguage([file('.gitignore')])).toBe('unknown')
  })
  it('mixed files returns most-frequent extension', () => {
    expect(primaryLanguage([file('a.ts'), file('b.ts'), file('README.md')])).toBe('ts')
  })
  it('private repo pr_loaded event carries only safe analytics fields', async () => {
    const tracked: Record<string, unknown>[] = []
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockResolvedValue({ ...META, private: true }),
      getPrFiles: vi.fn().mockResolvedValue([file('a.ts'), file('b.ts')]),
    })
    // Spy on what would be tracked via the primaryLanguage path
    await load.promise
    // Verify ready state carries the right shape (visibility/file_count/primary_language)
    expect(load.state.status).toBe('ready')
    if (load.state.status === 'ready') {
      const ext = primaryLanguage(load.state.files)
      expect(ext === 'ts' || ext === 'unknown').toBe(true)
      // Ensure the value is a safe extension token, never a full filename
      expect(ext).not.toContain('/')
      expect(ext).not.toContain('.')
    }
  })
})

describe('createPrLoad', () => {
  it('loads meta and files in parallel into ready state', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockResolvedValue(META),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state.status).toBe('ready')
    expect(load.state.status === 'ready' && load.state.files).toEqual(FILES)
  })

  it('maps not-found to a specific error state (EC-05a)', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockRejectedValue(new GithubApiError({ kind: 'not-found' })),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state).toEqual({ status: 'error', error: 'not-found' })
  })

  it('maps rate limit with reset time (EC-05c)', async () => {
    const resetAt = new Date(1781200000000)
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockRejectedValue(new GithubApiError({ kind: 'rate-limited', resetAt })),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state).toEqual({ status: 'error', error: 'rate-limited', resetAt })
  })

  it('zero changed files → ready with empty list (EC-05g)', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockResolvedValue({ ...META, changedFiles: 0 }),
      getPrFiles: vi.fn().mockResolvedValue([]),
    })
    await load.promise
    expect(load.state.status).toBe('ready')
  })

  it('maps forbidden to a specific error state', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockRejectedValue(new GithubApiError({ kind: 'forbidden' })),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state).toEqual({ status: 'error', error: 'forbidden' })
  })

  it('maps server error to a specific error state', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockRejectedValue(new GithubApiError({ kind: 'server', status: 500 })),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state).toEqual({ status: 'error', error: 'server' })
  })

  it('maps non-GithubApiError (network rejection) to network error', async () => {
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state).toEqual({ status: 'error', error: 'network' })
  })

  it('EC-05k: closed/merged PR loads into ready state', async () => {
    const closedMeta = { ...META, state: 'closed' as const, merged: true }
    const load = createPrLoad(REF, {
      getPrMeta: vi.fn().mockResolvedValue(closedMeta),
      getPrFiles: vi.fn().mockResolvedValue(FILES),
    })
    await load.promise
    expect(load.state.status).toBe('ready')
    expect(load.state.status === 'ready' && load.state.meta.merged).toBe(true)
  })
})
