/**
 * AgentFixPanel.wayout.test.ts — the refusal that offers a way out.
 *
 * `head-mismatch` is a CORRECT refusal: fixing a pull request's findings
 * against another commit's code produces a diff nobody asked for. But it used
 * to end in an instruction — "check it out" — with nothing to click, while the
 * capability to do exactly that was already granted and already wired into the
 * top bar of the same screen.
 *
 * So the refusal offers it. What these tests pin is that offering it does not
 * cost any of the guarantees the checkout contract was built on:
 *
 *   1. It appears ONLY where `--allow-checkout` is granted. That flag is a
 *      separate grant from `--allow-write`; neither implies the other.
 *   2. The working tree is never moved silently: a fork (or a provenance this
 *      build cannot prove) is confirmed first, and uncommitted work is
 *      confirmed separately, with the files NAMED.
 *   3. Every typed bridge failure keeps its OWN sentence. `tree-dirty` and
 *      `ref-unknown` are different problems and are never collapsed.
 *   4. A pull request that advanced AGAIN mid-flight ends somewhere honest.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import AgentFixPanel, { type FixCandidateEntry } from './AgentFixPanel.svelte'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _resetStackForTest, notePrCheckoutContext, stackState } from '../lib/bridge/runPr.svelte'
import { tick } from 'svelte'
import { BRIDGE_STORAGE_KEY } from '../lib/bridge/storage'
import { PROTOCOL_VERSION } from '../lib/bridge/protocol'
import { BRIDGE_START_COMMAND } from '../lib/bridge/install'
import type { PrRepoRelation } from '../lib/github/types'

/** The commit the review ran against. */
const PR_HEAD = 'abc1234567890abcdef1234567890abcdef12345'
/** Where the user's checkout actually is. */
const TREE_HEAD = 'def4567890abcdef1234567890abcdef12345678'
/** Where the pull request moved to while the user was reading it. */
const MOVED_HEAD = '9999999999999999999999999999999999999999'
const TOKEN = 'pairing-token-0000000000000000000000000000'
const PR_REF = 'refs/pull/42/head'

const fetchMock = vi.fn()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function candidate(key: string): FixCandidateEntry {
  return {
    key,
    skillName: 'Security Reviewer',
    path: 'src/secret.ts',
    line: 12,
    severity: 'high',
    body: 'Unescaped user input reaches the DOM',
    suggestedFix: 'Escape it with textContent.',
  }
}

function stackBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    git: { head: TREE_HEAD, branch: 'codex/test-pr', dirty: false },
    dirtyPaths: [],
    dirtyCount: 0,
    prior: null,
    app: { url: null, source: 'unknown', reachable: false, detail: '' },
    checkoutEnabled: true,
    ...overrides,
  }
}

/** The `/v1/checkout` answers, in order. */
const checkoutQueue: (() => Response)[] = []

function queueCheckout(fn: () => Response): void {
  checkoutQueue.push(fn)
}

/** Every `/v1/checkout` call the panel made, as parsed bodies. */
const checkoutCalls: Record<string, unknown>[] = []

/**
 * Pair a bridge, answer the panel's mount probe, and render.
 *
 * `fix: true` and a detected CLI throughout: the refusal under test is
 * `head-mismatch`, so everything EARLIER in the readiness rule has to pass or
 * the panel would be refusing for a different reason.
 */
