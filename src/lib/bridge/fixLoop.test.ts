/**
 * fixLoop.test.ts — the browser's half of the agent fix loop.
 *
 * Two things are worth testing here and they are both rules, not plumbing:
 * WHICH findings may be sent (the #228 routing rule + the #226 tier), and
 * whether every refusal names its reason instead of returning a bare false.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  cherryPickCommand,
  decideFixReadiness,
  describeFixEligibility,
  describeFixFailure,
  describeFixReadiness,
  describeFixSkip,
  describeFixStop,
  describeFixTests,
  fixEligibility,
  fixSkipLabel,
  fixTestLabel,
  isConcreteFix,
  preferredFixCli,
  runBridgeFix,
  type FixEligibility,
  type FixFailureKind,
  type FixReadinessReason,
  type FixSnapshot,
} from './fixLoop'
import { _resetBridgeForTest, connectBridge } from './bridge.svelte'
import { BRIDGE_STORAGE_KEY } from './storage'
import { MAX_FIX_FINDINGS, PROTOCOL_VERSION, type BridgeFixFinding } from './protocol'

const PR_HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_HEAD = 'def4567890abcdef1234567890abcdef12345678'
const COMMIT_A = '1111111111111111111111111111111111111111'
const COMMIT_B = '2222222222222222222222222222222222222222'
const TOKEN = 'pairing-token-0000000000000000000000000000'

// ---------------------------------------------------------------------------
// Eligibility — the routing rule
// ---------------------------------------------------------------------------

describe('isConcreteFix', () => {
  it('accepts a prescription', () => {
    expect(isConcreteFix('Escape it with `sanitizeHtml(input)` before rendering.')).toBe(true)
  })

  it('REFUSES the honest "No clean fix — tradeoff" form', () => {
    expect(isConcreteFix('No clean fix — batching adds latency; accept the N+1 here.')).toBe(false)
    expect(isConcreteFix('no clean fix — you have to pick one')).toBe(false)
    expect(isConcreteFix('**No clean fix —** it is a design tradeoff')).toBe(false)
  })

  it('does NOT refuse a fix that merely mentions the words mid-sentence', () => {
    // Anchored at the start on purpose: this IS a prescription.
    expect(
      isConcreteFix('There is no clean fix for the legacy path, so guard the new one with a null check.'),
    ).toBe(true)
  })

  it('treats absent and empty as not concrete', () => {
    expect(isConcreteFix(undefined)).toBe(false)
    expect(isConcreteFix('   ')).toBe(false)
  })
})

describe('fixEligibility', () => {
  it('sends a primary finding with a concrete fix', () => {
    expect(fixEligibility({ suggestedFix: 'Add the guard.', tier: 'primary' })).toBe('eligible')
    // No tier at all is treated as primary: a caller that does not rank is not
    // asking for its findings to be suppressed.
    expect(fixEligibility({ suggestedFix: 'Add the guard.' })).toBe('eligible')
  })

  it('never auto-sends a judgment call', () => {
    expect(fixEligibility({ suggestedFix: 'No clean fix — pick your poison.', tier: 'primary' })).toBe(
      'no-clean-fix',
    )
  })

  it('has nothing to send when the finding carries no fix', () => {
    expect(fixEligibility({ tier: 'primary' })).toBe('no-fix')
    expect(fixEligibility({ suggestedFix: '', tier: 'primary' })).toBe('no-fix')
  })

  it('leaves collapsed findings out of the batch', () => {
    expect(fixEligibility({ suggestedFix: 'Add the guard.', tier: 'secondary' })).toBe('secondary')
  })

  it('checks the FIX before the tier — a collapsed judgment call is still a judgment call', () => {
    expect(fixEligibility({ suggestedFix: 'No clean fix — …', tier: 'secondary' })).toBe('no-clean-fix')
  })

  it.each<FixEligibility>(['eligible', 'no-fix', 'no-clean-fix', 'secondary'])(
    'has a sentence for %s',
    (reason) => {
      expect(describeFixEligibility(reason).length).toBeGreaterThan(20)
    },
  )
})

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<FixSnapshot> = {}): FixSnapshot {
  return {
    connected: true,
    writeEnabled: true,
    clis: ['claude'],
    git: { head: PR_HEAD, branch: 'feat/thing', dirty: false },
    ...overrides,
  }
}

describe('decideFixReadiness', () => {
  it('is ready when paired, write-enabled, tooled and on this PR’s head', () => {
    const readiness = decideFixReadiness(snapshot(), PR_HEAD)
    expect(readiness).toMatchObject({ ready: true, reason: 'ready', cli: 'claude' })
  })

  it('is ready on a DIRTY checkout — the worktree is made from the commit, not the tree', () => {
    const readiness = decideFixReadiness(
      snapshot({ git: { head: PR_HEAD, branch: 'feat/thing', dirty: true } }),
      PR_HEAD,
    )
    expect(readiness.ready).toBe(true)
  })

  // THE GATE: a read-only bridge is never offered as a write one.
  it('refuses when the bridge is read-only, and says only the terminal can change it', () => {
    const readiness = decideFixReadiness(snapshot({ writeEnabled: false }), PR_HEAD)
    expect(readiness).toMatchObject({ ready: false, reason: 'write-disabled', cli: null })
    expect(describeFixReadiness(readiness, PR_HEAD)).toContain('--allow-write')
  })

  it('refuses with no bridge, before asking anything else', () => {
    expect(decideFixReadiness(snapshot({ connected: false, writeEnabled: true }), PR_HEAD).reason).toBe(
      'no-bridge',
    )
  })

  it('refuses when no coding agent is installed', () => {
    expect(decideFixReadiness(snapshot({ clis: [] }), PR_HEAD).reason).toBe('no-cli')
  })

  it('refuses when the bridge serves no git repository', () => {
    expect(decideFixReadiness(snapshot({ git: null }), PR_HEAD).reason).toBe('no-repo-state')
  })

  it('refuses a checkout on another commit, and names both shas so the user can act', () => {
    const readiness = decideFixReadiness(
      snapshot({ git: { head: OTHER_HEAD, branch: 'main', dirty: false } }),
      PR_HEAD,
    )
    expect(readiness.reason).toBe('head-mismatch')
    const sentence = describeFixReadiness(readiness, PR_HEAD)
    expect(sentence).toContain('main')
    expect(sentence).toContain(OTHER_HEAD.slice(0, 7))
    expect(sentence).toContain(PR_HEAD.slice(0, 7))
  })

  it.each<FixReadinessReason>([
    'ready', 'no-bridge', 'write-disabled', 'no-cli', 'no-repo-state', 'head-mismatch',
  ])('has a sentence for %s', (reason) => {
    const readiness = { ready: reason === 'ready', reason, cli: 'claude' as const, branch: 'x', bridgeHead: PR_HEAD }
    expect(describeFixReadiness(readiness, PR_HEAD).length).toBeGreaterThan(20)
  })
})

describe('preferredFixCli', () => {
  it('prefers the CLI whose write invocation is verified, and falls back', () => {
    expect(preferredFixCli(['codex', 'claude'])).toBe('claude')
    expect(preferredFixCli(['codex'])).toBe('codex')
    expect(preferredFixCli([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const fetchMock = vi.fn()

function healthBody(caps: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    root: 'review123',
    capabilities: { inference: ['claude'], infer: true, files: true, search: true, ...caps },
    git: { head: PR_HEAD, branch: 'feat/thing', dirty: false },
    version: '0.1.0',
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function fixFinding(overrides: Partial<BridgeFixFinding> = {}): BridgeFixFinding {
  return {
    id: 'f1',
    path: 'src/a.ts',
    line: 3,
    severity: 'high',
    body: 'unescaped input',
    suggestedFix: 'escape it',
    ...overrides,
  }
}

function fixResponseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    cli: 'claude',
    baseSha: PR_HEAD,
    branch: 'review123/fix/abc123456789',
    changes: [
      {
        findingId: 'f1',
        commit: COMMIT_A,
        subject: 'fix: escaped the name',
        intent: 'escaped the name before interpolating it',
        files: ['src/a.ts'],
        diff: '--- a/src/a.ts\n+++ b/src/a.ts\n',
        truncated: false,
        rounds: 1,
        stopReason: 'all-addressed',
        tests: { status: 'passed', command: 'pnpm test', durationMs: 900, output: 'ok' },
      },
    ],
    skipped: [],
    rounds: 1,
    stopReason: 'all-addressed',
    tests: { status: 'passed', command: 'pnpm test', durationMs: 900, output: 'ok' },
    durationMs: 1200,
    ...overrides,
  }
}

/** Pair with a write-enabled bridge so dispatch has credentials. */
async function pair(caps: Record<string, unknown> = { fix: true }): Promise<void> {
  fetchMock.mockResolvedValueOnce(jsonResponse(healthBody(caps)))
  await connectBridge(TOKEN, 7321)
}

