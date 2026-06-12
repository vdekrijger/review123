import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { track, _setCaptureForTest, initAnalytics, _setPosthogForTest } from './analytics'
import posthog from 'posthog-js'

describe('analytics privacy choke-point', () => {
  const capture = vi.fn()
  beforeEach(() => { capture.mockClear(); capture.mockImplementation(() => {}); _setCaptureForTest(capture) })

  it('sends an allowed event with allowed props (EC-18c)', () => {
    track('pr_loaded', { visibility: 'public', file_count: 12, primary_language: 'ts' })
    expect(capture).toHaveBeenCalledWith('pr_loaded', {
      visibility: 'public', file_count: 12, primary_language: 'ts',
    })
  })

  it('drops disallowed properties (EC-18a, EC-18h)', () => {
    track('pr_loaded', { visibility: 'public', diff_text: 'SECRET', token: 'ghp_x' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).not.toHaveProperty('diff_text')
    expect(props).not.toHaveProperty('token')
  })

  it('never sends repo identifiers for private repos (EC-18b)', () => {
    track('pr_loaded', { visibility: 'private', repo: 'acme/secret' } as never)
    expect(capture.mock.calls[0][1]).not.toHaveProperty('repo')
  })

  it('records key service but never the key value (EC-18d)', () => {
    track('settings_key_added', { service: 'github', key: 'ghp_x' } as never)
    expect(capture.mock.calls[0][1]).toEqual({ service: 'github' })
  })

  it('review_submitted carries verdict and count only (EC-18e)', () => {
    track('review_submitted', { verdict: 'APPROVE', comment_count: 2, body: 'hi' } as never)
    expect(capture.mock.calls[0][1]).toEqual({ verdict: 'APPROVE', comment_count: 2 })
  })

  it('ai_task events carry task/duration/cached only (EC-18f)', () => {
    track('ai_task_completed', { task: 'summary', duration_ms: 1200, cached: false, output: 'leak' } as never)
    expect(capture.mock.calls[0][1]).toEqual({ task: 'summary', duration_ms: 1200, cached: false })
  })

  it('unknown events are dropped entirely', () => {
    track('rogue_event' as never, {} as never)
    expect(capture).not.toHaveBeenCalled()
  })

  it('capture failures do not throw (EC-18g)', () => {
    capture.mockImplementation(() => { throw new Error('blocked') })
    expect(() => track('pr_loaded', { visibility: 'public' })).not.toThrow()
  })

  it('rejects unknown props at compile time', () => {
    // @ts-expect-error — typo'd prop must not compile
    track('pr_loaded', { fil_count: 12 })
    expect(capture).not.toHaveBeenCalledWith('pr_loaded', expect.objectContaining({ fil_count: 12 }))
  })

  it('ai_task_completed allows tokens (count only, PRIVACY DECISION)', () => {
    track('ai_task_completed', { task: 'summary', duration_ms: 1000, cached: false, tokens: 1234 } as never)
    expect(capture.mock.calls[0][1]).toEqual({ task: 'summary', duration_ms: 1000, cached: false, tokens: 1234 })
  })

  it('ai_task_completed still strips content-ish keys even when tokens present', () => {
    track('ai_task_completed', { task: 'summary', duration_ms: 500, cached: false, tokens: 800, output: 'leaked' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toHaveProperty('tokens', 800)
    expect(props).not.toHaveProperty('output')
  })
})

describe('initAnalytics — posthog.init config (exception capture + masked replay)', () => {
  const initSpy = vi.fn()
  const fakePosthog = { init: initSpy }

  beforeEach(() => {
    initSpy.mockClear()
    _setPosthogForTest(fakePosthog)
  })

  afterEach(() => {
    _setPosthogForTest(posthog as unknown as typeof fakePosthog)
  })

  it('skips init when VITE_POSTHOG_KEY is absent', () => {
    // VITE_POSTHOG_KEY is not set in test env — initAnalytics should be a no-op
    initAnalytics()
    expect(initSpy).not.toHaveBeenCalled()
  })
})
