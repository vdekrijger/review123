/**
 * e2e/hide-whitespace.spec.ts — "Hide whitespace changes" toggle on the
 * Inspect step toolbar.
 *
 * Fixture: two modified files with full contents served by the mocked
 * contents API.
 *   - src/mixed.ts: one real change + one whitespace-only change
 *   - src/ws-only.ts: indentation-only change (entire diff is whitespace)
 *
 * Asserts (single page load, toggle on → assertions → toggle off):
 *   1. Toggle renders next to the Unified/Side-by-side group, off by default.
 *   2. Toggling ON: the whitespace-only file collapses to the
 *      "No changes when hiding whitespace." placeholder and the toolbar
 *      counts it; the ws-only row in the mixed file disappears while the
 *      real change stays; the comment-anchoring note appears.
 *   3. Toggling OFF restores the full diff.
 *
 * Same mocking strategy as review-flow.spec.ts: all GitHub API calls are
 * intercepted via page.route(), PostHog is blocked.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// src/mixed.ts — a real change AND a whitespace-only change, embedded in a
// longer file so lines are hidden above/below the hunk (the expand affordance
// is used as the "contents have loaded" signal).
const MIXED_BEFORE =
  ['line one', 'line two', 'line three', 'alpha', 'foo bar', 'keep', 'real change', 'end', 'line nine', 'line ten', 'line eleven', 'line twelve'].join('\n') + '\n'
const MIXED_AFTER =
  ['line one', 'line two', 'line three', 'alpha', 'foo  bar', 'keep', 'real CHANGE', 'end', 'line nine', 'line ten', 'line eleven', 'line twelve'].join('\n') + '\n'
const MIXED_PATCH = `@@ -4,5 +4,5 @@
 alpha
-foo bar
+foo  bar
 keep
-real change
+real CHANGE
 end`

// src/ws-only.ts — indentation-only change
const WS_ONLY_BEFORE = ['function f() {', 'return wsonly', '}'].join('\n') + '\n'
const WS_ONLY_AFTER = ['function f() {', '  return wsonly', '}'].join('\n') + '\n'
const WS_ONLY_PATCH = `@@ -1,3 +1,3 @@
 function f() {
-return wsonly
+  return wsonly
 }`

test('inspect: hide-whitespace toggle collapses ws-only file and hides ws-only rows', async ({
  page,
}) => {
  // Block PostHog
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Whitespace test PR',
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
          { filename: 'src/mixed.ts', status: 'modified', patch: MIXED_PATCH, additions: 2, deletions: 2 },
          { filename: 'src/ws-only.ts', status: 'modified', patch: WS_ONLY_PATCH, additions: 1, deletions: 1 },
        ],
      })
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      const ref = url.searchParams.get('ref') ?? ''
      const filePath = decodeURIComponent(path.replace(`/repos/${OWNER}/${REPO}/contents/`, ''))
      let content: string | null = null
      if (filePath === 'src/mixed.ts') content = ref === BASE_SHA ? MIXED_BEFORE : MIXED_AFTER
      if (filePath === 'src/ws-only.ts') content = ref === BASE_SHA ? WS_ONLY_BEFORE : WS_ONLY_AFTER
      if (content !== null) {
        const b64 = Buffer.from(content).toString('base64')
        return route.fulfill({ json: { content: b64 + '\n', encoding: 'base64' } })
      }
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
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
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true })

  await page.goto(APP_REVIEW_PATH)

  await expect(page.getByRole('heading', { name: /Whitespace test PR/i })).toBeVisible({
    timeout: 10_000,
  })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Toggle present, off by default
  const wsToggle = page.getByRole('button', { name: 'Hide whitespace' })
  await expect(wsToggle).toBeVisible()
  await expect(wsToggle).toHaveAttribute('aria-pressed', 'false')

  // Both diffs render normally; the ws-only change shows as -/+ rows initially.
  // (Accessible row names collapse whitespace, so "foo  bar" reads as "foo bar";
  // the +/- markers are what distinguish changed rows from context rows.)
  await expect(page.locator('article.file-diff')).toHaveCount(2)
  await expect(page.getByRole('row', { name: /- foo bar/ })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('row', { name: /\+ foo bar/ })).toBeVisible()

  // Wait until contents have loaded (expand affordance appears), so the toggle
  // can actually recompute rather than fall back to "unavailable".
  await expect(
    page.locator('button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]').first(),
  ).toBeVisible({ timeout: 10_000 })

  // Toggle ON
  await wsToggle.click()
  await expect(wsToggle).toHaveAttribute('aria-pressed', 'true')

  // The whitespace-only file collapses to the placeholder, and is counted
  await expect(page.getByText('No changes when hiding whitespace.')).toBeVisible()
  await expect(page.getByText('1 whitespace-only file hidden')).toBeVisible()

  // The mixed file: the ws-only change is no longer marked as changed rows
  // (it renders as plain context now); the real change keeps its -/+ rows.
  await expect(page.getByRole('row', { name: /- foo bar/ })).toHaveCount(0)
  await expect(page.getByRole('row', { name: /\+ foo bar/ })).toHaveCount(0)
  await expect(page.getByRole('row', { name: /- real change/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /\+ real CHANGE/ })).toBeVisible()

  // Comment-anchoring note shows on the recomputed file
  await expect(
    page.getByText(/Line comments are disabled while whitespace changes are hidden/).first(),
  ).toBeVisible()

  // Toggle OFF restores the full diff
  await wsToggle.click()
  await expect(wsToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('No changes when hiding whitespace.')).toHaveCount(0)
  await expect(page.getByRole('row', { name: /- foo bar/ })).toBeVisible()
})
