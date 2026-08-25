/**
 * e2e/symbol-nav.spec.ts — Symbol click-through (Tier 1) on the Inspect step.
 *
 * Fixture: two TS files — src/util.ts DEFINES `computeTotal`, src/app.ts
 * CALLS it. Clicking the `computeTotal` identifier in app.ts's diff opens the
 * symbol popover with:
 *   1. a Definition section pointing at src/util.ts (snippet + file:line), and
 *   2. a "Call points in this PR (N)" section grouped by file.
 * Clicking the definition's file:line jumps ACROSS FILES to util.ts's diff row
 * (flash class). The definition entry expands (peek) to its actual code body
 * inline. Escape closes the popover. Clicking a keyword never opens it.
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

  // PEEK: expand the definition entry to its actual code body, inline.
  const peekToggle = popover.getByRole('button', { name: 'Definition body at src/util.ts:1' })
  await expect(peekToggle).toHaveAttribute('aria-expanded', 'false')
  await peekToggle.click()
  await expect(peekToggle).toHaveAttribute('aria-expanded', 'true')
  const peek = popover.getByTestId('definition-peek')
  await expect(peek).toBeVisible()
  await expect(peek).toContainText('return values.reduce((total, v) => total + v, 0)')
  // The toggle never unmounts, so the focusout idiom must NOT self-close the
  // popover on expand (the #210 lesson).
  await expect(popover).toBeVisible()
  // Collapse again — the body hides, the popover stays.
  await peekToggle.click()
  await expect(popover.getByTestId('definition-peek')).toBeHidden()
  await expect(popover).toBeVisible()

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

// ---------------------------------------------------------------------------
// Tier 2: on-demand "Search repo" — call points OUTSIDE the PR's files via the
// stubbed /search/code endpoint + a contents fetch at the PR's head SHA.
// ---------------------------------------------------------------------------

// A repo file OUTSIDE the PR that calls computeTotal (served at HEAD_SHA).
const OTHER_TS = [
  "import { computeTotal } from './util'",
  'export function report(xs: number[]) {',
  '  return computeTotal(xs) * 2',
  '}',
].join('\n')

test('inspect: Search repo lists call points outside the PR files', async ({ page }) => {
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
    // Code search: one hit OUTSIDE the PR + one hit that IS a PR file (must be
    // excluded — Tier 1 already lists its call points).
    if (path === '/search/code') {
      return route.fulfill({
        json: {
          total_count: 2,
          items: [{ path: 'src/other.ts' }, { path: 'src/app.ts' }],
        },
      })
    }
    // The search result file fetched at the PR's HEAD SHA.
    if (path === `/repos/${OWNER}/${REPO}/contents/src/other.ts`) {
      expect(url.searchParams.get('ref')).toBe(HEAD_SHA)
      return route.fulfill({
        json: { content: Buffer.from(OTHER_TS, 'utf-8').toString('base64'), encoding: 'base64' },
      })
    }
    return route.fulfill({ status: 404, json: { message: 'Not Found' } })
  })

  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Symbol nav test PR/i })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Open the popover on the computeTotal definition token in util.ts.
  const defToken = page
    .locator('#file-src-util-ts .diff-line-content span')
    .filter({ hasText: /^computeTotal$/ })
    .first()
  await expect(defToken).toBeVisible({ timeout: 10_000 })
  await defToken.click()

  const popover = page.getByTestId('symbol-popover')
  await expect(popover).toBeVisible()

  // The "In repo" section is idle: on-demand button, nothing searched yet.
  await expect(popover.getByText('In repo')).toBeVisible()
  const searchBtn = popover.getByRole('button', { name: 'Search repo' })
  await expect(searchBtn).toBeVisible()

  await searchBtn.click()

  // Results: grouped under the out-of-PR file, with real line + snippet rows.
  await expect(popover.getByText('In repo (2)')).toBeVisible({ timeout: 10_000 })
  await expect(popover.locator('.repo-file', { hasText: 'src/other.ts' })).toBeVisible()
  const repoRows = popover.locator('section.repo .ref-row.static')
  await expect(repoRows).toHaveCount(2)
  await expect(repoRows.nth(1)).toContainText('return computeTotal(xs) * 2')
  // Rows are honest about not being jumpable (these files aren't in the diff).
  await expect(repoRows.nth(0)).toHaveAttribute('title', "Not in this PR's diff")
  // The PR's own file (src/app.ts) was excluded from the repo results.
  await expect(popover.locator('section.repo .repo-file', { hasText: 'src/app.ts' })).toHaveCount(0)
  // Honest footnote about the default-branch index + head-SHA re-check.
  await expect(popover.getByText(/default branch index; results re-checked/)).toBeVisible()
})
