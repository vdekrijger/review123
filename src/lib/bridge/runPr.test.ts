/**
 * runPr.test.ts — the browser's half of "run this pull request".
 *
 * Four rules and their plumbing:
 *   1. WHEN the action may be offered, and that every refusal names a reason
 *      rather than returning a bare false (#242's discipline).
 *   2. WHOSE code is about to run, and that an unprovable answer is treated
 *      exactly like a fork rather than waved through.
 *   3. WHERE the preview panel points, and that the deploy path never becomes
 *      unreachable.
 *   4. That the transport sends the two explicit consents and nothing else,
 *      and turns every bridge refusal into its own named failure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _resetStackForTest,
  checkoutPr,
  currentCheckoutReadiness,
  decideCheckout,
  decideCheckoutTrust,
  decidePreviewSource,
  describeCheckout,
  describeCheckoutTrust,
  describePreviewSource,
  describeStackFailure,
  refreshStack,
  restoreCheckout,
  short,
  stackState,
  trustNeedsConfirmation,
  type CheckoutReason,
  type CheckoutSnapshot,
  type CheckoutTrust,
  type StackFailureKind,
} from './runPr.svelte'
import { _resetBridgeForTest, connectBridge } from './bridge.svelte'
import { BRIDGE_STORAGE_KEY } from './storage'
import type { BridgeStackApp, BridgeStackState } from './protocol'

const PR_HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_HEAD = 'def4567890abcdef1234567890abcdef12345678'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function healthBody(caps: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    protocol: 1,
    root: 'repo',
    capabilities: { inference: ['claude'], infer: true, files: true, search: true, ...caps },
    git: { head: OTHER_HEAD, branch: 'main', dirty: false },
    version: '0.1.0',
  }
}

const REACHABLE_APP: BridgeStackApp = {
  url: 'http://localhost:8010',
  source: 'posthog',
  reachable: true,
  detail: 'PostHog checkout.',
}

const DOWN_APP: BridgeStackApp = { ...REACHABLE_APP, reachable: false }

const UNKNOWN_APP: BridgeStackApp = {
  url: null,
  source: 'unknown',
  reachable: false,
  detail: 'The "dev" script names no port.',
}

function stackBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    git: { head: OTHER_HEAD, branch: 'main', dirty: false },
    dirtyPaths: [],
    dirtyCount: 0,
    prior: null,
    app: REACHABLE_APP,
    checkoutEnabled: true,
    ...overrides,
  }
}

function stack(overrides: Partial<BridgeStackState> = {}): BridgeStackState {
  return {
    git: { head: OTHER_HEAD, branch: 'main', dirty: false },
    dirtyPaths: [],
    dirtyCount: 0,
    prior: null,
    app: REACHABLE_APP,
    checkoutEnabled: true,
    ...overrides,
  }
}

function snapshot(overrides: Partial<CheckoutSnapshot> = {}): CheckoutSnapshot {
  return { connected: true, checkoutEnabled: true, routeAvailable: true, stack: stack(), ...overrides }
}

/** Pair with a bridge whose capabilities the test chooses. */
async function pair(caps: Record<string, unknown> = { fix: false, checkout: true }): Promise<void> {
  fetchMock.mockResolvedValueOnce(jsonResponse(healthBody(caps)))
  await connectBridge(TOKEN, 7321)
}

beforeEach(() => {
  localStorage.clear()
  _resetBridgeForTest()
  _resetStackForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
})

// ---------------------------------------------------------------------------
// 1. Readiness
// ---------------------------------------------------------------------------

