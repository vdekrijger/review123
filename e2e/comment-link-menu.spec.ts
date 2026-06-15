/**
 * e2e/comment-link-menu.spec.ts — per-comment actions menu on existing PR comments.
 *
 * Seeds one existing review comment that carries an html_url (permalink) and is
 * anchored to a line OUTSIDE the patch hunks, so it renders in the bottom-of-file
 * existing-thread list (not inline). Then:
 *   - opens the "⋯" Comment actions menu,
 *   - clicks "Copy link to comment" → asserts the clipboard holds comment.url,
 *   - re-opens and clicks "Quote reply" → asserts the clipboard holds the
 *     markdown-quoted attribution + body.
 *
 * Clipboard is granted via context permissions so navigator.clipboard.writeText
 * works in the headless browser.
 */

import { test, expect, type Page } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// The comment is anchored to line 99, which is NOT in this hunk → it renders in
// the bottom-of-file existing-thread list (easy to interact with), not inline.
const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

const COMMENT_BODY = 'first quoted line\nsecond quoted line'
const COMMENT_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}#discussion_r9001`

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

function makeReviewComments() {
  return [
    {
      id: 9001,
      user: { login: 'octocat', avatar_url: null },
      body: COMMENT_BODY,
      created_at: '2026-01-01T00:00:00Z',
      path: 'src/feature.ts',
      line: 99, // outside the hunk → renders in bottom-of-file list
      side: 'RIGHT',
      in_reply_to_id: null,
      html_url: COMMENT_URL,
    },
  ]
}

function seedSettings() {
  return {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
    theme: 'light',
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

test.describe('per-comment actions menu', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('Copy link copies comment.url; Quote reply copies the quoted body', async ({ page }) => {
    await setupRoutes(page)
    await page.addInitScript((settings) => {
      localStorage.setItem('review123:settings', JSON.stringify(settings))
    }, seedSettings())
    await page.addInitScript(() => {
      localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
    })

    await page.goto(APP_REVIEW_PATH)

    await expect(
      page.getByRole('heading', { name: /Test PR: add feature/i }),
    ).toBeVisible({ timeout: 10_000 })

    // Step 2 (Inspect) hosts the diff and the bottom-of-file comment list.
    await page.getByRole('button', { name: 'Next step' }).click()
    await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

    // Locate the existing comment thread (renders the seeded comment body).
    const thread = page.locator('[data-testid="existing-thread"]').filter({
      hasText: 'first quoted line',
    }).first()
    await expect(thread).toBeVisible({ timeout: 10_000 })

    // Open the per-comment actions menu.
    const trigger = thread.getByRole('button', { name: 'Comment actions' }).first()
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')

    // 1) Copy link to comment → clipboard holds the permalink.
    await page.getByRole('menuitem', { name: /copy link to comment/i }).click()
    await expect(thread.getByText(/Copied/i)).toBeVisible()
    const linkClip = await page.evaluate(() => navigator.clipboard.readText())
    expect(linkClip).toBe(COMMENT_URL)

    // 2) Re-open and Quote reply → clipboard holds the markdown-quoted form.
    await trigger.click()
    await page.getByRole('menuitem', { name: /quote reply/i }).click()
    const quoteClip = await page.evaluate(() => navigator.clipboard.readText())
    expect(quoteClip).toContain('> @octocat wrote:')
    expect(quoteClip).toContain('> first quoted line')
    expect(quoteClip).toContain('> second quoted line')
  })
})
