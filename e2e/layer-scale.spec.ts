/**
 * e2e/layer-scale.spec.ts — overlays must PAINT above the app's fixed chrome.
 *
 * WHY THIS FILE EXISTS. The reported bug: on the Verdict step the "Copy review
 * command" split menu opened and its dropdown rendered BEHIND the sticky
 * bottom draft bar — the `gh CLI` row was sliced in half by
 * "N comments drafted · ← Prev · Next →". `.review-cmd-dropdown` carried
 * `z-index: 30`; `.draft-bar` carried `z-index: 100`. Both live in the ROOT
 * stacking context (no ancestor of the dropdown establishes one — see the
 * companion unit guard), so 30 simply lost to 100.
 *
 * The number was not the defect; the absence of a scale was. Fourteen files
 * each picked a z-index by hand and cross-referenced each other's magic numbers
 * in comments. `src/app.css` now owns a named `--z-*` scale and
 * `src/lib/theme/layerScale.test.ts` stops raw numbers coming back.
 *
 * WHAT THIS FILE ADDS that the unit guard cannot: the unit guard reads
 * DECLARATIONS. Only a browser can answer "which element is actually on top at
 * this pixel". Every assertion here is a HIT TEST — `elementFromPoint` inside
 * the region where the two surfaces genuinely overlap — because a z-index that
 * is numerically higher can still lose to a stacking context, and a comparison
 * of two computed `z-index` strings would report success in exactly that case.
 *
 * Each test first asserts the two rects OVERLAP. A hit test over an empty
 * intersection passes vacuously, which is how this kind of guard rots.
 */

import { test, expect, type Page } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

/**
 * A SHORT viewport. The whole point is the overlap: at 1000px tall the verdict
 * actions sit far above the bottom bar and the dropdown never reaches it, so
 * the bug is invisible and the test would pass without proving anything.
 */
const SHORT_VIEWPORT = { width: 1280, height: 620 }

const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

function b64(text: string) {
  return { content: Buffer.from(text).toString('base64') + '\n', encoding: 'base64' }
}

/**
 * Minimal GitHub fixture — enough for the review route to load a PR and reach
 * the Verdict step. Everything unrecognised 404s, which the app tolerates.
 */