describe('decideCheckout', () => {
  it('is ready on a connected, checkout-enabled bridge with a clean tree elsewhere', () => {
    const readiness = decideCheckout(snapshot(), PR_HEAD)
    expect(readiness).toMatchObject({ ready: true, reason: 'ready', branch: 'main' })
  })

  it('reports no-bridge when nothing is paired', () => {
    expect(decideCheckout(snapshot({ connected: false }), PR_HEAD)).toMatchObject({
      ready: false,
      reason: 'no-bridge',
    })
  })

  it('reports route-missing for a bridge too old to answer /v1/stack', () => {
    expect(decideCheckout(snapshot({ routeAvailable: false, stack: null }), PR_HEAD)).toMatchObject({
      ready: false,
      reason: 'route-missing',
    })
  })

  // THE HEADLINE GATE. Nothing about the browser may turn this on.
  it('reports checkout-disabled when the bridge lacks --allow-checkout', () => {
    expect(decideCheckout(snapshot({ checkoutEnabled: false }), PR_HEAD)).toMatchObject({
      ready: false,
      reason: 'checkout-disabled',
    })
  })

  it('reports no-repo-state when the bridge serves something that is not a repo', () => {
    expect(decideCheckout(snapshot({ stack: stack({ git: null }) }), PR_HEAD)).toMatchObject({
      ready: false,
      reason: 'no-repo-state',
    })
  })

  it('reports tree-dirty WITH the paths, so the stash prompt can name them', () => {
    const readiness = decideCheckout(
      snapshot({
        stack: stack({
          git: { head: OTHER_HEAD, branch: 'main', dirty: true },
          dirtyPaths: ['src/a.ts', 'notes.txt'],
          dirtyCount: 2,
        }),
      }),
      PR_HEAD,
    )
    expect(readiness).toMatchObject({ ready: false, reason: 'tree-dirty', dirtyCount: 2 })
    expect(readiness.dirtyPaths).toEqual(['src/a.ts', 'notes.txt'])
  })

  it('reports already-on-pr when the checkout is on this PR head', () => {
    expect(
      decideCheckout(
        snapshot({ stack: stack({ git: { head: PR_HEAD, branch: null, dirty: false } }) }),
        PR_HEAD,
      ),
    ).toMatchObject({ ready: false, reason: 'already-on-pr' })
  })

  // Someone on the PR with edits in progress is in a fine state, not an error
  // state — saying "your tree is dirty" there would read as a complaint.
  it('prefers already-on-pr over tree-dirty when both are true', () => {
    expect(
      decideCheckout(
        snapshot({ stack: stack({ git: { head: PR_HEAD, branch: null, dirty: true } }) }),
        PR_HEAD,
      ),
    ).toMatchObject({ reason: 'already-on-pr' })
  })

  it('compares shas case-insensitively but never by prefix', () => {
    expect(
      decideCheckout(
        snapshot({ stack: stack({ git: { head: PR_HEAD.toUpperCase(), branch: null, dirty: false } }) }),
        PR_HEAD,
      ),
    ).toMatchObject({ reason: 'already-on-pr' })
    // A prefix match would accept the wrong commit.
    expect(
      decideCheckout(
        snapshot({
          stack: stack({ git: { head: `${PR_HEAD.slice(0, 39)}0`, branch: 'x', dirty: false } }),
        }),
        PR_HEAD,
      ),
    ).toMatchObject({ reason: 'ready' })
  })

  it('carries the recorded prior state through, so Restore can be offered', () => {
    const prior = {
      branch: 'main',
      head: OTHER_HEAD,
      recordedAt: '2026-01-01T00:00:00.000Z',
      checkedOutRef: 'refs/pull/1/head',
      checkedOutSha: PR_HEAD,
      stashRef: null,
    }
    expect(
      decideCheckout(
        snapshot({ stack: stack({ git: { head: PR_HEAD, branch: null, dirty: false }, prior }) }),
        PR_HEAD,
      ).prior,
    ).toEqual(prior)
  })
})

