/**
 * e2e/queue-columns.spec.ts — the review queue's columns, measured.
 *
 * WHY THIS FILE EXISTS. The queue's markup put `#ref · title · +a −d · time`
 * inline inside a single anchor with the Prepare button after it, so three
 * columns of data all rode on the end of a VARIABLE-WIDTH title. On a real
 * 14-row queue that produced, at 1440px:
 *
 *     diff-stat column   spread 61.7px
 *     timestamp column   spread 64.9px
 *     Prepare control    spread 55.2px
 *     title measure      varied by 66.8px
 *
 * — raggedness exactly where the eye wants a column to scan. The same markup
 * also overflowed: `.queue-link` was `width: 100%` with a non-shrinking
 * sibling, so the Prepare button ended 55px PAST the card's inner edge at
 * 1440px and pushed the document to 417px against a 400px viewport.
 *
 * Both are GEOMETRY. jsdom computes no layout, so no unit test can see either;
 * the component tests in src/routes/Landing.test.ts assert the structure that
 * makes alignment possible, and this file asserts that it actually happens.
 *
 * The fixture is deliberately nasty: four repos, fourteen rows, titles from 13
 * to 91 characters, PR numbers from two to five digits, and diff stats from
 * `+4 −0` to `+883 −1131`. A layout that aligns on tidy data is not tested.
 */
import { test, expect, type Page } from '@playwright/test'

const OWNER = 'posthog'

interface Row {
  repo: string
  n: number
  title: string
  add: number
  del: number
  ageMin: number
}

const ROWS: Row[] = [
  { repo: 'posthog', n: 21841, title: 'feat(surveys): allow multiple choice questions to be randomized', add: 216, del: 179, ageMin: 480 },
  { repo: 'posthog', n: 21902, title: 'fix: flaky test', add: 4, del: 0, ageMin: 35 },
  { repo: 'posthog', n: 20117, title: 'chore(deps): bump the whole frontend toolchain to the latest majors and regenerate lockfile', add: 883, del: 1131, ageMin: 4320 },
  { repo: 'posthog', n: 21733, title: 'refactor(insights): extract the trends query runner', add: 66, del: 4, ageMin: 120 },
  { repo: 'posthog', n: 21990, title: 'feat: add a new dashboard tile type', add: 41, del: 12, ageMin: 90 },
  { repo: 'posthog-js', n: 1204, title: 'fix(autocapture): do not capture password inputs', add: 18, del: 7, ageMin: 300 },
  { repo: 'posthog-js', n: 1211, title: 'feat: session recording canvas support behind a flag with a long descriptive title', add: 402, del: 88, ageMin: 1560 },
  { repo: 'posthog-js', n: 1180, title: 'docs: readme', add: 6, del: 2, ageMin: 10080 },
  { repo: 'posthog-foss', n: 88, title: 'build: pin node to 20', add: 9, del: 9, ageMin: 720 },
  { repo: 'posthog-foss', n: 91, title: 'feat(api): expose the query endpoint to personal api keys with scoped permissions', add: 155, del: 43, ageMin: 45 },
  { repo: 'posthog-foss', n: 95, title: 'test: cover the batch export retry path', add: 77, del: 21, ageMin: 240 },
  { repo: 'plugin-server', n: 3301, title: 'perf: reduce kafka consumer allocations', add: 31, del: 118, ageMin: 1200 },
  { repo: 'plugin-server', n: 3312, title: 'fix(ingestion): drop events with malformed distinct ids instead of dead-lettering them', add: 240, del: 64, ageMin: 15 },
  { repo: 'plugin-server', n: 3290, title: 'chore: tidy imports', add: 12, del: 30, ageMin: 3000 },
]

async function seedQueue(page: Page) {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())
  await page.route('**/api.deepseek.com/**', (r) => r.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === '/search/issues') {
      // `author:` is the "my open PRs" query — keep that group empty so the
      // measurement is over one homogeneous list.
      if ((url.searchParams.get('q') ?? '').includes('author:')) {
        return route.fulfill({ json: { total_count: 0, items: [] } })
      }
      return route.fulfill({
        json: {
          total_count: ROWS.length,
          items: ROWS.map((r) => ({
            number: r.n,
            title: r.title,
            updated_at: new Date(Date.now() - r.ageMin * 60_000).toISOString(),
            repository_url: `https://api.github.com/repos/${OWNER}/${r.repo}`,
          })),
        },
      })
    }

    const m = path.match(/^\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/)
    if (m) {
      const row = ROWS.find((r) => r.repo === m[1] && String(r.n) === m[2])
      return route.fulfill({
        json: {
          title: row?.title ?? '',
          state: 'open',
          merged: false,
          body: null,
          base: { sha: 'basesha', repo: { private: false } },
          head: { sha: 'headsha' },
          changed_files: 3,
          additions: row?.add ?? 0,
          deletions: row?.del ?? 0,
        },
      })
    }
    return route.fulfill({ json: [] })
  })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    githubAuth: { token: 'ghp_columns', method: 'pat', scopes: [] },
    // A key so Prepare renders LIVE rather than disabled — a disabled control
    // is still laid out, but measuring the real one is the point.
    deepseekKey: 'sk-columns-test',
    aiProvider: 'deepseek',
  })
}

