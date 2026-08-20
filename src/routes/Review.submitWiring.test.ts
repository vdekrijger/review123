/**
 * Review.svelte → VerdictStep submit wiring — provider-routed submission.
 *
 * Pins the production submit path: Review.svelte must hand VerdictStep a
 * submitFn derived from providerFor(providerId).submitReview so a GitLab MR /
 * Bitbucket PR review goes to the GitLab/Bitbucket submitter — NOT the default
 * GitHub submitReview that VerdictStep falls back to when no submitFn is
 * passed. GitHub goes through the same providerFor(...) path (one code path,
 * no special case).
 *
 * Seam: vi.mock of ../lib/provider/registry — every provider id resolves to a
 * recording fake, so the assertion is exactly "the active provider's
 * submitReview was invoked with the right args".
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import Review from './Review.svelte'
import { router, _resetStartedForTest } from '../lib/router/router.svelte'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'
import { setGithubPat } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'
import { jsonResponse } from '../test-helpers'
import 'fake-indexeddb/auto'

// ---------------------------------------------------------------------------
// Fakes — one recording provider per id, served by the mocked registry
// ---------------------------------------------------------------------------

const { fakes } = vi.hoisted(() => {
  function makeFake(id: 'github' | 'gitlab' | 'bitbucket', displayName: string) {
    const fake = {
      id,
      displayName,
      /** Every submitReview invocation's raw argument list. */
      submitCalls: [] as unknown[][],
      /** The outcome the next submitReview resolves with (reset per test). */
      nextOutcome: { ok: true } as Record<string, unknown>,
      parseUrl: () => ({ ok: false as const, error: 'unused in this test' }),
      prWebUrl: () => `https://example.test/${id}/pr/7`,
      getPrMeta: async () => ({
        title: `${displayName} PR under review`,
        state: 'open' as const,
        merged: false,
        body: null,
        baseSha: 'base-sha-1',
        headSha: 'head-sha-1',
        private: false,
        changedFiles: 1,
        authorLogin: 'someone-else',
      }),
      getPrFiles: async () => [
        {
          filename: 'src/feature.ts',
          status: 'modified' as const,
          additions: 1,
          deletions: 1,
          patch: '@@ -1,2 +1,2 @@\n-old\n+new',
        },
      ],
      getFileAtRef: async () => null,
      getCiSummary: async () => ({ total: 0, passed: 0, failed: 0, pending: 0, failures: [] }),
      getComments: async () => [],
      getResolvedCommentIds: async () => new Set<number>(),
      getCommits: async () => [],
      compareCommits: async () => [],
      submitReview: async (...args: unknown[]) => {
        fake.submitCalls.push(args)
        return fake.nextOutcome
      },
      authState: () => ({ configured: true, hint: 'stub token configured' }),
      capabilities: {
        resolvedThreads: false,
        checks: false,
        suggestions: false,
        atomicReview: false,
        compare: false,
        commentReplies: false,
        selfReviewBlocked: false,
      },
    }
    return fake
  }
  return {
    fakes: {
      github: makeFake('github', 'GitHub'),
      gitlab: makeFake('gitlab', 'GitLab'),
      bitbucket: makeFake('bitbucket', 'Bitbucket'),
    },
  }
})

vi.mock('../lib/provider/registry', () => ({
  providerFor: (id: string) => {
    const fake = (fakes as Record<string, unknown>)[id]
    if (!fake) throw new Error(`no fake provider for id "${id}"`)
    return fake
  },
  PROVIDERS: new Map(),
  parseAnyUrl: () => null,
}))

