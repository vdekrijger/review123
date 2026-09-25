/**
 * e2e/queue-signals.spec.ts — the queue's CI, unresolved-conversation and
 * base-standing signals, in a real browser.
 *
 * WHY THIS FILE EXISTS. Two of the three claims this feature makes cannot be
 * checked anywhere else:
 *
 *   1. THE REQUEST BUDGET. The whole design of the signals query is "one request
 *      for the queue, not three per row". That is a claim about what the app
 *      puts on the network, and the only place to count what the app puts on the
 *      network is a browser. The unit tests can prove the MODULE batches; only
 *      this can prove the PAGE does — that nothing downstream quietly reopened
 *      the per-row path. With 24 rows the old shape would have been 24 REST
 *      calls for sizes alone before CI or conversations were even asked for.
 *
 *   2. THE UPDATE ROUND TRIP. "Update" fires a PUT, and on success the row
 *      RE-READS the signals rather than asserting what CI will do next. That is
 *      a sequence of three network exchanges driving one row's state, and
 *      asserting it against a real fetch stack is the only way to know the
 *      re-read actually happens.
 *
 * The section ORDER is checked here too, because the DOM order of two headings
 * is cheap to assert and the whole point of the change.
 */
import { test, expect, type Page } from '@playwright/test'

const OWNER = 'acme'
const REPO = 'web'

interface Row {
  n: number
  title: string
  mine: boolean
  add: number
  del: number
  ci: string | null
  unresolved: number
  merge: string
}

const ROWS: Row[] = [
  { n: 101, title: 'feat: my own change', mine: true, add: 40, del: 10, ci: 'SUCCESS', unresolved: 2, merge: 'BEHIND' },
  { n: 102, title: 'fix: my conflicted change', mine: true, add: 12, del: 3, ci: 'FAILURE', unresolved: 0, merge: 'DIRTY' },
  { n: 103, title: 'chore: my tidy change', mine: true, add: 5, del: 5, ci: 'PENDING', unresolved: 1, merge: 'CLEAN' },
  { n: 201, title: 'feat: someone else needs review', mine: false, add: 80, del: 20, ci: 'SUCCESS', unresolved: 4, merge: 'CLEAN' },
  { n: 202, title: 'fix: no ci configured here', mine: false, add: 3, del: 1, ci: null, unresolved: 0, merge: 'CLEAN' },
]

const CI_MARKS = ROWS.filter((r) => r.ci).length
const UNRESOLVED_MARKS = ROWS.filter((r) => r.unresolved > 0).length

/** Every api.github.com path the page asked for, in order. */
type Seen = string[]

/**
 * A 40-hex commit id for a row. It has to BE one: the bridge's health document
 * refuses a `git.head` that is not 40 hex characters, and the fix panel is only
 * offered when the bridge's head equals the pull request's — so a fixture with
 * placeholder shas could never exercise that path.
 */
function sha(n: number): string {
  return String(n).padStart(40, 'a')
}

interface SeedOptions {
  /** Outcome of PUT …/update-branch. Default: 202 Accepted. */
  updateStatus?: number
  updateBody?: Record<string, unknown>
  /** Serve this merge state on the SECOND signals read (post-update). */
  afterUpdate?: Partial<Row>
}

