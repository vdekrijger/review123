/**
 * CiFixPanel.test.ts — the surface that can write to somebody else's remote.
 *
 * Four properties, and the first two are the whole reason the feature is
 * shaped the way it is:
 *
 *   1. When the failure did not reproduce locally, the panel LEADS with that
 *      and offers no push — because the bridge started no agent and there is
 *      no commit.
 *   2. A push is never sent without a confirmation that names the remote, the
 *      branch, the commit the branch is at and the commit it will be at.
 *   3. No result renders as "fixed": a green local run always carries the
 *      sentence saying it is one command on one machine.
 *   4. Every refusal shows its reason. There are no bare disabled buttons.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { tick } from 'svelte'
import CiFixPanel from './CiFixPanel.svelte'
import { _resetBridgeForTest, connectBridge } from '../lib/bridge/bridge.svelte'
import { _setCaptureForTest } from '../lib/analytics/analytics'
import { FIX_CLI_PREF_KEY } from '../lib/bridge/fixLoop'
import type { CiSummary } from '../lib/github/checks'
import type { PrRefX } from '../lib/provider/types'

const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'
const OTHER_SHA = 'def4567890abcdef1234567890abcdef12345678'
const NEW_SHA = '0123456789abcdef0123456789abcdef01234567'
const TOKEN = 'pairing-token-0000000000000000000000000000'

const PR: PrRefX = { provider: 'github', owner: 'acme', repo: 'widget', number: 42 }

const fetchMock = vi.fn()
const captured: { event: string; props: Record<string, unknown> }[] = []

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function healthBody(caps: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    protocol: 1,
    root: 'widget',
    capabilities: {
      inference: ['claude'],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      fix: true,
      checkout: false,
      push: true,
      ...caps,
    },
    // The bridge's checkout is ON the PR head, so readiness is `ready`.
    git: { head: HEAD_SHA, branch: 'feat/thing', dirty: false },
    version: '0.4.0',
  }
}

function ci(failures: { name: string; annotations: string[]; url?: string | null }[] = []): CiSummary {
  return {
    total: 3,
    passed: 3 - failures.length,
    failed: failures.length,
    pending: 0,
    failures,
  }
}

const ONE_FAILURE = ci([{ name: 'test (ubuntu-latest)', annotations: ['src/a.ts:3 expected 1 to be 2'] }])

function ciFixBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    cli: 'claude',
    reproduction: 'reproduced',
    baseline: { status: 'failed', command: 'pnpm test', durationMs: 900, output: '1 failed' },
    baseSha: HEAD_SHA,
    branch: 'review123/fix/abc123456789',
    changes: [
      {
        findingId: 'job:1',
        commit: NEW_SHA,
        subject: 'fix(ci): correct the expected value',
        intent: 'corrected the expected value the assertion compares against',
        files: ['src/a.ts'],
        diff: '',
        truncated: false,
        rounds: 1,
        stopReason: 'all-addressed',
        tests: { status: 'passed', command: 'pnpm test', durationMs: 800, output: 'ok' },
      },
    ],
    skipped: [],
    rounds: 1,
    stopReason: 'all-addressed',
    tests: { status: 'passed', command: 'pnpm test', durationMs: 800, output: 'ok' },
    headCommit: NEW_SHA,
    durationMs: 4200,
    ...overrides,
  }
}

/** The GitHub calls the panel makes while gathering evidence, in order. */
function queueGithubGathering(): void {
  // listFailingActionsJobs → /actions/runs
  fetchMock.mockResolvedValueOnce(jsonResponse({ workflow_runs: [] }))
}

/** The pull-request read that establishes where a push would go. */
function queuePushTarget(overrides: Record<string, unknown> = {}): void {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      head: { ref: 'feat/thing', sha: HEAD_SHA, repo: { full_name: 'acme/widget' } },
      base: { repo: { full_name: 'acme/widget' } },
      ...overrides,
    }),
  )
}