beforeEach(() => {
  localStorage.clear()
  _resetBridgeForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
})

describe('runBridgeFix', () => {
  it('posts the findings to /v1/fix with the pairing token, and parses the result', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse(fixResponseBody()))

    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.changes).toHaveLength(1)
    expect(outcome.response.changes[0]!.intent).toBe('escaped the name before interpolating it')
    expect(outcome.response.branch).toBe('review123/fix/abc123456789')

    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('http://127.0.0.1:7321/v1/fix')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(init.credentials).toBe('omit')
  })

  it('sends NO command, cwd or environment — only findings and a sha', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse(fixResponseBody()))
    await runBridgeFix('claude', PR_HEAD, [fixFinding()])

    const sent = JSON.parse(fetchMock.mock.calls[1]![1].body)
    expect(Object.keys(sent).sort()).toEqual(['cli', 'findings', 'headSha'])
    expect(Object.keys(sent.findings[0]).sort()).toEqual([
      'body', 'id', 'line', 'path', 'severity', 'suggestedFix',
    ])
  })

  it('refuses to dispatch with no bridge paired, instead of throwing', async () => {
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome).toEqual({ ok: false, failure: { kind: 'not-paired', detail: '' } })
    // Nothing was requested at all.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caps the batch on this side too, rather than letting the bridge silently trim', async () => {
    await pair()
    const many = Array.from({ length: MAX_FIX_FINDINGS + 1 }, (_, i) => fixFinding({ id: `f${i}` }))
    const outcome = await runBridgeFix('claude', PR_HEAD, many)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('bad-request')
    expect(fetchMock).toHaveBeenCalledTimes(1) // the health probe only
  })

  it('maps a 403 write-disabled onto its own actionable sentence', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: 'write-disabled', message: 'This bridge is read-only.' }, 403),
    )
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('write-disabled')
    expect(describeFixFailure(outcome.failure)).toContain('--allow-write')
  })

  it.each([
    ['head-unknown', 409, 'head-unknown'],
    ['worktree-failed', 500, 'worktree-failed'],
    ['cli-unavailable', 503, 'cli-unavailable'],
    ['timeout', 504, 'timeout'],
    ['bad-request', 400, 'bad-request'],
  ])('maps %s onto its own named failure', async (code, status, expected) => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: code, message: 'because' }, status))
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe(expected)
  })

  it('tells an OLD bridge’s 404 apart from a refusal', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not-found', message: 'no route' }, 404))
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('route-missing')
    expect(describeFixFailure(outcome.failure)).toMatch(/too old/i)
  })

  it('reports a bridge that stopped answering mid-run, and says nothing was left behind', async () => {
    await pair()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('unreachable')
    expect(describeFixFailure(outcome.failure)).toMatch(/nothing was left behind/i)
  })

  it('reports a malformed answer rather than rendering a half-parsed one', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, changes: 'not an array' }))
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('malformed')
  })

  it('drops an unusable change but keeps the good ones — a commit with no sha is not a result', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        fixResponseBody({
          changes: [
            { findingId: 'broken', commit: 'not-a-sha', intent: 'x', files: [], diff: '', rounds: 1 },
            {
              findingId: 'good',
              commit: COMMIT_B,
              subject: 's',
              intent: 'did it',
              files: ['src/b.ts'],
              diff: 'd',
              truncated: false,
              rounds: 1,
              stopReason: 'all-addressed',
              tests: null,
            },
          ],
        }),
      ),
    )
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.changes.map((c) => c.findingId)).toEqual(['good'])
  })

  it('reads an unknown test status as UNRUNNABLE, never as passed', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(fixResponseBody({ tests: { status: 'probably-fine', command: 'x', durationMs: 1, output: '' } })),
    )
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok && outcome.response.tests?.status).toBe('unrunnable')
  })

  it('reads an unknown skip reason as agent-failed, never as a judgment the agent did not make', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(fixResponseBody({ skipped: [{ findingId: 'f2', reason: 'vibes', detail: 'hm' }] })),
    )
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok && outcome.response.skipped[0]!.reason).toBe('agent-failed')
  })

  it('keeps the diff’s newlines — it is a patch, not a label', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse(fixResponseBody()))
    const outcome = await runBridgeFix('claude', PR_HEAD, [fixFinding()])
    expect(outcome.ok && outcome.response.changes[0]!.diff).toContain('\n')
  })
})