async function seedQueue(page: Page, seen: Seen, opts: SeedOptions = {}) {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())
  await page.route('**/api.deepseek.com/**', (r) => r.abort())

  let signalsReads = 0

  await page.route('**/api.github.com/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    seen.push(`${request.method()} ${path}`)

    if (path === '/graphql') {
      const query = (JSON.parse(request.postData() ?? '{}') as { query?: string }).query ?? ''
      const isMergeState = !query.includes('reviewThreads')
      if (!isMergeState) signalsReads++
      const data: Record<string, unknown> = {}
      for (const [, alias, number] of query.matchAll(
        /(p\d+): repository\(owner: "[^"]+", name: "[^"]+"\)[\s\S]*?pullRequest\(number: (\d+)\)/g,
      )) {
        const base = ROWS.find((r) => String(r.n) === number)
        if (!base) continue
        // After the update round trip the fixture answers with the post-merge
        // reality, which is what lets the test prove the row RE-READ rather
        // than patched itself locally.
        const row = signalsReads > 1 && base.mine && opts.afterUpdate && base.n === 101
          ? { ...base, ...opts.afterUpdate }
          : base
        data[alias] = isMergeState
          ? { pullRequest: { mergeStateStatus: row.merge } }
          : {
              viewerPermission: 'WRITE',
              pullRequest: {
                additions: row.add,
                deletions: row.del,
                mergeable: row.merge === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE',
                headRefOid: sha(row.n),
                reviewThreads: {
                  pageInfo: { hasNextPage: false },
                  nodes: [
                    ...Array.from({ length: row.unresolved }, () => ({ isResolved: false })),
                    { isResolved: true },
                  ],
                },
                commits: { nodes: [{ commit: { statusCheckRollup: row.ci ? { state: row.ci } : null } }] },
              },
            }
      }
      return route.fulfill({ json: { data } })
    }

    if (path === '/search/issues') {
      const mine = (url.searchParams.get('q') ?? '').includes('author:')
      const items = ROWS.filter((r) => r.mine === mine).map((r) => ({
        number: r.n,
        title: r.title,
        updated_at: new Date(Date.now() - 60_000).toISOString(),
        repository_url: `https://api.github.com/repos/${OWNER}/${REPO}`,
      }))
      return route.fulfill({ json: { total_count: items.length, items } })
    }

    if (path.endsWith('/update-branch')) {
      return route.fulfill({
        status: opts.updateStatus ?? 202,
        json: opts.updateBody ?? { message: 'Updating pull request branch.' },
      })
    }

    // The two REST calls a CiSummary costs, served so that opening one fix
    // panel can be MEASURED rather than mocked away. Annotations first: both
    // paths contain "check-runs".
    if (path.endsWith('/annotations')) {
      return route.fulfill({ json: [{ message: 'expected 1 to be 2' }] })
    }
    if (path.endsWith('/check-runs')) {
      return route.fulfill({
        json: {
          total_count: 2,
          check_runs: [
            { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
            {
              id: 9001,
              name: 'unit (node 22)',
              status: 'completed',
              conclusion: 'failure',
              html_url: `https://github.com/${OWNER}/${REPO}/runs/9001`,
            },
          ],
        },
      })
    }

    return route.fulfill({ json: [] })
  })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    githubAuth: { token: 'ghp_signals', method: 'pat', scopes: [] },
    deepseekKey: 'sk-signals-test',
    aiProvider: 'deepseek',
  })
}

/**
 * Pair a bridge that is READY at `head`, stubbed at the `window.fetch` seam.
 *
 * Same technique as e2e/bridge.spec.ts and for the same reason: the real call
 * is cross-origin to 127.0.0.1 with an Authorization header, so intercepting it
 * with page.route would drag CORS into assertions that are not about CORS.
 * Everything that is not the bridge falls through to the real fetch, so the
 * api.github.com counting this file exists for is untouched.
 */
async function pairBridge(page: Page, head: string, push = true) {
  await page.addInitScript(
    ({ health, key }) => {
      localStorage.setItem(key, JSON.stringify({ token: 'e2e-queue-bridge-token', port: 7321 }))
      const realFetch = window.fetch.bind(window)
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('127.0.0.1') && url.includes('/v1/health')) {
          return Promise.resolve(
            new Response(JSON.stringify(health), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
        return realFetch(input as RequestInfo, init)
      }
    },
    {
      key: 'review123:bridge',
      health: {
        ok: true,
        protocol: 1,
        root: 'web',
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
          push,
        },
        git: { head, branch: 'feat/thing', dirty: false },
      },
    },
  )
}

async function waitForSignals(page: Page) {
  await expect(page.getByText('Your review queue')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('queue-size')).toHaveCount(ROWS.length, { timeout: 20_000 })
  await expect(page.getByTestId('queue-ci')).toHaveCount(CI_MARKS, { timeout: 20_000 })
  await expect(page.getByTestId('queue-unresolved')).toHaveCount(UNRESOLVED_MARKS, { timeout: 20_000 })
}

// ---------------------------------------------------------------------------
// The request budget
// ---------------------------------------------------------------------------

test('the whole queue is drawn without a single per-row fetch', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await page.goto('/')
  await waitForSignals(page)
  // Give any straggling per-row fetch a chance to show up before counting.
  await page.waitForTimeout(1000)

  const perRow = seen.filter((s) => /\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(s))
  const graphql = seen.filter((s) => s.endsWith('/graphql'))
  const searches = seen.filter((s) => s.includes('/search/issues'))

  // The size chips, the CI marks and the conversation counts are all on screen,
  // and NOTHING was fetched per row to put them there. Before this, the sizes
  // alone cost one REST call per GitHub row.
  expect(perRow, `per-row fetches: ${perRow.join(', ')}`).toHaveLength(0)
  // Two searches (review-requested + author), one signals document, one
  // merge-state document for the user's own PRs. Four requests, whatever the
  // queue's length.
  expect(searches).toHaveLength(2)
  expect(graphql).toHaveLength(2)
  expect(seen).toHaveLength(4)
})