async function setupRoutes(page: Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const base = `/repos/${OWNER}/${REPO}`

    if (path === `${base}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Test PR: add feature',
          state: 'open',
          merged: false,
          body: 'A PR for the layering test.',
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 1,
        },
      })
    }
    if (path === `${base}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          {
            filename: 'src/feature.ts',
            status: 'modified',
            patch: PATCH_WITH_LINES,
            additions: 2,
            deletions: 1,
          },
        ],
      })
    }
    if (path === `${base}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path.startsWith(`${base}/contents/`)) {
      return route.fulfill({ json: b64('unchanged line\nadded line\nanother added line\n') })
    }
    return route.fulfill({ status: 404, json: { message: 'Not Found' } })
  })

  // GraphQL (resolved-thread lookup) — empty result.
  await page.route('**/api.github.com/graphql', (route) =>
    route.fulfill({ json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } } }),
  )
}

/** Seed settings (GitHub PAT so the Verdict form renders) and one draft. */
async function seedState(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript(
    (args: { theme: string; prKey: string }) => {
      localStorage.setItem(
        'review123:settings',
        JSON.stringify({
          deepseekKey: 'sk-test-deepseek-key',
          diffMode: 'unified',
          railCollapsed: true,
          storyMode: false,
          theme: args.theme,
          githubAuth: { token: 'ghp_test_token', method: 'pat', scopes: ['repo'] },
        }),
      )

      const request = indexedDB.open('review123-drafts', 1)
      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts')
      }
      request.onsuccess = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        const store = db.transaction('drafts', 'readwrite').objectStore('drafts')
        store.put(
          {
            path: 'src/feature.ts',
            line: 3,
            side: 'RIGHT',
            body: 'Seeded draft for the layering test',
            prKey: args.prKey,
          },
          `${args.prKey}|src/feature.ts|3|RIGHT`,
        )
      }
    },
    { theme, prKey: `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}` },
  )
}

/**
 * Hit-test the intersection of two selectors.
 *
 * Returns `overlap: false` when the rects do not actually cross — the caller
 * asserts on that FIRST so a layout change that separates the two surfaces
 * fails loudly instead of passing for free.
 */
async function topmostOverIntersection(page: Page, overlaySel: string, underSel: string) {
  return page.evaluate(
    ({ overlaySel, underSel }) => {
      const over = document.querySelector(overlaySel)
      const under = document.querySelector(underSel)
      if (!over || !under) return { overlap: false, reason: 'missing element' as const, wins: false }

      const a = over.getBoundingClientRect()
      const b = under.getBoundingClientRect()
      const left = Math.max(a.left, b.left)
      const right = Math.min(a.right, b.right)
      const top = Math.max(a.top, b.top)
      const bottom = Math.min(a.bottom, b.bottom)
      if (right - left < 2 || bottom - top < 2) {
        return { overlap: false, reason: 'rects do not intersect' as const, wins: false }
      }

      // Probe three points across the intersection, not one: a single centre
      // sample can land on a gap between the dropdown's own children.
      const ys = [top + 1, (top + bottom) / 2, bottom - 1]
      const x = (left + right) / 2
      const hits = ys.map((y) => {
        const el = document.elementFromPoint(x, y)
        return el ? !!el.closest(overlaySel) : false
      })
      return { overlap: true, reason: 'ok' as const, wins: hits.every(Boolean) }
    },
    { overlaySel, underSel },
  )
}

/** Load the review route and step through to Verdict. */
async function gotoVerdict(page: Page) {
  await page.setViewportSize(SHORT_VIEWPORT)
  await page.goto(REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 15_000,
  })
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('button', { name: /submit review/i })).toBeVisible({ timeout: 10_000 })
}

for (const theme of ['light', 'dark'] as const) {
  test(`copy-review-command dropdown paints above the sticky draft bar (${theme})`, async ({
    page,
  }) => {
    await setupRoutes(page)
    await seedState(page, theme)
    await gotoVerdict(page)

    // The sticky bar is the surface that ate the dropdown.
    await expect(page.locator('.draft-bar')).toBeVisible()

    await page.getByRole('button', { name: /copy review command/i }).click()
    const dropdown = page.locator('.review-cmd-dropdown')
    await expect(dropdown).toBeVisible()

    const probe = await topmostOverIntersection(page, '.review-cmd-dropdown', '.draft-bar')
    // If this fails the test proves nothing — the surfaces must genuinely cross.
    expect(probe.overlap, `dropdown/draft-bar must overlap to test this: ${probe.reason}`).toBe(true)
    expect(probe.wins, 'the dropdown must be the topmost element over the draft bar').toBe(true)

    // And the item the user reported as sliced in half is fully clickable.
    await expect(page.getByRole('menuitem', { name: /gh cli/i })).toBeVisible()
  })
}

/**
 * The narrow window, where the actions row wraps and the dropdown sits lower
 * still relative to the bar. Same defect, different geometry — and the regime
 * where the context rail turns into an overlay, so the chrome around the menu
 * is not the chrome the desktop case exercised.
 *
 * (There is deliberately NO test of this dropdown against the TOPBAR: measured
 * on this fixture the verdict document is 1036px against a 620px viewport, so
 * the trigger can rise at most ~16px past where the topbar would clip it and
 * the two rects never intersect. A test whose overlap can never occur asserts
 * nothing. The popover-over-topbar ORDER is pinned in layerScale.test.ts.)
 */
test('copy-review-command dropdown paints above the draft bar at a narrow window', async ({
  page,
}) => {
  await setupRoutes(page)
  await seedState(page, 'dark')
  await gotoVerdict(page)
  await page.setViewportSize({ width: 720, height: 620 })

  await page.getByRole('button', { name: /copy review command/i }).click()
  await expect(page.locator('.review-cmd-dropdown')).toBeVisible()

  const probe = await topmostOverIntersection(page, '.review-cmd-dropdown', '.draft-bar')
  expect(probe.overlap, `dropdown/draft-bar must overlap to test this: ${probe.reason}`).toBe(true)
  expect(probe.wins, 'the dropdown must be the topmost element over the draft bar').toBe(true)
})