beforeEach(async () => {
  localStorage.clear()
  captured.length = 0
  _setCaptureForTest((event, props) => captured.push({ event, props }))
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

function mount(props: Record<string, unknown> = {}) {
  return render(CiFixPanel, { props: { pr: PR, headSha: HEAD_SHA, ci: ONE_FAILURE, ...props } })
}

/** Click start and wait for the run to settle. */
async function runIt(): Promise<void> {
  await userEvent.click(screen.getByTestId('ci-fix-start'))
  await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-reproduction')).not.toBeNull())
  await tick()
}

// ---------------------------------------------------------------------------
// When there is nothing to say
// ---------------------------------------------------------------------------

describe('CiFixPanel — when it appears at all', () => {
  it('renders nothing when CI reports no failures', async () => {
    await pair()
    mount({ ci: ci([]) })
    expect(screen.queryByTestId('ci-fix-panel')).toBeNull()
  })

  it('renders nothing when CI is unknown — unknown is not red', async () => {
    await pair()
    mount({ ci: null })
    expect(screen.queryByTestId('ci-fix-panel')).toBeNull()
  })

  it('names every failing job, and counts them', async () => {
    await pair()
    mount({
      ci: ci([
        { name: 'test (ubuntu-latest)', annotations: [] },
        { name: 'build', annotations: [] },
      ]),
    })
    expect(screen.getByTestId('ci-fix-job-count')).toHaveTextContent('2 jobs failed')
    expect(screen.getByTestId('ci-fix-jobs')).toHaveTextContent('build')
  })
})

// ---------------------------------------------------------------------------
// Refusals always carry their reason
// ---------------------------------------------------------------------------

describe('CiFixPanel — no bare disabled buttons', () => {
  it('says WHY when no bridge is paired, and offers no run', async () => {
    mount()
    expect(screen.getByTestId('ci-fix-readiness')).toHaveAttribute('data-reason', 'no-bridge')
    expect(screen.queryByTestId('ci-fix-start')).toBeNull()
  })

  it('says WHY when the bridge is read-only', async () => {
    await pair({ fix: false })
    mount()
    const readiness = screen.getByTestId('ci-fix-readiness')
    expect(readiness).toHaveAttribute('data-reason', 'write-disabled')
    expect(readiness).toHaveTextContent(/--allow-write/)
  })

  it('says WHY when the checkout is on a different commit', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...healthBody(), git: { head: OTHER_SHA, branch: 'main', dirty: false } }),
    )
    await connectBridge(TOKEN, 7321)
    mount()
    expect(screen.getByTestId('ci-fix-readiness')).toHaveAttribute('data-reason', 'head-mismatch')
  })

  it('warns before running that no agent starts unless the failure reproduces', async () => {
    await pair()
    mount()
    expect(screen.getByTestId('ci-fix-lede')).toHaveTextContent(/no agent is started/i)
  })
})

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

