/**
 * e2e/real-pr.smoke.spec.ts — Real-network smoke test
 *
 * Loads a small REAL public merged PR (octocat/Hello-World #9698 — one file added,
 * stable, public, unauthenticated read allowed) and asserts that the diff container
 * renders.
 *
 * Skipped unless:
 *   - Running in CI (process.env.CI is set), or
 *   - Developer explicitly opts in via RUN_SMOKE=1
 *
 * Rationale for skip: avoids flaking local test runs due to network conditions
 * and GitHub rate limiting for unauthenticated requests.
 */

import { test, expect } from '@playwright/test'

// PR: octocat/Hello-World #9698 — "Adding a file" — 1 file added (my_note.txt)
// Verified stable and publicly readable without auth.
const SMOKE_PR_URL = 'https://github.com/octocat/Hello-World/pull/9698'
const SMOKE_APP_PATH = '/review/octocat/Hello-World/9698'

test.describe('real-network smoke: public PR diff renders', () => {
  test.skip(
    !process.env.CI && !process.env.RUN_SMOKE,
    'Smoke test skipped locally — set RUN_SMOKE=1 or run in CI',
  )

  test('octocat/Hello-World #9698: diff container renders', async ({ page }) => {
    // Block PostHog — no analytics in smoke
    await page.route('**/posthog.com/**', (route) => route.abort())
    await page.route('**/us.i.posthog.com/**', (route) => route.abort())

    // Seed settings. A GitHub token is used when available (CI runners share
    // egress IPs whose unauthenticated api.github.com quota is usually
    // exhausted — tokenless smoke is structurally flaky there). Locally the
    // test still runs tokenless.
    const token = process.env.SMOKE_GITHUB_TOKEN ?? null
    await page.addInitScript((tok) => {
      localStorage.setItem(
        'review123:settings',
        JSON.stringify({
          diffMode: 'unified',
          railCollapsed: true,
          ...(tok ? { githubAuth: { token: tok, method: 'pat', scopes: [] } } : {}),
        }),
      )
    }, token)

    await page.goto(SMOKE_APP_PATH, { timeout: 30_000 })

    // PR title should appear once loaded
    await expect(
      page.getByRole('heading', { name: /Adding a file/i }),
    ).toBeVisible({ timeout: 30_000 })

    // Navigate to step 2 (Inspect) via the stepper to see the diff
    await page.getByRole('button', { name: '2 · Inspect' }).click()

    // Diff container should render (file-diff article with file header)
    await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 15_000 })

    // The added file should be listed
    await expect(page.locator('article.file-diff').getByText('my_note.txt').first()).toBeVisible()
  })
})
