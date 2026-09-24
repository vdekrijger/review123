/**
 * e2e/popover-escape.spec.ts — overlays rendered INSIDE a diff row must escape
 * the library's stacking trap.
 *
 * THE DEFECT, and why it is not a z-index bug. `@git-diff-view` renders every
 * line widget (our inline comment threads and draft editors) inside a wrapper
 * carrying its own `sticky` + `z-[1]` utilities. A positioned element with a
 * z-index ESTABLISHES a stacking context, so everything in that subtree paints
 * at 1 against the root — whatever number a descendant declares. The comment
 * actions menu was trapped at `z-index: 20`, PR #277 moved it to `--z-popover`
 * (250), and it stayed trapped, because 250 and 20 are equally irrelevant
 * inside a context that is itself painted at 1.
 *
 * Measured on this fixture before the fix, with the two surfaces genuinely
 * overlapping: the hit test over the parked draft bar returned
 * `div.review-progress-inline` — the BAR. Neutralise only the library wrapper
 * (`z-index: auto; position: static`) and the same hit test returned
 * `button.comment-menu-item` — the MENU. The wrapper is what decides it, so the
 * fix has to be structural.
 *
 * THE FIX these tests pin: the trapped surfaces are promoted to the browser TOP
 * LAYER via the Popover API (`popover="manual"` + showPopover), which is above
 * every stacking context in the document by construction. This is the idiom
 * VerifyVotesTooltip already uses for the same reason. `z-index` survives only
 * as the fallback floor on browsers without the API.
 *
 * WHY HIT TESTS RATHER THAN COMPUTED STYLE: comparing two `z-index` strings
 * would have reported SUCCESS for the entire life of this bug — both numbers
 * were exactly what their authors intended. Only `elementFromPoint` can answer
 * "which surface actually won this pixel". Every test asserts the two rects
 * OVERLAP first, because a hit test over an empty intersection passes
 * vacuously, which is how this kind of guard rots.
 *
 * NOT COVERED HERE, deliberately: `.findings-popover` (InspectStep). It was
 * suspected of sharing this trap and MEASURED NOT TO — its stacking-context
 * ancestor chain is empty, it is not inside `.diff-line-extend-wrapper`, and it
 * renders in the root context. For it the `--z-popover` token alone was the
 * whole fix, and e2e/skill-reviewers.spec.ts already covers it.
 */

import { test, expect, type Page } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`
const PR_KEY = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`

/**
 * A SHORT viewport. The whole point is the overlap: with a tall window the
 * comment row and the bottom draft bar never meet and the bug is invisible.
 */
const SHORT_VIEWPORT = { width: 1280, height: 620 }

/** Lines 1..4 after the hunk; the seeded comment sits on 3, the draft on 2. */
const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

const COMMENT_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}#discussion_r9001`