describe('describeCheckout', () => {
  it('gives every reason a distinct, non-empty sentence', () => {
    const reasons: CheckoutReason[] = [
      'ready', 'no-bridge', 'checkout-disabled', 'route-missing',
      'no-repo-state', 'tree-dirty', 'already-on-pr',
    ]
    const seen = new Set<string>()
    for (const reason of reasons) {
      const sentence = describeCheckout({
        ready: false, reason, branch: 'main', bridgeHead: OTHER_HEAD,
        dirtyPaths: [], dirtyCount: 1, prior: null,
      })
      expect(sentence.length).toBeGreaterThan(20)
      seen.add(sentence)
    }
    expect(seen.size).toBe(reasons.length)
  })

  // Someone who already typed --allow-write will otherwise assume they are
  // done, and stare at a disabled button.
  it('names the RIGHT flag, and rules out the adjacent one', () => {
    const sentence = describeCheckout({
      ready: false, reason: 'checkout-disabled', branch: null, bridgeHead: null,
      dirtyPaths: [], dirtyCount: 0, prior: null,
    })
    expect(sentence).toContain('--allow-checkout')
    expect(sentence).toContain('--allow-write does not enable this')
  })

  it('counts the dirty files in the dirty sentence, with singular/plural', () => {
    const one = describeCheckout({
      ready: false, reason: 'tree-dirty', branch: 'main', bridgeHead: null,
      dirtyPaths: ['a'], dirtyCount: 1, prior: null,
    })
    expect(one).toContain('1 uncommitted change.')
    const many = describeCheckout({
      ready: false, reason: 'tree-dirty', branch: 'main', bridgeHead: null,
      dirtyPaths: ['a', 'b'], dirtyCount: 2, prior: null,
    })
    expect(many).toContain('2 uncommitted changes')
  })

  it('promises nothing is touched in the dirty sentence', () => {
    expect(
      describeCheckout({
        ready: false, reason: 'tree-dirty', branch: 'main', bridgeHead: null,
        dirtyPaths: ['a'], dirtyCount: 1, prior: null,
      }),
    ).toMatch(/nothing will be touched/i)
  })
})