async function setup(
  opts: {
    caps?: Record<string, unknown>
    stack?: Record<string, unknown> | 'none'
    relation?: PrRepoRelation
    ref?: string | null
    context?: boolean
  } = {},
) {
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    const target = String(url)
    if (target.endsWith('/v1/stack')) {
      return opts.stack === 'none'
        ? Promise.resolve(json({ ok: false, error: 'not-found', message: 'no' }, 404))
        : Promise.resolve(json(stackBody(opts.stack ?? {})))
    }
    if (target.endsWith('/v1/checkout')) {
      checkoutCalls.push(JSON.parse(String(init.body)))
      const next = checkoutQueue.shift()
      if (next !== undefined) return Promise.resolve(next())
    }
    return Promise.reject(new TypeError('Failed to fetch'))
  })

  fetchMock.mockResolvedValueOnce(
    json({
      ok: true,
      protocol: PROTOCOL_VERSION,
      root: 'review123',
      capabilities: {
        inference: ['claude'],
        infer: true,
        files: true,
        search: true,
        fix: true,
        checkout: true,
        ...opts.caps,
      },
      git: { head: TREE_HEAD, branch: 'codex/test-pr', dirty: false },
      version: '0.1.0',
    }),
  )
  await connectBridge(TOKEN, 7321)

  if (opts.context !== false) {
    notePrCheckoutContext({
      headSha: PR_HEAD,
      ref: opts.ref === undefined ? PR_REF : opts.ref,
      relation: opts.relation ?? 'same-repo',
    })
  }

  const utils = render(AgentFixPanel, { headSha: PR_HEAD, candidates: [candidate('f1')] })
  // Wait for the STORE, not for the call count: `waitFor` on the latter fires
  // the moment fetch is invoked, long before its body has been read. A 404
  // leaves the store null on purpose, so there is nothing to wait for there.
  if (opts.stack === 'none') {
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2))
  } else {
    await vi.waitFor(() => expect(stackState.state).not.toBeNull())
  }
  await tick()
  return utils
}

beforeEach(() => {
  localStorage.clear()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
  checkoutQueue.length = 0
  checkoutCalls.length = 0
  _resetBridgeForTest()
  _resetStackForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// The refusal itself
// ---------------------------------------------------------------------------

describe('the head-mismatch refusal', () => {
  it('names which commit is on disk and which one was reviewed', async () => {
    await setup()
    const sentence = screen.getByTestId('agent-fix-readiness')
    expect(sentence).toHaveAttribute('data-reason', 'head-mismatch')
    expect(sentence.textContent).toContain('codex/test-pr')
    expect(sentence.textContent).toContain(TREE_HEAD.slice(0, 7))
    expect(sentence.textContent).toContain(PR_HEAD.slice(0, 7))
  })

  it('offers the resolving action when the bridge may move the tree', async () => {
    await setup()
    expect(screen.getByTestId('agent-fix-checkout')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 1. Only where the capability is actually granted
// ---------------------------------------------------------------------------

describe('the checkout grant is separate from the write grant', () => {
  it('offers NO control on a bridge without --allow-checkout, and names the right flag', async () => {
    await setup({ caps: { checkout: false } })
    expect(screen.queryByTestId('agent-fix-checkout')).toBeNull()
    const blocked = screen.getByTestId('agent-fix-checkout-blocked')
    expect(blocked).toHaveAttribute('data-reason', 'checkout-disabled')
    expect(blocked.textContent).toContain('--allow-checkout')
    // …and rules out the adjacent flag, which this very panel needed.
    expect(blocked.textContent).toMatch(/--allow-write does not enable this/)
  })

  it('offers no control on a bridge too old for the stack routes', async () => {
    await setup({ stack: 'none' })
    expect(screen.queryByTestId('agent-fix-checkout')).toBeNull()
    expect(screen.getByTestId('agent-fix-checkout-blocked')).toHaveAttribute('data-reason', 'route-missing')
  })

  it('offers no control when the provider exposes no fetchable ref', async () => {
    await setup({ ref: null })
    expect(screen.queryByTestId('agent-fix-checkout')).toBeNull()
    const blocked = screen.getByTestId('agent-fix-checkout-blocked')
    expect(blocked).toHaveAttribute('data-reason', 'no-ref')
    expect(blocked.textContent).toMatch(/does not expose a pull-request ref/)
  })

  it('offers no control when the app is not showing this pull request', async () => {
    // A context left over from another PR must never be used for this one.
    await setup({ context: false })
    expect(screen.queryByTestId('agent-fix-checkout')).toBeNull()
    expect(screen.getByTestId('agent-fix-checkout-blocked')).toHaveAttribute('data-reason', 'no-ref')
  })
})

// ---------------------------------------------------------------------------
// 2. Nothing is moved silently
// ---------------------------------------------------------------------------

describe('running someone else’s code is confirmed first', () => {
  it('asks before checking out a FORK, naming what running it means', async () => {
    await setup({ relation: 'fork' })
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))

    const text = screen.getByTestId('agent-fix-trust-text').textContent ?? ''
    expect(text).toMatch(/FORK/)
    expect(text).toMatch(/runs its code on your machine/)
    // NOTHING has been sent yet.
    expect(checkoutCalls).toHaveLength(0)
  })

  it('treats an UNPROVABLE provenance exactly like a fork', async () => {
    await setup({ relation: 'unknown' })
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))
    expect(screen.getByTestId('agent-fix-trust-text').textContent).toMatch(/cannot confirm whether/)
    expect(checkoutCalls).toHaveLength(0)
  })

  it('cancelling the confirmation touches nothing', async () => {
    await setup({ relation: 'fork' })
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))
    await userEvent.click(screen.getByTestId('agent-fix-trust-cancel'))
    expect(screen.queryByTestId('agent-fix-trust-confirm')).toBeNull()
    expect(checkoutCalls).toHaveLength(0)
  })

  it('skips the question only for a branch PROVABLY in the repository itself', async () => {
    queueCheckout(() =>
      json({
        ok: true,
        git: { head: PR_HEAD, branch: null, dirty: false },
        prior: { branch: 'codex/test-pr', head: TREE_HEAD, recordedAt: '', checkedOutRef: PR_REF, checkedOutSha: PR_HEAD, stashRef: null },
        stash: null,
        app: { url: null, source: 'unknown', reachable: false, detail: '' },
      }),
    )
    await setup({ relation: 'same-repo' })
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))

    await vi.waitFor(() => expect(checkoutCalls).toHaveLength(1))
    expect(checkoutCalls[0]).toMatchObject({ ref: PR_REF, acknowledgeUntrusted: true })
    expect(checkoutCalls[0]).not.toHaveProperty('stashDirty')
    // The refusal is gone: the panel is ready and the send button is back.
    await vi.waitFor(() => expect(screen.getByTestId('agent-fix-send')).toBeTruthy())
  })
})