describe('CiFixPanel — the failure did not reproduce', () => {
  beforeEach(async () => {
    await pair()
  })

  it('LEADS with the verdict and offers no push', async () => {
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ciFixBody({
          reproduction: 'not-reproduced',
          baseline: { status: 'passed', command: 'pnpm test', durationMs: 900, output: '' },
          changes: [],
          headCommit: null,
          tests: null,
        }),
      ),
    )
    mount()
    await runIt()

    const verdict = screen.getByTestId('ci-fix-reproduction')
    expect(verdict).toHaveAttribute('data-reproduction', 'not-reproduced')
    expect(verdict).toHaveTextContent(/did NOT reproduce/i)
    // No commit exists, so there is nothing to offer.
    expect(screen.queryByTestId('ci-fix-push')).toBeNull()
  })

  it('names the next move rather than leaving a dead end', async () => {
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ciFixBody({
          reproduction: 'not-reproduced',
          baseline: { status: 'passed', command: 'pnpm test', durationMs: 900, output: '' },
          changes: [],
          headCommit: null,
        }),
      ),
    )
    mount()
    await runIt()
    expect(screen.getByTestId('ci-fix-next-step')).toHaveTextContent(/--test-command/)
  })

  it('offers no push when there was no local signal at all', async () => {
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ciFixBody({
          reproduction: 'no-local-signal',
          baseline: { status: 'unrunnable', command: '', durationMs: 0, output: '' },
          changes: [],
          headCommit: null,
        }),
      ),
    )
    mount()
    await runIt()
    expect(screen.queryByTestId('ci-fix-push')).toBeNull()
  })

  // An unreadable `reproduction` must not enable a push. Parsing already
  // defaults it to `no-local-signal`; this asserts the UI honours that.
  it('offers no push when the verdict could not be read', async () => {
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody({ reproduction: 'who-knows' })))
    mount()
    await runIt()
    expect(screen.getByTestId('ci-fix-reproduction')).toHaveAttribute('data-reproduction', 'no-local-signal')
    expect(screen.queryByTestId('ci-fix-push')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A run that did reproduce
// ---------------------------------------------------------------------------

describe('CiFixPanel — the failure reproduced', () => {
  beforeEach(async () => {
    await pair()
  })

  it('shows the commit and never calls it fixed', async () => {
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
    mount()
    await runIt()

    expect(screen.getByTestId('ci-fix-changes')).toHaveTextContent('0123456')
    const panel = screen.getByTestId('ci-fix-panel')
    expect(panel.textContent).not.toMatch(/\b(is|are|was|were|now)\s+(fixed|resolved)\b/i)
    expect(panel.textContent).not.toMatch(/\bCI is green\b|\ball clear\b/i)
  })

  it('always says a green local run is one command on one machine', async () => {
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
    mount()
    await runIt()
    expect(screen.getByTestId('ci-fix-local-only')).toHaveTextContent(/new result rather than proof/i)
    expect(screen.getByTestId('ci-fix-not-reviewed')).toHaveTextContent(/No person has read/i)
  })

  it('says plainly when the round cap was reached with the run still red', async () => {
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        ciFixBody({
          stopReason: 'round-cap',
          tests: { status: 'failed', command: 'pnpm test', durationMs: 800, output: 'still red' },
        }),
      ),
    )
    mount()
    await runIt()
    const stop = screen.getByTestId('ci-fix-stop')
    expect(stop).toHaveAttribute('data-stop', 'round-cap')
    expect(stop).toHaveTextContent(/STILL failing/i)
    expect(stop).toHaveTextContent(/nothing about it has been shown to work/i)
  })

  it('reports when GitHub would not give this browser the logs', async () => {
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
    mount()
    await runIt()
    expect(screen.getByTestId('ci-fix-logs-missing')).toHaveTextContent(/would not hand this browser/i)
  })
})

// ---------------------------------------------------------------------------
// THE CONFIRMATION
// ---------------------------------------------------------------------------

