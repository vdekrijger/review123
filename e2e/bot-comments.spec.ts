/**
 * e2e/bot-comments.spec.ts — bot comments are out of the diff by default, one
 * click from showing, and worth their height once shown.
 *
 * The user's report: "these bot comments are quite noisy and distracting during
 * a review with no way to hide or filter them out". Their screenshot: one line
 * of code carrying a veria-ai[bot] comment, two resolved threads, two
 * posthog[bot] comments, two of their own replies and a "Reply (posts now)"
 * button under each — a screen and a half.
 *
 * Route is /demo, whose fixture now carries the four cases this feature turns
 * on (src/lib/demo/fixture.ts § demoComments):
 *   - 9006  a bot comment whose whole body is nested disclosures, INCLUDING a
 *           "Prompt to fix with AI (copy-paste)" section — unresolved, inline
 *           at useSearch.ts RIGHT 22
 *   - 9007  a bot finding the reviewer ANSWERED (9008) — inline at RIGHT 16
 *   - 9004  two resolved bot threads in the per-file "General" block
 *     9005
 *
 * WHY A REAL BROWSER for the last test: the disclosure labels inside a bot
 * comment are the author's words, and app.css's editorial `details > summary`
 * rule (uppercase, letter-spaced, weight 600) inherits into them. Whether the
 * reset in ExistingThread WINS is a cascade question across three stylesheets
 * in separate bundle chunks — a declaration that is out-specified looks exactly
 * like one that is right, in the source. jsdom cannot answer it.
 */

import { test, expect, type Page } from '@playwright/test'

/** The first section of the 200px comment, and the section that must be gone. */
const FIRST_SECTION = 'Issue description'
const OPENED_PROSE = 'Re-throwing inside'
const AI_PROMPT_LABEL = 'Prompt to fix with AI'
/** The reviewer's OWN reply under a bot finding. Must never be hidden. */
const REVIEWER_REPLY = 'Aborting a settled request is a no-op'
const ANSWERED_BOT_FINDING = 'Calling `abort()` on every keystroke'.replace(/`/g, '')

async function openInspect(
  page: Page,
  opts: { theme?: 'light' | 'dark'; diffMode?: 'unified' | 'split' } = {},
) {
  await page.route('**/*posthog.com/**', (r) => r.abort())
  await page.route('**/us.i.posthog.com/**', (r) => r.abort())
  await page.addInitScript(
    (s) => localStorage.setItem('review123:settings', JSON.stringify(s)),
    {
      theme: opts.theme ?? 'light',
      diffMode: opts.diffMode ?? 'unified',
      railCollapsed: true,
      deepseekKey: '',
    },
  )
  await page.goto('/demo')
  await page.getByRole('button', { name: /next step/i }).first().click()
  await page.locator('.diff-tailwindcss-wrapper').first().waitFor({ timeout: 20_000 })
}

// ---------------------------------------------------------------------------
// Hidden by default, counted, one click from showing
// ---------------------------------------------------------------------------

test('bot comments: excluded by default, counted in the toolbar, and revealed in place', async ({
  page,
}) => {
  await openInspect(page)

  const toggle = page.getByTestId('hide-bots-toggle')
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // Nothing hidden silently. One bot thread is hidden BY THE BOT FILTER: 9006.
  // 9004 and 9005 are bot threads too, but they are also resolved, and the
  // resolved filter claims them — so the two counts do not double up.
  const botCount = page.getByTestId('bot-hidden-count')
  await expect(botCount).toContainText('1 bot thread hidden')
  await expect(page.getByTestId('resolved-hidden-count')).toContainText('3 resolved threads hidden')

  // The 200px comment is gone from the diff...
  await expect(page.getByText(FIRST_SECTION)).toHaveCount(0)

  // ...and says so where it was, with a one-click reveal.
  const note = page.getByTestId('bot-hidden-note').first()
  await note.scrollIntoViewIfNeeded()
  await expect(note).toContainText('1 bot thread hidden — show')
  await note.click()

  await expect(page.getByText(FIRST_SECTION).first()).toBeVisible({ timeout: 5_000 })

  // A local reveal does NOT flip the global preference.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(botCount).toContainText('1 bot thread hidden')
})

test('bot comments: a finding the REVIEWER ANSWERED is never hidden', async ({ page }) => {
  await openInspect(page)
  await expect(page.getByTestId('hide-bots-toggle')).toBeVisible({ timeout: 10_000 })

  // With the switch ON and nothing revealed, the reviewer's own words — and the
  // bot finding they answer, which they would otherwise make no sense — are
  // both on screen. This is the whole asymmetry of the rule.
  const reply = page.getByText(REVIEWER_REPLY).first()
  await reply.scrollIntoViewIfNeeded()
  await expect(reply).toBeVisible()
  await expect(page.getByText(ANSWERED_BOT_FINDING).first()).toBeVisible()
})

test('bot comments: turning the switch off restores every bot thread', async ({ page }) => {
  await openInspect(page)
  const toggle = page.getByTestId('hide-bots-toggle')
  await expect(toggle).toBeVisible({ timeout: 10_000 })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('bot-hidden-count')).toHaveCount(0)
  await expect(page.getByTestId('bot-hidden-note')).toHaveCount(0)
  await expect(page.getByText(FIRST_SECTION).first()).toBeVisible({ timeout: 5_000 })
})

test('bot comments: unticking "Hide resolved" hands its bot threads to the bot count, not back to the diff', async ({
  page,
}) => {
  await openInspect(page)
  await expect(page.getByTestId('hide-bots-toggle')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('bot-hidden-count')).toContainText('1 bot thread hidden')

  await page.getByTestId('hide-resolved-toggle').click()
  await expect(page.getByTestId('resolved-hidden-count')).toHaveCount(0)

  // 9004 and 9005 were counted as resolved; now the bot filter holds them. The
  // human resolved thread (9002) comes back; the bot ones stay gone.
  await expect(page.getByTestId('bot-hidden-count')).toContainText('3 bot threads hidden')
  await expect(page.getByText('Should `signal` be required'.replace(/`/g, '')).first()).toBeVisible()
})

