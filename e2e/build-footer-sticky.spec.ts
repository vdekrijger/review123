/**
 * e2e/build-footer-sticky.spec.ts
 *
 * The global build-provenance footer (BuildIndicator: "build {sha} · {date}")
 * is rendered globally at the END of App.svelte's markup. It must read as a
 * real PAGE footer:
 *
 *   SHORT route (e.g. /settings) — content does not fill the viewport, yet the
 *     sticky-footer flex column makes the footer's bottom sit at/near the
 *     viewport bottom (pinned), NOT floating mid-viewport right after content.
 *
 *   TALL route (the review/inspect flow) — the footer sits BELOW all the
 *     content (you scroll to reach it); it is below the document's tall body,
 *     not overlapping the sticky draft bar / inspect content.
 *
 * In both cases the footer is in NORMAL FLOW (never position:fixed/absolute)
 * and spans the full page width with its border-top.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// A long added hunk so the review/inspect page is much taller than the viewport.
const ADDED_LINES = Array.from({ length: 120 }, (_, i) => `+const v${i} = ${i}`).join('\n')
const LONG_PATCH = `@@ -1,1 +1,121 @@\n const head = 0\n${ADDED_LINES}`

async function blockExternal(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
}

test('SHORT route (/settings): build footer is pinned to the bottom of the viewport, not mid-viewport', async ({
  page,
}) => {
  await blockExternal(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  // /settings is a short page that does not fill 900px of height.
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })

  const footer = page.locator('footer.build-indicator')
  await expect(footer).toBeVisible()

  // Normal flow — never fixed/absolute.
  const position = await footer.evaluate((el) => getComputedStyle(el).position)
  expect(['static', 'relative', 'sticky']).toContain(position)

  const box = await footer.boundingBox()
  const viewportH = page.viewportSize()!.height
  expect(box).not.toBeNull()

  // The footer's BOTTOM edge sits at/near the viewport bottom (the column's
  // growing route region pushed it down). Without the sticky-footer layout it
  // would float up just below the short settings content, far above 900px.
  expect(box!.y + box!.height).toBeGreaterThan(viewportH - 4)
  // And it is not floating mid-viewport: its top is well into the lower half.
  expect(box!.y).toBeGreaterThan(viewportH / 2)

  // Spans the full page width (deliberate footer, with border-top).
  expect(box!.width).toBeGreaterThan(1280 - 4)
})

test('TALL route (review/inspect): build footer sits BELOW the content at the document bottom', async ({
  page,
}) => {
  await blockExternal(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Footer tall-page test PR',
          state: 'open',
          merged: false,
          body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 1,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          {
            filename: 'src/feature.ts',
            status: 'modified',
            additions: 120,
            deletions: 0,
            changes: 120,
            patch: LONG_PATCH,
          },
        ],
      })
    }
    return route.fulfill({ json: {} })
  })

  // Go straight to the inspect step (step 2) — the tall scrolling diff with the
  // sticky file header, sticky drawer, and fixed draft bar.
  await page.goto(`${APP_REVIEW_PATH}/inspect`)
  await expect(page.getByText(/Footer tall-page test PR/)).toBeVisible({ timeout: 10_000 })

  const footer = page.locator('footer.build-indicator')
  await expect(footer).toBeVisible()

  // Normal flow — never fixed/absolute.
  const position = await footer.evaluate((el) => getComputedStyle(el).position)
  expect(['static', 'relative', 'sticky']).toContain(position)

  // The document is taller than the viewport (long diff), so the footer lives
  // below the fold — its position in the page is well past one viewport height.
  const footerTopInDoc = await footer.evaluate((el) => el.getBoundingClientRect().top + window.scrollY)
  expect(footerTopInDoc).toBeGreaterThan(900)

  // Scroll to the very bottom: the footer becomes visible at/near the viewport
  // bottom, sitting below all the content.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const box = await footer.boundingBox()
  const viewportH = page.viewportSize()!.height
  expect(box).not.toBeNull()
  expect(box!.y + box!.height).toBeGreaterThan(viewportH - 60)
})
