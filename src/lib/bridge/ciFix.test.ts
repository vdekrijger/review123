/**
 * ciFix.test.ts — the client half of the failing-CI flow.
 *
 * Mostly a test of VOCABULARY, which is the right thing to test here. The
 * bridge decides what happened; this layer decides what the user is told, and
 * the failure mode of a feature like this is not a crash — it is a surface
 * that reads as "CI is fixed" when what actually happened is "one command on
 * one machine stopped failing".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CI_FIX_LOCAL_ONLY,
  CI_FIX_NOT_REVIEWED,
  describeCiFixFailure,
  describeCiStop,
  describeNoReproductionNextStep,
  describeReproduction,
  hasUnverifiedCommit,
  pushableCommit,
  runBridgeCiFix,
  type CiFixFailureKind,
} from './ciFix'
import { _resetBridgeForTest, connectBridge } from './bridge.svelte'
import { parseCiFixResponse, type BridgeCiFixResponse } from './protocol'

const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'
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
      checkout: false,
      push: false,
      ...caps,
    },
    git: { head: HEAD_SHA, branch: 'feat/thing', dirty: false },
    version: '0.4.0',
  }
}

function response(overrides: Partial<BridgeCiFixResponse> = {}): BridgeCiFixResponse {
  return {
    ok: true,
    cli: 'claude',
    reproduction: 'reproduced',
    baseline: { status: 'failed', command: 'pnpm test', durationMs: 900, output: 'red' },
    baseSha: HEAD_SHA,
    branch: 'review123/fix/abc123456789',
    changes: [],
    skipped: [],
    rounds: 1,
    stopReason: 'all-addressed',
    tests: { status: 'passed', command: 'pnpm test', durationMs: 800, output: 'ok' },
    headCommit: NEW_SHA,
    durationMs: 4000,
    ...overrides,
  }
}

const FAILURES = [{ id: 'job:1', name: 'test', log: 'boom' }]

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
// The verdict
// ---------------------------------------------------------------------------

describe('describeReproduction', () => {
  it('names the command that failed when the failure reproduced', () => {
    expect(describeReproduction(response())).toMatch(/pnpm test failed at this commit/i)
  })

  it('says NOT reproduced plainly, and that no agent ran', () => {
    const sentence = describeReproduction(
      response({
        reproduction: 'not-reproduced',
        baseline: { status: 'passed', command: 'pnpm test', durationMs: 1, output: '' },
      }),
    )
    expect(sentence).toMatch(/did NOT reproduce/)
    expect(sentence).toMatch(/No agent was started and nothing was changed/i)
  })

  it('distinguishes "no signal" from "it passed"', () => {
    const sentence = describeReproduction(response({ reproduction: 'no-local-signal', baseline: null }))
    expect(sentence).toMatch(/no local signal/i)
    expect(sentence).not.toMatch(/passed/i)
  })

  it('never says anything was fixed', () => {
    for (const r of ['reproduced', 'not-reproduced', 'no-local-signal'] as const) {
      expect(describeReproduction(response({ reproduction: r }))).not.toMatch(
        /\bfixed\b|\bresolved\b/i,
      )
    }
  })
})

describe('describeNoReproductionNextStep', () => {
  it('names --test-command, so the refusal has a way forward', () => {
    expect(describeNoReproductionNextStep('not-reproduced')).toMatch(/--test-command/)
    expect(describeNoReproductionNextStep('no-local-signal')).toMatch(/--test-command/)
  })

  it('offers nothing when the failure DID reproduce — there is nothing to fix', () => {
    expect(describeNoReproductionNextStep('reproduced')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// THE GATE, restated where the button is
// ---------------------------------------------------------------------------

describe('pushableCommit', () => {
  it('offers the commit only when the failure reproduced', () => {
    expect(pushableCommit(response())).toBe(NEW_SHA)
  })

  it.each(['not-reproduced', 'no-local-signal'] as const)(
    'offers NOTHING when the verdict is %s, even if a commit sha arrived',
    (reproduction) => {
      expect(pushableCommit(response({ reproduction }))).toBeNull()
    },
  )

  it('offers nothing when the bridge committed nothing', () => {
    expect(pushableCommit(response({ headCommit: null }))).toBeNull()
  })
})

describe('hasUnverifiedCommit', () => {
  it('is true for a commit whose local run never went green', () => {
    expect(
      hasUnverifiedCommit(
        response({
          stopReason: 'round-cap',
          tests: { status: 'failed', command: 'pnpm test', durationMs: 1, output: 'red' },
        }),
      ),
    ).toBe(true)
  })

  it('is false when the local run passed', () => {
    expect(hasUnverifiedCommit(response())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('the honesty sentences', () => {
  it('says a green local run is one command on one machine', () => {
    expect(CI_FIX_LOCAL_ONLY).toMatch(/one command on your machine, not CI/i)
    expect(CI_FIX_LOCAL_ONLY).toMatch(/new result rather than proof/i)
  })

  it('says nobody has reviewed it', () => {
    expect(CI_FIX_NOT_REVIEWED).toMatch(/No person has read/i)
    expect(CI_FIX_NOT_REVIEWED).toMatch(/not a substitute for it/i)
  })

  it('neither of them claims anything is fixed, resolved or done', () => {
    for (const sentence of [CI_FIX_LOCAL_ONLY, CI_FIX_NOT_REVIEWED]) {
      expect(sentence).not.toMatch(/\b(is|are|was|were|now)\s+(fixed|resolved)\b|\ball clear\b/i)
    }
  })
})

describe('describeCiStop', () => {
  it('says plainly that a round-cap run is STILL failing and proves nothing', () => {
    const sentence = describeCiStop(
      response({
        stopReason: 'round-cap',
        tests: { status: 'failed', command: 'pnpm test', durationMs: 1, output: 'red' },
      }),
    )
    expect(sentence).toMatch(/STILL failing/)
    expect(sentence).toMatch(/nothing about it has been shown to work/i)
  })

  it('does not call a green run a success, only a stop', () => {
    expect(describeCiStop(response())).toMatch(/stopped when the test command stopped failing/i)
  })

  it.each(['all-addressed', 'round-cap', 'no-progress', 'repeat-diff', 'budget-exhausted'] as const)(
    'gives %s its own sentence, and never says fixed',
    (stopReason) => {
      const sentence = describeCiStop(response({ stopReason }))
      expect(sentence.length).toBeGreaterThan(20)
      expect(sentence).not.toMatch(/\bfixed\b|\bresolved\b/i)
    },
  )
})

describe('describeCiFixFailure', () => {
  const kinds: CiFixFailureKind[] = [
    'not-paired', 'unreachable', 'unauthorized', 'write-disabled', 'route-missing',
    'cli-unavailable', 'head-unknown', 'worktree-failed', 'timeout', 'cancelled',
    'bad-request', 'malformed', 'http',
  ]

  it.each(kinds)('gives %s a sentence of its own', (kind) => {
    expect(describeCiFixFailure({ kind, detail: '' }).length).toBeGreaterThan(20)
  })

  it('says nothing was pushed when a run is cancelled', () => {
    expect(describeCiFixFailure({ kind: 'cancelled', detail: '' })).toMatch(/nothing was pushed/i)
  })
})

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe('runBridgeCiFix', () => {
  it('refuses before any request when no bridge is paired', async () => {
    const outcome = await runBridgeCiFix('claude', HEAD_SHA, FAILURES)
    expect(outcome).toEqual({ ok: false, failure: { kind: 'not-paired', detail: '' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses before any request when the bridge is read-only', async () => {
    await pair({ fix: false })
    const before = fetchMock.mock.calls.length
    const outcome = await runBridgeCiFix('claude', HEAD_SHA, FAILURES)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.kind).toBe('write-disabled')
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('caps the failures it sends rather than letting the bridge drop some silently', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse(response()))
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `j${i}`, name: 'test', log: '' }))
    await runBridgeCiFix('claude', HEAD_SHA, many)
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/ci-fix'))!
    expect(JSON.parse((call[1] as RequestInit).body as string).failures).toHaveLength(5)
  })

  it('reads a 404 as an older bridge rather than as a broken one', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not-found', message: '' }, 404))
    const outcome = await runBridgeCiFix('claude', HEAD_SHA, FAILURES)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.failure.kind).toBe('route-missing')
  })
})

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseCiFixResponse', () => {
  it('reads a complete response', () => {
    const parsed = parseCiFixResponse(response())
    expect(parsed?.reproduction).toBe('reproduced')
    expect(parsed?.headCommit).toBe(NEW_SHA)
    expect(parsed?.baseline?.status).toBe('failed')
  })

  // THE ONE THAT MATTERS: a field we could not read must offer LESS, not more.
  it('reads an unknown verdict as no-local-signal, never as reproduced', () => {
    const parsed = parseCiFixResponse(response({ reproduction: 'sure' as never }))
    expect(parsed?.reproduction).toBe('no-local-signal')
  })

  it('reads a missing verdict as no-local-signal too', () => {
    const { reproduction: _drop, ...without } = response()
    expect(parseCiFixResponse(without)?.reproduction).toBe('no-local-signal')
  })

  it('refuses a headCommit that is not a sha rather than passing it to a push', () => {
    const parsed = parseCiFixResponse(response({ headCommit: 'HEAD' as never }))
    expect(parsed?.headCommit).toBeNull()
  })

  it('refuses a response that is not a fix response at all', () => {
    expect(parseCiFixResponse(null)).toBeNull()
    expect(parseCiFixResponse({ ok: false })).toBeNull()
  })
})
