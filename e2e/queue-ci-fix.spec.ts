/**
 * e2e/queue-ci-fix.spec.ts — the failing-CI flow, from a queue row to a push.
 *
 * WHY THIS FILE EXISTS. #288 built CiFixPanel and shipped no e2e spec, honestly:
 * there was no route that rendered it. There is now — the queue's actions
 * column — so the whole flow is reachable by something that can open a URL, and
 * the three outcomes that actually matter are pinned here:
 *
 *   1. THE FAILURE REPRODUCES AND IS FIXED. The verdict leads, the honesty
 *      sentences ride with it, and the push is a two-step confirmation that
 *      names the remote, the branch, where it is and where it will be.
 *   2. THE FAILURE DOES NOT REPRODUCE. No agent, no commit, no push — the
 *      common case (a different OS, a missing secret, a flake), and the one a
 *      surface is most tempted to bury under an empty result.
 *   3. THE PUSH GRANT IS ABSENT. A sentence and the exact command to restart
 *      with, NOT a greyed-out button. `--allow-push` is a third grant nobody
 *      pastes by accident, so "you cannot" without "here is how" would mean the
 *      feature silently does not work.
 *
 * WHAT A BROWSER CAN AND CANNOT SEE, said plainly so nobody trusts case 2 too
 * far. The agent runs INSIDE the bridge, and the bridge is stubbed here at the
 * `window.fetch` seam — so "the agent was never invoked" is not directly
 * observable from this side. What IS observable, and is what these tests
 * assert, is everything the browser controls: that /v1/ci-fix is called once
 * and nothing else on the bridge is called at all, that the response's round
 * count and change list are rendered as the zero they are, and that no push is
 * offered or sent. The bridge's own round-zero contract — reproduce first, or
 * start nothing — is covered by bridge/src/ciFix.test.ts, which can see it.
 *
 * The bridge is stubbed at `window.fetch` rather than with page.route for the
 * reason e2e/bridge.spec.ts gives: the real calls are cross-origin to
 * 127.0.0.1 with an Authorization header, and intercepting them would drag CORS
 * into assertions that are not about CORS. Everything that is not the bridge
 * falls through to the real fetch, and therefore to page.route.
 */
import { test, expect, type Page } from '@playwright/test'
import { BRIDGE_START_COMMAND_WITH_PUSH } from '../src/lib/bridge/install'

const OWNER = 'acme'
const REPO = 'web'
const NUMBER = 102
const BRANCH = 'feat/thing'

/** The commit CI failed on — the bridge's checkout is here, or nothing runs. */
const HEAD = 'a'.repeat(38) + '02'
/** What the agent committed, and the only sha a push may carry. */
const FIXED = 'b'.repeat(38) + '77'

const JOB = 'unit (node 22)'

type CiFixBody = Record<string, unknown>

/** Every bridge route the page asked for, in order, plus the ci-fix payload. */
interface BridgeSeen {
  calls: string[]
  ciFixRequests: unknown[]
}

interface Options {
  /** The `/v1/ci-fix` answer. */
  ciFix: CiFixBody
  /** `capabilities.push` — the bridge's `--allow-push` grant. */
  push?: boolean
  /** Make the pull request's head live on a fork. */
  fork?: boolean
}

function reproducedAndFixed(): CiFixBody {
  return {
    ok: true,
    cli: 'claude',
    reproduction: 'reproduced',
    baseline: { status: 'failed', command: 'pnpm test', durationMs: 910, output: '1 failing' },
    baseSha: HEAD,
    branch: 'review123/ci-fix-9f2',
    changes: [
      {
        findingId: `job:777`,
        commit: FIXED,
        subject: 'fix: compare the boundary inclusively',
        intent: 'Make the failing assertion in src/a.ts pass',
        files: ['src/a.ts'],
        diff: '',
        truncated: false,
        rounds: 1,
        stopReason: 'all-addressed',
        tests: { status: 'passed', command: 'pnpm test', durationMs: 830, output: 'ok' },
      },
    ],
    skipped: [],
    rounds: 1,
    stopReason: 'all-addressed',
    tests: { status: 'passed', command: 'pnpm test', durationMs: 830, output: 'ok' },
    headCommit: FIXED,
    durationMs: 2400,
  }
}