describe('short', () => {
  it('abbreviates a sha and says "unknown" rather than printing null', () => {
    expect(short(PR_HEAD)).toBe('abc1234')
    expect(short(null)).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// 2. Trust
// ---------------------------------------------------------------------------

describe('decideCheckoutTrust', () => {
  it('calls a branch in the repository itself same-repo', () => {
    expect(decideCheckoutTrust({ repos: { head: 'octo/hello', base: 'octo/hello' } })).toBe('same-repo')
    expect(decideCheckoutTrust({ repos: { head: 'Octo/Hello', base: 'octo/hello' } })).toBe('same-repo')
  })

  it('calls a different head repository a fork', () => {
    expect(decideCheckoutTrust({ repos: { head: 'stranger/hello', base: 'octo/hello' } })).toBe('fork')
  })

  // THE DEFAULT, and the one that applies everywhere in this build today.
  it('is UNVERIFIED when the provider gave no repository identities', () => {
    expect(decideCheckoutTrust({})).toBe('unverified')
    expect(decideCheckoutTrust({ repos: { head: null, base: 'octo/hello' } })).toBe('unverified')
    expect(decideCheckoutTrust({ repos: { head: 'octo/hello', base: null } })).toBe('unverified')
    expect(decideCheckoutTrust({ repos: { head: '', base: '' } })).toBe('unverified')
  })

  it('requires a confirmation for anything that is not PROVABLY same-repo', () => {
    expect(trustNeedsConfirmation('same-repo')).toBe(false)
    expect(trustNeedsConfirmation('fork')).toBe(true)
    // An unknown provenance must never render as the reassuring answer.
    expect(trustNeedsConfirmation('unverified')).toBe(true)
  })
})

describe('describeCheckoutTrust', () => {
  it('names what running the code actually means, for both risky levels', () => {
    for (const trust of ['fork', 'unverified'] as CheckoutTrust[]) {
      const sentence = describeCheckoutTrust(trust)
      expect(sentence).toMatch(/runs its code on your machine/)
      expect(sentence).toMatch(/database/)
      expect(sentence).toMatch(/trust its author/)
    }
  })

  it('says a fork IS a fork, and says an unverified one is merely unprovable', () => {
    expect(describeCheckoutTrust('fork')).toMatch(/comes from a FORK/)
    expect(describeCheckoutTrust('unverified')).toMatch(/cannot confirm/)
    expect(describeCheckoutTrust('unverified')).toMatch(/treated as if it does/)
  })

  it('is calm and short for a same-repo branch', () => {
    expect(describeCheckoutTrust('same-repo')).not.toMatch(/FORK/)
  })
})

// ---------------------------------------------------------------------------
// 3. Preview source
// ---------------------------------------------------------------------------

describe('decidePreviewSource', () => {
  it('picks LOCAL when the PR is checked out and the dev server answers', () => {
    expect(
      decidePreviewSource({ onPrBranch: true, app: REACHABLE_APP, deployUrl: 'https://d.test' }),
    ).toEqual({ kind: 'local', reason: 'local-live', url: 'http://localhost:8010' })
  })

  // The deploy path is an addition's fallback, never deleted and never
  // unreachable.
  it('falls back to the DEPLOY preview when local is not live', () => {
    expect(
      decidePreviewSource({ onPrBranch: false, app: REACHABLE_APP, deployUrl: 'https://d.test' }),
    ).toEqual({ kind: 'deploy', reason: 'deploy-only', url: 'https://d.test' })
    expect(
      decidePreviewSource({ onPrBranch: true, app: DOWN_APP, deployUrl: 'https://d.test' }),
    ).toMatchObject({ kind: 'deploy' })
  })

  it('falls back to deploy with no bridge at all', () => {
    expect(
      decidePreviewSource({ onPrBranch: false, app: null, deployUrl: 'https://d.test' }),
    ).toMatchObject({ kind: 'deploy' })
  })

  // Two DIFFERENT things to do about it, so two different reasons.
  it('distinguishes "not checked out" from "checked out but not running"', () => {
    expect(
      decidePreviewSource({ onPrBranch: false, app: REACHABLE_APP, deployUrl: null }),
    ).toEqual({ kind: 'none', reason: 'local-not-checked-out', url: null })
    expect(
      decidePreviewSource({ onPrBranch: true, app: DOWN_APP, deployUrl: null }),
    ).toEqual({ kind: 'none', reason: 'local-not-running', url: null })
  })

  it('never claims local when the URL could not be detected', () => {
    expect(
      decidePreviewSource({ onPrBranch: true, app: UNKNOWN_APP, deployUrl: null }),
    ).toMatchObject({ kind: 'none' })
  })

  it('treats an empty deploy URL as no deploy preview', () => {
    expect(
      decidePreviewSource({ onPrBranch: false, app: null, deployUrl: '' }),
    ).toMatchObject({ kind: 'none' })
  })
})

describe('describePreviewSource', () => {
  it('names the local URL when local is live', () => {
    const source = decidePreviewSource({ onPrBranch: true, app: REACHABLE_APP, deployUrl: null })
    expect(describePreviewSource(source, REACHABLE_APP)).toContain('http://localhost:8010')
  })

  it('tells the user to start their dev server, naming the port it tried', () => {
    const source = decidePreviewSource({ onPrBranch: true, app: DOWN_APP, deployUrl: null })
    const sentence = describePreviewSource(source, DOWN_APP)
    expect(sentence).toContain('http://localhost:8010')
    expect(sentence).toMatch(/start your dev server/i)
  })

  it('admits it does not know the port, rather than naming a guessed one', () => {
    const source = decidePreviewSource({ onPrBranch: true, app: UNKNOWN_APP, deployUrl: null })
    const sentence = describePreviewSource(source, UNKNOWN_APP)
    expect(sentence).toMatch(/could not tell where your dev server listens/)
    expect(sentence).not.toMatch(/5173|8010/)
  })
})

// ---------------------------------------------------------------------------
// 4. Transport
// ---------------------------------------------------------------------------

describe('refreshStack', () => {
  it('reads /v1/stack with the pairing token and stores the answer', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse(stackBody()))

    const state = await refreshStack()
    expect(state?.checkoutEnabled).toBe(true)
    expect(stackState.app?.url).toBe('http://localhost:8010')

    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('http://127.0.0.1:7321/v1/stack')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(init.credentials).toBe('omit')
  })

  it('makes NO request at all when no bridge is connected', async () => {
    expect(await refreshStack()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // A bridge that is not running is the normal case, not news.
  it('is silent on failure: no error surfaced, state simply left empty', async () => {
    await pair()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await refreshStack()).toBeNull()
    expect(stackState.error).toBeNull()
    expect(stackState.state).toBeNull()
  })

  it('leaves state null for an older bridge that 404s the route', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not-found', message: 'no' }, 404))
    expect(await refreshStack()).toBeNull()
    // …and the readiness rule then says exactly that.
    expect(currentCheckoutReadiness(PR_HEAD).reason).toBe('route-missing')
  })

  it('never reports reachable for an app block with no URL', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(stackBody({ app: { url: null, source: 'unknown', reachable: true, detail: 'x' } })),
    )
    await refreshStack()
    expect(stackState.app).toMatchObject({ url: null, reachable: false })
  })
})

describe('checkoutPr', () => {
  it('sends the ref and BOTH explicit consents, and nothing else', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: PR_HEAD, branch: null, dirty: false },
        prior: { branch: 'main', head: OTHER_HEAD, recordedAt: '', checkedOutRef: 'refs/pull/1/head', checkedOutSha: PR_HEAD, stashRef: null },
        stash: null,
        app: REACHABLE_APP,
      }),
    )

    const outcome = await checkoutPr({ ref: 'refs/pull/1/head', stashDirty: true })
    expect(outcome.ok).toBe(true)

    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('http://127.0.0.1:7321/v1/checkout')
    const sent = JSON.parse(init.body)
    expect(Object.keys(sent).sort()).toEqual(['acknowledgeUntrusted', 'ref', 'stashDirty'])
    expect(sent.acknowledgeUntrusted).toBe(true)
    expect(sent.ref).toBe('refs/pull/1/head')
  })

  it('omits stashDirty entirely when it was not asked for', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, git: { head: PR_HEAD, branch: null, dirty: false }, prior: null, stash: null, app: REACHABLE_APP }),
    )
    await checkoutPr({ ref: 'refs/pull/1/head' })
    const sent = JSON.parse(fetchMock.mock.calls[1]![1].body)
    expect(sent).not.toHaveProperty('stashDirty')
  })

  it('sends NO command, cwd or environment — a ref and two booleans', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, git: { head: PR_HEAD, branch: null, dirty: false }, prior: null, stash: null, app: REACHABLE_APP }),
    )
    await checkoutPr({ ref: 'refs/pull/1/head' })
    const sent = JSON.parse(fetchMock.mock.calls[1]![1].body)
    for (const forbidden of ['command', 'cwd', 'env', 'argv', 'shell', 'root']) {
      expect(sent).not.toHaveProperty(forbidden)
    }
  })

  it('updates the store from the response, so the UI flips to on-PR', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse(stackBody()))
    await refreshStack()
    expect(stackState.onPrBranch(PR_HEAD)).toBe(false)

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: PR_HEAD, branch: null, dirty: false },
        prior: { branch: 'main', head: OTHER_HEAD, recordedAt: '', checkedOutRef: 'refs/pull/1/head', checkedOutSha: PR_HEAD, stashRef: null },
        stash: { action: 'created', ref: 'c'.repeat(40), dropCommand: 'git stash drop cccccccccccc' },
        app: REACHABLE_APP,
      }),
    )
    await checkoutPr({ ref: 'refs/pull/1/head', stashDirty: true })

    expect(stackState.onPrBranch(PR_HEAD)).toBe(true)
    expect(stackState.prior?.branch).toBe('main')
    expect(stackState.stash).toMatchObject({ action: 'created' })
  })

  it('refuses with no bridge paired, instead of throwing, and requests nothing', async () => {
    const outcome = await checkoutPr({ ref: 'refs/pull/1/head' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('not-paired')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the dirty paths from a tree-dirty refusal, so the prompt can name them', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse(stackBody()))
    await refreshStack()

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          error: 'tree-dirty',
          message: 'Your working tree has 2 uncommitted changes.',
          dirtyPaths: ['src/a.ts', 'notes.txt'],
          dirtyCount: 2,
        },
        409,
      ),
    )
    const outcome = await checkoutPr({ ref: 'refs/pull/1/head' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('tree-dirty')
    expect(outcome.failure.dirtyPaths).toEqual(['src/a.ts', 'notes.txt'])
    expect(stackState.state?.dirtyPaths).toEqual(['src/a.ts', 'notes.txt'])
  })

  it('maps each bridge refusal onto its own named failure', async () => {
    const cases: [string, number, StackFailureKind][] = [
      ['checkout-disabled', 403, 'checkout-disabled'],
      ['untrusted-unacknowledged', 403, 'untrusted-unacknowledged'],
      ['ref-unknown', 404, 'ref-unknown'],
      ['checkout-failed', 500, 'checkout-failed'],
      ['no-prior-state', 404, 'no-prior-state'],
      ['prior-gone', 409, 'prior-gone'],
      ['moved-since', 409, 'moved-since'],
    ]
    for (const [code, status, kind] of cases) {
      _resetBridgeForTest()
      _resetStackForTest()
      fetchMock.mockReset()
      await pair()
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: code, message: 'because' }, status))
      const outcome = await checkoutPr({ ref: 'refs/pull/1/head' })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.failure.kind).toBe(kind)
      expect(outcome.failure.detail).toBe('because')
    }
  })

  it('reads a bare 404 as route-missing, so an older bridge is told to update', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404))
    const outcome = await checkoutPr({ ref: 'refs/pull/1/head' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('route-missing')
  })

  it('tells a dead bridge apart from a cancellation', async () => {
    await pair()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const dead = await checkoutPr({ ref: 'refs/pull/1/head' })
    expect(dead.ok).toBe(false)
    if (dead.ok) return
    expect(dead.failure.kind).toBe('unreachable')
  })

  it('surfaces the failure sentence on the store, because the user asked for this', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: 'checkout-disabled', message: 'read-only' }, 403),
    )
    await checkoutPr({ ref: 'refs/pull/1/head' })
    expect(stackState.error).toContain('read-only')
  })

  it('rejects a malformed success body rather than trusting it', async () => {
    await pair()
    // No `git` — an action that succeeded must say where the tree now is.
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, prior: null, stash: null }))
    const outcome = await checkoutPr({ ref: 'refs/pull/1/head' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('malformed')
  })
})

