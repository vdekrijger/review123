/**
 * OutcomesPanel.local.test.ts — making an expected outcome actionable.
 *
 * Each outcome row already states a concrete before → after claim. When the
 * pull request is checked out locally AND the dev server answers, that claim
 * is checkable right now, so each row grows a "Try it" link onto the running
 * app.
 *
 * The contract these tests pin is a negative one, mostly: the link appears
 * ONLY when both halves hold. A local app serving some other branch, or a dead
 * port, must never be offered as a way to check this PR's outcomes — that
 * would invite the reviewer to disprove a claim against the wrong code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import OutcomesPanel from './OutcomesPanel.svelte'
import { _resetBridgeForTest, connectBridge } from '../../lib/bridge/bridge.svelte'
import { _resetStackForTest, refreshStack } from '../../lib/bridge/runPr.svelte'
import { BRIDGE_STORAGE_KEY } from '../../lib/bridge/storage'
import type { AiRun } from '../../lib/ai/run.svelte'
import type { ExpectedOutcomesResult } from '../../lib/ai/schemas'
import type { PrFile } from '../../lib/github/types'

const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_SHA = 'def4567890abcdef1234567890abcdef12345678'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

async function seedStack(opts: { head: string; reachable?: boolean; url?: string | null }) {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      ok: true,
      protocol: 1,
      root: 'repo',
      capabilities: { inference: [], infer: true, files: true, search: true, checkout: true },
      git: { head: opts.head, branch: 'main', dirty: false },
      version: '0.1.0',
    }),
  )
  await connectBridge(TOKEN, 7321)
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      ok: true,
      git: { head: opts.head, branch: null, dirty: false },
      dirtyPaths: [],
      dirtyCount: 0,
      prior: null,
      app: {
        url: opts.url === undefined ? 'http://localhost:8010' : opts.url,
        source: 'posthog',
        reachable: opts.reachable !== false,
        detail: '',
      },
      checkoutEnabled: true,
    }),
  )
  await refreshStack()
}

const FILES: PrFile[] = [{ filename: 'src/review.ts', status: 'modified', additions: 5, deletions: 2 }]

const RESULT: ExpectedOutcomesResult = {
  outcomes: [
    {
      id: 'o1',
      before: 'An off-diff comment failed the whole review.',
      after: 'It posts as a file-level comment.',
      evidence: [{ path: 'src/review.ts', line: 42 }],
      symbols: ['postReview'],
    },
    {
      id: 'o2',
      before: 'Retry storms hammered the API.',
      after: 'Failures back off exponentially.',
      evidence: [{ path: 'src/review.ts' }],
      symbols: ['backoff'],
    },
  ],
  withoutThis: '',
}

function makeRun(): AiRun {
  return {
    summary: { status: 'idle' },
    attention: { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    tests: { status: 'idle' },
    alternatives: { status: 'idle' },
    intent: { status: 'idle' },
    outcomes: { status: 'done', value: RESULT },
    story: { status: 'idle' },
    riskJudge: { status: 'idle' },
    skillReviews: [],
    testReviews: [],
    convergence: { status: 'idle' },
    simplify: { status: 'idle' },
    totalUsage: undefined,
    verdictModels: [],
    modelPerformance: [],
    modelCostBreakdown: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    expandComment: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    runTestsReview: async () => {},
    retrySkill: async () => {},
  } as unknown as AiRun
}

function renderPanel(props: Record<string, unknown> = {}) {
  return render(OutcomesPanel, {
    props: { run: makeRun(), files: FILES, contentsMap: null, ...props },
  })
}

beforeEach(() => {
  localStorage.clear()
  localStorage.removeItem(BRIDGE_STORAGE_KEY)
  _resetBridgeForTest()
  _resetStackForTest()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('OutcomesPanel — "Try it" against the running app', () => {
  it('offers one link per outcome when this PR is checked out and running', async () => {
    await seedStack({ head: HEAD_SHA })
    renderPanel({ headSha: HEAD_SHA })

    const links = screen.getAllByTestId('outcome-try')
    expect(links).toHaveLength(RESULT.outcomes.length)
    for (const link of links) {
      expect(link).toHaveAttribute('href', 'http://localhost:8010')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
  })

  // Deliberately the app ROOT, not a route guessed from the outcome text: a
  // guessed deep link would land on a 404 and read as the app disagreeing
  // with the claim.
  it('links to the app root rather than a route invented from the outcome', async () => {
    await seedStack({ head: HEAD_SHA })
    renderPanel({ headSha: HEAD_SHA })
    expect(screen.getAllByTestId('outcome-try')[0]).toHaveAttribute('href', 'http://localhost:8010')
  })
})

describe('OutcomesPanel — when the claim is NOT checkable', () => {
  it('offers nothing with no bridge paired at all', () => {
    renderPanel({ headSha: HEAD_SHA })
    expect(screen.queryByTestId('outcome-try')).not.toBeInTheDocument()
  })

  // The dangerous case: an app that IS running, but not this PR.
  it('offers nothing when the local checkout is on another commit', async () => {
    await seedStack({ head: OTHER_SHA })
    renderPanel({ headSha: HEAD_SHA })
    expect(screen.queryByTestId('outcome-try')).not.toBeInTheDocument()
  })

  it('offers nothing when the PR is checked out but the server is down', async () => {
    await seedStack({ head: HEAD_SHA, reachable: false })
    renderPanel({ headSha: HEAD_SHA })
    expect(screen.queryByTestId('outcome-try')).not.toBeInTheDocument()
  })

  it('offers nothing when the dev-server URL could not be detected', async () => {
    await seedStack({ head: HEAD_SHA, url: null })
    renderPanel({ headSha: HEAD_SHA })
    expect(screen.queryByTestId('outcome-try')).not.toBeInTheDocument()
  })

  // Without a head sha there is no way to know WHICH branch the app serves.
  it('offers nothing when no headSha was supplied', async () => {
    await seedStack({ head: HEAD_SHA })
    renderPanel()
    expect(screen.queryByTestId('outcome-try')).not.toBeInTheDocument()
  })

  it('still renders the outcomes themselves, unchanged', () => {
    renderPanel({ headSha: HEAD_SHA })
    expect(screen.getByText(/posts as a file-level comment/)).toBeInTheDocument()
  })
})