test('the signals query does not grow a request when the queue grows', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await page.goto('/')
  await waitForSignals(page)

  // Five rows, one signals document. The batch cap is twenty, so the shape that
  // matters — requests do not scale with rows — is visible here and pinned by
  // the unit tests at the boundary.
  const signalDocs = seen.filter((s) => s.endsWith('/graphql'))
  expect(signalDocs.length).toBeLessThanOrEqual(2)
})

// ---------------------------------------------------------------------------
// The CI-fix panel's share of the budget
//
// The panel needs a full CiSummary, which the batched signals query does not
// and cannot carry: the query answers a rollup STATE per row, and the summary
// is a REST pass over check-runs plus one annotations call per failed job.
// Doing that for every red row on render is exactly the per-row shape this
// whole feature was built to kill — so it is fetched when a panel is OPENED,
// and these two tests are what keeps that measured rather than assumed.
//
// #102 is the only row that can offer it: the user's own (a push goes to its
// head branch), on GitHub, actually failing, and — with the bridge below paired
// at its head — the one commit the bridge could work on.
// ---------------------------------------------------------------------------

test('a red queue still renders inside the same budget, panel offer and all', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await pairBridge(page, sha(102))
  await page.goto('/')
  await waitForSignals(page)

  // Offered on exactly one row, and on the right one.
  await expect(page.getByTestId('queue-ci-fix')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator('.queue-item', { hasText: '#102' }).getByTestId('queue-ci-fix')).toBeVisible()
  // #201 is red too, but it is somebody else's pull request.
  await expect(page.locator('.queue-item', { hasText: '#201' }).getByTestId('queue-ci-fix')).toHaveCount(0)

  await page.waitForTimeout(1000)
  // Not one check-run read. The offer costs nothing; only accepting it does.
  expect(seen.filter((s) => s.includes('/check-runs'))).toHaveLength(0)
  expect(seen).toHaveLength(4)
})

test('the actions column still lands at one x, on the row with two controls too', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await pairBridge(page, sha(102))
  await page.goto('/')
  await waitForSignals(page)
  await expect(page.getByTestId('queue-ci-fix')).toHaveCount(1, { timeout: 10_000 })

  // #287's whole row design is a table: every trailing column at the same x on
  // every row, held to half a pixel by e2e/queue-columns.spec.ts. A control that
  // widened only its own row's actions cell broke that by 12.9px at 1440 —
  // which is why the column is reserved for the list, not for the row.
  const lefts = async () =>
    page.locator('.prepare-cell').evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().left * 10) / 10),
    )

  const closed = await lefts()
  expect(closed.length).toBeGreaterThan(1)
  expect(Math.max(...closed) - Math.min(...closed)).toBeLessThanOrEqual(0.5)

  // And opening it does not move anything either: the measure is sized for the
  // wider of the two labels, so "Fix CI" → "Hide CI" reflows nothing.
  await page.locator('.queue-item', { hasText: '#102' }).getByTestId('queue-ci-fix').click()
  await expect(page.getByTestId('ci-fix-panel')).toBeVisible({ timeout: 10_000 })
  const open = await lefts()
  expect(Math.max(...open) - Math.min(...open)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(open[0] - closed[0])).toBeLessThanOrEqual(0.5)
})

test('opening one panel fetches one summary, for that row’s head and no other', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await pairBridge(page, sha(102))
  await page.goto('/')
  await waitForSignals(page)

  const row = page.locator('.queue-item', { hasText: '#102' })
  await row.getByTestId('queue-ci-fix').click()

  // The panel has the real failure list — the rollup word could not have
  // produced a job name.
  await expect(page.getByTestId('ci-fix-panel')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('ci-fix-jobs')).toContainText('unit (node 22)')

  await page.waitForTimeout(500)
  const checkRuns = seen.filter((s) => s.endsWith('/check-runs'))
  const annotations = seen.filter((s) => s.endsWith('/annotations'))
  expect(checkRuns).toEqual([`GET /repos/${OWNER}/${REPO}/commits/${sha(102)}/check-runs`])
  // One per FAILED run, not per run: `lint` passed and was never asked about.
  expect(annotations).toHaveLength(1)
  // Four to draw the page, two to open one panel.
  expect(seen).toHaveLength(6)

  // Closing costs nothing, and discards the summary with the panel. Reopening
  // therefore reads CI again rather than showing what it said minutes ago —
  // which is the right trade for a user-driven click on a page whose whole
  // point is that it does not fetch per row.
  await row.getByTestId('queue-ci-fix').click()
  await expect(page.getByTestId('ci-fix-panel')).toHaveCount(0)
  expect(seen).toHaveLength(6)

  await row.getByTestId('queue-ci-fix').click()
  await expect(page.getByTestId('ci-fix-panel')).toBeVisible()
  await page.waitForTimeout(500)
  expect(seen).toHaveLength(8)
})

// ---------------------------------------------------------------------------
// What the signals actually draw
// ---------------------------------------------------------------------------