async function setupRoutes(page: Page) {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())

  await page.route('**/api.github.com/graphql', (r) =>
    r.fulfill({ json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } } }),
  )

  await page.route('**/api.github.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const base = `/repos/${OWNER}/${REPO}`

    if (path === `${base}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Test PR: add feature',
          state: 'open',
          merged: false,
          body: 'A PR for the stacking-trap test.',
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
    if (path === `${base}/pulls/${PR_NUMBER}/comments`) {
      // line 3 is INSIDE the hunk → renders as an inline line widget, which is
      // the trapping subtree. A comment outside the hunk renders in the
      // bottom-of-file list instead and would NOT reproduce the bug.
      return route.fulfill({
        json: [
          {
            id: 9001,
            user: { login: 'octocat', avatar_url: null },
            body: 'inline seeded comment',
            created_at: '2026-01-01T00:00:00Z',
            path: 'src/feature.ts',
            line: 3,
            side: 'RIGHT',
            in_reply_to_id: null,
            html_url: COMMENT_URL,
          },
        ],
      })
    }
    if (path === `${base}/issues/${PR_NUMBER}/comments`) return route.fulfill({ json: [] })
    if (path === `${base}/pulls/${PR_NUMBER}/commits`) return route.fulfill({ json: [] })
    if (path.startsWith(`${base}/contents/`)) {
      return route.fulfill({
        json: {
          content:
            Buffer.from('unchanged line\nadded line\nanother added line\n').toString('base64') +
            '\n',
          encoding: 'base64',
        },
      })
    }
    return route.fulfill({ json: {} })
  })
}

/** Settings + one inline draft on line 2 (so the draft editor is reachable). */
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
        }),
      )
      localStorage.setItem(
        'review123:ai-consent',
        JSON.stringify({ public: true, private: false }),
      )

      const request = indexedDB.open('review123-drafts', 1)
      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts')
      }
      request.onsuccess = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        db.transaction('drafts', 'readwrite')
          .objectStore('drafts')
          .put(
            {
              path: 'src/feature.ts',
              line: 2,
              side: 'RIGHT',
              body: 'seeded draft body',
              prKey: args.prKey,
            },
            `${args.prKey}|src/feature.ts|2|RIGHT`,
          )
      }
    },
    { theme, prKey: PR_KEY },
  )
}

/** Load the review route and land on step 2 (Inspect), which hosts the diff. */
async function gotoInspect(page: Page, theme: 'light' | 'dark' = 'light') {
  await setupRoutes(page)
  await seedState(page, theme)
  await page.setViewportSize(SHORT_VIEWPORT)
  await page.goto(REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 15_000,
  })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
}

/**
 * Hit-test the intersection of two selectors.
 *
 * `overlap: false` when the rects do not actually cross — the caller asserts on
 * that FIRST so a layout change that separates the surfaces fails loudly
 * instead of passing for free. `winner` names what actually took the pixel, so
 * a failure says which surface won rather than only that ours did not.
 */
async function topmostOverIntersection(page: Page, overlaySel: string, underSel: string) {
  return page.evaluate(
    ({ overlaySel, underSel }) => {
      const over = document.querySelector(overlaySel)
      const under = document.querySelector(underSel)
      if (!over || !under) {
        return { overlap: false, reason: 'missing element', wins: false, winner: '' }
      }
      const a = over.getBoundingClientRect()
      const b = under.getBoundingClientRect()
      const left = Math.max(a.left, b.left)
      const right = Math.min(a.right, b.right)
      const top = Math.max(a.top, b.top)
      const bottom = Math.min(a.bottom, b.bottom)
      if (right - left < 2 || bottom - top < 2) {
        return { overlap: false, reason: 'rects do not intersect', wins: false, winner: '' }
      }
      // Three points across the intersection, not one: a single centre sample
      // can land in a gap between the menu's own children.
      const x = (left + right) / 2
      const ys = [top + 1, (top + bottom) / 2, bottom - 1]
      const hits = ys.map((y) => {
        const el = document.elementFromPoint(x, y)
        return el ? !!el.closest(overlaySel) : false
      })
      const mid = document.elementFromPoint(x, (top + bottom) / 2)
      const winner = mid
        ? `${mid.tagName.toLowerCase()}.${String(mid.className).split(' ').filter(Boolean).slice(0, 3).join('.')}`
        : 'none'
      return { overlap: true, reason: 'ok', wins: hits.every(Boolean), winner }
    },
    { overlaySel, underSel },
  )
}

/**
 * Scroll so `triggerSel` sits `gap` px above the draft bar's top edge, which is
 * what makes the popover open ACROSS the bar. Without this the two surfaces sit
 * hundreds of px apart on this fixture and every hit test below would pass
 * vacuously.
 */
async function parkAboveDraftBar(page: Page, triggerSel: string, gap = 30) {
  const delta = await page.evaluate(
    ({ triggerSel, gap }) => {
      const btn = document.querySelector(triggerSel)
      const bar = document.querySelector('.draft-bar')
      if (!btn || !bar) return null
      return btn.getBoundingClientRect().bottom - (bar.getBoundingClientRect().top - gap)
    },
    { triggerSel, gap },
  )
  if (delta !== null) await page.evaluate((d) => window.scrollBy(0, d), delta)
  await page.waitForTimeout(150)
}

/** Open the actions menu on the inline seeded comment, parked over the bar. */
async function openParkedCommentMenu(page: Page) {
  const thread = page
    .locator('[data-testid="existing-thread"]')
    .filter({ hasText: 'inline seeded comment' })
    .first()
  await expect(thread).toBeVisible({ timeout: 15_000 })

  const trigger = thread.getByRole('button', { name: 'Comment actions' }).first()
  await trigger.scrollIntoViewIfNeeded()
  await parkAboveDraftBar(page, '[data-comment-menu] .comment-menu-btn')

  await trigger.click()
  await expect(page.locator('.comment-menu-popover')).toBeVisible()
  return trigger
}

// ---------------------------------------------------------------------------
// The comment actions menu — the surface the bug was reported on.
// ---------------------------------------------------------------------------

for (const theme of ['light', 'dark'] as const) {
  test(`comment actions menu paints above the sticky draft bar (${theme})`, async ({ page }) => {
    await gotoInspect(page, theme)
    await openParkedCommentMenu(page)

    await expect(page.locator('.draft-bar')).toBeVisible()

    const probe = await topmostOverIntersection(page, '.comment-menu-popover', '.draft-bar')
    expect(probe.overlap, `menu/draft-bar must overlap to test this: ${probe.reason}`).toBe(true)
    expect(probe.wins, `the menu must take the pixel, but "${probe.winner}" did`).toBe(true)

    // And the row the reviewer actually clicks is reachable.
    await expect(page.getByRole('menuitem', { name: /quote reply/i })).toBeVisible()
  })
}

test('comment actions menu paints above the draft bar at a narrow window', async ({ page }) => {
  // The narrow regime turns the context rail into an overlay, so the chrome
  // around the menu is not the chrome the desktop case exercised.
  await gotoInspect(page, 'dark')
  await page.setViewportSize({ width: 720, height: 620 })
  await openParkedCommentMenu(page)

  const probe = await topmostOverIntersection(page, '.comment-menu-popover', '.draft-bar')
  expect(probe.overlap, `menu/draft-bar must overlap to test this: ${probe.reason}`).toBe(true)
  expect(probe.wins, `the menu must take the pixel, but "${probe.winner}" did`).toBe(true)
})

test('comment actions menu stays inside the viewport near the bottom edge', async ({ page }) => {
  // Promotion to the top layer means the menu no longer inherits the anchor's
  // containing block, so placement is ours to get right: it must flip above the
  // trigger rather than hang off the bottom of the screen.
  await gotoInspect(page)
  await openParkedCommentMenu(page)

  const box = await page.locator('.comment-menu-popover').boundingBox()
  expect(box).not.toBeNull()
  const vh = SHORT_VIEWPORT.height
  expect(box!.y, 'menu top is on screen').toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height, 'menu bottom is on screen').toBeLessThanOrEqual(vh)
})

test('comment actions menu keeps Escape-to-close and returns focus to its trigger', async ({
  page,
}) => {
  // A menu that escapes its trap but strands focus is a worse outcome than the
  // bug. Dismissal stays the component's own (popover="manual"), so this is the
  // assertion that the move did not quietly hand it to the UA.
  await gotoInspect(page)
  const trigger = await openParkedCommentMenu(page)
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  await page.keyboard.press('Escape')
  await expect(page.locator('.comment-menu-popover')).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toBeFocused()
})

test('clicking outside still closes the comment actions menu', async ({ page }) => {
  // The popover is promoted for PAINTING only; it stays where it is in the DOM,
  // so the component's existing `closest('[data-comment-menu]')` outside-click
  // test must keep working. This is the test that would catch a "fix" that
  // reparented the menu to <body> and silently broke dismissal.
  await gotoInspect(page)
  await openParkedCommentMenu(page)

  await page.locator('h1, h2').first().click({ force: true })
  await expect(page.locator('.comment-menu-popover')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// The emoji picker — MEASURED to share the identical trap (same wrapper, same
// single-entry stacking chain), so the --z-popover token alone did not fix it.
// ---------------------------------------------------------------------------

test('inline emoji picker paints above the sticky draft bar', async ({ page }) => {
  await gotoInspect(page)

  const annotations = page.locator('[data-testid="inline-annotations"][data-line="2"]')
  await expect(annotations).toBeVisible({ timeout: 15_000 })

  const editBtn = annotations.getByRole('button', { name: /edit/i }).first()
  await editBtn.evaluate((el: HTMLButtonElement) => el.click())

  const emojiBtn = annotations.getByRole('button', { name: /insert emoji/i }).first()
  await expect(emojiBtn).toBeVisible({ timeout: 10_000 })
  await emojiBtn.scrollIntoViewIfNeeded()
  await parkAboveDraftBar(page, '.emoji-wrap button')
  await emojiBtn.evaluate((el: HTMLButtonElement) => el.click())
  await expect(page.locator('.emoji-popover')).toBeVisible()

  const probe = await topmostOverIntersection(page, '.emoji-popover', '.draft-bar')
  expect(probe.overlap, `picker/draft-bar must overlap to test this: ${probe.reason}`).toBe(true)
  expect(probe.wins, `the picker must take the pixel, but "${probe.winner}" did`).toBe(true)
})

test('inline emoji picker keeps Escape-to-close and returns focus to its trigger', async ({
  page,
}) => {
  await gotoInspect(page)

  const annotations = page.locator('[data-testid="inline-annotations"][data-line="2"]')
  await expect(annotations).toBeVisible({ timeout: 15_000 })
  await annotations
    .getByRole('button', { name: /edit/i })
    .first()
    .evaluate((el: HTMLButtonElement) => el.click())

  const emojiBtn = annotations.getByRole('button', { name: /insert emoji/i }).first()
  await expect(emojiBtn).toBeVisible({ timeout: 10_000 })
  await emojiBtn.evaluate((el: HTMLButtonElement) => el.click())
  await expect(page.getByTestId('emoji-picker')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('emoji-picker')).toHaveCount(0)
  await expect(emojiBtn).toBeFocused()
})
