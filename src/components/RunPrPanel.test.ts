/**
 * RunPrPanel.test.ts — the only surface in review123 that moves the user's
 * working tree, so the tests are mostly about what it REFUSES to do.
 *
 * The four things that must hold:
 *   1. It never shows a bare disabled button — every unavailable state renders
 *      its reason (#242's discipline, made visible).
 *   2. Moving uncommitted work is a separate, explicit confirmation that NAMES
 *      the files.
 *   3. Running a fork's code — or code whose provenance cannot be proven — is
 *      a separate, explicit confirmation that names the risk.
 *   4. While on the PR there is an unmissable indicator and a way back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import RunPrPanel from './RunPrPanel.svelte'
import { tick } from 'svelte'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _resetStackForTest, stackState } from '../lib/bridge/runPr.svelte'
import { BRIDGE_STORAGE_KEY } from '../lib/bridge/storage'

const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_SHA = 'def4567890abcdef1234567890abcdef12345678'
const TOKEN = 'pairing-token-0000000000000000000000000000'
const PR_REF = 'refs/pull/42/head'

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function healthBody(caps: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    protocol: 1,
    root: 'repo',
    capabilities: { inference: [], infer: true, files: true, search: true, ...caps },
    git: { head: OTHER_SHA, branch: 'main', dirty: false },
    version: '0.1.0',
  }
}

function stackBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    git: { head: OTHER_SHA, branch: 'main', dirty: false },
    dirtyPaths: [],
    dirtyCount: 0,
    prior: null,
    app: { url: 'http://localhost:8010', source: 'posthog', reachable: true, detail: 'PostHog.' },
    checkoutEnabled: true,
    ...overrides,
  }
}

/**
 * Pair a bridge, queue the `/v1/stack` answer the COMPONENT will fetch on
 * mount, render, and wait for it to land.
 *
 * The panel probes `/v1/stack` itself on mount rather than trusting a cached
 * answer — the tree may have moved since — so the response is queued here and
 * consumed by the component, not by the test. Call indices are therefore
 * stable: 0 = health, 1 = stack, 2+ = whatever the test clicks.
 */
async function setup(
  opts: {
    caps?: Record<string, unknown>
    stack?: Record<string, unknown> | 'none'
    props?: Record<string, unknown>
  } = {},
) {
  fetchMock.mockResolvedValueOnce(jsonResponse(healthBody(opts.caps ?? { checkout: true })))
  await connectBridge(TOKEN, 7321)

  if (opts.stack === 'none') {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not-found', message: 'no' }, 404))
  } else {
    fetchMock.mockResolvedValueOnce(jsonResponse(stackBody(opts.stack ?? {})))
  }

  const utils = render(RunPrPanel, {
    props: { headSha: HEAD_SHA, prRef: PR_REF, ...opts.props },
  })
  // Wait for the STORE, not for the fetch call: `waitFor` on the call count
  // fires the moment fetch is invoked, long before its body has been read and
  // assigned. A 404 leaves the store null on purpose, so there is nothing to
  // wait for there — and `route-missing` is the answer either way.
  if (opts.stack !== 'none') {
    await vi.waitFor(() => expect(stackState.state).not.toBeNull())
  } else {
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  }
  await tick()
  return utils
}

