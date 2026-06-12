/**
 * e2e/fullwidth-rail.spec.ts
 *
 * Proof: full-width diff mode + open context rail → first FileDiff article
 * bounding box does NOT intersect the rail's bounding box.
 *
 * This is the key regression from PR #18: in full-width mode the 70rem
 * centered column disappears and the rail overlaps the content column.
 * Fix: reserve padding-right on .review when data-diffwidth='full' and
 * data-rail-collapsed='false'.
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
          title: 'Full-width rail test PR',
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
// Test 1 (KEY): Full-width + open rail → first FileDiff article does NOT intersect rail
// ---------------------------------------------------------------------------

test('full-width + open rail: first FileDiff article bounding box does not intersect the rail', async ({ page }) => {
  await setupMinimalRoutes(page)

  // Use a wide viewport (≥1444px) to ensure the rail is always visible
  await page.setViewportSize({ width: 1600, height: 900 })

  // Start with full-width mode and rail EXPANDED (not collapsed)
  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({
      deepseekKey: '',
      diffMode: 'unified',
      railCollapsed: false, // rail EXPANDED
      diffWidth: 'full',   // FULL width mode
    }))
  })

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(page.getByRole('heading', { name: /Full-width rail test PR/i })).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect) where InspectStep and ContextRail both render
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for file diffs to render
  const firstArticle = page.locator('article.file-diff').first()
  await expect(firstArticle).toBeVisible({ timeout: 8_000 })

  // Wait for the context rail to be visible (it should be open)
  const rail = page.locator('aside.context-rail')
  await expect(rail).toBeVisible({ timeout: 5_000 })

  // Wait a frame for any layout to stabilize
  await page.waitForTimeout(200)

  // Get bounding boxes for the first article and the rail
  const articleBox = await firstArticle.boundingBox()
  const railBox = await rail.boundingBox()

  expect(articleBox).not.toBeNull()
  expect(railBox).not.toBeNull()

  // KEY ASSERTION: the first FileDiff article must NOT intersect the rail
  // The article's right edge must be to the LEFT of the rail's left edge.
  // Allow 2px tolerance for sub-pixel rendering.
  const articleRight = articleBox!.x + articleBox!.width
  const railLeft = railBox!.x

  expect(articleRight).toBeLessThanOrEqual(railLeft + 2)
})

// ---------------------------------------------------------------------------
// Test 2: Full-width + COLLAPSED rail → article can expand normally (no excess reserve)
// ---------------------------------------------------------------------------

test('full-width + collapsed rail: first FileDiff article is wider than in expanded-rail mode', async ({ page }) => {
  await setupMinimalRoutes(page)

  await page.setViewportSize({ width: 1600, height: 900 })

  // First run: expanded rail → capture article width
  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({
      deepseekKey: '',
      diffMode: 'unified',
      railCollapsed: false,
      diffWidth: 'full',
    }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Full-width rail test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })
  await page.waitForTimeout(200)

  const expandedBox = await page.locator('article.file-diff').first().boundingBox()

  // Collapse the rail (click the collapse button)
  await page.locator('.context-rail .collapse-btn').click()
  await page.waitForTimeout(200)

  const collapsedBox = await page.locator('article.file-diff').first().boundingBox()

  expect(expandedBox).not.toBeNull()
  expect(collapsedBox).not.toBeNull()

  // When rail is collapsed, the article should be wider or same width
  // (the margin-right reserve is released)
  expect(collapsedBox!.width).toBeGreaterThanOrEqual(expandedBox!.width - 2)
})

// ---------------------------------------------------------------------------
// Test 3: Centered mode + open rail → articles don't change position vs before opening
// (regression guard: centered mode layout is unchanged from pre-fix)
// ---------------------------------------------------------------------------

test('centered mode: opening the rail does not change the first article X position', async ({ page }) => {
  await setupMinimalRoutes(page)

  await page.setViewportSize({ width: 1600, height: 900 })

  // Centered mode, rail starts COLLAPSED
  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({
      deepseekKey: '',
      diffMode: 'unified',
      railCollapsed: true,   // start collapsed
      diffWidth: 'centered', // CENTERED mode
    }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Full-width rail test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })
  await page.waitForTimeout(200)

  // Get X position BEFORE expanding rail
  const boxBefore = await page.locator('article.file-diff').first().boundingBox()

  // Expand the rail
  await page.locator('.context-rail .collapse-btn').click()
  await page.waitForTimeout(200)

  // Get X position AFTER expanding rail
  const boxAfter = await page.locator('article.file-diff').first().boundingBox()

  expect(boxBefore).not.toBeNull()
  expect(boxAfter).not.toBeNull()

  // In centered mode, the article X position (left edge) should not change when
  // the rail expands — the rail lives in the margin, not in the content area.
  // Allow 2px tolerance for sub-pixel rendering.
  expect(Math.abs(boxAfter!.x - boxBefore!.x)).toBeLessThanOrEqual(2)
})

// ---------------------------------------------------------------------------
// Test 4: Full-width is genuinely wider than centered on a NARROW viewport.
// Below the 70rem cap both modes used to render identically; in full mode the
// horizontal gutters now collapse to a slim minimum so the diff really widens.
// ---------------------------------------------------------------------------

test('narrow viewport: full-width mode renders a wider diff than centered mode', async ({ page }) => {
  await setupMinimalRoutes(page)
  await page.setViewportSize({ width: 1000, height: 800 })

  // First pass: centered. Only seed settings when absent so the second pass
  // (which flips diffWidth via evaluate) is not clobbered on re-navigation.
  await page.addInitScript(() => {
    if (!localStorage.getItem('review123:settings')) {
      localStorage.setItem('review123:settings', JSON.stringify({
        deepseekKey: '',
        diffMode: 'unified',
        railCollapsed: true,
        diffWidth: 'centered',
      }))
    }
  })
  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Full-width rail test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })
  await page.waitForTimeout(200)
  const centeredBox = await page.locator('article.file-diff').first().boundingBox()
  expect(centeredBox).not.toBeNull()

  // Second pass: full — flip the persisted setting, then navigate to step 1
  // again (the step lives in the URL) and walk back to the Inspect step.
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('review123:settings') ?? '{}')
    settings.diffWidth = 'full'
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  })
  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Full-width rail test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })
  await page.waitForTimeout(200)
  const fullBox = await page.locator('article.file-diff').first().boundingBox()
  expect(fullBox).not.toBeNull()

  // KEY: the diff is genuinely wider in full mode even though 1000px < 70rem.
  // Gutters collapse from 1rem (15px) to 10px per side → at least ~8px wider.
  expect(fullBox!.width).toBeGreaterThanOrEqual(centeredBox!.width + 8)
  // And it starts closer to the viewport edge
  expect(fullBox!.x).toBeLessThan(centeredBox!.x)
})

// ---------------------------------------------------------------------------
// Test 5: Rail + drawer coexistence on a WIDE viewport — full-width mode with
// the rail EXPANDED and the tree drawer OPEN: the article must sit cleanly
// between the tree (left) and the rail (right). Nothing overlaps, no backdrop.
// ---------------------------------------------------------------------------

test('full-width wide + expanded rail + open drawer: tree | diff | rail coexist without overlap', async ({ page }) => {
  await setupMinimalRoutes(page)
  await page.setViewportSize({ width: 1600, height: 900 })

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({
      deepseekKey: '',
      diffMode: 'unified',
      railCollapsed: false, // rail EXPANDED
      diffWidth: 'full',
    }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Full-width rail test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })

  // Open the tree drawer (inline mode in full-width)
  const toggleTab = page.locator('.tree-toggle-tab')
  await toggleTab.click()
  await expect(toggleTab).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(200)

  const articleBox = await page.locator('article.file-diff').first().boundingBox()
  const navBox = await page.locator('.file-tree-nav').boundingBox()
  const railBox = await page.locator('aside.context-rail').boundingBox()

  expect(articleBox).not.toBeNull()
  expect(navBox).not.toBeNull()
  expect(railBox).not.toBeNull()

  // Tree fully on-screen, entirely LEFT of the article
  expect(navBox!.x).toBeGreaterThanOrEqual(0)
  expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(articleBox!.x + 2)

  // Article entirely LEFT of the rail (PR #18 regression guard)
  expect(articleBox!.x + articleBox!.width).toBeLessThanOrEqual(railBox!.x + 2)

  // No backdrop — nothing overlays the diff
  await expect(page.locator('.tree-backdrop')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Test 6: Medium width (1280px, the PR #18 trouble spot) — full-width + rail
// EXPANDED: the medium-regime padding reservation must keep winning over the
// new slim-gutter rule, so content never slides under the rail.
// ---------------------------------------------------------------------------

test('full-width @ 1280px + expanded rail: article never slides under the rail (slim gutter must not override the reserve)', async ({ page }) => {
  await setupMinimalRoutes(page)
  await page.setViewportSize({ width: 1280, height: 800 })

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({
      deepseekKey: '',
      diffMode: 'unified',
      railCollapsed: false, // rail EXPANDED
      diffWidth: 'full',
    }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Full-width rail test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })
  await page.waitForTimeout(200)

  const articleBox = await page.locator('article.file-diff').first().boundingBox()
  const railBox = await page.locator('aside.context-rail').boundingBox()
  expect(articleBox).not.toBeNull()
  expect(railBox).not.toBeNull()

  // The 1100–1443px expanded-rail reservation (Review.svelte) must still win:
  // article's right edge stays left of the rail.
  expect(articleBox!.x + articleBox!.width).toBeLessThanOrEqual(railBox!.x + 2)
})