describe('CiFixPanel — confirming a push', () => {
  beforeEach(async () => {
    await pair()
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
  })

  async function reachConfirm(): Promise<void> {
    mount()
    await runIt()
    queuePushTarget()
    await userEvent.click(screen.getByTestId('ci-fix-push'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-confirm')).not.toBeNull())
  }

  it('names the remote, the branch and BOTH commits', async () => {
    await reachConfirm()
    const plan = screen.getByTestId('ci-fix-plan')
    expect(plan).toHaveTextContent('origin/feat/thing')
    expect(plan).toHaveTextContent(HEAD_SHA.slice(0, 12))
    expect(plan).toHaveTextContent(NEW_SHA.slice(0, 12))
  })

  it('states the consequence in full, and the guarantees the bridge enforces', async () => {
    await reachConfirm()
    expect(screen.getByTestId('ci-fix-consequence')).toHaveTextContent(/cannot be undone/i)
    const guarantees = screen.getByTestId('ci-fix-guarantees')
    expect(guarantees).toHaveTextContent(/Fast-forward only/i)
    expect(guarantees).toHaveTextContent(/no force/i)
    // And the guarantee it does NOT make, said out loud.
    expect(guarantees).toHaveTextContent(/cannot check who authored/i)
  })

  it('sends NOTHING until the confirmation is accepted', async () => {
    await reachConfirm()
    const before = fetchMock.mock.calls.length
    await userEvent.click(screen.getByTestId('ci-fix-push-cancel'))
    await tick()
    expect(fetchMock.mock.calls.length).toBe(before)
    expect(screen.queryByTestId('ci-fix-confirm')).toBeNull()
  })

  it('sends the exact move it showed, with expectedRemoteSha', async () => {
    await reachConfirm()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        remote: 'origin',
        branch: 'feat/thing',
        before: HEAD_SHA,
        after: NEW_SHA,
        commits: 1,
        durationMs: 900,
      }),
    )
    await userEvent.click(screen.getByTestId('ci-fix-push-confirm'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-pushed')).not.toBeNull())

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/push'))!
    const body = JSON.parse((call[1] as RequestInit).body as string)
    expect(body).toEqual({
      remote: 'origin',
      branch: 'feat/thing',
      expectedRemoteSha: HEAD_SHA,
      sha: NEW_SHA,
    })
    // No force field exists to send, in either direction.
    expect(Object.keys(body)).not.toContain('force')
  })

  it('restates what happened, and says CI re-running is not a verdict', async () => {
    await reachConfirm()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        remote: 'origin',
        branch: 'feat/thing',
        before: HEAD_SHA,
        after: NEW_SHA,
        commits: 1,
        durationMs: 900,
      }),
    )
    await userEvent.click(screen.getByTestId('ci-fix-push-confirm'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-pushed')).not.toBeNull())

    expect(screen.getByTestId('ci-fix-pushed')).toHaveTextContent(HEAD_SHA.slice(0, 12))
    expect(screen.getByTestId('ci-fix-pushed')).toHaveTextContent(NEW_SHA.slice(0, 12))
    expect(screen.getByTestId('ci-fix-push-not-verdict')).toHaveTextContent(/a new result, not proof/i)
  })

  it('shows the bridge’s own refusal, in its own words', async () => {
    await reachConfirm()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          error: 'remote-moved',
          message: 'origin/feat/thing is now at 99aabbccddee, not abc123456789.',
        },
        409,
      ),
    )
    await userEvent.click(screen.getByTestId('ci-fix-push-confirm'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-push-refused')).not.toBeNull())

    const refusal = screen.getByTestId('ci-fix-push-refused')
    expect(refusal).toHaveAttribute('data-kind', 'remote-moved')
    expect(refusal).toHaveTextContent('99aabbccddee')
  })

  it('names the files in the way when the tree is dirty', async () => {
    await reachConfirm()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          error: 'tree-dirty',
          message: 'This checkout has uncommitted changes.',
          dirtyPaths: ['src/wip.ts'],
          dirtyCount: 1,
        },
        409,
      ),
    )
    await userEvent.click(screen.getByTestId('ci-fix-push-confirm'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-dirty-paths')).not.toBeNull())
    expect(screen.getByTestId('ci-fix-dirty-paths')).toHaveTextContent('src/wip.ts')
  })
})

