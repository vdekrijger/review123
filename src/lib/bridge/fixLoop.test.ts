/**
 * fixLoop.test.ts — the browser's half of the agent fix loop.
 *
 * Two things are worth testing here and they are both rules, not plumbing:
 * WHICH findings may be sent (the #228 routing rule + the #226 tier), and
 * whether every refusal names its reason instead of returning a bare false.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  FIX_CLI_PREF_KEY,
  FIX_LOOP_NOT_REVIEWED,
  cherryPickCommand,
  decideFixLoopStop,
  decideFixReadiness,
  describeFixEligibility,
  describeFixFailure,
  describeFixLoopStop,
  describeFixReadiness,
  describeFixSkip,
  describeFixStop,
  describeFixTests,
  describeRetryableSkips,
  describeUnsoftenedChanges,
  fixCliChoices,
  fixEligibility,
  fixSkipLabel,
  fixTestLabel,
  isConcreteFix,
  preferredFixCli,
  readFixCliPref,
  retryableSkips,
  runBridgeFix,
  skipIsRetryable,
  unsoftenedChanges,
  writeFixCliPref,
  type FixEligibility,
  type FixFailureKind,
  type FixLoopProgress,
  type FixLoopRound,
  type FixLoopStopReason,
  type FixReadinessReason,
  type FixSnapshot,
} from './fixLoop'
import { _resetBridgeForTest, connectBridge } from './bridge.svelte'
import { BRIDGE_STORAGE_KEY } from './storage'
import {
  MAX_FIX_FINDINGS,
  PROTOCOL_VERSION,
  type BridgeFixChange,
  type BridgeFixFinding,
  type BridgeFixSkip,
} from './protocol'

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

  // -------------------------------------------------------------------------
  // CONTAINMENT, NOT EQUALITY — the rule this file exists to hold.
  //
  // `git worktree add … <sha>` reads the OBJECT STORE. Nothing about it needs
  // the working tree to be sitting on that commit, so nothing about readiness
  // does either. Before the containment probe, the equality test meant a user
  // looking at twenty of their own pull requests could be offered the fix loop
  // on at most one row — the feature shipped and was unreachable.
  // -------------------------------------------------------------------------

  it('IS READY on a checkout sitting somewhere else entirely, when the repo HAS the commit', () => {
    const readiness = decideFixReadiness(
      snapshot({
        // Another branch, another commit, and a dirty tree for good measure.
        git: { head: OTHER_HEAD, branch: 'main', dirty: true },
        headPresent: true,
      }),
      PR_HEAD,
    )
    expect(readiness).toMatchObject({ ready: true, reason: 'ready', cli: 'claude' })
  })

  it('refuses SPECIFICALLY when the repo has never seen the commit, even on the right branch', () => {
    const readiness = decideFixReadiness(
      // Nothing is wrong with this checkout: clean, on its own branch. The
      // commit simply is not in the object store, so there is nothing to build
      // a worktree from — a different refusal from "you are somewhere else".
      snapshot({ git: { head: OTHER_HEAD, branch: 'main', dirty: false }, headPresent: false }),
      PR_HEAD,
    )
    expect(readiness).toMatchObject({ ready: false, reason: 'head-unfetched' })
    const sentence = describeFixReadiness(readiness, PR_HEAD)
    // It names the ONE command that fixes it, and the commit it is about.
    expect(sentence).toContain('fetch')
    expect(sentence).toContain(PR_HEAD.slice(0, 7))
    // And it is NOT the old sentence, which was about where the checkout sits.
    expect(sentence).not.toContain('too old')
  })

  it('refuses head-unfetched even when the checkout IS on the commit — the probe wins', () => {
    // Belt and braces: a bridge that answered "absent" for the sha its own HEAD
    // reports is self-contradictory, and the conservative read of a
    // contradiction is the refusal. Equality must not sneak back in as an
    // override.
    const readiness = decideFixReadiness(snapshot({ headPresent: false }), PR_HEAD)
    expect(readiness.reason).toBe('head-unfetched')
  })

  it('falls back to the OLD equality test when nobody could answer', () => {
    // An older bridge has no `/v1/commits`, so `headPresent` is null. Behaviour
    // must be byte-for-byte what it was: ready on the matching head…
    expect(decideFixReadiness(snapshot({ headPresent: null }), PR_HEAD).reason).toBe('ready')
    // …and head-mismatch anywhere else.
    expect(
      decideFixReadiness(
        snapshot({ git: { head: OTHER_HEAD, branch: 'main', dirty: false }, headPresent: null }),
        PR_HEAD,
      ).reason,
    ).toBe('head-mismatch')
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
    // head-mismatch is now the NARROW reason: it fires only where the bridge
    // cannot answer the containment question, so the fix it names is an update.
    expect(sentence).toContain('Update the bridge')
  })

  it.each<FixReadinessReason>([
    'ready', 'no-bridge', 'write-disabled', 'no-cli', 'no-repo-state', 'head-unfetched', 'head-mismatch',
  ])('has a sentence for %s', (reason) => {
    const readiness = { ready: reason === 'ready', reason, cli: 'claude' as const, branch: 'x', bridgeHead: PR_HEAD }
    expect(describeFixReadiness(readiness, PR_HEAD).length).toBeGreaterThan(20)
  })

  it('gives head-unfetched and head-mismatch DIFFERENT sentences', () => {
    const base = { ready: false, cli: null, branch: 'main', bridgeHead: OTHER_HEAD }
    const unfetched = describeFixReadiness({ ...base, reason: 'head-unfetched' }, PR_HEAD)
    const mismatch = describeFixReadiness({ ...base, reason: 'head-mismatch' }, PR_HEAD)
    expect(unfetched).not.toBe(mismatch)
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

// ---------------------------------------------------------------------------
// Which CLI runs the fix — a choice, not a hard-coded fact
// ---------------------------------------------------------------------------

describe('the CLI the user picks', () => {
  beforeEach(() => localStorage.clear())

  it('honours a stored choice over the built-in ranking', () => {
    expect(preferredFixCli(['claude', 'codex'], 'codex')).toBe('codex')
    expect(preferredFixCli(['claude', 'codex'], 'claude')).toBe('claude')
  })

  it('falls back to the ranking when the chosen CLI is not installed here', () => {
    // A stale preference from another machine must not disable the feature.
    expect(preferredFixCli(['claude'], 'codex')).toBe('claude')
    expect(preferredFixCli([], 'codex')).toBeNull()
  })

  it('changes nothing for a user who never chose — today’s behaviour is the default', () => {
    expect(preferredFixCli(['codex', 'claude'], null)).toBe('claude')
    expect(readFixCliPref()).toBeNull()
  })

  it('offers no choice where there is none to make', () => {
    expect(fixCliChoices(['claude'])).toEqual(['claude'])
    expect(fixCliChoices([])).toEqual([])
    // Two detected CLIs, in the ranking's order whatever order the bridge used.
    expect(fixCliChoices(['codex', 'claude'])).toEqual(['claude', 'codex'])
  })

  it('round-trips through localStorage and clears back to no preference', () => {
    writeFixCliPref('codex')
    expect(readFixCliPref()).toBe('codex')
    writeFixCliPref(null)
    expect(readFixCliPref()).toBeNull()
  })

  it('reads a corrupt or unknown entry as no preference rather than throwing', () => {
    localStorage.setItem(FIX_CLI_PREF_KEY, 'not json')
    expect(readFixCliPref()).toBeNull()
    localStorage.setItem(FIX_CLI_PREF_KEY, JSON.stringify({ cli: 'cursor' }))
    expect(readFixCliPref()).toBeNull()
  })

  it('is the CLI the readiness rule reports, so no label can name another', () => {
    const readiness = decideFixReadiness(
      snapshot({ clis: ['claude', 'codex'], preferredCli: 'codex' }),
      PR_HEAD,
    )
    expect(readiness).toMatchObject({ ready: true, cli: 'codex' })
    expect(describeFixReadiness(readiness, PR_HEAD)).toContain('codex')
  })
})

// ---------------------------------------------------------------------------
// Skips worth sending again
// ---------------------------------------------------------------------------

describe('retryable skips', () => {
  const skip = (reason: BridgeFixSkip['reason']): BridgeFixSkip => ({
    findingId: reason,
    reason,
    detail: '',
  })

  it('offers back only the skips that never got a real answer', () => {
    const skips = [
      skip('refused'),
      skip('no-change'),
      skip('forbidden-path'),
      skip('agent-failed'),
      skip('timeout'),
      skip('budget'),
    ]
    expect(retryableSkips(skips).map((s) => s.reason)).toEqual(['agent-failed', 'timeout', 'budget'])
  })

  // The whole point of a separate action: a refusal is an ANSWER, and sweeping
  // it into a retry button would quietly re-ask a question already answered.
  it('never treats a refusal as retryable', () => {
    expect(skipIsRetryable('refused')).toBe(false)
    expect(describeRetryableSkips(2)).toMatch(/not refusals/i)
    expect(describeRetryableSkips(1)).toMatch(/not a refusal/i)
  })
})

// ---------------------------------------------------------------------------
// The bounded loop
// ---------------------------------------------------------------------------

describe('decideFixLoopStop', () => {
  const round = (n: number, over: Partial<FixLoopRound> = {}): FixLoopRound => ({
    round: n,
    sent: ['f1'],
    commits: [COMMIT_A],
    stillOpen: ['f1'],
    verifyCalls: 2,
    ...over,
  })

  const progress = (over: Partial<FixLoopProgress> = {}): FixLoopProgress => ({
    rounds: [round(1)],
    elapsedMs: 1_000,
    interrupted: false,
    failed: false,
    ...over,
  })

  it('runs another round while something is still open and nothing is spent', () => {
    expect(decideFixLoopStop(progress())).toBeNull()
  })

  it('stops QUIET when a round leaves nothing open — and says it is a sample', () => {
    const p = progress({ rounds: [round(1, { stillOpen: [] })] })
    expect(decideFixLoopStop(p)).toBe('quiet')
    const sentence = describeFixLoopStop('quiet', 1, 0)
    expect(sentence).toMatch(/sample/i)
    expect(sentence).not.toMatch(/\bfixed\b|\bresolved\b|\bdone\b/i)
  })

  it('stops at the ROUND CAP and calls the cap a budget, not a judgment', () => {
    const p = progress({ rounds: [round(1), round(2, { stillOpen: ['f2'] }), round(3)] })
    expect(decideFixLoopStop(p)).toBe('round-cap')
    expect(describeFixLoopStop('round-cap', 3, 1)).toMatch(/budget this loop spends/i)
  })

  it('stops on NO-NEW-COMMIT when a round produced nothing', () => {
    const p = progress({ rounds: [round(1, { commits: [] })] })
    expect(decideFixLoopStop(p)).toBe('no-new-commit')
  })

  // The precedence that is easy to get backwards: a round where every finding
  // was SKIPPED has no commit to re-read, so nothing comes back still open.
  // Calling that "quiet" would report a reviewer going quiet about work that
  // never happened.
  it('calls a round with no commit NO-NEW-COMMIT, never quiet', () => {
    const p = progress({ rounds: [round(1, { commits: [], stillOpen: [] })] })
    expect(decideFixLoopStop(p)).toBe('no-new-commit')
  })

  it('stops on REPEAT-OUTCOME when a round leaves what the previous one left', () => {
    // Different commits each time — an agent rewriting the same file every turn
    // is still oscillating if the same complaints stand, so the signature is the
    // still-open set and never the shas.
    const p = progress({
      rounds: [
        round(1, { stillOpen: ['f1', 'f2'], commits: [COMMIT_A] }),
        round(2, { stillOpen: ['f2', 'f1'], commits: [COMMIT_B] }),
      ],
    })
    expect(decideFixLoopStop(p)).toBe('repeat-outcome')
  })

  it('stops when the re-read CALL BUDGET is spent', () => {
    const p = progress({ rounds: [round(1, { verifyCalls: 30 })] })
    expect(decideFixLoopStop(p, { maxRounds: 9, maxVerifyCalls: 24, maxWallMs: 1_000_000 })).toBe(
      'budget-spent',
    )
  })

  it('stops when the WALL CLOCK is spent', () => {
    const p = progress({ elapsedMs: 21 * 60_000 })
    expect(decideFixLoopStop(p, { maxRounds: 9, maxVerifyCalls: 500, maxWallMs: 20 * 60_000 })).toBe(
      'budget-spent',
    )
  })

  // The user's stop and a dead transport outrank every budget: neither is a
  // thing the loop gets to overrule with arithmetic.
  it('stops for the USER before any budget, and keeps what landed', () => {
    const p = progress({ interrupted: true, rounds: [round(1, { stillOpen: [] })] })
    expect(decideFixLoopStop(p)).toBe('stopped-by-user')
    expect(describeFixLoopStop('stopped-by-user', 2, 1)).toMatch(/stays on the scratch branch/i)
  })

  it('stops on a FAILED round before anything else', () => {
    expect(decideFixLoopStop(progress({ failed: true, interrupted: true }))).toBe('run-failed')
  })

  it('has no opinion before the first round finishes', () => {
    expect(decideFixLoopStop(progress({ rounds: [] }))).toBeNull()
  })

  it.each<FixLoopStopReason>([
    'quiet',
    'no-new-commit',
    'repeat-outcome',
    'round-cap',
    'budget-spent',
    'stopped-by-user',
    'run-failed',
  ])('has a sentence for %s that never claims a fix', (reason) => {
    const sentence = describeFixLoopStop(reason, 3, 2)
    expect(sentence.length).toBeGreaterThan(30)
    // No sentence here may CLAIM a fix. ("not a judgment that the rest cannot
    // be fixed" is the opposite of a claim, which is why the pattern is the
    // assertion and not the bare word.)
    expect(sentence).not.toMatch(/\b(is|are|were|been|now)\s+(fixed|resolved)\b|\ball clear\b/i)
  })
})

describe('the inner loop’s verdict survives the outer one', () => {
  const change = (stopReason: BridgeFixChange['stopReason'], id: string): BridgeFixChange => ({
    findingId: id,
    commit: COMMIT_A,
    subject: '',
    intent: '',
    files: [],
    diff: '',
    truncated: false,
    rounds: 3,
    stopReason,
    tests: null,
  })

  it('counts every commit a re-read may not soften, however many rounds ran', () => {
    const changes = [
      change('all-addressed', 'a'),
      change('round-cap', 'b'),
      change('no-progress', 'c'),
      change('repeat-diff', 'd'),
      change('budget-exhausted', 'e'),
    ]
    expect(unsoftenedChanges(changes).map((c) => c.findingId)).toEqual(['b', 'c', 'd'])
  })

  it('says so plainly, and says more rounds do not change it', () => {
    expect(describeUnsoftenedChanges(0)).toBeNull()
    expect(describeUnsoftenedChanges(2)).toMatch(/more rounds of re-reading do not change that/i)
  })

  it('never lets the loop imply a person has read anything', () => {
    expect(FIX_LOOP_NOT_REVIEWED).toMatch(/no person has read/i)
    expect(FIX_LOOP_NOT_REVIEWED).toMatch(/does not replace it/i)
  })
})