describe('uncommitted work is confirmed separately, and named', () => {
  it('lists the files before anything is stashed', async () => {
    await setup({
      stack: { git: { head: TREE_HEAD, branch: 'codex/test-pr', dirty: true }, dirtyPaths: ['src/a.ts', 'notes.txt'], dirtyCount: 2 },
    })
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))

    const list = screen.getByTestId('agent-fix-dirty-list')
    expect(list.textContent).toContain('src/a.ts')
    expect(list.textContent).toContain('notes.txt')
    expect(checkoutCalls).toHaveLength(0)
  })

  it('sends stashDirty only after the user accepts, and uses the bridge’s own stash path', async () => {
    queueCheckout(() =>
      json({
        ok: true,
        git: { head: PR_HEAD, branch: null, dirty: false },
        prior: { branch: 'codex/test-pr', head: TREE_HEAD, recordedAt: '', checkedOutRef: PR_REF, checkedOutSha: PR_HEAD, stashRef: 'c'.repeat(40) },
        stash: { action: 'created', ref: 'c'.repeat(40), dropCommand: 'git stash drop cccccccccccc' },
        app: { url: null, source: 'unknown', reachable: false, detail: '' },
      }),
    )
    await setup({
      stack: { git: { head: TREE_HEAD, branch: 'codex/test-pr', dirty: true }, dirtyPaths: ['src/a.ts'], dirtyCount: 1 },
    })
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))
    await userEvent.click(screen.getByTestId('agent-fix-stash-accept'))

    await vi.waitFor(() => expect(checkoutCalls).toHaveLength(1))
    expect(checkoutCalls[0]).toMatchObject({ ref: PR_REF, stashDirty: true })
  })

  it('cancelling the stash prompt sends nothing', async () => {
    await setup({
      stack: { git: { head: TREE_HEAD, branch: 'codex/test-pr', dirty: true }, dirtyPaths: ['src/a.ts'], dirtyCount: 1 },
    })
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))
    await userEvent.click(screen.getByTestId('agent-fix-stash-cancel'))
    expect(screen.queryByTestId('agent-fix-stash-confirm')).toBeNull()
    expect(checkoutCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Every typed failure keeps its own sentence
// ---------------------------------------------------------------------------

describe('a refused checkout says which refusal it was', () => {
  it('a branch the remote does not have is not "couldn’t check out"', async () => {
    queueCheckout(() =>
      json({ ok: false, error: 'ref-unknown', message: 'origin has no refs/pull/42/head' }, 404),
    )
    await setup()
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))

    const error = await screen.findByTestId('agent-fix-checkout-error')
    expect(error.textContent).toContain('origin has no refs/pull/42/head')
  })

  it('git’s own refusal is quoted rather than paraphrased', async () => {
    queueCheckout(() =>
      json({ ok: false, error: 'checkout-failed', message: 'error: Your local changes would be overwritten' }, 500),
    )
    await setup()
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))

    const error = await screen.findByTestId('agent-fix-checkout-error')
    expect(error.textContent).toContain('Your local changes would be overwritten')
  })

  it('a tree that turned dirty between the probe and the click offers the stash', async () => {
    queueCheckout(() =>
      json(
        {
          ok: false,
          error: 'tree-dirty',
          message: 'Your working tree has 2 uncommitted changes.',
          dirtyPaths: ['src/a.ts', 'src/b.ts'],
          dirtyCount: 2,
        },
        409,
      ),
    )
    await setup()
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))

    const prompt = await screen.findByTestId('agent-fix-stash-confirm')
    expect(prompt.textContent).toContain('src/a.ts')
    // …and the refusal's own sentence is still on screen beside it.
    expect(screen.getByTestId('agent-fix-checkout-error').textContent).toContain('2 uncommitted changes')
  })

  it('a bridge that revoked the grant mid-session says so', async () => {
    queueCheckout(() =>
      json({ ok: false, error: 'checkout-disabled', message: 'restart me with --allow-checkout' }, 403),
    )
    await setup()
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))

    const error = await screen.findByTestId('agent-fix-checkout-error')
    expect(error.textContent).toContain('--allow-checkout')
  })
})