beforeEach(() => {
  localStorage.clear()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
  _resetBridgeForTest()
  _resetStackForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

// ---------------------------------------------------------------------------
// Absence
// ---------------------------------------------------------------------------

describe('RunPrPanel — zero-cost absence', () => {
  it('renders NOTHING when no bridge has ever been paired', () => {
    render(RunPrPanel, { props: { headSha: HEAD_SHA, prRef: PR_REF } })
    expect(screen.queryByTestId('runpr-panel')).not.toBeInTheDocument()
    // Telling someone who has never heard of the bridge that they "cannot
    // check this PR out" is noise, not honesty.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 1. Never a bare disabled button
// ---------------------------------------------------------------------------

describe('RunPrPanel — every refusal names its reason', () => {
  it('says the bridge lacks --allow-checkout, and that --allow-write is not it', async () => {
    await setup({ caps: { fix: true }, stack: { checkoutEnabled: false } })
    const reason = screen.getByTestId('runpr-reason')
    expect(reason).toHaveAttribute('data-reason', 'checkout-disabled')
    expect(reason).toHaveTextContent('--allow-checkout')
    expect(reason).toHaveTextContent(/--allow-write does not enable this/)
    expect(screen.queryByTestId('runpr-checkout')).not.toBeInTheDocument()
  })

  it('tells an older bridge to update, rather than silently doing nothing', async () => {
    await setup({ stack: 'none' })
    expect(screen.getByTestId('runpr-reason')).toHaveAttribute('data-reason', 'route-missing')
  })

  it('says the bridge is not serving a repository', async () => {
    await setup({ stack: { git: null } })
    expect(screen.getByTestId('runpr-reason')).toHaveAttribute('data-reason', 'no-repo-state')
  })

  it('disables the action with an explanation when the provider exposes no ref', async () => {
    await setup({ props: { prRef: null } })
    const button = screen.getByTestId('runpr-checkout')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('does not expose'))
  })
})

// ---------------------------------------------------------------------------
// 2. + 3. The two confirmations
// ---------------------------------------------------------------------------

describe('RunPrPanel — the untrusted-code confirmation', () => {
  it('asks BEFORE anything is sent, naming what running the code means', async () => {
    const user = userEvent.setup()
    await setup()
    await user.click(screen.getByTestId('runpr-checkout'))

    const text = screen.getByTestId('runpr-trust-text')
    expect(text).toHaveTextContent(/runs its code on your machine/)
    expect(text).toHaveTextContent(/database/)
    // Nothing has been requested beyond the health + stack probes.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // The provider layer carries no head/base repo pair today, so every PR is
  // `unverified` — and unverified is treated exactly like a fork.
  it('treats an UNVERIFIED provenance exactly like a fork', async () => {
    const user = userEvent.setup()
    await setup()
    await user.click(screen.getByTestId('runpr-checkout'))
    expect(screen.getByTestId('runpr-trust-text')).toHaveTextContent(/cannot confirm/)
    expect(screen.getByTestId('runpr-trust-dialog')).toBeInTheDocument()
  })

  it('says FORK plainly when the provider proves it is one', async () => {
    const user = userEvent.setup()
    await setup({ props: { repos: { head: 'stranger/x', base: 'octo/x' } } })
    await user.click(screen.getByTestId('runpr-checkout'))
    expect(screen.getByTestId('runpr-trust-text')).toHaveTextContent(/comes from a FORK/)
  })

  it('cancelling sends nothing at all', async () => {
    const user = userEvent.setup()
    await setup()
    await user.click(screen.getByTestId('runpr-checkout'))
    await user.click(screen.getByTestId('runpr-trust-cancel'))
    expect(screen.queryByTestId('runpr-trust-dialog')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips the confirmation for a PROVABLY same-repo branch', async () => {
    const user = userEvent.setup()
    await setup({ props: { repos: { head: 'octo/x', base: 'octo/x' } } })
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: HEAD_SHA, branch: null, dirty: false },
        prior: { branch: 'main', head: OTHER_SHA, recordedAt: '', checkedOutRef: PR_REF, checkedOutSha: HEAD_SHA, stashRef: null },
        stash: null,
        app: { url: 'http://localhost:8010', source: 'posthog', reachable: true, detail: '' },
      }),
    )
    await user.click(screen.getByTestId('runpr-checkout'))
    expect(screen.queryByTestId('runpr-trust-dialog')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('accepting sends the checkout WITH the acknowledgement', async () => {
    const user = userEvent.setup()
    await setup()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: HEAD_SHA, branch: null, dirty: false },
        prior: { branch: 'main', head: OTHER_SHA, recordedAt: '', checkedOutRef: PR_REF, checkedOutSha: HEAD_SHA, stashRef: null },
        stash: null,
        app: { url: 'http://localhost:8010', source: 'posthog', reachable: true, detail: '' },
      }),
    )
    await user.click(screen.getByTestId('runpr-checkout'))
    await user.click(screen.getByTestId('runpr-trust-accept'))

    const sent = JSON.parse(fetchMock.mock.calls[2]![1].body)
    expect(sent).toEqual({ ref: PR_REF, acknowledgeUntrusted: true })
  })
})

describe('RunPrPanel — the stash confirmation', () => {
  const dirtyStack = {
    git: { head: OTHER_SHA, branch: 'main', dirty: true },
    dirtyPaths: ['src/a.ts', 'notes.txt'],
    dirtyCount: 2,
  }

  it('warns about the uncommitted changes before anything is clicked', async () => {
    await setup({ stack: dirtyStack })
    expect(screen.getByTestId('runpr-dirty-note')).toHaveTextContent('2 uncommitted changes')
  })

  // NAMING THE FILES IS THE POINT: a prompt that says "you have uncommitted
  // changes" without listing them asks for trust the user cannot check.
  it('LISTS the exact files a stash would move', async () => {
    const user = userEvent.setup()
    await setup({ stack: dirtyStack })
    await user.click(screen.getByTestId('runpr-checkout'))
    await user.click(screen.getByTestId('runpr-trust-accept'))

    const list = screen.getByTestId('runpr-dirty-list')
    expect(list).toHaveTextContent('src/a.ts')
    expect(list).toHaveTextContent('notes.txt')
  })

  it('promises nothing is deleted, and that restoring puts them back', async () => {
    const user = userEvent.setup()
    await setup({ stack: dirtyStack })
    await user.click(screen.getByTestId('runpr-checkout'))
    await user.click(screen.getByTestId('runpr-trust-accept'))
    const dialog = screen.getByTestId('runpr-stash-dialog')
    expect(dialog).toHaveTextContent(/nothing is deleted/i)
    expect(dialog).toHaveTextContent(/puts them back/i)
  })

  it('cancelling the stash prompt sends NOTHING — the tree is untouched', async () => {
    const user = userEvent.setup()
    await setup({ stack: dirtyStack })
    await user.click(screen.getByTestId('runpr-checkout'))
    await user.click(screen.getByTestId('runpr-trust-accept'))
    await user.click(screen.getByTestId('runpr-stash-cancel'))
    expect(screen.queryByTestId('runpr-stash-dialog')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('accepting sends stashDirty, and nothing sends it before then', async () => {
    const user = userEvent.setup()
    await setup({ stack: dirtyStack })
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: HEAD_SHA, branch: null, dirty: false },
        prior: { branch: 'main', head: OTHER_SHA, recordedAt: '', checkedOutRef: PR_REF, checkedOutSha: HEAD_SHA, stashRef: 'c'.repeat(40) },
        stash: { action: 'created', ref: 'c'.repeat(40), dropCommand: 'git stash drop cccccccccccc' },
        app: { url: 'http://localhost:8010', source: 'posthog', reachable: true, detail: '' },
      }),
    )
    await user.click(screen.getByTestId('runpr-checkout'))
    await user.click(screen.getByTestId('runpr-trust-accept'))
    await user.click(screen.getByTestId('runpr-stash-accept'))

    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({
      ref: PR_REF,
      acknowledgeUntrusted: true,
      stashDirty: true,
    })
  })

  it('afterwards says the work is safe, and how to remove the entry', async () => {
    const user = userEvent.setup()
    await setup({ stack: dirtyStack })
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: HEAD_SHA, branch: null, dirty: false },
        prior: { branch: 'main', head: OTHER_SHA, recordedAt: '', checkedOutRef: PR_REF, checkedOutSha: HEAD_SHA, stashRef: 'c'.repeat(40) },
        stash: { action: 'created', ref: 'c'.repeat(40), dropCommand: 'git stash drop cccccccccccc' },
        app: { url: 'http://localhost:8010', source: 'posthog', reachable: true, detail: '' },
      }),
    )
    await user.click(screen.getByTestId('runpr-checkout'))
    await user.click(screen.getByTestId('runpr-trust-accept'))
    await user.click(screen.getByTestId('runpr-stash-accept'))

    const note = screen.getByTestId('runpr-stash-note')
    expect(note).toHaveTextContent(/stashed and safe/i)
    expect(note).toHaveTextContent('git stash drop cccccccccccc')
  })
})

