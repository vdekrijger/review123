/**
 * e2e/tree-height-clamp.spec.ts
 *
 * The open file-tree drawer must never be taller than the diff column it
 * accompanies. A ResizeObserver on .diff-column mirrors its height into
 * --diff-col-h on .inspect-layout, and .file-tree-nav clamps to
 *
 *   max-height: min(calc(100vh - 5rem), max(12rem, var(--diff-col-h, 100vh)))
 *
 * Geometry proofs with real CSS:
 *   - SHORT diff + LONG tree (inline regime): nav height <= diff column height,
 *     even though the tree's content is taller (clamp genuinely engaged).
 *   - Same proof in the MARGIN regime (centered + >=1750px viewport).
 *   - TALL diff: the historic viewport cap (100vh - 5rem) is unchanged.
 *
 * Fixture trick for "short diff, long tree": rename-only files pre-seeded as
 * viewed (collapsed to header-only cards) keep the diff column short, while
 * their long multi-segment directory names wrap across several lines inside
 * the 340px tree, making the tree content tall.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`
// prId format used by the viewed store (Review.svelte): `${provider}:${owner}/${repo}#${number}`
const PR_ID = `github:${OWNER}/${REPO}#${PR_NUMBER}`
// djb2('') — the patchHash the viewed store computes for patch-less (rename-only) files
const EMPTY_PATCH_HASH = '1505'

const SMALL_PATCH = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

// Long collapsed-chain directory names: each wraps over several lines in the
// 340px-wide tree, so every file contributes far more tree height than its
// collapsed (viewed) diff card contributes to the diff column.
function renameOnlyFiles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `feature-modules-area-${i}/internal-request-handlers-${i}/deeply-nested-helper-utilities-${i}/long-tail-shared-fixtures-${i}/component-${i}.ts`,
    previous_filename: `old-feature-modules-${i}/component-${i}.ts`,
    status: 'renamed',
    additions: 0,
    deletions: 0,
  }))
}

function bigPatch(lines: number): string {
  const added = Array.from({ length: lines }, (_, i) => `+added line number ${i}`).join('\n')
  return `@@ -1,1 +1,${lines + 1} @@\n unchanged line\n${added}`
}

type FixtureFile = {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
  previous_filename?: string
}

async function setupRoutes(page: import('@playwright/test').Page, files: FixtureFile[]) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Tree clamp test PR',
          state: 'open',
          merged: false,
          body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: files.length,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: files })
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

type GotoOptions = {
  files: FixtureFile[]
  /** Paths pre-seeded as viewed (collapses their diff cards to header-only). */
  viewedPaths?: string[]
  diffWidth?: 'centered' | 'full'
}

async function gotoInspectStep(page: import('@playwright/test').Page, opts: GotoOptions) {
  await setupRoutes(page, opts.files)
  await page.addInitScript(
    ({ viewedPaths, prId, emptyHash, diffWidth }) => {
      localStorage.setItem('review123:settings', JSON.stringify({
        deepseekKey: '',
        diffMode: 'unified',
        railCollapsed: true,
        ...(diffWidth ? { diffWidth } : {}),
      }))
      if (viewedPaths.length > 0) {
        localStorage.setItem('review123:viewed', JSON.stringify({
          [prId]: viewedPaths.map((path: string) => ({ path, patchHash: emptyHash, viewedAt: 1 })),
        }))
      }
    },
    { viewedPaths: opts.viewedPaths ?? [], prId: PR_ID, emptyHash: EMPTY_PATCH_HASH, diffWidth: opts.diffWidth },
  )

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Tree clamp test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })
}

async function openDrawer(page: import('@playwright/test').Page) {
  const toggleTab = page.locator('.tree-toggle-tab')
  await toggleTab.click()
  await expect(toggleTab).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(150) // let layout + ResizeObserver write settle
}

const TOLERANCE = 4 // px — borders / sub-pixel rounding

function shortDiffLongTreeFixture() {
  const renames = renameOnlyFiles(12)
  const files: FixtureFile[] = [
    { filename: 'src/main.ts', status: 'modified', additions: 2, deletions: 1, patch: SMALL_PATCH },
    ...renames,
  ]
  return { files, viewedPaths: renames.map(f => f.filename) }
}

/**
 * Shared proof: nav height <= diff column height + tolerance, AND the tree's
 * content is genuinely taller than the diff column (so without the clamp the
 * old viewport-only cap would let the nav overhang — the assertion is not
 * vacuous).
 */