/** Every row's left edge for `selector`, once all 14 rows have their sizes. */
async function columnLefts(page: Page, selector: string): Promise<number[]> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll('.queue-item')]
      .map((li) => li.querySelector(sel))
      .filter((el): el is Element => el !== null)
      .map((el) => Math.round(el.getBoundingClientRect().left * 10) / 10)
  }, selector)
}

async function waitForAllSizes(page: Page) {
  await expect(page.getByText('Your review queue')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('queue-size')).toHaveCount(ROWS.length, { timeout: 20_000 })
}

test('every queue column lands on the same x across a 14-row, 4-repo queue', async ({ page }) => {
  await seedQueue(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await waitForAllSizes(page)

  for (const [label, selector] of [
    ['diff-stat chip', '[data-testid="queue-size"]'],
    ['effort gauge', '.churn'],
    ['timestamp', '.queue-time'],
    ['prepare control', '.prepare-cell'],
    ['title', '.queue-title-text'],
  ] as const) {
    const lefts = await columnLefts(page, selector)
    expect(lefts, `${label}: expected one per row`).toHaveLength(ROWS.length)
    const spread = Math.max(...lefts) - Math.min(...lefts)
    // Zero, not "small": these are fixed measures, so any drift at all means a
    // column has started depending on its neighbour's content again.
    expect(spread, `${label} column spread was ${spread}px across ${ROWS.length} rows`).toBeLessThanOrEqual(0.5)
  }
})

test('the title truncates at ONE measure, so no row is shortened by its neighbours', async ({ page }) => {
  await seedQueue(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await waitForAllSizes(page)

  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('.queue-title-text')].map(
      (el) => Math.round(el.getBoundingClientRect().width * 10) / 10,
    ),
  )
  expect(widths).toHaveLength(ROWS.length)
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.5)
  // And the one measure has to be worth having: the old layout's BEST row got
  // 396px, its worst 330px. A regression that aligned everything at 180px
  // would pass the spread check and still be a loss.
  expect(Math.min(...widths)).toBeGreaterThan(330)
})

test('no row escapes the card, and a 400px viewport does not scroll sideways', async ({ page }) => {
  await seedQueue(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await waitForAllSizes(page)

  // Every row control stays inside the card's padding box. The old layout put
  // the Prepare button 55px PAST it on long-title rows.
  const worstOverflow = await page.evaluate(() => {
    const card = document.querySelector('.queue-section')!
    const cs = getComputedStyle(card)
    const innerRight =
      card.getBoundingClientRect().right -
      parseFloat(cs.paddingRight) -
      parseFloat(cs.borderRightWidth)
    return Math.max(
      0,
      ...[...document.querySelectorAll('.queue-item')].map(
        (li) => li.getBoundingClientRect().right - innerRight,
      ),
    )
  })
  expect(worstOverflow).toBeLessThanOrEqual(0.5)

  await page.setViewportSize({ width: 400, height: 900 })
  await expect(page.getByTestId('queue-size')).toHaveCount(ROWS.length)
  const scroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  // Was 417 vs 400 — 17px of horizontal page scroll, which is what put the
  // Prepare buttons under the scrollbar.
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth)
})

test('at 400px the title keeps a real measure instead of being starved by the columns', async ({ page }) => {
  await seedQueue(page)
  await page.setViewportSize({ width: 400, height: 900 })
  await page.goto('/')
  await waitForAllSizes(page)

  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('.queue-title-text')].map(
      (el) => el.getBoundingClientRect().width,
    ),
  )
  expect(widths).toHaveLength(ROWS.length)
  // Holding the desktop column measures here collapsed the title cell to 0px:
  // the row showed everything about the PR except which PR it was.
  expect(Math.min(...widths)).toBeGreaterThan(200)
})

test('the queue row titles render in the app font, not the browser default', async ({ page }) => {
  await seedQueue(page)
  await page.goto('/')
  await waitForAllSizes(page)

  // A <button> does not inherit font-family. Without an explicit one these
  // titles rendered in the UA default (measured as Arial) on a Plex Sans page.
  const families = await page.evaluate(() =>
    [...document.querySelectorAll('.queue-title-text')]
      .slice(0, 3)
      .map((el) => getComputedStyle(el).fontFamily),
  )
  for (const family of families) expect(family).toContain('IBM Plex Sans')
})

test('the effort gauge ranks by churn, scaled to the largest diff in the queue', async ({ page }) => {
  await seedQueue(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await waitForAllSizes(page)

  const fills = await page.evaluate(() =>
    [...document.querySelectorAll('.queue-item')].map((li) => ({
      ref: li.querySelector('.queue-ref')?.textContent?.trim() ?? '',
      width: li.querySelector('.churn-fill')?.getBoundingClientRect().width ?? 0,
    })),
  )
  const byRef = Object.fromEntries(fills.map((f) => [f.ref, f.width]))

  // #20117 is +883 −1131 = 2014 churn, the largest in the fixture; #21902 is
  // +4 −0. The gauge must say so, and must not say it by colour alone — the
  // +/− figures next to it carry the exact value.
  const biggest = byRef['#20117']
  const smallest = byRef['#21902']
  expect(biggest).toBeGreaterThan(0)
  expect(smallest).toBeGreaterThan(0) // the floor keeps a tiny diff visible
  expect(biggest).toBeGreaterThan(smallest * 5)
  expect(biggest).toBeGreaterThanOrEqual(Math.max(...Object.values(byRef)) - 0.5)
})
