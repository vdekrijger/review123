/**
 * e2e/symbol-nav.spec.ts — Symbol click-through (Tier 1) on the Inspect step.
 *
 * Fixture: two TS files — src/util.ts DEFINES `computeTotal`, src/app.ts
 * CALLS it. Clicking the `computeTotal` identifier in app.ts's diff opens the
 * symbol popover with:
 *   1. a Definition section pointing at src/util.ts (snippet + file:line), and
 *   2. a "Call points in this PR (N)" section grouped by file.
 * Clicking the definition's file:line jumps ACROSS FILES to util.ts's diff row
 * (flash class). Escape closes the popover. Clicking a keyword never opens it.
 *
 * Same mocking strategy as focus-mode.spec.ts (route-intercepted GitHub API,
 * no AI, PostHog blocked).
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 77
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// src/util.ts — adds the computeTotal definition.
const UTIL_PATCH = `@@ -1,1 +1,4 @@
+export function computeTotal(values: number[]): number {
+  return values.reduce((total, v) => total + v, 0)
+}
 export const UTIL_VERSION = 1`

// src/app.ts — adds a call to computeTotal.
const APP_PATCH = `@@ -1,2 +1,3 @@
 const items = [1, 2, 3]
+const grandTotal = computeTotal(items)
 export const APP_VERSION = 1`

test('inspect: clicking an identifier opens the symbol popover with definition + call points', async ({ page }) => {
  // Block PostHog
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Symbol nav test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 2,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          { filename: 'src/util.ts', status: 'modified', patch: UTIL_PATCH, additions: 3, deletions: 0 },
          { filename: 'src/app.ts', status: 'modified', patch: APP_PATCH, additions: 1, deletions: 0 },
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

  // No AI in this test
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

  await page.goto(APP_REVIEW_PATH)

  await expect(page.getByRole('heading', { name: /Symbol nav test PR/i })).toBeVisible({
    timeout: 10_000,
  })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Both file diffs render.
  await expect(page.locator('article.file-diff')).toHaveCount(2)
  const defCell = page.locator('#file-src-util-ts .diff-line-content', { hasText: 'export function computeTotal' })
  await expect(defCell.first()).toBeVisible({ timeout: 10_000 })

  // Click the computeTotal identifier on its DEFINITION line in src/util.ts.
  // The lowlight highlighter wraps declaration names in their own hljs token
  // span (hljs-title), so the click target is exactly the identifier.
  const defToken = page
    .locator('#file-src-util-ts .diff-line-content span')
    .filter({ hasText: /^computeTotal$/ })
    .first()
  await expect(defToken).toBeVisible({ timeout: 10_000 })
  await defToken.click()

  // The popover opens with both sections.
  const popover = page.getByTestId('symbol-popover')
  await expect(popover).toBeVisible()
  await expect(popover.getByText('Definition')).toBeVisible()
  // Definition resolved from the patch text of this PR, with file:line.
  await expect(popover.getByText(/export function computeTotal/)).toBeVisible()
  await expect(popover.getByRole('button', { name: /^src\/util\.ts:1$/ })).toBeVisible()
  // Call points: exactly the app.ts call line (the def line is excluded).
  await expect(popover.getByText('Call points in this PR (1)')).toBeVisible()
  await expect(popover.locator('.ref-file-name', { hasText: 'src/app.ts' })).toBeVisible()

  // CROSS-FILE jump: clicking the app.ts reference row closes the popover and
  // flashes the target row in src/app.ts's diff.
  await popover.getByRole('button', { name: /grandTotal = computeTotal\(items\)/ }).click()
  await expect(popover).toBeHidden()
  await expect(page.locator('#file-src-app-ts tr.symbol-jump-flash')).toHaveCount(1, { timeout: 3000 })

  // Reopen and close with Escape.
  await defToken.click()
  await expect(popover).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()

  // Clicking a keyword token never opens the popover.
  const keywordToken = page
    .locator('#file-src-util-ts .diff-line-content span.hljs-keyword', { hasText: 'export' })
    .first()
  await keywordToken.click()
  await expect(popover).toBeHidden()
})