async function expectNavClampedToDiffColumn(page: import('@playwright/test').Page) {
  const diffColBox = await page.locator('.diff-column').boundingBox()
  expect(diffColBox).not.toBeNull()

  const nav = page.locator('.file-tree-nav')
  await expect(nav).toBeVisible()
  const navBox = await nav.boundingBox()
  expect(navBox).not.toBeNull()

  // Precondition: the tree CONTENT is meaningfully taller than the diff column
  // (and would also fit under the viewport cap) — i.e. the clamp is what's
  // limiting the nav, not its own content or the viewport.
  const navScrollHeight = await nav.evaluate((el) => el.scrollHeight)
  expect(navScrollHeight).toBeGreaterThan(diffColBox!.height + 50)
  const viewportCap = await page.evaluate(
    () => window.innerHeight - 5 * parseFloat(getComputedStyle(document.documentElement).fontSize),
  )
  expect(diffColBox!.height).toBeLessThan(viewportCap - 50)

  // KEY PROOF: the nav never runs past the diff column it accompanies.
  expect(navBox!.height).toBeLessThanOrEqual(diffColBox!.height + TOLERANCE)

  // And the nav's bottom edge stays at/above the diff column's bottom edge.
  expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(diffColBox!.y + diffColBox!.height + TOLERANCE)
}

// ---------------------------------------------------------------------------
// Test 1: SHORT diff + LONG tree — INLINE regime (full-width mode forces the
// inline push at any viewport; the wide viewport keeps the fixture's long
// filenames on one header line so the diff column stays genuinely short).
// ---------------------------------------------------------------------------

test('short diff + long tree (inline regime): nav is clamped to the diff column height', async ({ page }) => {
  await page.setViewportSize({ width: 1900, height: 1400 })
  const { files, viewedPaths } = shortDiffLongTreeFixture()
  await gotoInspectStep(page, { files, viewedPaths, diffWidth: 'full' })

  const firstArticle = page.locator('article.file-diff').first()
  const boxBefore = await firstArticle.boundingBox()

  await openDrawer(page)

  // Sanity: we really are in the INLINE regime — the drawer pushes the diff
  const boxAfter = await firstArticle.boundingBox()
  expect(boxAfter!.x - boxBefore!.x).toBeGreaterThanOrEqual(300)

  await expectNavClampedToDiffColumn(page)

  // Internal tree scrolling still works: the clamped nav is scrollable
  const nav = page.locator('.file-tree-nav')
  const overflowY = await nav.evaluate((el) => getComputedStyle(el).overflowY)
  expect(overflowY).toBe('auto')
})

// ---------------------------------------------------------------------------
// Test 2: SHORT diff + LONG tree — MARGIN regime (centered @ 1900px)
// ---------------------------------------------------------------------------

test('short diff + long tree (margin regime, >=1750px centered): nav is clamped too', async ({ page }) => {
  await page.setViewportSize({ width: 1900, height: 1400 })
  const { files, viewedPaths } = shortDiffLongTreeFixture()
  await gotoInspectStep(page, { files, viewedPaths })

  const firstArticle = page.locator('article.file-diff').first()
  const boxBefore = await firstArticle.boundingBox()

  await openDrawer(page)

  // Still margin mode (PR #59 contract): the diff column does not move
  const boxAfter = await firstArticle.boundingBox()
  expect(Math.abs(boxAfter!.x - boxBefore!.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(boxAfter!.width - boxBefore!.width)).toBeLessThanOrEqual(2)

  await expectNavClampedToDiffColumn(page)
})

// ---------------------------------------------------------------------------
// Test 3: TALL diff — viewport-cap behaviour unchanged
// ---------------------------------------------------------------------------

test('tall diff: nav keeps the historic viewport cap (100vh - 5rem)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  // 12 files with large patches → diff column far taller than the viewport;
  // long wrapping dir names → tree content taller than the viewport cap, so
  // the nav's actual height lands exactly on the cap.
  const files: FixtureFile[] = renameOnlyFiles(12).map((f, i) => ({
    filename: f.filename,
    status: 'modified',
    additions: 40,
    deletions: 0,
    patch: bigPatch(40),
  }))
  await gotoInspectStep(page, { files })
  await openDrawer(page)

  const diffColBox = await page.locator('.diff-column').boundingBox()
  const navBox = await page.locator('.file-tree-nav').boundingBox()
  expect(diffColBox).not.toBeNull()
  expect(navBox).not.toBeNull()

  // Precondition: the diff column dwarfs the viewport
  expect(diffColBox!.height).toBeGreaterThan(720)

  // The nav fills exactly the historic viewport cap: 100vh - 5rem
  const viewportCap = await page.evaluate(
    () => window.innerHeight - 5 * parseFloat(getComputedStyle(document.documentElement).fontSize),
  )
  expect(Math.abs(navBox!.height - viewportCap)).toBeLessThanOrEqual(3)

  // Tree content overflows the cap → internal scrolling preserved
  const navScrollHeight = await page.locator('.file-tree-nav').evaluate((el) => el.scrollHeight)
  expect(navScrollHeight).toBeGreaterThan(navBox!.height + 50)
})