// ---------------------------------------------------------------------------
// Copy — every state says something a person can act on
// ---------------------------------------------------------------------------

describe('describeFixFailure', () => {
  it.each<FixFailureKind>([
    'not-paired', 'unreachable', 'unauthorized', 'write-disabled', 'route-missing',
    'cli-unavailable', 'head-unknown', 'worktree-failed', 'timeout', 'cancelled',
    'bad-request', 'malformed', 'http',
  ])('has a sentence for %s', (kind) => {
    expect(describeFixFailure({ kind, detail: '' }).length).toBeGreaterThan(20)
  })

  it('prefers the bridge’s OWN sentence when it sent one', () => {
    expect(describeFixFailure({ kind: 'head-unknown', detail: 'Fetch the branch first.' })).toBe(
      'Fetch the branch first.',
    )
  })
})

describe('describeFixStop', () => {
  it('says the round cap returned a RED commit, rather than implying success', () => {
    const sentence = describeFixStop('round-cap', 3)
    expect(sentence).toMatch(/still failing/i)
    expect(sentence).toMatch(/red/i)
  })

  it('names oscillation as oscillation', () => {
    expect(describeFixStop('repeat-diff', 3)).toMatch(/oscillating/i)
  })

  it('distinguishes a one-round finish from a repaired one', () => {
    expect(describeFixStop('all-addressed', 1)).toMatch(/one round/i)
    expect(describeFixStop('all-addressed', 2)).toMatch(/repaired its own change/i)
  })
})

