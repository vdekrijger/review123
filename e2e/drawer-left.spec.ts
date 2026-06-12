/**
 * e2e/drawer-left.spec.ts
 *
 * Adaptive drawer contract (geometry proofs with real CSS):
 *
 *   MARGIN mode — centered diff + viewport wide enough (≥1750px) that the left
 *     margin fits the 340px tree: the drawer expands LEFTWARD into the margin
 *     and the first FileDiff article's boundingBox is unchanged.
 *
 *   INLINE mode — full-width mode (any viewport) OR centered on a viewport too
 *     narrow for the margin: the drawer opens inline next to its toggle and
 *     PUSHES the diff over (diff shrinks while open). No backdrop, no overlay —
 *     the tree never covers the diff and is always fully on-screen.
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

type DrawerSettings = { diffWidth?: 'centered' | 'full' }

async function gotoInspectStep(page: import('@playwright/test').Page, settings: DrawerSettings = {}) {
  await setupMinimalRoutes(page)
  await page.addInitScript((s) => {
    localStorage.setItem('review123:settings', JSON.stringify({
      deepseekKey: '',
      diffMode: 'unified',
      railCollapsed: true,
      ...s,
    }))
  }, settings)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Drawer test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })
}

async function openDrawer(page: import('@playwright/test').Page) {
  const toggleTab = page.locator('.tree-toggle-tab')
  await toggleTab.click()
  await expect(toggleTab).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(100) // let layout reflow settle
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
// Test 2: MARGIN mode — wide (1900px) + centered: drawer expands leftward into
// the margin; the first FileDiff article boundingBox is unchanged and the tree
// is fully on-screen beside it.
// ---------------------------------------------------------------------------

test('margin mode (wide + centered): drawer opens into the margin, diff boundingBox unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1900, height: 900 })
  await gotoInspectStep(page)

  const firstArticle = page.locator('article.file-diff').first()
  const boxBefore = await firstArticle.boundingBox()
  expect(boxBefore).not.toBeNull()

  await openDrawer(page)

  const boxAfter = await firstArticle.boundingBox()
  expect(boxAfter).not.toBeNull()

  // KEY PROOF: x-position and width unchanged — the drawer dwells in the margin.
  // (y can change due to focus scroll; 2px tolerance for sub-pixel rendering.)
  expect(Math.abs(boxAfter!.x - boxBefore!.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(boxAfter!.width - boxBefore!.width)).toBeLessThanOrEqual(2)

  // The tree is fully on-screen, entirely left of the diff (no overlap)
  const navBox = await page.locator('.file-tree-nav').boundingBox()
  expect(navBox).not.toBeNull()
  expect(navBox!.x).toBeGreaterThanOrEqual(0)
  expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(boxAfter!.x + 2)

  // No backdrop in any regime
  await expect(page.locator('.tree-backdrop')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Test 3: INLINE mode — default viewport (1280px) + centered: no margin to dwell
// in, so the drawer pushes the diff over instead of overlaying it.
// ---------------------------------------------------------------------------

test('inline mode (narrow + centered): drawer pushes the diff over; tree fully visible, no overlay', async ({ page }) => {
  // Default Playwright viewport (1280×720) — too narrow for the 340px margin
  await gotoInspectStep(page)

  const firstArticle = page.locator('article.file-diff').first()
  const boxBefore = await firstArticle.boundingBox()
  expect(boxBefore).not.toBeNull()

  await openDrawer(page)

  const boxAfter = await firstArticle.boundingBox()
  expect(boxAfter).not.toBeNull()

  // KEY PROOF: the diff is PUSHED right and SHRINKS (no overlay) while open
  expect(boxAfter!.x - boxBefore!.x).toBeGreaterThanOrEqual(300)
  expect(boxBefore!.width - boxAfter!.width).toBeGreaterThanOrEqual(300)

  // The tree is fully on-screen and does not cover the diff
  const navBox = await page.locator('.file-tree-nav').boundingBox()
  expect(navBox).not.toBeNull()
  expect(navBox!.x).toBeGreaterThanOrEqual(0)
  expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(boxAfter!.x + 2)

  // No backdrop — the diff stays interactive
  await expect(page.locator('.tree-backdrop')).toHaveCount(0)

  // Closing the drawer gives the diff its width back
  await page.locator('.tree-toggle-tab').click()
  await page.waitForTimeout(100)
  const boxClosed = await firstArticle.boundingBox()
  expect(Math.abs(boxClosed!.x - boxBefore!.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(boxClosed!.width - boxBefore!.width)).toBeLessThanOrEqual(2)
})

// ---------------------------------------------------------------------------
// Test 4: INLINE mode — wide (1600px) + FULL-WIDTH: there is no margin in full
// mode, so even a wide viewport pushes inline. Tree readable, diff not covered.
// ---------------------------------------------------------------------------

test('inline mode (wide + full-width): drawer pushes inline, diff narrows, no overlay', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await gotoInspectStep(page, { diffWidth: 'full' })

  const firstArticle = page.locator('article.file-diff').first()
  const boxBefore = await firstArticle.boundingBox()
  expect(boxBefore).not.toBeNull()

  await openDrawer(page)

  const boxAfter = await firstArticle.boundingBox()
  expect(boxAfter).not.toBeNull()

  // Diff narrows and shifts right — pushed, not covered
  expect(boxAfter!.x - boxBefore!.x).toBeGreaterThanOrEqual(300)
  expect(boxBefore!.width - boxAfter!.width).toBeGreaterThanOrEqual(300)

  // Tree fully visible, entirely left of the diff
  const navBox = await page.locator('.file-tree-nav').boundingBox()
  expect(navBox).not.toBeNull()
  expect(navBox!.x).toBeGreaterThanOrEqual(0)
  expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(boxAfter!.x + 2)

  // No backdrop in full-width mode either
  await expect(page.locator('.tree-backdrop')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Test 5: Drawer width is 340px when open (default viewport) and fully on-screen
// ---------------------------------------------------------------------------

test('open drawer is 340px wide and fully on-screen on the default viewport', async ({ page }) => {
  await gotoInspectStep(page)
  await openDrawer(page)

  const nav = page.locator('.file-tree-nav')
  await expect(nav).toBeVisible()
  const navBox = await nav.boundingBox()
  expect(navBox).not.toBeNull()
  // Allow ±4px tolerance
  expect(Math.abs(navBox!.width - 340)).toBeLessThanOrEqual(4)
  // Fully on-screen (the old leftward drawer hung off-screen at this width)
  expect(navBox!.x).toBeGreaterThanOrEqual(0)
})
