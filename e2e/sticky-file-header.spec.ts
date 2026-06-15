/**
 * e2e/sticky-file-header.spec.ts — sticky file headers in the step-2 Files-mode
 * diff.
 *
 * Fixture: ONE modified TS file with a long added hunk (~120 lines) so the file
 * is far taller than the viewport. While scrolling down inside that file the
 * header (path + ± counts + copy-path + Viewed checkbox + collapse) must stay
 * pinned just below the app topbar instead of scrolling away.
 *
 * Asserts (single page load):
 *   1. The file header carries the `sticky-header` class.
 *   2. After scrolling deep into the file, the header is still in view and its
 *      top sits at/below the sticky offset (the app topbar height) and well
 *      above the bottom of the viewport — i.e. it pinned, it did not scroll off.
 *   3. The Viewed checkbox is clickable MID-SCROLL (without scrolling back up)
 *      and toggling it flips the viewed state (article collapses).
 *
 * Same GitHub-mocking strategy as focus-mode.spec.ts.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// A long added hunk: 120 new lines so the file is much taller than the viewport.
const ADDED_LINES = Array.from({ length: 120 }, (_, i) => `+const v${i} = ${i}`).join('\n')
const LONG_PATCH = `@@ -1,1 +1,121 @@\n const head = 0\n${ADDED_LINES}`

test('inspect: file header stays sticky while scrolling and Viewed stays clickable', async ({ page }) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Sticky header test PR',
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
          { filename: 'src/long.ts', status: 'modified', patch: LONG_PATCH, additions: 120, deletions: 0 },
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

  // Files mode (no AI key → story mode unavailable), rail collapsed.
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

  await page.setViewportSize({ width: 1100, height: 700 })
  await page.goto(APP_REVIEW_PATH)

  await expect(page.getByRole('heading', { name: /Sticky header test PR/i })).toBeVisible({
    timeout: 10_000,
  })

  // Step 2 (Inspect).
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await expect(page.locator('article.file-diff')).toHaveCount(1)

  const header = page.locator('article.file-diff > header')
  await expect(header).toHaveClass(/sticky-header/)

  // Resolve the sticky offset (app topbar height) from the live CSS var.
  const topbarH = await page.evaluate(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim()
    const probe = document.createElement('div')
    probe.style.height = v || '2.75rem'
    document.body.appendChild(probe)
    const px = probe.getBoundingClientRect().height
    probe.remove()
    return px
  })

  // Scroll deep into the file (the page is the scroller).
  await page.evaluate(() => window.scrollTo(0, 1200))
  await page.waitForTimeout(150)

  // Header is still visible and PINNED: its top sits at/just below the topbar
  // offset (allow a small tolerance) and nowhere near scrolled off-screen.
  const box = await header.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(topbarH - 2)
  expect(box!.y).toBeLessThanOrEqual(topbarH + 6)

  // Viewed checkbox is clickable mid-scroll WITHOUT scrolling back up.
  const checkbox = page.getByRole('checkbox', { name: /mark src\/long\.ts as viewed/i })
  await expect(checkbox).not.toBeChecked()
  await checkbox.click()
  await expect(checkbox).toBeChecked()
  // Toggling viewed collapses the file.
  await expect(page.locator('article.file-diff')).toHaveClass(/is-collapsed/)
})