describe('describeFixTests / fixTestLabel', () => {
  it('never calls an unrun suite green', () => {
    expect(describeFixTests(null)).toMatch(/No tests were run/i)
    expect(fixTestLabel(null)).toBe('no tests')
    expect(describeFixTests({ status: 'skipped', command: '', durationMs: 0, output: '', detail: 'the bridge was started with --no-tests' }))
      .toMatch(/--no-tests/)
  })

  it('shouts about a failing suite', () => {
    expect(describeFixTests({ status: 'failed', command: 'pnpm test', durationMs: 5, output: '' })).toContain('FAILED')
    expect(fixTestLabel({ status: 'failed', command: 'pnpm test', durationMs: 5, output: '' })).toBe('tests failed')
  })
})

describe('describeFixSkip / fixSkipLabel', () => {
  it('treats a refusal as the agent disagreeing, not as a failure', () => {
    expect(fixSkipLabel('refused')).toBe('agent disagreed')
    expect(describeFixSkip({ findingId: 'f', reason: 'refused', detail: 'that would remove the auth check' }))
      .toBe('that would remove the auth check')
  })

  it('falls back to its own sentence when the bridge sent no detail', () => {
    expect(describeFixSkip({ findingId: 'f', reason: 'no-change', detail: '' })).toMatch(/changed nothing/i)
  })
})

describe('cherryPickCommand', () => {
  it('builds the ONE command that moves an approved fix into the user’s own branch', () => {
    const change = (commit: string) => ({
      findingId: 'f', commit, subject: '', intent: '', files: [], diff: '',
      truncated: false, rounds: 1, stopReason: 'all-addressed' as const, tests: null,
    })
    expect(cherryPickCommand([change(COMMIT_A), change(COMMIT_B)])).toBe(
      `git cherry-pick ${COMMIT_A.slice(0, 12)} ${COMMIT_B.slice(0, 12)}`,
    )
    expect(cherryPickCommand([])).toBe('')
  })
})