describe('restoreCheckout', () => {
  it('sends only the consents that were given', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, git: { head: OTHER_HEAD, branch: 'main', dirty: false }, prior: null, stash: null, app: REACHABLE_APP }),
    )
    await restoreCheckout({ restoreStash: true })
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('http://127.0.0.1:7321/v1/restore')
    expect(JSON.parse(init.body)).toEqual({ restoreStash: true })
  })

  it('sends an empty body for a plain restore', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, git: { head: OTHER_HEAD, branch: 'main', dirty: false }, prior: null, stash: null, app: REACHABLE_APP }),
    )
    await restoreCheckout()
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({})
  })

  it('clears the prior state, so no second Restore is offered', async () => {
    await pair()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: OTHER_HEAD, branch: 'main', dirty: false },
        prior: null,
        stash: { action: 'applied', ref: 'c'.repeat(40), dropCommand: 'git stash drop cccccccccccc' },
        app: REACHABLE_APP,
      }),
    )
    await restoreCheckout({ restoreStash: true })
    expect(stackState.prior).toBeNull()
    expect(stackState.onPrBranch(PR_HEAD)).toBe(false)
    // The entry survives, and the user is told how to remove it themselves.
    expect(stackState.stash).toMatchObject({ action: 'applied', dropCommand: expect.stringContaining('git stash drop') })
  })
})