function didNotReproduce(): CiFixBody {
  return {
    ok: true,
    cli: 'claude',
    reproduction: 'not-reproduced',
    baseline: { status: 'passed', command: 'pnpm test', durationMs: 740, output: 'ok' },
    baseSha: HEAD,
    branch: 'review123/ci-fix-9f2',
    changes: [],
    skipped: [],
    rounds: 0,
    stopReason: 'all-addressed',
    tests: null,
    // The bridge never invents one, and a client that read a commit out of an
    // empty changes array would be inventing the one thing that cannot be
    // taken back.
    headCommit: null,
    durationMs: 740,
  }
}

/** Fake the GitHub half: the queue, its signals, the checks and the job log. */
async function seedGithub(page: Page, opts: Options) {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const request = route.request()
    const { pathname, searchParams } = new URL(request.url())

    if (pathname === '/graphql') {
      const query = (JSON.parse(request.postData() ?? '{}') as { query?: string }).query ?? ''
      const isMergeState = !query.includes('reviewThreads')
      return route.fulfill({
        json: {
          data: {
            p0: isMergeState
              ? { pullRequest: { mergeStateStatus: 'CLEAN' } }
              : {
                  viewerPermission: 'WRITE',
                  pullRequest: {
                    additions: 12,
                    deletions: 3,
                    mergeable: 'MERGEABLE',
                    headRefOid: HEAD,
                    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
                  },
                },
          },
        },
      })
    }

    if (pathname === '/search/issues') {
      // One pull request, authored by the viewer. Nothing is awaiting review,
      // so nothing on this page can be mistaken for somebody else's branch.
      const mine = (searchParams.get('q') ?? '').includes('author:')
      const items = mine
        ? [{
            number: NUMBER,
            title: 'fix: the boundary check',
            updated_at: new Date(Date.now() - 60_000).toISOString(),
            repository_url: `https://api.github.com/repos/${OWNER}/${REPO}`,
          }]
        : []
      return route.fulfill({ json: { total_count: items.length, items } })
    }

    // The CiSummary the panel is mounted with.
    if (pathname.endsWith('/annotations')) {
      return route.fulfill({ json: [{ message: 'src/a.ts:12 expected 1 to be 2' }] })
    }
    if (pathname.endsWith('/check-runs')) {
      return route.fulfill({
        json: {
          total_count: 1,
          check_runs: [{
            id: 9001,
            name: JOB,
            status: 'completed',
            conclusion: 'failure',
            html_url: `https://github.com/${OWNER}/${REPO}/runs/9001`,
          }],
        },
      })
    }

    // The Actions evidence gatherCiFailures enriches the request with.
    if (pathname.endsWith('/actions/runs')) {
      return route.fulfill({ json: { workflow_runs: [{ id: 555, conclusion: 'failure' }] } })
    }
    if (pathname.endsWith('/actions/runs/555/jobs')) {
      return route.fulfill({
        json: {
          jobs: [{
            id: 777,
            name: JOB,
            conclusion: 'failure',
            html_url: `https://github.com/${OWNER}/${REPO}/runs/777`,
          }],
        },
      })
    }
    if (pathname.endsWith('/actions/jobs/777/logs')) {
      return route.fulfill({
        contentType: 'text/plain',
        body: '2026-03-12T15:00:00.000Z FAIL src/a.test.ts\n2026-03-12T15:00:01.000Z expected 1 to be 2\n',
      })
    }

    // getPushTarget — where a push would go, and whether it is a fork.
    if (pathname === `/repos/${OWNER}/${REPO}/pulls/${NUMBER}`) {
      return route.fulfill({
        json: {
          head: {
            ref: BRANCH,
            sha: HEAD,
            repo: { full_name: opts.fork ? `someone-else/${REPO}` : `${OWNER}/${REPO}` },
          },
          base: { repo: { full_name: `${OWNER}/${REPO}` } },
        },
      })
    }

    return route.fulfill({ json: [] })
  })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    githubAuth: { token: 'ghp_ci_fix', method: 'pat', scopes: [] },
    deepseekKey: 'sk-ci-fix',
    aiProvider: 'deepseek',
  })
}