// Stub analytics (same as Review.test.ts)
vi.mock('../lib/analytics/analytics', () => ({
  track: vi.fn(),
  initAnalytics: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

// Stub DraftThread so we don't fight jsdom canvas / DiffView internals
vi.mock('../components/DraftThread.svelte', () => ({
  default: { name: 'DraftThread' },
}))

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  // canvas stub for DiffView inside FileDiff (step 2 mounts on the way to 3)
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      font: '',
      measureText: () => ({ width: 0 }),
    }),
    writable: true,
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  _resetStartedForTest()
  router.route = { name: 'landing' }
  _resetSettingsStateForTest()
  _resetAuthStateForTest()
  for (const fake of Object.values(fakes)) {
    fake.submitCalls.length = 0
    fake.nextOutcome = { ok: true }
  }
  // No test here may touch the network. Before the wiring fix, VerdictStep's
  // default GitHub submitReview would hit this stub instead of the provider.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ message: 'network stub' }, {}, 500))))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Render Review for the given provider, load the PR, and walk to step 3. */
async function renderAtVerdict(providerId: 'gitlab' | 'bitbucket' | undefined, number: number) {
  const user = userEvent.setup()
  render(Review, {
    props: { owner: 'grp', repo: 'proj', number, ...(providerId ? { provider: providerId } : {}) },
  })

  await vi.waitFor(() => {
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  const nextBtn = screen.getByRole('button', { name: /next step/i })
  await user.click(nextBtn)
  await user.click(nextBtn)

  await vi.waitFor(() => {
    expect(screen.getByRole('button', { name: /submit review/i })).toBeInTheDocument()
  })
  return user
}

/** Pick APPROVE (empty body is allowed) and click Submit review. */
async function approveAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: /approve/i }))
  await user.click(screen.getByRole('button', { name: /submit review/i }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Review → VerdictStep submit wiring (provider-routed)', () => {
  it('gitlab: submits through providerFor("gitlab").submitReview with the right args', async () => {
    fakes.gitlab.nextOutcome = { ok: true, posted: { inline: 0, fileLevel: 2, bodyFolded: 0 } }
    const user = await renderAtVerdict('gitlab', 7)

    await approveAndSubmit(user)

    await waitFor(() => expect(fakes.gitlab.submitCalls.length).toBe(1))
    const call = fakes.gitlab.submitCalls[0]
    // ref is provider-qualified — GitLab's submitter needs PrRefX.provider
    expect(call[0]).toMatchObject({ provider: 'gitlab', owner: 'grp', repo: 'proj', number: 7 })
    expect(call[1]).toBe('APPROVE')
    expect(call[2]).toBe('') // empty overall body
    expect(call[3]).toEqual([]) // no drafts
    expect(call[4]).toBe('head-sha-1') // commitId = loaded headSha
    // files pass through for the off-diff anchor split (#214)
    const filesArg = call[5] as Array<{ filename: string }>
    expect(filesArg).toHaveLength(1)
    expect(filesArg[0].filename).toBe('src/feature.ts')

    // The GitHub submitter must NOT have been used
    expect(fakes.github.submitCalls.length).toBe(0)

    // SubmitOutcome rendering works for provider outcomes, incl. #214 posted counts
    await waitFor(() => {
      expect(screen.getByText('Your review was submitted successfully.')).toBeInTheDocument()
    })
    expect(screen.getByTestId('submit-outcome-breakdown').textContent).toContain(
      '2 posted as file comments',
    )
    // Success link is provider-honest, not hardcoded to GitHub
    expect(screen.getByRole('link', { name: /view on gitlab/i })).toBeInTheDocument()
  })

  it('bitbucket: submits through providerFor("bitbucket").submitReview', async () => {
    const user = await renderAtVerdict('bitbucket', 8)

    await approveAndSubmit(user)

    await waitFor(() => expect(fakes.bitbucket.submitCalls.length).toBe(1))
    const call = fakes.bitbucket.submitCalls[0]
    expect(call[0]).toMatchObject({ provider: 'bitbucket', owner: 'grp', repo: 'proj', number: 8 })
    expect(call[1]).toBe('APPROVE')
    expect(fakes.github.submitCalls.length).toBe(0)

    await waitFor(() => {
      expect(screen.getByText('Your review was submitted successfully.')).toBeInTheDocument()
    })
    expect(screen.getByRole('link', { name: /view on bitbucket/i })).toBeInTheDocument()
  })

  it('github (default provider): submits through providerFor("github").submitReview — one path for all providers', async () => {
    // GitHub's VerdictStep sign-in check reads authState (PAT seam)
    setGithubPat('ghp_test_token')
    const user = await renderAtVerdict(undefined, 9)

    await approveAndSubmit(user)

    await waitFor(() => expect(fakes.github.submitCalls.length).toBe(1))
    const call = fakes.github.submitCalls[0]
    expect(call[0]).toMatchObject({ provider: 'github', owner: 'grp', repo: 'proj', number: 9 })
    expect(call[1]).toBe('APPROVE')

    await waitFor(() => {
      expect(screen.getByText('Your review was submitted successfully.')).toBeInTheDocument()
    })
  })

  it('provider failure outcome renders verbatim in role=alert (drafts path unchanged)', async () => {
    fakes.gitlab.nextOutcome = { ok: false, kind: 'other', message: 'GitLab rejected the approval.' }
    const user = await renderAtVerdict('gitlab', 10)

    await approveAndSubmit(user)

    await waitFor(() => expect(fakes.gitlab.submitCalls.length).toBe(1))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('GitLab rejected the approval.')
    })
    // No success panel on failure
    expect(screen.queryByText('Your review was submitted successfully.')).not.toBeInTheDocument()
  })
})