// ---------------------------------------------------------------------------
// 4. The pull request moved again, mid-flight
// ---------------------------------------------------------------------------

describe('a pull request that advanced while it was being read', () => {
  it('says the checkout landed somewhere the findings do not describe', async () => {
    // The ref resolves at FETCH time, so this lands on a NEWER commit than the
    // one the review ran against. "It worked" would be a lie by omission.
    queueCheckout(() =>
      json({
        ok: true,
        git: { head: MOVED_HEAD, branch: null, dirty: false },
        prior: { branch: 'codex/test-pr', head: TREE_HEAD, recordedAt: '', checkedOutRef: PR_REF, checkedOutSha: MOVED_HEAD, stashRef: null },
        stash: null,
        app: { url: null, source: 'unknown', reachable: false, detail: '' },
      }),
    )
    await setup()
    await userEvent.click(screen.getByTestId('agent-fix-checkout'))

    const landing = await screen.findByTestId('agent-fix-landing')
    expect(landing.textContent).toContain(MOVED_HEAD.slice(0, 7))
    expect(landing.textContent).toContain(PR_HEAD.slice(0, 7))
    expect(landing.textContent).toMatch(/moved while you were reading it/)
    // The panel still refuses to run the fix loop, and still says why.
    expect(screen.getByTestId('agent-fix-readiness')).toHaveAttribute('data-reason', 'head-mismatch')
  })
})

// ---------------------------------------------------------------------------
// The other dead ends
// ---------------------------------------------------------------------------

describe('the other refusals', () => {
  it('hands a read-only bridge the command that grants write, both flags included', async () => {
    await setup({ caps: { fix: false } })
    expect(screen.getByTestId('agent-fix-readiness')).toHaveAttribute('data-reason', 'write-disabled')
    const command = screen.getByTestId('agent-fix-start-command').textContent ?? ''
    expect(command).toBe(BRIDGE_START_COMMAND)
    expect(command).toContain('--allow-write')
    expect(command).toContain('--allow-checkout')
    // It is the WRITE grant that is missing, not the checkout one: no offer to
    // move the tree here, because moving it would not make the panel work.
    expect(screen.queryByTestId('agent-fix-checkout')).toBeNull()
  })

  it('says plainly that no agent was found, and offers nothing it cannot do', async () => {
    await setup({ caps: { inference: [] } })
    expect(screen.getByTestId('agent-fix-readiness')).toHaveAttribute('data-reason', 'no-cli')
    expect(screen.queryByTestId('agent-fix-checkout')).toBeNull()
    expect(screen.queryByTestId('agent-fix-start-command')).toBeNull()
  })
})
