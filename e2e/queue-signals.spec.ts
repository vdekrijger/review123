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
                headRefOid: `sha${row.n}`,
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
