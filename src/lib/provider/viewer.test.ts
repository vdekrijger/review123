/**
 * viewer.test.ts — session-cached viewer identity resolution.
 *
 * resolveViewerLogin(provider) caches the result per provider id so the
 * Verdict step never refetches identity per render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveViewerLogin, _resetViewerCacheForTest } from './viewer'
import type { ReviewProvider } from './types'

function makeProvider(overrides: Partial<ReviewProvider> = {}): ReviewProvider {
  return {
    id: 'github',
    displayName: 'GitHub',
    capabilities: {
      resolvedThreads: true,
      checks: true,
      suggestions: true,
      atomicReview: true,
      compare: true,
      selfReviewBlocked: true,
    },
    parseUrl: vi.fn(),
    getPrMeta: vi.fn(),
    getPrFiles: vi.fn(),
    getFileAtRef: vi.fn(),
    getCiSummary: vi.fn(),
    getComments: vi.fn(),
    getResolvedCommentIds: vi.fn(),
    getCommits: vi.fn(),
    compareCommits: vi.fn(),
    submitReview: vi.fn(),
    authState: vi.fn().mockReturnValue({ configured: true, hint: '' }),
    getViewerLogin: vi.fn().mockResolvedValue('alice'),
    ...overrides,
  } as unknown as ReviewProvider
}

beforeEach(() => {
  _resetViewerCacheForTest()
})

describe('resolveViewerLogin', () => {
  it('returns the login from provider.getViewerLogin', async () => {
    const p = makeProvider()
    expect(await resolveViewerLogin(p)).toBe('alice')
  })

  it('returns null when the provider does not implement getViewerLogin', async () => {
    const p = makeProvider({ getViewerLogin: undefined })
    expect(await resolveViewerLogin(p)).toBeNull()
  })

  it('returns null when the provider is not authenticated', async () => {
    const p = makeProvider({
      authState: vi.fn().mockReturnValue({ configured: false, hint: '' }),
    })
    expect(await resolveViewerLogin(p)).toBeNull()
    expect(p.getViewerLogin).not.toHaveBeenCalled()
  })

  it('caches the result per session — second call does not refetch', async () => {
    const p = makeProvider()
    await resolveViewerLogin(p)
    await resolveViewerLogin(p)
    expect(p.getViewerLogin).toHaveBeenCalledTimes(1)
  })

  it('returns null on fetch failure and does NOT cache the failure', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('alice')
    const p = makeProvider({ getViewerLogin: fn })
    expect(await resolveViewerLogin(p)).toBeNull()
    // retry succeeds — failure was not cached
    expect(await resolveViewerLogin(p)).toBe('alice')
  })

  it('caches per provider id — different providers resolve independently', async () => {
    const gh = makeProvider()
    const gl = makeProvider({
      id: 'gitlab',
      getViewerLogin: vi.fn().mockResolvedValue('bob'),
    })
    expect(await resolveViewerLogin(gh)).toBe('alice')
    expect(await resolveViewerLogin(gl)).toBe('bob')
  })
})