for (const diffMode of ['unified', 'split'] as const) {
  test(`bot comments: hidden inline in ${diffMode} mode, revealed at their line`, async ({
    page,
  }) => {
    await openInspect(page, { diffMode })
    await expect(page.getByTestId('hide-bots-toggle')).toBeVisible({ timeout: 10_000 })

    // The hidden thread is anchored INSIDE a hunk, so its note renders inside
    // the diff library's extend-row wrapper rather than in the bottom list.
    const inlineNote = page.locator(
      '.inline-comment-threads [data-testid="bot-hidden-note"]',
    ).first()
    await inlineNote.scrollIntoViewIfNeeded()
    await expect(inlineNote).toBeVisible({ timeout: 10_000 })
    await inlineNote.click()
    await expect(page.getByText(FIRST_SECTION).first()).toBeVisible({ timeout: 5_000 })
  })
}

// ---------------------------------------------------------------------------
// Worth its height once revealed
// ---------------------------------------------------------------------------

test('a revealed bot comment shows content, drops the copy-paste prompt, and says so', async ({
  page,
}) => {
  await openInspect(page)
  const note = page.getByTestId('bot-hidden-note').first()
  await note.scrollIntoViewIfNeeded()
  await note.click()

  const first = page.getByText(FIRST_SECTION).first()
  await expect(first).toBeVisible({ timeout: 5_000 })

  // 1. The reader lands on content, not a stack of shut doors: the FIRST
  //    disclosure is open and its prose is on screen.
  await expect(page.getByText(OPENED_PROSE).first()).toBeVisible()
  const openSections = page.locator('.comment-body details[open]')
  await expect(openSections).toHaveCount(1)

  // 2. The remaining sections are still shut — one open row, not four.
  await expect(page.locator('.comment-body details')).toHaveCount(3)

  // 3. The copy-paste AI prompt is gone, and the thread states it rather than
  //    dropping a section of somebody's comment in silence.
  await expect(page.getByText(AI_PROMPT_LABEL)).toHaveCount(0)
  await expect(page.getByTestId('bot-prompt-section-hidden').first()).toContainText(
    /Copy-paste AI prompt hidden/i,
  )
})

for (const theme of ['light', 'dark'] as const) {
  test(`a bot comment's own section labels are the author's words, not our editorial caps (${theme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme })
    await openInspect(page, { theme })

    const note = page.getByTestId('bot-hidden-note').first()
    await note.scrollIntoViewIfNeeded()
    await note.click()
    await expect(page.getByText(FIRST_SECTION).first()).toBeVisible({ timeout: 5_000 })

    const summary = page.locator('.comment-body details > summary').first()
    const style = await summary.evaluate((el) => {
      const s = getComputedStyle(el)
      return {
        fontWeight: s.fontWeight,
        textTransform: s.textTransform,
        letterSpacing: s.letterSpacing,
      }
    })
    // app.css's `details > summary` sets 600 / uppercase / 0.04em. All three
    // inherit into a summary's children, and these are somebody else's words.
    expect(style.fontWeight).toBe('400')
    expect(style.textTransform).toBe('none')
    expect(style.letterSpacing).toBe('normal')
  })
}

test('the toolbar switch and both counts survive a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 900 })
  await openInspect(page)

  const toggle = page.getByTestId('hide-bots-toggle')
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('bot-hidden-count')).toBeVisible()
  await expect(page.getByTestId('resolved-hidden-count')).toBeVisible()

  // Neither note may push the toolbar past the viewport.
  for (const id of ['bot-hidden-count', 'resolved-hidden-count', 'hide-bots-toggle']) {
    const box = await page.getByTestId(id).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(400)
  }
})
