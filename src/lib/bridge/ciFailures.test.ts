/**
 * ciFailures.test.ts — getting the failure output, and admitting when it could
 * not be got.
 *
 * The property under test throughout is that NOTHING HERE THROWS and nothing
 * here invents. Log fetching is enrichment over an unreliable transport (the
 * Actions logs endpoint redirects to a host that does not reliably allow
 * cross-origin reads), so every failure has to come back as "unavailable" —
 * never as an exception that takes the flow down, and never as an empty log
 * that reads like a job which printed nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CI_LOGS_UNAVAILABLE,
  composeEvidence,
  fetchJobLog,
  gatherCiFailures,
  getPushTarget,
  listFailingActionsJobs,
  tailLog,
} from './ciFailures'
import { saveGithubAuth } from '../settings/settings'
import type { CiSummary } from '../github/checks'
import type { PrRefX } from '../provider/types'

const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'
const PR: PrRefX = { provider: 'github', owner: 'acme', repo: 'widget', number: 42 }
const GITLAB_PR: PrRefX = { ...PR, provider: 'gitlab' }

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response
}

function ci(failures: CiSummary['failures']): CiSummary {
  return { total: failures.length, passed: 0, failed: failures.length, pending: 0, failures }
}

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  saveGithubAuth({ token: 'gho_test', method: 'oauth', scopes: ['repo'] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  saveGithubAuth(null)
})

// ---------------------------------------------------------------------------
// Where a push would go
// ---------------------------------------------------------------------------

describe('getPushTarget', () => {
  it('reads the head branch and sha', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        head: { ref: 'feat/thing', sha: HEAD_SHA, repo: { full_name: 'acme/widget' } },
        base: { repo: { full_name: 'acme/widget' } },
      }),
    )
    expect(await getPushTarget(PR)).toEqual({ branch: 'feat/thing', headSha: HEAD_SHA, isFork: false })
  })

  it('reports a fork as a fork', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        head: { ref: 'feat/thing', sha: HEAD_SHA, repo: { full_name: 'contributor/widget' } },
        base: { repo: { full_name: 'acme/widget' } },
      }),
    )
    expect((await getPushTarget(PR))?.isFork).toBe(true)
  })

  // UNKNOWN IS NOT SAME-REPO. A head repo that could not be read is one this
  // app cannot prove is the repo `origin` points at.
  it('treats an unreadable head repo as a fork rather than as the same repo', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ head: { ref: 'feat/thing', sha: HEAD_SHA, repo: null }, base: { repo: null } }),
    )
    expect((await getPushTarget(PR))?.isFork).toBe(true)
  })

  it('returns null rather than guessing when the read fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    expect(await getPushTarget(PR)).toBeNull()
  })

  const unusableBodies: [string, Record<string, unknown>][] = [
    ['an empty branch name', { head: { ref: '', sha: HEAD_SHA } }],
    ['a sha that is not one', { head: { ref: 'x', sha: 'not-a-sha' } }],
    ['no head at all', {}],
  ]

  it.each(unusableBodies)('returns null for %s', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body))
    expect(await getPushTarget(PR)).toBeNull()
  })

  it('answers null for a non-GitHub provider without making a request', async () => {
    expect(await getPushTarget(GITLAB_PR)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The failing jobs
// ---------------------------------------------------------------------------

describe('listFailingActionsJobs', () => {
  it('walks failing runs to their failing jobs', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ workflow_runs: [{ id: 7, conclusion: 'failure' }, { id: 8, conclusion: 'success' }] }),
    )
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        jobs: [
          { id: 71, name: 'test', conclusion: 'failure', html_url: 'https://gh.test/71' },
          { id: 72, name: 'lint', conclusion: 'success' },
        ],
      }),
    )
    const jobs = await listFailingActionsJobs(PR, HEAD_SHA)
    expect(jobs).toEqual([{ id: 71, name: 'test', url: 'https://gh.test/71' }])
    // The successful RUN was never opened.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns nothing rather than throwing when Actions cannot be read', async () => {
    fetchMock.mockRejectedValueOnce(new Error('403'))
    expect(await listFailingActionsJobs(PR, HEAD_SHA)).toEqual([])
  })

  it('carries on past a run whose jobs cannot be listed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ workflow_runs: [{ id: 7, conclusion: 'failure' }, { id: 9, conclusion: 'timed_out' }] }),
    )
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: [{ id: 91, name: 'e2e', conclusion: 'failure' }] }))
    const jobs = await listFailingActionsJobs(PR, HEAD_SHA)
    expect(jobs.map((j) => j.id)).toEqual([91])
  })

  it('makes no request for a non-GitHub provider', async () => {
    expect(await listFailingActionsJobs(GITLAB_PR, HEAD_SHA)).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchJobLog', () => {
  it('returns the text when the browser is allowed to read it', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('2026-01-01T00:00:00.0Z FAIL src/a.test.ts'))
    expect(await fetchJobLog(PR, 71)).toContain('FAIL src/a.test.ts')
  })

  // The CORS case, the 404 case and the 302-to-nowhere case are all one answer,
  // because from here they are indistinguishable.
  it.each([
    ['a rejected fetch (CORS, offline)', () => fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))],
    ['a non-ok response', () => fetchMock.mockResolvedValueOnce(textResponse('', 404))],
    ['an empty body', () => fetchMock.mockResolvedValueOnce(textResponse(''))],
  ])('returns null for %s', async (_label, arrange) => {
    arrange()
    expect(await fetchJobLog(PR, 71)).toBeNull()
  })

  it('does not attempt a log without a GitHub token', async () => {
    saveGithubAuth(null)
    expect(await fetchJobLog(PR, 71)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('tailLog', () => {
  it('drops the timestamp GitHub prefixes to every line', () => {
    const raw = '2026-01-01T00:00:00.1234567Z first\n2026-01-01T00:00:01.0000000Z second'
    expect(tailLog(raw)).toBe('first\nsecond')
  })

  it('keeps the TAIL, because that is where a failure reports itself', () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const tail = tailLog(raw, 200)
    expect(tail).toContain('line 499')
    expect(tail).not.toContain('line 0\n')
    expect(tail.startsWith('…')).toBe(true)
  })

  it('leaves a short log alone', () => {
    expect(tailLog('short')).toBe('short')
  })
})

describe('composeEvidence', () => {
  it('leads with annotations, then the log', () => {
    const { text } = composeEvidence(['src/a.ts:3 expected 1 to be 2'], 'FAIL src/a.test.ts')
    expect(text.indexOf('annotations:')).toBeLessThan(text.indexOf('job log'))
  })

  it('says outright when nothing could be read, rather than being empty', () => {
    const { text, logUnavailable } = composeEvidence([], null)
    expect(text).toBe('(no output could be read for this job)')
    expect(logUnavailable).toBe(true)
  })

  it('reports logUnavailable even when annotations WERE available', () => {
    const { logUnavailable } = composeEvidence(['something'], null)
    expect(logUnavailable).toBe(true)
  })

  it('reports the log as available when there is one', () => {
    expect(composeEvidence([], 'FAIL').logUnavailable).toBe(false)
  })
})

describe('gatherCiFailures', () => {
  it('pairs each CI failure with its Actions job when it can', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workflow_runs: [{ id: 7, conclusion: 'failure' }] }))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ jobs: [{ id: 71, name: 'test', conclusion: 'failure', html_url: 'https://gh.test/71' }] }),
    )
    fetchMock.mockResolvedValueOnce(textResponse('FAIL src/a.test.ts'))

    const out = await gatherCiFailures(PR, HEAD_SHA, ci([{ name: 'test', annotations: ['a note'] }]))
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('job:71')
    expect(out[0]!.log).toContain('a note')
    expect(out[0]!.log).toContain('FAIL src/a.test.ts')
    expect(out[0]!.logUnavailable).toBe(false)
  })

  it('still reports a failure whose job it could not find, with what it has', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workflow_runs: [] }))
    const out = await gatherCiFailures(
      PR,
      HEAD_SHA,
      ci([{ name: 'deploy preview', annotations: [], url: 'https://gh.test/x' }]),
    )
    expect(out[0]).toMatchObject({ id: 'check:deploy preview', logUnavailable: true })
    expect(out[0]!.log).toBe('(no output could be read for this job)')
  })

  it('caps how many failures it carries', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workflow_runs: [] }))
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `job ${i}`, annotations: [] }))
    expect(await gatherCiFailures(PR, HEAD_SHA, ci(many))).toHaveLength(5)
  })
})

describe('CI_LOGS_UNAVAILABLE', () => {
  it('says what was missing AND that the work is still verified locally', () => {
    expect(CI_LOGS_UNAVAILABLE).toMatch(/would not hand this browser the job logs/i)
    expect(CI_LOGS_UNAVAILABLE).toMatch(/verified against a real local failure/i)
  })
})
