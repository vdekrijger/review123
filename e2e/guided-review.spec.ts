/**
 * e2e/guided-review.spec.ts — the deterministic risk-guided flow on the
 * Inspect step (Files mode).
 *
 * Fixture: a PR mixing a HIGH-risk file (large added churn in an auth path),
 * a small normal file, a generated lockfile, and a tests-only file. Asserts:
 *   1. Default stays Narrative — current order (generated sink), NO tail.
 *   2. Switching to "Risk first" orders attention files highest-risk first
 *      and collapses the mechanical files into ONE low-attention tail,
 *      rendered collapsed with an honest count + reason summary.
 *   3. "Mark all N viewed" marks every tail file viewed in one click; the
 *      attention progress line ("M of N attention files reviewed") counts
 *      only attention files, so it does not move.
 *   4. The choice persists per-browser across a reload.
 *
 * Same GitHub-mocking strategy as generated-files.spec.ts.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 91
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

const SMALL_PATCH = `@@ -1,2 +1,3 @@
 const existing = 1
 const keep = 2
+const added = 3`

const AUTH_PATCH = `@@ -0,0 +1,4 @@
+export function issueToken(user: string): string {
+  const secret = deriveSecret(user)
+  return sign(user, secret)
+}`

const LOCK_PATCH = `@@ -1,2 +1,4 @@
 lockfileVersion: 5.4
 dependencies:
+  left-pad: 1.3.0
+  chalk: 5.0.0`

const TEST_PATCH = `@@ -1,2 +1,3 @@
 it('works', () => {
   expect(1).toBe(1)
+  expect(2).toBe(2)
 })`

test('inspect: Risk first orders by attention need, tails mechanical files, mark-all works', async ({ page }) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Guided review test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 4,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          // Served small-file-first so Risk first demonstrably REORDERS.
          { filename: 'src/app.ts', status: 'modified', patch: SMALL_PATCH, additions: 1, deletions: 0 },
          // Lockfile early in the list — must land in the tail, not the top.
          { filename: 'pnpm-lock.yaml', status: 'modified', patch: LOCK_PATCH, additions: 2, deletions: 0 },
          // HIGH deterministic risk: added file, 400 added lines, auth path.
          { filename: 'src/auth/core.ts', status: 'added', patch: AUTH_PATCH, additions: 400, deletions: 0 },
          { filename: 'src/util.test.ts', status: 'modified', patch: TEST_PATCH, additions: 1, deletions: 0 },
        ],
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    return route.fulfill({ status: 404, json: { message: 'Not Found' } })
  })

  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

  await page.goto(APP_REVIEW_PATH)

  await expect(page.getByRole('heading', { name: /Guided review test PR/i })).toBeVisible({
    timeout: 10_000,
  })

  // Navigate to step 2 (Inspect).
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await expect(page.locator('article.file-diff')).toHaveCount(4)

  // 1. Default is Narrative: current order (generated sink → lockfile last),
  //    and NO low-attention tail.
  const sortGroup = page.getByRole('group', { name: 'File order' })
  await expect(sortGroup.getByRole('button', { name: 'Narrative' })).toHaveAttribute('aria-pressed', 'true')
  const narrativeCards = page.locator('article.file-diff header code')
  await expect(narrativeCards.nth(0)).toHaveText('src/app.ts')
  await expect(narrativeCards.nth(3)).toHaveText('pnpm-lock.yaml')
  await expect(page.locator('details.attention-tail')).toHaveCount(0)

  // Progress line counts ATTENTION files only: app.ts + auth/core.ts = 2.
  await expect(page.getByTestId('attention-progress')).toHaveText(/0 of 2 attention files reviewed/)

  // 2. Switch to Risk first: attention files highest-risk first; mechanical
  //    files collapse into the tail (collapsed, honest count + reasons).
  await sortGroup.getByRole('button', { name: 'Risk first' }).click()
  const mainCards = page.locator('.diff-column > [id^="file-"] article.file-diff header code')
  await expect(mainCards).toHaveCount(2)
  await expect(mainCards.nth(0)).toHaveText('src/auth/core.ts') // high risk first
  await expect(mainCards.nth(1)).toHaveText('src/app.ts')

  const tail = page.locator('details.attention-tail')
  await expect(tail).toHaveCount(1)
  await expect(tail).not.toHaveAttribute('open', '')
  await expect(tail).toContainText('2 low-attention files — skim or mark all viewed')
  await expect(tail).toContainText('1 lockfile')
  await expect(tail).toContainText('1 tests only')

  // 3. One-click "Mark all 2 viewed" (works from the collapsed summary).
  await tail.getByRole('button', { name: 'Mark all 2 viewed' }).click()

  // Open the tail and verify both mechanical files are now checked viewed.
  await tail.locator('.attention-tail-label').click()
  await expect(tail).toHaveAttribute('open', '')
  await expect(page.getByRole('checkbox', { name: 'Mark pnpm-lock.yaml as viewed' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Mark src/util.test.ts as viewed' })).toBeChecked()
  // Tail files carry their why-mechanical chips.
  await expect(tail.locator('.triage-chip').filter({ hasText: 'lockfile' })).toHaveCount(1)
  await expect(tail.locator('.triage-chip').filter({ hasText: 'tests only' })).toHaveCount(1)

  // Attention progress does NOT move — tail files aren't attention files.
  await expect(page.getByTestId('attention-progress')).toHaveText(/0 of 2 attention files reviewed/)

  // Viewing an attention file DOES move it.
  await page.getByRole('checkbox', { name: 'Mark src/app.ts as viewed' }).check()
  await expect(page.getByTestId('attention-progress')).toHaveText(/1 of 2 attention files reviewed/)

  // 4. The sort choice persists per-browser across a reload. (The app also
  //    restores the last-visited step, so jump to Inspect via the stepper.)
  await page.reload()
  await expect(page.getByRole('heading', { name: /Guided review test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '2 · Inspect' }).click()
  await expect(
    page.getByRole('group', { name: 'File order' }).getByRole('button', { name: 'Risk first' }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('details.attention-tail')).toHaveCount(1)
})