describe('CiFixPanel — where a push would go', () => {
  beforeEach(async () => {
    await pair()
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
  })

  it('refuses a fork rather than guessing a remote', async () => {
    mount()
    await runIt()
    queuePushTarget({
      head: { ref: 'feat/thing', sha: HEAD_SHA, repo: { full_name: 'contributor/widget' } },
    })
    await userEvent.click(screen.getByTestId('ci-fix-push'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-no-target')).not.toBeNull())
    expect(screen.getByTestId('ci-fix-no-target')).toHaveTextContent(/on a fork/i)
    expect(screen.queryByTestId('ci-fix-confirm')).toBeNull()
  })

  it('refuses when the pull request moved on GitHub since the run', async () => {
    mount()
    await runIt()
    queuePushTarget({
      head: { ref: 'feat/thing', sha: OTHER_SHA, repo: { full_name: 'acme/widget' } },
    })
    await userEvent.click(screen.getByTestId('ci-fix-push'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-no-target')).not.toBeNull())
    expect(screen.getByTestId('ci-fix-no-target')).toHaveTextContent(/moved on GitHub/i)
  })

  it('refuses when the head branch cannot be read at all', async () => {
    mount()
    await runIt()
    fetchMock.mockRejectedValueOnce(new Error('network'))
    await userEvent.click(screen.getByTestId('ci-fix-push'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-no-target')).not.toBeNull())
    expect(screen.getByTestId('ci-fix-no-target')).toHaveTextContent(/could not read/i)
  })
})

// ---------------------------------------------------------------------------
// Failures of the run itself
// ---------------------------------------------------------------------------

describe('CiFixPanel — the run failed', () => {
  it('shows the named failure and offers no push', async () => {
    await pair()
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: 'head-unknown', message: 'That commit is not here.' }, 409),
    )
    mount()
    await userEvent.click(screen.getByTestId('ci-fix-start'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-failure')).not.toBeNull())

    expect(screen.getByTestId('ci-fix-failure')).toHaveAttribute('data-kind', 'head-unknown')
    expect(screen.queryByTestId('ci-fix-push')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Choosing the agent
// ---------------------------------------------------------------------------

describe('CiFixPanel — which agent runs', () => {
  it('offers no choice when only one CLI is installed', async () => {
    await pair({ inference: ['claude'] })
    mount()
    expect(screen.queryByTestId('ci-fix-cli-choice')).toBeNull()
  })

  it('offers a choice when two are, and remembers it', async () => {
    await pair({ inference: ['claude', 'codex'] })
    mount()
    await userEvent.click(screen.getByTestId('ci-fix-cli-codex'))
    await tick()
    expect(screen.getByTestId('ci-fix-cli-codex')).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem(FIX_CLI_PREF_KEY)).toContain('codex')
    expect(screen.getByTestId('ci-fix-start')).toHaveTextContent('codex')
  })
})

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe('CiFixPanel — what it reports', () => {
  it('sends counts and enums only — never a job name, a branch or a sha', async () => {
    await pair()
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
    mount()
    await runIt()

    const settled = captured.find((c) => c.event === 'bridge_ci_fix_settled')!
    expect(settled.props).toEqual({
      reproduction: 'reproduced',
      jobs: 1,
      logs_missing: 1,
      cli: 'claude',
      outcome: 'done',
      changes: 1,
      stop_reason: 'all-addressed',
      tests_green: true,
      duration_ms: expect.any(Number),
    })
    const serialised = JSON.stringify(settled.props)
    expect(serialised).not.toContain('ubuntu-latest')
    expect(serialised).not.toContain('feat/thing')
    expect(serialised).not.toContain(NEW_SHA)
    expect(serialised).not.toContain('widget')
  })

  it('reports a push as an outcome and a count, never as a destination', async () => {
    await pair()
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
    mount()
    await runIt()
    queuePushTarget()
    await userEvent.click(screen.getByTestId('ci-fix-push'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-confirm')).not.toBeNull())
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        remote: 'origin',
        branch: 'feat/thing',
        before: HEAD_SHA,
        after: NEW_SHA,
        commits: 1,
        durationMs: 900,
      }),
    )
    await userEvent.click(screen.getByTestId('ci-fix-push-confirm'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-pushed')).not.toBeNull())

    const pushed = captured.find((c) => c.event === 'bridge_push_settled')!
    expect(pushed.props).toEqual({
      outcome: 'pushed',
      commits: 1,
      confirmed: true,
      duration_ms: expect.any(Number),
    })
  })
})

// ---------------------------------------------------------------------------
// Telling the parent
// ---------------------------------------------------------------------------

describe('CiFixPanel — what it hands back', () => {
  it('tells the parent the verdict and the commit count, and again once pushed', async () => {
    await pair()
    const onSettled = vi.fn()
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
    mount({ onSettled })
    await runIt()
    expect(onSettled).toHaveBeenCalledWith({ reproduction: 'reproduced', changes: 1, pushed: false })

    queuePushTarget()
    await userEvent.click(screen.getByTestId('ci-fix-push'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-confirm')).not.toBeNull())
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        remote: 'origin',
        branch: 'feat/thing',
        before: HEAD_SHA,
        after: NEW_SHA,
        commits: 1,
        durationMs: 900,
      }),
    )
    await userEvent.click(screen.getByTestId('ci-fix-push-confirm'))
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2))
    expect(onSettled).toHaveBeenLastCalledWith({ reproduction: 'reproduced', changes: 1, pushed: true })
  })

  it('offers no "re-read CI" when the parent gave it no way to do so', async () => {
    await pair()
    queueGithubGathering()
    fetchMock.mockResolvedValueOnce(jsonResponse(ciFixBody()))
    mount()
    await runIt()
    queuePushTarget()
    await userEvent.click(screen.getByTestId('ci-fix-push'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-confirm')).not.toBeNull())
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        remote: 'origin',
        branch: 'feat/thing',
        before: HEAD_SHA,
        after: NEW_SHA,
        commits: 1,
        durationMs: 900,
      }),
    )
    await userEvent.click(screen.getByTestId('ci-fix-push-confirm'))
    await vi.waitFor(() => expect(screen.queryByTestId('ci-fix-pushed')).not.toBeNull())
    expect(screen.queryByTestId('ci-fix-refresh')).toBeNull()
  })
})
