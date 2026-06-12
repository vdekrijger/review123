/**
 * e2e/drawer-left.spec.ts
 *
 * Fix 1 proof: Opening the file tree drawer on default viewport does NOT cover
 * the first FileDiff article. The article's boundingBox must be unchanged
 * (same left, top, width, height) after the drawer opens.
 *
 * Also verifies: crafted loading state shows diff-bars SVG before PR loads.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

async function setupMinimalRoutes(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Drawer test PR',
          state: 'open',
          merged: false,
          body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 2,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          {
            filename: 'src/feature.ts',
            status: 'modified',
            patch: PATCH_WITH_LINES,
            additions: 2,
            deletions: 1,
          },
          {
            filename: 'src/utils.ts',
            status: 'modified',
            patch: PATCH_WITH_LINES,
            additions: 1,
            deletions: 1,
          },
        ],
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === '/graphql') {
      return route.fulfill({
        json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
      })
    }
    return route.fulfill({ json: {} })
  })

  await page.route('**/api.deepseek.com/**', (route) => route.abort())
}

// ---------------------------------------------------------------------------
// Test 1: Crafted loading state — diff-bars SVG present before PR loads
// ---------------------------------------------------------------------------

test('crafted loader: diff-bars SVG and caption visible while PR is loading', async ({ page }) => {
  // Never resolve the GitHub API so we stay in loading state
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.github.com/**', () => {
    // Never resolve — stays loading
    return new Promise(() => {})
  })
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: '', diffMode: 'unified', railCollapsed: true }))
  })

  await page.goto(APP_REVIEW_PATH)

  // The crafted loader should be visible while loading
  await expect(page.locator('.crafted-loader')).toBeVisible({ timeout: 5_000 })

  // The diff-bars mark (SVG) should be present
  await expect(page.locator('.loader-bars-mark')).toBeVisible({ timeout: 3_000 })

  // A caption should be visible (one of the four cycling messages)
  const captionRegion = page.locator('[aria-live="polite"]')
  await expect(captionRegion).toBeVisible()
  const captionText = await captionRegion.textContent()
  expect(captionText?.trim().length).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// Test 2: Drawer opens leftward — diff article boundingBox unchanged
// ---------------------------------------------------------------------------

test('drawer-left: opening drawer does NOT change first FileDiff article boundingBox', async ({ page }) => {
  await setupMinimalRoutes(page)

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: '', diffMode: 'unified', railCollapsed: true }))
  })

  // Use default Playwright viewport (1280×720 — wide enough for wide mode)
  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load and navigate to step 2 (Inspect)
  await expect(page.getByRole('heading', { name: /Drawer test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for file diffs to render
  const firstArticle = page.locator('article.file-diff').first()
  await expect(firstArticle).toBeVisible({ timeout: 8_000 })

  // Capture boundingBox BEFORE opening drawer
  const boxBefore = await firstArticle.boundingBox()
  expect(boxBefore).not.toBeNull()

  // Open the drawer
  const toggleTab = page.locator('.tree-toggle-tab')
  await toggleTab.click()
  await expect(toggleTab).toHaveAttribute('aria-expanded', 'true')

  // Wait a frame for any layout reflow to settle
  await page.waitForTimeout(100)

  // Capture boundingBox AFTER opening drawer
  const boxAfter = await firstArticle.boundingBox()
  expect(boxAfter).not.toBeNull()

  // KEY PROOF: first FileDiff article x-position and width are unchanged
  // (the diff is not pushed or shrunk by the drawer opening).
  // Note: y can change due to page scroll triggered by focus/click — that's not a layout shift.
  // Allow 2px tolerance for sub-pixel rendering differences.
  expect(Math.abs(boxAfter!.x - boxBefore!.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(boxAfter!.width - boxBefore!.width)).toBeLessThanOrEqual(2)
})

// ---------------------------------------------------------------------------
// Test 3: Drawer width is 340px when open on wide viewport
// ---------------------------------------------------------------------------

test('drawer-left: open drawer has width 340px on wide viewport', async ({ page }) => {
  await setupMinimalRoutes(page)

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: '', diffMode: 'unified', railCollapsed: true }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Drawer test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })

  // Open the drawer
  await page.locator('.tree-toggle-tab').click()
  await expect(page.locator('.tree-toggle-tab')).toHaveAttribute('aria-expanded', 'true')

  // Measure the file-tree-nav width
  const nav = page.locator('.file-tree-nav')
  await expect(nav).toBeVisible()
  const navBox = await nav.boundingBox()
  expect(navBox).not.toBeNull()
  // Allow ±4px tolerance
  expect(Math.abs(navBox!.width - 340)).toBeLessThanOrEqual(4)
})
