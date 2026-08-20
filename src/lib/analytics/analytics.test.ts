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

  it('ai_finding_accepted carries ids/enums/counts only — NO finding content', () => {
    track('ai_finding_accepted', {
      reviewer: 'bug-hunter',
      severity: 'high',
      deep: true,
      crossVerified: true,
      confirmedBy: 2,
      polledModels: 3,
      fusionMode: 'generate',
      raisedByCount: 2,
      // content that MUST be stripped by the choke-point:
      body: 'SQL injection in users.ts',
      path: 'src/api/users.ts',
      line: 42,
      code: 'const q = `...${id}`',
    } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({
      reviewer: 'bug-hunter',
      severity: 'high',
      deep: true,
      crossVerified: true,
      confirmedBy: 2,
      polledModels: 3,
      fusionMode: 'generate',
      raisedByCount: 2,
    })
    expect(props).not.toHaveProperty('body')
    expect(props).not.toHaveProperty('path')
    expect(props).not.toHaveProperty('line')
    expect(props).not.toHaveProperty('code')
  })

  it('ai_finding_dismissed carries reviewer/severity/verification context only', () => {
    track('ai_finding_dismissed', {
      reviewer: 'builtin:attention',
      severity: 'low',
      deep: false,
      crossVerified: false,
      confirmedBy: 0,
      polledModels: 0,
      raisedByCount: 0,
      description: 'leaky finding text',
    } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({
      reviewer: 'builtin:attention',
      severity: 'low',
      deep: false,
      crossVerified: false,
      confirmedBy: 0,
      polledModels: 0,
      raisedByCount: 0,
    })
    expect(props).not.toHaveProperty('description')
  })

  it('symbol_repo_searched carries outcome/counts/duration only — never the symbol or paths', () => {
    track('symbol_repo_searched', {
      outcome: 'success',
      definitions: 1,
      references: 4,
      files_scanned: 3,
      files_skipped: 1,
      duration_ms: 840,
      // content that MUST be stripped by the choke-point:
      symbol: 'computeTotal',
      path: 'src/lib/secret.ts',
      snippet: 'const total = computeTotal(xs)',
    } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({
      outcome: 'success',
      definitions: 1,
      references: 4,
      files_scanned: 3,
      files_skipped: 1,
      duration_ms: 840,
    })
    expect(props).not.toHaveProperty('symbol')
    expect(props).not.toHaveProperty('path')
    expect(props).not.toHaveProperty('snippet')
  })

  it('finding_moved carries method/distance/side flags only — never lines, paths, or body', () => {
    track('finding_moved', {
      method: 'drag',
      distance: 3,
      same_side: true,
      off_diff_rescue: false,
      // content that MUST be stripped by the choke-point:
      line: 42,
      path: 'src/api/users.ts',
      body: 'SQL injection in users.ts',
      hash: 'abc123',
    } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toEqual({ method: 'drag', distance: 3, same_side: true, off_diff_rescue: false })
    expect(props).not.toHaveProperty('line')
    expect(props).not.toHaveProperty('path')
    expect(props).not.toHaveProperty('body')
    expect(props).not.toHaveProperty('hash')
  })

  it('finding_move_undone carries nothing at all', () => {
    track('finding_move_undone', { line: 7, path: 'src/a.ts' } as never)
    expect(capture.mock.calls[0][1]).toEqual({})
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
    track('ai_task_completed', { task: 'summary', duration_ms: 1000, cached: false, tokens: 1234 })
    expect(capture.mock.calls[0][1]).toEqual({ task: 'summary', duration_ms: 1000, cached: false, tokens: 1234 })
  })

  it('ai_task_completed still strips content-ish keys even when tokens present', () => {
    track('ai_task_completed', { task: 'summary', duration_ms: 500, cached: false, tokens: 800, output: 'leaked' } as never) // output is not in allowlist — as never needed
    const props = capture.mock.calls[0][1]
    expect(props).toHaveProperty('tokens', 800)
    expect(props).not.toHaveProperty('output')
  })

  it('ai_task_failed allows reason_detail (provider error text, PRIVACY DECISION)', () => {
    track('ai_task_failed', { task: 'summary', reason: 'server', reason_detail: 'Server error (503): overloaded' })
    expect(capture.mock.calls[0][1]).toEqual({
      task: 'summary',
      reason: 'server',
      reason_detail: 'Server error (503): overloaded',
    })
  })

  it('ai_task_failed still strips content-ish keys alongside reason_detail', () => {
    track('ai_task_failed', { task: 'summary', reason: 'server', reason_detail: 'boom', prompt: 'leaked diff' } as never)
    const props = capture.mock.calls[0][1]
    expect(props).toHaveProperty('reason_detail', 'boom')
    expect(props).not.toHaveProperty('prompt')
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