test('each CI state draws its own mark, and no CI configured draws none', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await page.goto('/')
  await waitForSignals(page)

  const stateOf = async (n: number) =>
    page.locator('.queue-item', { hasText: `#${n}` }).getByTestId('queue-ci')

  await expect(await stateOf(101)).toHaveAttribute('data-ci', 'passing')
  await expect(await stateOf(102)).toHaveAttribute('data-ci', 'failing')
  await expect(await stateOf(103)).toHaveAttribute('data-ci', 'running')
  // #202 has no checks configured: an empty cell, never a tick.
  await expect(page.locator('.queue-item', { hasText: '#202' }).getByTestId('queue-ci')).toHaveCount(0)
  // The cell is still there holding the column open.
  await expect(page.locator('.queue-item', { hasText: '#202' }).locator('.ci-cell')).toHaveCount(1)
})

test('the unresolved count is of conversations, not of comments', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await page.goto('/')
  await waitForSignals(page)

  // Row 201 is served four unresolved threads and one resolved one. The answer
  // is four — not five, and not the number of comments in them.
  const chip = page.locator('.queue-item', { hasText: '#201' }).getByTestId('queue-unresolved')
  await expect(chip).toHaveAttribute('title', '4 unresolved conversations')
})

// ---------------------------------------------------------------------------
// Update branch
// ---------------------------------------------------------------------------

test('Update is offered only where it can work', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await page.goto('/')
  await waitForSignals(page)

  const row = (n: number) => page.locator('.queue-item', { hasText: `#${n}` })

  // Behind + can push → a real control.
  await expect(row(101).getByTestId('queue-base')).toHaveText('Update')
  // Conflicting → words, not a button that would 422.
  const conflicted = row(102).getByTestId('queue-base')
  await expect(conflicted).toHaveText('conflicts')
  expect(await conflicted.evaluate((el) => el.tagName)).not.toBe('BUTTON')
  // Up to date → nothing to say.
  await expect(row(103).getByTestId('queue-base')).toHaveCount(0)
  // Not the user's PR → base standing was never even asked for.
  await expect(row(201).getByTestId('queue-base')).toHaveCount(0)
})

test('Update merges on the server, then re-reads what CI is actually doing', async ({ page }) => {
  const seen: Seen = []
  // The merge puts a new commit on the branch: CI starts over and the PR is no
  // longer behind. The page learns that by ASKING, not by assuming.
  await seedQueue(page, seen, { afterUpdate: { ci: 'PENDING', merge: 'CLEAN' } })
  await page.goto('/')
  await waitForSignals(page)

  const row = page.locator('.queue-item', { hasText: '#101' })
  await row.getByTestId('queue-base').click()

  // The offer is gone because the PR is no longer behind…
  await expect(row.getByTestId('queue-base')).toHaveCount(0, { timeout: 10_000 })
  // …and CI is running again, which is the thing the row could not have known
  // without re-reading.
  await expect(row.getByTestId('queue-ci')).toHaveAttribute('data-ci', 'running')

  const puts = seen.filter((s) => s.startsWith('PUT '))
  expect(puts).toEqual([`PUT /repos/${OWNER}/${REPO}/pulls/101/update-branch`])
})

test('a refused update says so on the row, with GitHub’s reason, and can be retried', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen, {
    updateStatus: 422,
    updateBody: { message: 'merge conflict between base and head' },
  })
  await page.goto('/')
  await waitForSignals(page)

  const row = page.locator('.queue-item', { hasText: '#101' })
  await row.getByTestId('queue-base').click()

  const retry = row.getByTestId('queue-base')
  await expect(retry).toHaveText('Retry')
  await expect(retry).toHaveAttribute('title', 'merge conflict between base and head')

  // Retrying really re-fires the call rather than being a dead label.
  await retry.click()
  await expect(retry).toHaveText('Retry')
  expect(seen.filter((s) => s.startsWith('PUT '))).toHaveLength(2)
})

// ---------------------------------------------------------------------------
// Section weight
// ---------------------------------------------------------------------------

test('the page leads with the user’s own PRs', async ({ page }) => {
  const seen: Seen = []
  await seedQueue(page, seen)
  await page.goto('/')
  await waitForSignals(page)

  const titles = await page.locator('.queue-group-title').allTextContents()
  expect(titles.map((t) => t.trim())).toEqual(['Your open PRs', 'Awaiting your review'])

  // And the lead group is above the other one on screen, not merely first in
  // the DOM — the rule that separates them could have been placed either way.
  const mine = await page.getByTestId('queue-group-mine').boundingBox()
  const awaiting = await page.getByTestId('queue-group-awaiting').boundingBox()
  expect(mine!.y).toBeLessThan(awaiting!.y)
})