/** A paired bridge, ready at HEAD, answering /v1/health, /v1/ci-fix, /v1/push. */
async function seedBridge(page: Page, opts: Options) {
  await page.addInitScript(
    ({ health, ciFix, pushed, key }) => {
      localStorage.setItem(key, JSON.stringify({ token: 'e2e-ci-fix-token', port: 7321 }))
      const seen: BridgeSeen = { calls: [], ciFixRequests: [] }
      ;(window as unknown as { __bridge: BridgeSeen }).__bridge = seen
      const realFetch = window.fetch.bind(window)
      const json = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)
        const path = new URL(url).pathname
        seen.calls.push(path)
        if (path === '/v1/health') return json(health)
        if (path === '/v1/ci-fix') {
          seen.ciFixRequests.push(JSON.parse(String(init?.body ?? '{}')))
          return json(ciFix)
        }
        if (path === '/v1/push') return json(pushed)
        return Promise.resolve(new Response('{}', { status: 404 }))
      }
    },
    {
      key: 'review123:bridge',
      ciFix: opts.ciFix,
      pushed: {
        ok: true,
        remote: 'origin',
        branch: BRANCH,
        before: HEAD,
        after: FIXED,
        commits: 1,
        durationMs: 1200,
      },
      health: {
        ok: true,
        protocol: 1,
        root: REPO,
        version: '0.1.0',
        capabilities: {
          inference: ['claude'],
          infer: true,
          inferStream: true,
          inferAgentic: true,
          files: true,
          search: true,
          fix: true,
          checkout: true,
          push: opts.push ?? true,
        },
        git: { head: HEAD, branch: BRANCH, dirty: false },
      },
    },
  )
}

async function openPanel(page: Page, opts: Options) {
  await seedGithub(page, opts)
  await seedBridge(page, opts)
  await page.goto('/')
  await expect(page.getByText('Your review queue')).toBeVisible({ timeout: 10_000 })
  const control = page.getByTestId('queue-ci-fix')
  await expect(control).toBeVisible({ timeout: 20_000 })
  await control.click()
  await expect(page.getByTestId('ci-fix-panel')).toBeVisible({ timeout: 10_000 })
}

function bridgeSeen(page: Page): Promise<BridgeSeen> {
  return page.evaluate(() => (window as unknown as { __bridge: BridgeSeen }).__bridge)
}

// ---------------------------------------------------------------------------
// 1 — it reproduced, it was fixed, and the push is confirmed in full
// ---------------------------------------------------------------------------

test('a failure that reproduces is fixed, and pushing is a confirmation that names all four things', async ({ page }) => {
  await openPanel(page, { ciFix: reproducedAndFixed() })

  // Before anything runs, the panel says what the bridge will do FIRST.
  await expect(page.getByTestId('ci-fix-job-count')).toHaveText(/1 job failed/)
  await expect(page.getByTestId('ci-fix-jobs')).toContainText(JOB)
  await expect(page.getByTestId('ci-fix-lede')).toContainText('own test command')

  await page.getByTestId('ci-fix-start').click()

  // THE HEADLINE IS THE VERDICT, not the commit count.
  const verdict = page.getByTestId('ci-fix-reproduction')
  await expect(verdict).toHaveAttribute('data-reproduction', 'reproduced', { timeout: 20_000 })
  await expect(verdict).toContainText('reproduced here')
  await expect(page.getByTestId('ci-fix-next-step')).toHaveCount(0)

  // The commit, and the two sentences that must ride with any local green.
  await expect(page.getByTestId('ci-fix-changes')).toContainText(FIXED.slice(0, 7))
  await expect(page.getByTestId('ci-fix-local-only')).toContainText('not CI')
  await expect(page.getByTestId('ci-fix-not-reviewed')).toContainText('No person has read this change')
  // The logs were readable here, so the "working blind" note must NOT appear.
  await expect(page.getByTestId('ci-fix-logs-missing')).toHaveCount(0)

  // The bridge was asked exactly once, for this commit.
  const asked = await bridgeSeen(page)
  expect(asked.calls.filter((c) => c === '/v1/ci-fix')).toHaveLength(1)
  expect((asked.ciFixRequests[0] as { headSha: string }).headSha).toBe(HEAD)

  // Pushing is deliberately two steps, and nothing has left the machine yet.
  await page.getByTestId('ci-fix-push').click()
  const plan = page.getByTestId('ci-fix-plan')
  await expect(plan).toBeVisible()
  // The remote, the branch, where it is, and where it will be.
  await expect(plan).toContainText('origin/' + BRANCH)
  await expect(plan).toContainText(HEAD.slice(0, 12))
  await expect(plan).toContainText(FIXED.slice(0, 12))
  await expect(page.getByTestId('ci-fix-consequence')).toContainText('cannot be undone')
  expect((await bridgeSeen(page)).calls).not.toContain('/v1/push')

  await page.getByTestId('ci-fix-push-confirm').click()
  await expect(page.getByTestId('ci-fix-pushed')).toContainText('moved from', { timeout: 10_000 })
  // And what it still does not mean.
  await expect(page.getByTestId('ci-fix-push-not-verdict')).toContainText('not proof the defect is gone')
  expect((await bridgeSeen(page)).calls.filter((c) => c === '/v1/push')).toHaveLength(1)

  // The panel was given a way to re-read CI, so the row can catch up.
  await expect(page.getByTestId('ci-fix-refresh')).toBeVisible()
})

