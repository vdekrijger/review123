/**
 * e2e/generated-files.spec.ts — generated-file detection treatment on the
 * Inspect step.
 *
 * Fixture: a PR with one hand-written TS file plus a generated lockfile
 * (pnpm-lock.yaml). Asserts:
 *   1. The lockfile renders with a `generated` chip on its header.
 *   2. The lockfile sorts LAST in the Files-mode diff list (after the normal
 *      file) even though it leads the PR's file list.
 *   3. With focus mode on, EVERY content line of the lockfile is dimmed
 *      (`dimmed-noise`), while the normal file's real code stays bright.
 *
 * Same GitHub-mocking strategy as focus-mode.spec.ts.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 77
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

const NORMAL_PATCH = `@@ -1,2 +1,3 @@
 const existing = 1
 const keep = 2
+const added = 3`

const LOCK_PATCH = `@@ -1,2 +1,5 @@
 lockfileVersion: 5.4
 dependencies:
+  left-pad: 1.3.0
+  is-odd: 3.0.1
+  chalk: 5.0.0`

test('inspect: generated file is chipped, dimmed in focus mode, and sorts last', async ({ page }) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Generated files test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 2,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        // pnpm-lock.yaml listed FIRST — the generated sink must still move it last.
        json: [
          { filename: 'pnpm-lock.yaml', status: 'modified', patch: LOCK_PATCH, additions: 3, deletions: 0 },
          { filename: 'src/sample.ts', status: 'modified', patch: NORMAL_PATCH, additions: 1, deletions: 0 },
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

  // Seed focus mode OFF so we can toggle it on explicitly.
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

  await page.goto(APP_REVIEW_PATH)

  await expect(page.getByRole('heading', { name: /Generated files test PR/i })).toBeVisible({
    timeout: 10_000,
  })

  // Navigate to step 2 (Inspect).
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await expect(page.locator('article.file-diff')).toHaveCount(2)

  // 1. The lockfile carries a `generated` chip.
  await expect(page.locator('.generated-chip')).toHaveCount(1)
  await expect(page.locator('.generated-chip')).toHaveText('generated')

  // 2. Sort-last: the generated lockfile's card is the LAST file card despite
  //    being first in the PR file list.
  const cards = page.locator('article.file-diff')
  await expect(cards.nth(0).locator('header code')).toHaveText('src/sample.ts')
  await expect(cards.nth(1).locator('header code')).toHaveText('pnpm-lock.yaml')

  // 3. Focus mode dims EVERY content line of the generated file.
  const focusToggle = page.getByRole('button', { name: /^Focus:/ })
  await focusToggle.click() // off → imports
  await expect(page.getByRole('button', { name: 'Focus: imports' })).toBeVisible()

  const leftPad = page.locator('.diff-line-content', { hasText: 'left-pad: 1.3.0' })
  const chalk = page.locator('.diff-line-content', { hasText: 'chalk: 5.0.0' })
  await expect(leftPad.first()).toHaveClass(/dimmed-noise/)
  await expect(chalk.first()).toHaveClass(/dimmed-noise/)

  // The normal file's real code line is NOT dimmed.
  const normalCode = page.locator('.diff-line-content', { hasText: 'const added = 3' })
  await expect(normalCode.first()).not.toHaveClass(/dimmed-noise/)
})
