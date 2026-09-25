/**
 * src/lib/github/updateBranch.test.ts
 *
 * The native update-branch call and, more importantly, its REFUSALS. The
 * failure paths are the ones worth pinning: this is an action offered on a row
 * in a list, and a row that says "Update" and then throws an unhandled rejection
 * is worse than a row that never offered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { updateBranch } from './updateBranch'

const REF = { owner: 'acme', repo: 'web', number: 7 }

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
  }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    'review123:settings',
    JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('updateBranch', () => {
  it('PUTs the native update-branch endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(202, { message: 'Updating pull request branch.' }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await updateBranch(REF)

    expect(outcome).toEqual({ ok: true, message: 'Updating pull request branch.' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/acme/web/pulls/7/update-branch')
    expect(init.method).toBe('PUT')
  })

  it('passes the head SHA it read, so a push in between is refused rather than merged over', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(202, {}))
    vi.stubGlobal('fetch', fetchMock)

    await updateBranch(REF, 'deadbeef')

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body))).toEqual({ expected_head_sha: 'deadbeef' })
  })

  it('omits expected_head_sha when the queue never learned one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(202, {}))
    vi.stubGlobal('fetch', fetchMock)

    await updateBranch(REF, null)

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body))).toEqual({})
  })

  it('a 422 is a conflict, and GitHub’s own words are kept for the tooltip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(422, { message: 'merge conflict between base and head' }),
      ),
    )

    const outcome = await updateBranch(REF)
    expect(outcome).toEqual({
      ok: false,
      kind: 'conflict',
      message: 'merge conflict between base and head',
    })
  })

  it('a 403 says the token cannot push, rather than blaming the branch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(403, { message: 'Resource not accessible by personal access token' }, {
          'X-RateLimit-Remaining': '4999',
        }),
      ),
    )

    const outcome = await updateBranch(REF)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('forbidden')
    expect(outcome.message).toContain('not accessible')
  })

  it('a 404 is reported as unreachable, not as a conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(404, {})))
    const outcome = await updateBranch(REF)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.kind).toBe('not-found')
  })

  it('a rate limit names the reset time instead of saying "failed"', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(403, {}, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(resetAt) }),
      ),
    )

    const outcome = await updateBranch(REF)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('failed')
      expect(outcome.message).toContain('rate limit')
    }
  })

  it('never throws — a dead network is an outcome the row can render', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const outcome = await updateBranch(REF)
    expect(outcome).toEqual({
      ok: false,
      kind: 'failed',
      message: "The update didn't go through.",
    })
  })

  it('falls back to its own sentence when GitHub sends a 422 with no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(422, {})))
    const outcome = await updateBranch(REF)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('conflict')
      expect(outcome.message).toContain('conflict')
    }
  })
})