// ---------------------------------------------------------------------------
// 4. On the PR: the indicator and the way back
// ---------------------------------------------------------------------------

describe('RunPrPanel — while on the PR branch', () => {
  const onPrStack = {
    git: { head: HEAD_SHA, branch: null, dirty: false },
    prior: {
      branch: 'main',
      head: OTHER_SHA,
      recordedAt: '2026-01-01T00:00:00.000Z',
      checkedOutRef: PR_REF,
      checkedOutSha: HEAD_SHA,
      stashRef: null,
    },
  }

  it('shows an unmissable indicator instead of the checkout button', async () => {
    await setup({ stack: onPrStack })
    expect(screen.getByTestId('runpr-on-pr')).toHaveTextContent(/checked out here/i)
    expect(screen.queryByTestId('runpr-checkout')).not.toBeInTheDocument()
    expect(screen.getByTestId('runpr-panel')).toHaveAttribute('data-on-pr', 'true')
  })

  it('offers the running app, and NAMES the branch to restore', async () => {
    await setup({ stack: onPrStack })
    expect(screen.getByTestId('runpr-open-app')).toHaveAttribute('href', 'http://localhost:8010')
    expect(screen.getByTestId('runpr-restore')).toHaveTextContent('Restore main')
  })

  it('names the SHA when the user started from a detached HEAD', async () => {
    await setup({
      stack: { ...onPrStack, prior: { ...onPrStack.prior, branch: null } },
    })
    expect(screen.getByTestId('runpr-restore')).toHaveTextContent('Restore def4567')
  })

  it('says so honestly when the dev server is not answering', async () => {
    await setup({
      stack: {
        ...onPrStack,
        app: { url: 'http://localhost:8010', source: 'posthog', reachable: false, detail: '' },
      },
    })
    expect(screen.getByTestId('runpr-app-down')).toHaveTextContent('Nothing answering at http://localhost:8010')
    expect(screen.queryByTestId('runpr-open-app')).not.toBeInTheDocument()
  })

  it('admits it does not know the port rather than naming a guessed one', async () => {
    await setup({
      stack: {
        ...onPrStack,
        app: { url: null, source: 'unknown', reachable: false, detail: 'no port' },
      },
    })
    expect(screen.getByTestId('runpr-app-down')).toHaveTextContent(/location unknown/i)
  })

  it('restore asks for the stash back, and clears the indicator', async () => {
    const user = userEvent.setup()
    await setup({ stack: onPrStack })
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: OTHER_SHA, branch: 'main', dirty: false },
        prior: null,
        stash: null,
        app: { url: 'http://localhost:8010', source: 'posthog', reachable: true, detail: '' },
      }),
    )
    await user.click(screen.getByTestId('runpr-restore'))

    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({ restoreStash: true })
    expect(screen.queryByTestId('runpr-on-pr')).not.toBeInTheDocument()
    expect(screen.getByTestId('runpr-checkout')).toBeInTheDocument()
  })
})

