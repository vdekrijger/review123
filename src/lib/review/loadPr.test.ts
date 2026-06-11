import { describe, it, expect, vi } from 'vitest'
import { createPrLoad } from './loadPr.svelte'
import { GithubApiError } from '../github/types'

const REF = { owner: 'a', repo: 'b', number: 1 }
const META = {
  title: 'T', state: 'open' as const, merged: false, body: null,
  baseSha: 'b1', headSha: 'h1', private: false, changedFiles: 1,
}
const FILES = [{ filename: 'a.ts', status: 'modified' as const, patch: '@@', additions: 1, deletions: 0 }]

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
})