describe('describeStackFailure', () => {
  it('gives every failure kind a distinct, non-empty sentence', () => {
    const kinds: StackFailureKind[] = [
      'not-paired', 'unreachable', 'unauthorized', 'checkout-disabled', 'route-missing',
      'tree-dirty', 'ref-unknown', 'checkout-failed', 'no-prior-state', 'prior-gone',
      'moved-since', 'untrusted-unacknowledged', 'timeout', 'cancelled', 'bad-request',
      'malformed', 'http',
    ]
    const seen = new Set<string>()
    for (const kind of kinds) {
      const sentence = describeStackFailure({ kind, detail: '', dirtyPaths: [], dirtyCount: 0 })
      expect(sentence.length).toBeGreaterThan(10)
      seen.add(sentence)
    }
    expect(seen.size).toBe(kinds.length)
  })

  it('prefers the bridge’s OWN sentence over a generic one', () => {
    expect(
      describeStackFailure({ kind: 'checkout-failed', detail: 'git said no', dirtyPaths: [], dirtyCount: 0 }),
    ).toBe('git said no')
  })

  it('reassures that nothing changed on the failures where nothing did', () => {
    for (const kind of ['unreachable', 'timeout', 'cancelled'] as StackFailureKind[]) {
      expect(
        describeStackFailure({ kind, detail: '', dirtyPaths: [], dirtyCount: 0 }),
      ).toMatch(/unchanged|as it was/i)
    }
  })
})
