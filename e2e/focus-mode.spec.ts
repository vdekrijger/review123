/**
 * e2e/focus-mode.spec.ts — "Focus mode" import/comment dimming on the Inspect
 * step toolbar.
 *
 * Fixture: one modified TS file whose diff adds an import line and a real code
 * line. Focus mode dims (never hides) the import line by toggling a
 * `dimmed-noise` class on its content cell.
 *
 * Asserts (single page load):
 *   1. Toolbar Focus button is present; seeded 'off' → import line not dimmed.
 *   2. Clicking it cycles to 'imports' → the import content cell gets the
 *      `dimmed-noise` class while the real code line does not.
 *   3. Cycling all the way back to 'off' removes the dimmed class.
 *
 * Same mocking strategy as hide-whitespace.spec.ts.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// src/sample.ts — adds a single-line import, a MULTI-LINE import (opener +
// continuation names + `} from '…'` closing line), and a real code line.
const SAMPLE_PATCH = `@@ -1,2 +1,8 @@
 const existing = 1
 const keep = 2
+import { bar } from './bar'
+import {
+  WidgetCardContent,
+  WidgetCardBodyMessage,
+} from './widget'
+const added = 3`

test('inspect: focus mode dims import lines and toggling off restores them', async ({ page }) => {
  // Block PostHog
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Focus mode test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 1,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          { filename: 'src/sample.ts', status: 'modified', patch: SAMPLE_PATCH, additions: 2, deletions: 0 },
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

  // Seed focus mode OFF so we can exercise the on/off toggle explicitly.
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

  await page.goto(APP_REVIEW_PATH)

  await expect(page.getByRole('heading', { name: /Focus mode test PR/i })).toBeVisible({
    timeout: 10_000,
  })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // The diff renders.
  await expect(page.locator('article.file-diff')).toHaveCount(1)
  await expect(page.getByRole('row', { name: /import \{ bar \}/ })).toBeVisible({ timeout: 10_000 })

  // The toolbar focus toggle is present and reads "off" initially.
  const focusToggle = page.getByRole('button', { name: /^Focus:/ })
  await expect(focusToggle).toBeVisible()
  await expect(focusToggle).toHaveAttribute('aria-pressed', 'false')

  // The import content cell is NOT dimmed while focus is off.
  const importCell = page.locator('.diff-line-content', { hasText: "import { bar } from './bar'" })
  await expect(importCell.first()).not.toHaveClass(/dimmed-noise/)

  // Cycle off → imports.
  await focusToggle.click()
  await expect(focusToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Focus: imports' })).toBeVisible()

  // The import line's content cell now carries the dimmed-noise class…
  await expect(importCell.first()).toHaveClass(/dimmed-noise/)
  // …and the real code line does not.
  const codeCell = page.locator('.diff-line-content', { hasText: 'const added = 3' })
  await expect(codeCell.first()).not.toHaveClass(/dimmed-noise/)

  // The MULTI-LINE import dims its continuation AND closing lines, not just the
  // opener — the original bug. Each of these content cells must be dimmed.
  const opener = page.locator('.diff-line-content', { hasText: 'import {' })
  const contName = page.locator('.diff-line-content', { hasText: 'WidgetCardContent,' })
  const closing = page.locator('.diff-line-content', { hasText: "} from './widget'" })
  await expect(opener.first()).toHaveClass(/dimmed-noise/)
  await expect(contName.first()).toHaveClass(/dimmed-noise/)
  await expect(closing.first()).toHaveClass(/dimmed-noise/)

  // Cycle imports → imports-comments → off, then verify dimming is removed.
  await focusToggle.click() // → imports-comments
  await expect(page.getByRole('button', { name: 'Focus: imports + comments' })).toBeVisible()
  await focusToggle.click() // → off
  await expect(page.getByRole('button', { name: 'Focus: off' })).toBeVisible()
  await expect(focusToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(importCell.first()).not.toHaveClass(/dimmed-noise/)
})
