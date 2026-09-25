/**
 * push.test.ts — the client half of the only operation that leaves the machine.
 *
 * The bridge's own tests prove the guarantees. These prove the two things the
 * BROWSER is responsible for: that the request says exactly what the
 * confirmation said, and that every refusal the bridge can send arrives as its
 * own sentence rather than as a generic HTTP error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  PUSH_CONSEQUENCE,
  PUSH_GUARANTEES,
  PUSH_NOT_A_VERDICT,
  describePushFailure,
  describePushPlan,
  describePushResult,
  pushFailureForStatus,
  runBridgePush,
  type PushFailureKind,
} from './push'
import { _resetBridgeForTest, connectBridge } from './bridge.svelte'
import { parsePushResponse } from './protocol'

const OLD_SHA = 'abc1234567890abcdef1234567890abcdef12345'
const NEW_SHA = '0123456789abcdef0123456789abcdef01234567'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function healthBody(caps: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    protocol: 1,
    root: 'repo',
    capabilities: {
      inference: ['claude'],
      infer: true,
      files: true,
      search: true,
      fix: true,
      checkout: true,
      push: true,
      ...caps,
    },
    git: { head: OLD_SHA, branch: 'feat/thing', dirty: false },
    version: '0.4.0',
  }
}

const PLAN = {
  remote: 'origin',
  branch: 'feat/thing',
  expectedRemoteSha: OLD_SHA,
  sha: NEW_SHA,
}

beforeEach(async () => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  _resetBridgeForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetBridgeForTest()
})

async function pair(caps: Record<string, unknown> = {}): Promise<void> {
  fetchMock.mockResolvedValueOnce(jsonResponse(healthBody(caps)))
  await connectBridge(TOKEN, 7321)
}

// ---------------------------------------------------------------------------
// The confirmation copy
// ---------------------------------------------------------------------------

describe('describePushPlan', () => {
  it('names all four things that can be wrong', () => {
    const sentence = describePushPlan(PLAN, 2)
    expect(sentence).toContain('origin/feat/thing')
    expect(sentence).toContain('2 commits')
    expect(sentence).toContain(OLD_SHA.slice(0, 12))
    expect(sentence).toContain(NEW_SHA.slice(0, 12))
  })

  it('says "1 commit", not "1 commits"', () => {
    expect(describePushPlan(PLAN, 1)).toContain('1 commit,')
  })

  it('does not invent a count it does not have', () => {
    const sentence = describePushPlan(PLAN, null)
    expect(sentence).not.toMatch(/\bby \d/)
    expect(sentence).toContain('commits')
  })
})

describe('the confirmation says the whole truth', () => {
  it('states that a push cannot be undone', () => {
    expect(PUSH_CONSEQUENCE).toMatch(/cannot be undone/i)
    expect(PUSH_CONSEQUENCE).toMatch(/everyone who can see the repository/i)
  })

  it('lists the guarantees the bridge actually enforces', () => {
    const all = PUSH_GUARANTEES.join(' ')
    expect(all).toMatch(/fast-forward only/i)
    expect(all).toMatch(/no force/i)
    expect(all).toMatch(/default branch/i)
  })

  // THE ONE THE USER ASKED FOR AND CANNOT HAVE. Saying so beside the button is
  // better than implying a check that does not exist.
  it('says out loud which guarantee is NOT made', () => {
    expect(PUSH_GUARANTEES.join(' ')).toMatch(/cannot check who authored/i)
  })

  it('never claims a push proves anything about CI', () => {
    expect(PUSH_NOT_A_VERDICT).toMatch(/new result, not proof/i)
    expect(PUSH_NOT_A_VERDICT).not.toMatch(/\b(is|are|was|were|now)\s+(fixed|resolved)\b/i)
  })
})

describe('describePushResult', () => {
  it('restates the move in the terms the user confirmed', () => {
    const sentence = describePushResult({
      ok: true,
      remote: 'origin',
      branch: 'feat/thing',
      before: OLD_SHA,
      after: NEW_SHA,
      commits: 3,
      durationMs: 1,
    })
    expect(sentence).toContain(OLD_SHA.slice(0, 12))
    expect(sentence).toContain(NEW_SHA.slice(0, 12))
    expect(sentence).toContain('3 commits')
  })
})

// ---------------------------------------------------------------------------
// Refusals arrive as themselves
// ---------------------------------------------------------------------------

describe('pushFailureForStatus', () => {
  const codes: PushFailureKind[] = [
    'push-disabled',
    'protected-branch',
    'default-branch-unknown',
    'remote-unknown',
    'branch-missing',
    'commit-unknown',
    'tree-dirty',
    'remote-moved',
    'not-fast-forward',
    'nothing-to-push',
    'remote-unreachable',
    'push-rejected',
    'push-failed',
  ]

  it.each(codes)('keeps %s as itself rather than collapsing it into http', (code) => {
    expect(pushFailureForStatus(409, code, 'a reason').kind).toBe(code)
  })

  it('reads a bare 404 as an older bridge, not as a missing branch', () => {
    expect(pushFailureForStatus(404, null, '').kind).toBe('route-missing')
  })

  it('reads an unrecognised 403 as an authorisation refusal', () => {
    expect(pushFailureForStatus(403, null, 'forbidden origin').kind).toBe('push-disabled')
  })

  it('reads a 401 as a stale pairing token', () => {
    expect(pushFailureForStatus(401, null, '').kind).toBe('unauthorized')
  })
})

describe('describePushFailure', () => {
  const kinds: PushFailureKind[] = [
    'not-paired', 'unreachable', 'unauthorized', 'push-disabled', 'route-missing',
    'protected-branch', 'default-branch-unknown', 'remote-unknown', 'branch-missing',
    'commit-unknown', 'tree-dirty', 'remote-moved', 'not-fast-forward', 'nothing-to-push',
    'remote-unreachable', 'push-rejected', 'push-failed', 'timeout', 'cancelled',
    'bad-request', 'malformed', 'http',
  ]

  it.each(kinds)('gives %s a sentence of its own', (kind) => {
    const sentence = describePushFailure({ kind, detail: '' })
    expect(sentence.length).toBeGreaterThan(20)
  })

  it('prefers the bridge’s own words, which know things this layer does not', () => {
    const sentence = describePushFailure({
      kind: 'push-rejected',
      detail: 'origin refused: GH006 Protected branch update failed',
    })
    expect(sentence).toContain('GH006')
  })

  // A push that timed out on this side may have landed on the other. Telling
  // someone to "just try again" would be advice given without knowing.
  it.each(['timeout', 'cancelled', 'push-failed', 'malformed'] as const)(
    'tells the user to CHECK the remote after %s rather than to retry',
    (kind) => {
      expect(describePushFailure({ kind, detail: '' })).toMatch(/check the branch on the remote/i)
    },
  )

  it('never tells the user to force anything', () => {
    for (const kind of kinds) {
      expect(describePushFailure({ kind, detail: '' })).not.toMatch(/force[- ]push|--force/i)
    }
  })
})

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe('runBridgePush', () => {
  it('refuses before any request when no bridge is paired', async () => {
    const outcome = await runBridgePush(PLAN)
    expect(outcome).toEqual({ ok: false, failure: { kind: 'not-paired', detail: '' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses before any request when the bridge has no push grant', async () => {
    await pair({ push: false })
    const before = fetchMock.mock.calls.length
    const outcome = await runBridgePush(PLAN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.kind).toBe('push-disabled')
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('--allow-write alone does not enable it here either', async () => {
    await pair({ fix: true, checkout: true, push: false })
    const outcome = await runBridgePush(PLAN)
    expect(outcome.ok).toBe(false)
  })

  it('sends exactly the plan, and nothing that could mean force', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        remote: 'origin',
        branch: 'feat/thing',
        before: OLD_SHA,
        after: NEW_SHA,
        commits: 1,
        durationMs: 5,
      }),
    )
    await runBridgePush(PLAN)
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/push'))!
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual(PLAN)
    expect((call[1] as RequestInit).credentials).toBe('omit')
  })

  it('carries the dirty paths through, so the UI can name them', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          error: 'tree-dirty',
          message: 'uncommitted changes',
          dirtyPaths: ['src/wip.ts', 'notes.md'],
          dirtyCount: 2,
        },
        409,
      ),
    )
    const outcome = await runBridgePush(PLAN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('tree-dirty')
      expect(outcome.failure.dirtyPaths).toEqual(['src/wip.ts', 'notes.md'])
      expect(outcome.failure.dirtyCount).toBe(2)
    }
  })

  it('NEVER retries — one confirmation, one attempt', async () => {
    await pair()
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
    const before = fetchMock.mock.calls.length
    const outcome = await runBridgePush(PLAN)
    expect(outcome.ok).toBe(false)
    expect(fetchMock.mock.calls.length).toBe(before + 1)
  })

  it('reports an unreadable success as unknown rather than as a success', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, remote: 'origin', branch: 'x' }))
    const outcome = await runBridgePush(PLAN)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.kind).toBe('malformed')
  })
})

describe('parsePushResponse', () => {
  const good = {
    ok: true,
    remote: 'origin',
    branch: 'feat/thing',
    before: OLD_SHA,
    after: NEW_SHA,
    commits: 2,
    durationMs: 9,
  }

  it('accepts a complete response', () => {
    expect(parsePushResponse(good)).toEqual(good)
  })

  it.each(['before', 'after'])('refuses a response with no readable %s sha', (field) => {
    expect(parsePushResponse({ ...good, [field]: 'nope' })).toBeNull()
  })

  it('refuses a response that does not say ok', () => {
    expect(parsePushResponse({ ...good, ok: false })).toBeNull()
    expect(parsePushResponse(null)).toBeNull()
  })

  it('defaults an unreadable commit count to zero rather than inventing one', () => {
    expect(parsePushResponse({ ...good, commits: 'lots' })?.commits).toBe(0)
    expect(parsePushResponse({ ...good, commits: -3 })?.commits).toBe(0)
  })
})