describe('RunPrPanel — a restore that needs a decision', () => {
  const onPrStack = {
    git: { head: HEAD_SHA, branch: null, dirty: false },
    prior: {
      branch: 'main',
      head: OTHER_SHA,
      recordedAt: '',
      checkedOutRef: PR_REF,
      checkedOutSha: HEAD_SHA,
      stashRef: null,
    },
  }

  async function restoreFailing(code: string, message: string) {
    const user = userEvent.setup()
    await setup({ stack: onPrStack })
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: code, message }, 409))
    await user.click(screen.getByTestId('runpr-restore'))
    return user
  }

  it('offers the recorded SHA when the branch was deleted — never silently detaching', async () => {
    await restoreFailing('prior-gone', 'The branch main no longer exists.')
    expect(screen.getByTestId('runpr-restore-detail')).toHaveTextContent(/no longer exists/)
    expect(screen.getByTestId('runpr-restore-detach')).toHaveTextContent('def4567')
  })

  it('asks before restoring over a HEAD the user moved themselves', async () => {
    const user = await restoreFailing('moved-since', 'HEAD is at 1111111, not where we left it.')
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        git: { head: OTHER_SHA, branch: 'main', dirty: false },
        prior: null,
        stash: null,
        app: { url: 'http://localhost:8010', source: 'posthog', reachable: true, detail: '' },
      }),
    )
    await user.click(screen.getByTestId('runpr-restore-anyway'))
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body)).toEqual({
      acknowledgeMoved: true,
      restoreStash: true,
    })
  })

  it('offers to stash work made ON the PR, rather than losing it', async () => {
    await restoreFailing('tree-dirty', 'Your working tree has 1 uncommitted change.')
    expect(screen.getByTestId('runpr-restore-stash')).toBeInTheDocument()
  })

  it('"leave it as it is" sends nothing further', async () => {
    const user = await restoreFailing('moved-since', 'moved')
    await user.click(screen.getByTestId('runpr-restore-cancel'))
    expect(screen.queryByTestId('runpr-restore-dialog')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('RunPrPanel — failures are surfaced', () => {
  it('shows the bridge’s own sentence when a checkout is refused', async () => {
    const user = userEvent.setup()
    await setup({ props: { repos: { head: 'octo/x', base: 'octo/x' } } })
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: 'ref-unknown', message: 'origin has no refs/pull/42/head.' }, 404),
    )
    await user.click(screen.getByTestId('runpr-checkout'))
    expect(screen.getByTestId('runpr-error')).toHaveTextContent('origin has no refs/pull/42/head.')
  })
})
