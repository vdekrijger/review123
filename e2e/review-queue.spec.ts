/**
 * e2e/review-queue.spec.ts — Your review queue feature on the landing page.
 *
 * Three scenarios:
 *   (a) GitHub: seed auth + intercept search API → queue row appears → click navigates
 *   (b) GitLab: seed token + intercept /user + MR list → queue row appears
 *   (c) GitHub with delayed fixture: skeleton shows while fetch is in flight,
 *       then rows replace it
 */

import { test, expect } from '@playwright/test'

const GH_OWNER = 'myorg'
const GH_REPO = 'myrepo'
const GH_PR = 99

const GL_OWNER = 'glgroup'
const GL_REPO = 'glrepo'
const GL_MR = 7

// ---------------------------------------------------------------------------
// Test (a): GitHub queue
// ---------------------------------------------------------------------------

test('github queue: row appears on landing and click navigates to review', async ({ page }) => {
  // Block analytics / AI
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  // Single dispatcher for all GitHub API calls (same pattern as other e2e specs)
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const q = url.searchParams.get('q') ?? ''

    // Search: review-requested → 1 item; author → 0 items
    if (path === '/search/issues') {
      const item = {
        number: GH_PR,
        title: 'Queue test PR',
        updated_at: new Date(Date.now() - 300_000).toISOString(),
        repository_url: `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`,
      }
      const isAuthor = q.includes('author:')
      return route.fulfill({
        json: { total_count: isAuthor ? 0 : 1, items: isAuthor ? [] : [item] },
      })
    }

    // PR meta — needed so the review page can load after navigation
    if (path === `/repos/${GH_OWNER}/${GH_REPO}/pulls/${GH_PR}`) {
      return route.fulfill({
        json: {
          title: 'Queue test PR',
          state: 'open',
          merged: false,
          body: null,
          base: { sha: 'basesha', repo: { private: false } },
          head: { sha: 'headsha' },
          changed_files: 0,
        },
      })
    }

    // Catch-all
    return route.fulfill({ json: [] })
  })

  // Seed GitHub auth via localStorage
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    githubAuth: { token: 'ghp_test_queue', method: 'pat', scopes: [] },
    deepseekKey: '',
  })

  await page.goto('/')

  // Queue section should be visible
  await expect(page.getByText('Your review queue')).toBeVisible({ timeout: 10_000 })

  // The PR row should appear under "Awaiting your review"
  await expect(page.getByText(/Awaiting your review/i)).toBeVisible({ timeout: 10_000 })

  const queueRow = page.getByRole('button', { name: new RegExp(`${GH_OWNER}/${GH_REPO}#${GH_PR}`, 'i') })
  await expect(queueRow).toBeVisible({ timeout: 10_000 })

  // Click the row — should navigate to the review route
  await queueRow.click()
  await expect(page).toHaveURL(
    new RegExp(`/review/github/${GH_OWNER}/${GH_REPO}/${GH_PR}`),
    { timeout: 8_000 },
  )
})

// ---------------------------------------------------------------------------
// Test (b): GitLab queue
// ---------------------------------------------------------------------------

test('gitlab queue: row appears on landing when signed in via token', async ({ page }) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  // Intercept GitLab /user and /merge_requests
  await page.route('**/gitlab.com/api/v4/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === '/api/v4/user') {
      return route.fulfill({ json: { username: 'testme' } })
    }

    if (path === '/api/v4/merge_requests') {
      const reviewerUsername = url.searchParams.get('reviewer_username')
      const authorUsername = url.searchParams.get('author_username')

      const item = {
        iid: GL_MR,
        title: 'GitLab queue MR',
        updated_at: new Date(Date.now() - 600_000).toISOString(),
        web_url: `https://gitlab.com/${GL_OWNER}/${GL_REPO}/-/merge_requests/${GL_MR}`,
      }

      if (reviewerUsername === 'testme') {
        return route.fulfill({ json: [item] })
      }
      if (authorUsername === 'testme') {
        return route.fulfill({ json: [] })
      }
    }

    // Fallback
    return route.fulfill({ json: [] })
  })

  // Seed GitLab token
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    gitlabToken: 'glpat_test_queue',
    deepseekKey: '',
  })

  await page.goto('/')

  // Queue section should appear
  await expect(page.getByText('Your review queue')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/Awaiting your review/i)).toBeVisible({ timeout: 10_000 })

  const queueRow = page.getByRole('button', { name: new RegExp(`${GL_OWNER}/${GL_REPO}#${GL_MR}`, 'i') })
  await expect(queueRow).toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test (c): loading skeleton while the queue fetch is in flight
// ---------------------------------------------------------------------------

test('github queue: skeleton shows while fetch is delayed, then rows replace it', async ({ page }) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const q = url.searchParams.get('q') ?? ''

    if (path === '/search/issues') {
      // Delayed fixture — keep the fetch in flight long enough to observe the skeleton
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const item = {
        number: GH_PR,
        title: 'Queue test PR',
        updated_at: new Date(Date.now() - 300_000).toISOString(),
        repository_url: `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`,
      }
      const isAuthor = q.includes('author:')
      return route.fulfill({
        json: { total_count: isAuthor ? 0 : 1, items: isAuthor ? [] : [item] },
      })
    }

    return route.fulfill({ json: [] })
  })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    githubAuth: { token: 'ghp_test_queue', method: 'pat', scopes: [] },
    deepseekKey: '',
  })

  await page.goto('/')

  // While the search response is delayed, the skeleton must be visible
  const skeleton = page.getByTestId('queue-skeleton')
  await expect(skeleton).toBeVisible({ timeout: 5_000 })

  // Once the fixture resolves, rows replace the skeleton
  const queueRow = page.getByRole('button', { name: new RegExp(`${GH_OWNER}/${GH_REPO}#${GH_PR}`, 'i') })
  await expect(queueRow).toBeVisible({ timeout: 10_000 })
  await expect(skeleton).toBeHidden()
})