// ---------------------------------------------------------------------------
// 2 — it did not reproduce: nothing ran, nothing exists, nothing is offered
// ---------------------------------------------------------------------------

test('a failure that does not reproduce starts no agent and offers no push', async ({ page }) => {
  await openPanel(page, { ciFix: didNotReproduce() })
  await page.getByTestId('ci-fix-start').click()

  const verdict = page.getByTestId('ci-fix-reproduction')
  await expect(verdict).toHaveAttribute('data-reproduction', 'not-reproduced', { timeout: 20_000 })
  await expect(verdict).toContainText('did NOT reproduce here')
  // It says so in the verdict itself rather than leaving an empty result to
  // be read as a failed attempt.
  await expect(verdict).toContainText('No agent was started and nothing was changed')
  // And it names the next move instead of stopping at the refusal.
  await expect(page.getByTestId('ci-fix-next-step')).toContainText('--test-command')

  // No commit, so nothing that could be pushed, in either of the two ways the
  // push can present itself.
  await expect(page.getByTestId('ci-fix-changes')).toHaveCount(0)
  await expect(page.getByTestId('ci-fix-push')).toHaveCount(0)
  await expect(page.getByTestId('ci-fix-push-ungranted')).toHaveCount(0)
  await expect(page.getByTestId('ci-fix-confirm')).toHaveCount(0)

  // What the browser can actually witness about "no agent ran": the bridge was
  // asked once, for the round-zero check, and never again — no second request,
  // no /v1/fix, no /v1/infer — and the answer it rendered reports zero rounds
  // and zero changes. The bridge's own contract is tested where it can be seen,
  // in bridge/src/ciFix.test.ts.
  const asked = await bridgeSeen(page)
  expect(asked.calls.filter((c) => c === '/v1/ci-fix')).toHaveLength(1)
  expect(asked.calls.filter((c) => c !== '/v1/health' && c !== '/v1/ci-fix')).toEqual([])

  // Nothing was asked of GitHub about where a push would go, either.
  await expect(page.getByTestId('ci-fix-no-target')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// 3 — the push grant is absent: a sentence and a command, not a dead button
// ---------------------------------------------------------------------------

test('without --allow-push the panel says what to run, and shows no disabled button', async ({ page }) => {
  await openPanel(page, { ciFix: reproducedAndFixed(), push: false })
  await page.getByTestId('ci-fix-start').click()

  await expect(page.getByTestId('ci-fix-reproduction')).toHaveAttribute(
    'data-reproduction',
    'reproduced',
    { timeout: 20_000 },
  )

  // There is a commit — this is not "nothing to push", it is "not allowed to".
  await expect(page.getByTestId('ci-fix-changes')).toContainText(FIXED.slice(0, 7))

  const note = page.getByTestId('ci-fix-push-ungranted')
  await expect(note).toContainText('may not write to a remote')
  await expect(note).toContainText('separate grant')
  // The exact line to restart with, read from the app's own constant so the
  // test cannot drift from the command the user is told to paste.
  await expect(page.getByTestId('ci-fix-push-command')).toHaveText(BRIDGE_START_COMMAND_WITH_PUSH)
  // And where the commit is in the meantime, so it is not stranded.
  await expect(page.getByTestId('ci-fix-panel')).toContainText('review123/ci-fix-9f2')

  // NOT a greyed-out button: there is no push control on the page at all.
  await expect(page.getByTestId('ci-fix-push')).toHaveCount(0)
  expect((await bridgeSeen(page)).calls).not.toContain('/v1/push')
})
