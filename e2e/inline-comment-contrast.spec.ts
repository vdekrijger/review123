/**
 * e2e/inline-comment-contrast.spec.ts — dark-mode contrast regression guard for
 * inline (extend-row) existing PR comments.
 *
 * Bug: @git-diff-view forces `.diff-line-extend-wrapper * { color: initial }`
 * on every descendant of an inline annotation row that lacks its own explicit
 * color (the comment body, time, markdown <p>, …). `initial` for `color` is the
 * `canvastext` SYSTEM color, so the text no longer tracks the app's --text token
 * — it tracks whatever the browser/OS resolves canvastext to for the active
 * color-scheme. In the user's environment that lands as a low-contrast value on
 * the dark comment banner (washed dark-on-dark); only the inline (extend-row)
 * context is affected because the bottom-of-file list sits OUTSIDE the wrapper.
 * FileDiff.svelte re-pins the app text cascade for the inline host with
 * selectors that out-specify the library rule, so the body always resolves to
 * --text (a real token with guaranteed contrast) instead of canvastext.
 *
 * These tests seed a greptile-apps[bot] review comment anchored to a line that
 * IS in the patch hunks, so it renders INLINE inside .diff-line-extend-wrapper,
 * then for BOTH themes assert:
 *   - the comment body's computed color resolves to the app --text token
 *     (NOT the library's initial/black diff-row color), and
 *   - body-text-vs-container-background contrast > 4.5 (WCAG AA body text).
 * A screenshot is attached for each theme.
 */

import { test, expect, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Fixture data — mirrors the skill-reviewers / review-flow specs
// ---------------------------------------------------------------------------

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// line 2 (RIGHT) is present in these hunks → the comment anchors INLINE
const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

// A distinctive marker so we can locate exactly this comment's rendered body.
const COMMENT_MARKER = 'Greptile inline contrast probe body text'

function makePrMeta() {
  return {
    title: 'Test PR: add feature',
    state: 'open',
    merged: false,
    body: 'This PR adds a new feature.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 1,
  }
}

function makePrFiles() {
  return [
    {
      filename: 'src/feature.ts',
      status: 'modified',
      patch: PATCH_WITH_LINES,
      additions: 2,
      deletions: 1,
    },
  ]
}

function makeFileContent(text: string) {
  const b64 = Buffer.from(text).toString('base64')
  return { content: b64 + '\n', encoding: 'base64' }
}

/** One existing review comment from a bot, anchored to line 2 on the RIGHT. */
function makeReviewComments() {
  return [
    {
      id: 9001,
      user: { login: 'greptile-apps[bot]', avatar_url: null },
      body: COMMENT_MARKER,
      created_at: '2026-01-01T00:00:00Z',
      path: 'src/feature.ts',
      line: 2,
      side: 'RIGHT',
      in_reply_to_id: null,
    },
  ]
}

function seedSettings(theme: 'dark' | 'light') {
  return {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
    theme,
  }
}

async function setupRoutes(page: Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({ json: makePrMeta() })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: makePrFiles() })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      const ref = url.searchParams.get('ref') ?? ''
      const filePath = decodeURIComponent(path.replace(`/repos/${OWNER}/${REPO}/contents/`, ''))
      if (filePath === 'src/feature.ts' && ref === BASE_SHA) {
        return route.fulfill({ json: makeFileContent('const old = 1\nremoved line\ntrailing context') })
      }
      if (filePath === 'src/feature.ts' && ref === HEAD_SHA) {
        return route.fulfill({ json: makeFileContent('const old = 1\nunchanged line\nadded line\nanother added line\ntrailing context') })
      }
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: makeReviewComments() })
    }
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) {
      return route.fulfill({ json: [] })
    }
    if (path === '/graphql' && route.request().method() === 'POST') {
      return route.fulfill({
        json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
      })
    }
    return route.fulfill({ json: {} })
  })
}

// ---------------------------------------------------------------------------
// Color helpers — parse rgb() and compute WCAG contrast
// ---------------------------------------------------------------------------

function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (!m) throw new Error(`cannot parse color: ${css}`)
  const parts = m[1].split(',').map((p) => parseFloat(p.trim()))
  return [parts[0], parts[1], parts[2]]
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relLuminance(parseRgb(fg))
  const l2 = relLuminance(parseRgb(bg))
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** Walk up the ancestor chain to the first element with a non-transparent bg. */
async function effectiveBackground(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (el) => {
    let node: HTMLElement | null = el as HTMLElement
    while (node) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
      node = node.parentElement
    }
    return getComputedStyle(document.body).backgroundColor
  })
}

// ---------------------------------------------------------------------------
// Parametrized over both themes
// ---------------------------------------------------------------------------

for (const theme of ['dark', 'light'] as const) {
  test(`inline existing comment body uses app --text with AA contrast (${theme} theme)`, async ({
    page,
  }, testInfo) => {
    await setupRoutes(page)
    await page.addInitScript((settings) => {
      localStorage.setItem('review123:settings', JSON.stringify(settings))
    }, seedSettings(theme))
    await page.addInitScript(() => {
      localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
    })

    await page.goto(APP_REVIEW_PATH)

    await expect(
      page.getByRole('heading', { name: /Test PR: add feature/i }),
    ).toBeVisible({ timeout: 10_000 })

    // The app must have applied the theme attribute we seeded.
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

    // Step 2 (Inspect) hosts the diff with inline annotations.
    await page.getByRole('button', { name: 'Next step' }).click()
    await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

    // The comment renders INLINE inside the diff library's extend-row wrapper.
    const inlineThread = page.locator(
      '.diff-line-extend-wrapper .inline-comment-threads [data-testid="existing-thread"]',
    )
    await expect(inlineThread).toBeVisible({ timeout: 10_000 })

    const body = inlineThread.locator('.comment-body').filter({ hasText: COMMENT_MARKER }).first()
    await expect(body).toBeVisible()

    // Read the resolved color of the actual rendered markdown text node and the
    // app's --text token, plus the effective background behind the comment.
    const bodyColor = await body.evaluate((el) => getComputedStyle(el).color)
    const appText = await page.evaluate(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--text').trim()
      // Resolve the token to an rgb() string via a throwaway element.
      const probe = document.createElement('span')
      probe.style.color = v
      document.body.appendChild(probe)
      const resolved = getComputedStyle(probe).color
      probe.remove()
      return resolved
    })

    const bg = await effectiveBackground(
      page,
      '.diff-line-extend-wrapper .inline-comment-threads',
    )

    const ratio = contrastRatio(bodyColor, bg)

    // Attach a screenshot of the inline thread for visual proof.
    const shot = await inlineThread.screenshot()
    await testInfo.attach(`inline-comment-${theme}`, { body: shot, contentType: 'image/png' })
    testInfo.annotations.push({
      type: 'contrast',
      description: `${theme}: body=${bodyColor} bg=${bg} app--text=${appText} ratio=${ratio.toFixed(2)}`,
    })

    // 1) Body text color is the app --text token, not the library's initial/black.
    expect(parseRgb(bodyColor)).toEqual(parseRgb(appText))

    // 2) Body-vs-background contrast clears WCAG AA for body text.
    expect(ratio).toBeGreaterThan(4.5)
  })
}
