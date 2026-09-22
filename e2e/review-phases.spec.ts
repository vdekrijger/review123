/**
 * e2e/review-phases.spec.ts — the Implementation → Tests review phases on the
 * Inspect step (Files mode).
 *
 * Fixture: a PR mixing implementation files (one high-risk auth file, one small
 * file) with two test files. Asserts:
 *   1. The step opens in the Implementation phase: test files are absent from
 *      the diff list AND the file tree, and the deferred count is stated.
 *   2. "Implementation looks good" records the approval and moves to the Tests
 *      phase, which shows ONLY the test files, framed against the approval.
 *   3. The phase survives a reload (per-PR localStorage).
 *   4. "Re-open implementation" is reversible and puts the impl files back.
 *   5. The quiet override: a fresh PR lets the user preview the Tests phase
 *      before approving, and labels it as a preview.
 *
 * Same GitHub-mocking strategy as guided-review.spec.ts.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 92
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

const TEST_PATCH = `@@ -1,2 +1,3 @@
 it('works', () => {
   expect(1).toBe(1)
+  expect(2).toBe(2)
 })`

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Review phases test PR',
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
          { filename: 'src/app.ts', status: 'modified', patch: SMALL_PATCH, additions: 1, deletions: 0 },
          // Test files interleaved so the split is a real partition, not a suffix.
          { filename: 'src/app.test.ts', status: 'modified', patch: TEST_PATCH, additions: 1, deletions: 0 },
          { filename: 'src/auth/core.ts', status: 'added', patch: AUTH_PATCH, additions: 400, deletions: 0 },
          { filename: 'src/auth/core.spec.ts', status: 'added', patch: TEST_PATCH, additions: 1, deletions: 0 },
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
}

/** Open the PR and land on step 2 (Inspect). */
async function gotoInspect(page: import('@playwright/test').Page) {
  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Review phases test PR/i })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
}

const fileNames = (page: import('@playwright/test').Page) =>
  page.locator('article.file-diff header code')

test('inspect: Implementation defers tests, approval unlocks the Tests phase, and it survives a reload', async ({ page }) => {
  await setupRoutes(page)
  await gotoInspect(page)

  // --- 1. Implementation phase is the default ----------------------------
  const phaseGroup = page.getByRole('group', { name: 'Review phase' })
  await expect(phaseGroup).toBeVisible()
  await expect(page.getByTestId('phase-btn-implementation')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'false')

  // Only the two implementation files render — the tests are gone from the list…
  await expect(page.locator('article.file-diff')).toHaveCount(2)
  await expect(fileNames(page)).toHaveText(['src/app.ts', 'src/auth/core.ts'])

  // …and the reviewer is told exactly where they went.
  await expect(page.getByTestId('phase-deferred-note')).toContainText(
    '2 test files — reviewed in the Tests phase',
  )

  // …and they are gone from the file tree too (no dead click targets).
  await page.getByRole('button', { name: 'Open file tree' }).click()
  const tree = page.locator('.file-tree-nav')
  await expect(tree).toBeVisible()
  await expect(tree).toContainText('app.ts')
  await expect(tree.getByText('app.test.ts')).toHaveCount(0)
  await expect(tree.getByText('core.spec.ts')).toHaveCount(0)
  await page.locator('button.tree-drawer-close').click()

  // The Tests tab reads as not-yet-unlocked until the user acts.
  await expect(page.getByTestId('phase-btn-tests')).toContainText('🔒')

  // --- 2. Approve → the Tests phase ---------------------------------------
  await page.getByTestId('phase-approve').click()

  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('article.file-diff')).toHaveCount(2)
  await expect(fileNames(page)).toHaveText(['src/app.test.ts', 'src/auth/core.spec.ts'])

  // Framed against the approval, and pinned to the head sha it was made on.
  await expect(page.getByTestId('phase-tests-lead')).toContainText(
    'against the implementation you approved at abc1234',
  )
  await expect(page.getByTestId('phase-tests-deferred-note')).toContainText(
    '2 implementation files hidden here',
  )
  await expect(page.getByTestId('phase-btn-tests')).not.toContainText('🔒')

  // --- 3. The phase survives a reload -------------------------------------
  // (The app restores the last-visited step, so jump to Inspect via the stepper.)
  await page.reload()
  await expect(page.getByRole('heading', { name: /Review phases test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '2 · Inspect' }).click()

  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')
  await expect(fileNames(page)).toHaveText(['src/app.test.ts', 'src/auth/core.spec.ts'])
  await expect(page.getByTestId('phase-tests-lead')).toContainText('you approved at abc1234')

  // --- 4. Re-open is reversible -------------------------------------------
  await page.getByTestId('phase-reopen').click()
  await expect(page.getByTestId('phase-btn-implementation')).toHaveAttribute('aria-pressed', 'true')
  await expect(fileNames(page)).toHaveText(['src/app.ts', 'src/auth/core.ts'])
  // The approval is withdrawn, so the Tests tab is locked again.
  await expect(page.getByTestId('phase-btn-tests')).toContainText('🔒')
})

test('inspect: the Tests phase is previewable before approval, and says so', async ({ page }) => {
  await setupRoutes(page)
  await gotoInspect(page)

  // The quiet override: clicking Tests works even with no approval on record.
  await page.getByTestId('phase-btn-tests').click()

  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')
  await expect(fileNames(page)).toHaveText(['src/app.test.ts', 'src/auth/core.spec.ts'])

  // It is labelled honestly as a preview — no approval was invented.
  await expect(page.getByTestId('phase-tests-lead')).toContainText(
    "Previewing the tests — the implementation isn't approved yet.",
  )
  await expect(page.getByTestId('phase-btn-tests')).toContainText('🔒')

  // Going back to Implementation still offers the un-taken approval action.
  await page.getByTestId('phase-btn-implementation').click()
  await expect(page.getByTestId('phase-approve')).toHaveText('Implementation looks good')
  await expect(page.getByTestId('phase-approved-note')).toHaveCount(0)
})
