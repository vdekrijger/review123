/**
 * Tests for getCiSummary — CI check-run signals (REQ-10)
 *
 * EC-10a: zero check-runs → all-zero CiSummary
 * EC-10b: runs with status != completed → pending counts
 * EC-10c: all runs success → all-pass, no failures
 * EC-10d: mixed conclusions → correct pass/fail/pending split + annotation fetch
 * Pagination traversal: two pages of check-runs
 * Annotation cap: only first 50 annotations returned
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getCiSummary } from './checks'
import { jsonResponse } from '../../test-helpers'

const REF = { owner: 'acme', repo: 'web', number: 7 }
const SHA = 'abc123def456'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckRun(
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  urls?: { html_url?: string | null; details_url?: string | null },
) {
  return { id, name, status, conclusion, ...urls }
}

function checkRunsPage(
  runs: ReturnType<typeof makeCheckRun>[],
  total_count?: number,
  nextUrl?: string,
) {
  const headers: Record<string, string> = {}
  if (nextUrl) {
    headers['Link'] = `<${nextUrl}>; rel="next"`
  }
  return jsonResponse(
    { total_count: total_count ?? runs.length, check_runs: runs },
    headers,
  )
}

function annotationsResponse(messages: string[]) {
  return jsonResponse(messages.map((m) => ({ message: m })))
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// EC-10a: zero runs
// ---------------------------------------------------------------------------

describe('getCiSummary — zero runs (EC-10a)', () => {
  it('returns all-zero summary when no check-runs exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(checkRunsPage([], 0)),
    )

    const result = await getCiSummary(REF, SHA)
    expect(result).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      failures: [],
    })
  })
})

// ---------------------------------------------------------------------------
// EC-10b: pending runs
// ---------------------------------------------------------------------------

describe('getCiSummary — pending runs (EC-10b)', () => {
  it('counts in_progress and queued runs as pending', async () => {
    const runs = [
      makeCheckRun(1, 'build', 'in_progress', null),
      makeCheckRun(2, 'lint', 'queued', null),
      makeCheckRun(3, 'test', 'completed', 'success'),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(checkRunsPage(runs)))

    const result = await getCiSummary(REF, SHA)
    expect(result.total).toBe(3)
    expect(result.pending).toBe(2)
    expect(result.passed).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.failures).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// EC-10c: all pass
// ---------------------------------------------------------------------------

describe('getCiSummary — all pass (EC-10c)', () => {
  it('counts success, neutral, and skipped as passed', async () => {
    const runs = [
      makeCheckRun(1, 'unit', 'completed', 'success'),
      makeCheckRun(2, 'info-check', 'completed', 'neutral'),
      makeCheckRun(3, 'optional', 'completed', 'skipped'),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(checkRunsPage(runs)))

    const result = await getCiSummary(REF, SHA)
    expect(result.total).toBe(3)
    expect(result.passed).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.pending).toBe(0)
    expect(result.failures).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// EC-10d: mixed conclusions
// ---------------------------------------------------------------------------

describe('getCiSummary — mixed conclusions (EC-10d)', () => {
  it('correctly maps failure/timed_out/cancelled/action_required as failed and fetches annotations', async () => {
    const runs = [
      makeCheckRun(10, 'unit', 'completed', 'success'),
      makeCheckRun(20, 'e2e', 'completed', 'failure'),
      makeCheckRun(30, 'perf', 'completed', 'timed_out'),
      makeCheckRun(40, 'deploy', 'in_progress', null),
      makeCheckRun(50, 'security', 'completed', 'cancelled'),
      makeCheckRun(60, 'sign-off', 'completed', 'action_required'),
      makeCheckRun(70, 'coverage', 'completed', 'skipped'),
    ]

    const mockFetch = vi
      .fn()
      // First call: check-runs page
      .mockResolvedValueOnce(checkRunsPage(runs))
      // Subsequent calls: annotation endpoints for each failed run (ids 20,30,50,60)
      .mockResolvedValueOnce(annotationsResponse(['Test foo failed at line 42']))
      .mockResolvedValueOnce(annotationsResponse(['Timeout exceeded 60s']))
      .mockResolvedValueOnce(annotationsResponse([]))
      .mockResolvedValueOnce(annotationsResponse(['Manual approval required']))

    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)

    expect(result.total).toBe(7)
    expect(result.passed).toBe(2) // success + skipped
    expect(result.failed).toBe(4) // failure + timed_out + cancelled + action_required
    expect(result.pending).toBe(1)
    expect(result.failures).toHaveLength(4)
    // URL is null here because the fixture check-runs carry no html_url/details_url.
    expect(result.failures[0]).toEqual({
      name: 'e2e',
      annotations: ['Test foo failed at line 42'],
      url: null,
    })
    expect(result.failures[1]).toEqual({
      name: 'perf',
      annotations: ['Timeout exceeded 60s'],
      url: null,
    })
    expect(result.failures[2]).toEqual({ name: 'security', annotations: [], url: null })
    expect(result.failures[3]).toEqual({
      name: 'sign-off',
      annotations: ['Manual approval required'],
      url: null,
    })
  })

  it('verifies annotation fetch URL pattern', async () => {
    const runs = [makeCheckRun(99, 'ci', 'completed', 'failure')]
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockResolvedValueOnce(annotationsResponse(['err msg']))

    vi.stubGlobal('fetch', mockFetch)

    await getCiSummary(REF, SHA)

    // First call: check-runs list
    expect(mockFetch.mock.calls[0][0]).toContain(
      `/repos/${REF.owner}/${REF.repo}/commits/${SHA}/check-runs`,
    )
    // Second call: annotations
    expect(mockFetch.mock.calls[1][0]).toContain(
      `/repos/${REF.owner}/${REF.repo}/check-runs/99/annotations`,
    )
    expect(mockFetch.mock.calls[1][0]).toContain('per_page=50')
  })
})

// ---------------------------------------------------------------------------
// Pagination traversal
// ---------------------------------------------------------------------------

describe('getCiSummary — pagination traversal', () => {
  it('follows Link next header across multiple pages', async () => {
    const page1Runs = [
      makeCheckRun(1, 'job-1', 'completed', 'success'),
      makeCheckRun(2, 'job-2', 'completed', 'success'),
    ]
    const page2Runs = [
      makeCheckRun(3, 'job-3', 'completed', 'success'),
      makeCheckRun(4, 'job-4', 'completed', 'failure'),
    ]

    const nextUrl =
      `https://api.github.com/repos/${REF.owner}/${REF.repo}/commits/${SHA}/check-runs?per_page=100&page=2`

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(page1Runs, 4, nextUrl))
      .mockResolvedValueOnce(checkRunsPage(page2Runs, 4))
      .mockResolvedValueOnce(annotationsResponse(['page 2 failure annotation']))

    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)

    expect(result.total).toBe(4)
    expect(result.passed).toBe(3)
    expect(result.failed).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].name).toBe('job-4')
    expect(result.failures[0].annotations).toEqual(['page 2 failure annotation'])

    // First fetch: initial URL; second fetch: next page URL
    expect(mockFetch.mock.calls[1][0]).toBe(nextUrl)
  })
})

// ---------------------------------------------------------------------------
// Annotation cap (one page, max 50)
// ---------------------------------------------------------------------------

describe('getCiSummary — annotation cap', () => {
  it('caps annotations at 50 per run', async () => {
    const runs = [makeCheckRun(1, 'linter', 'completed', 'failure')]

    // Create 60 annotations — only first 50 should come through
    const allMessages = Array.from({ length: 60 }, (_, i) => `error ${i + 1}`)

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockResolvedValueOnce(jsonResponse(allMessages.map((m) => ({ message: m }))))

    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)
    // The annotation endpoint is called with per_page=50 (API-level cap),
    // but we also slice to 50 defensively on the response.
    expect(result.failures[0].annotations).toHaveLength(50)
    expect(result.failures[0].annotations[0]).toBe('error 1')
    expect(result.failures[0].annotations[49]).toBe('error 50')
  })

  it('annotation fetch with per_page=50 query param', async () => {
    const runs = [makeCheckRun(77, 'check', 'completed', 'failure')]
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockResolvedValueOnce(annotationsResponse([]))

    vi.stubGlobal('fetch', mockFetch)
    await getCiSummary(REF, SHA)

    // Verify the annotation URL has per_page=50
    const annotationCall = mockFetch.mock.calls[1][0] as string
    expect(annotationCall).toMatch(/per_page=50/)
  })
})

// ---------------------------------------------------------------------------
// Annotation fetch failure is non-fatal
// ---------------------------------------------------------------------------

describe('getCiSummary — annotation fetch failures are non-fatal', () => {
  it('returns empty annotations when annotation endpoint throws', async () => {
    const runs = [makeCheckRun(42, 'broken-check', 'completed', 'failure')]

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockRejectedValueOnce(new TypeError('network error'))

    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].annotations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Per-failure web URL: html_url preferred, details_url fallback, null when absent
// ---------------------------------------------------------------------------

describe('getCiSummary — per-failure web URL', () => {
  it('populates url from html_url when present', async () => {
    const runs = [
      makeCheckRun(1, 'unit', 'completed', 'failure', {
        html_url: 'https://github.com/acme/web/runs/1',
        details_url: 'https://ci.example.com/build/1',
      }),
    ]
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockResolvedValueOnce(annotationsResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)
    // html_url is preferred over details_url
    expect(result.failures[0].url).toBe('https://github.com/acme/web/runs/1')
  })

  it('falls back to details_url when html_url is absent', async () => {
    const runs = [
      makeCheckRun(2, 'e2e', 'completed', 'failure', {
        details_url: 'https://ci.example.com/build/2',
      }),
    ]
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockResolvedValueOnce(annotationsResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)
    expect(result.failures[0].url).toBe('https://ci.example.com/build/2')
  })

  it('falls back to details_url when html_url is null', async () => {
    const runs = [
      makeCheckRun(3, 'lint', 'completed', 'failure', {
        html_url: null,
        details_url: 'https://ci.example.com/build/3',
      }),
    ]
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockResolvedValueOnce(annotationsResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)
    expect(result.failures[0].url).toBe('https://ci.example.com/build/3')
  })

  it('is null when neither html_url nor details_url is present', async () => {
    const runs = [makeCheckRun(4, 'build', 'completed', 'failure')]
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockResolvedValueOnce(annotationsResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)
    expect(result.failures[0].url).toBeNull()
  })

  it('is null when html_url is null and details_url is absent', async () => {
    const runs = [makeCheckRun(5, 'typecheck', 'completed', 'failure', { html_url: null })]
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(checkRunsPage(runs))
      .mockResolvedValueOnce(annotationsResponse([]))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getCiSummary(REF, SHA)
    expect(result.failures[0].url).toBeNull()
  })
})
