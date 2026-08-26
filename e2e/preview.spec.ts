/**
 * e2e/preview.spec.ts — deploy-preview surfacing (deterministic, zero LLM).
 *
 * All api.github.com traffic is intercepted via page.route() (same idiom as
 * review-flow.spec.ts); the stubbed GitHub Deployments API endpoints drive the
 * header affordance. The preview host itself is also stubbed so the embedded
 * iframe loads a deterministic page with no real network.
 *
 * No LLM key is seeded — the whole feature is deterministic and must work
 * without any AI configuration.
 *
 * Covers:
 *   - deployments?sha=head → statuses → "Open preview ↗" renders with the
 *     ready state note ("vercel · ready")
 *   - "Preview panel" toggle opens the right-side panel: iframe src points at
 *     the stubbed preview URL, sandbox attrs, persistent fallback bar; the
 *     open state survives a reload (localStorage persistence)
 *   - behind-sha honesty: no deployment for head, an older-sha deployment
 *     exists → "1+ commits behind"
 *   - building state: disabled-ish note, no Open link
 */

import { test, expect, type Page } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const OLD_SHA = 'aaa1111111111'

const APP_REVIEW_UNDERSTAND = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}/understand`

const PREVIEW_HOST = 'testrepo-abc123.vercel.app'
const PREVIEW_URL = `https://${PREVIEW_HOST}`

const PATCH = `@@ -1,2 +1,3 @@
 context
+added line
 trailing`

function makePrMeta() {
  return {
    title: 'Test PR: preview surfacing',
    state: 'open',
    merged: false,
    body: 'PR body.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 1,
  }
}

function makePrFiles() {
  return [
    { filename: 'src/feature.ts', status: 'modified', patch: PATCH, additions: 1, deletions: 0 },
  ]
}

type DeployScenario = 'ready' | 'building' | 'behind' | 'none'

function makeDeployment(id: number, sha: string) {
  return {
    id,
    sha,
    ref: 'feature-branch',
    environment: 'Preview',
    created_at: '2026-08-20T10:00:00Z',
    updated_at: '2026-08-20T10:01:00Z',
  }
}

function makeDeployStatuses(state: string) {
  return [
    {
      id: 1,
      state,
      environment_url: PREVIEW_URL,
      target_url: `https://vercel.com/${OWNER}/${REPO}/deploys/1`,
      created_at: '2026-08-20T10:02:00Z',
      updated_at: '2026-08-20T10:02:00Z',
    },
  ]
}

async function setupRoutes(page: Page, scenario: DeployScenario) {
  // Block PostHog analytics
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  // Stub the preview host itself so the iframe load is deterministic
  await page.route(`**/${PREVIEW_HOST}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>preview ok</body></html>' }),
  )

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({ json: makePrMeta() })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: makePrFiles() })
    }

    // Deployments list — rung 1 uses ?sha=<head>, rung 2 omits the sha filter
    if (path === `/repos/${OWNER}/${REPO}/deployments`) {
      const sha = url.searchParams.get('sha')
      if (scenario === 'none') return route.fulfill({ json: [] })
      if (scenario === 'behind') {
        // Nothing deployed for the current head — only an older commit has one
        if (sha === HEAD_SHA) return route.fulfill({ json: [] })
        return route.fulfill({ json: [makeDeployment(902, OLD_SHA)] })
      }
      // ready / building: a deployment exists for the head sha
      if (sha === HEAD_SHA || sha === null) {
        return route.fulfill({ json: [makeDeployment(901, HEAD_SHA)] })
      }
      return route.fulfill({ json: [] })
    }

    // Deployment statuses
    if (path === `/repos/${OWNER}/${REPO}/deployments/901/statuses`) {
      return route.fulfill({
        json: makeDeployStatuses(scenario === 'building' ? 'in_progress' : 'success'),
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/deployments/902/statuses`) {
      return route.fulfill({ json: makeDeployStatuses('success') })
    }

    // CI surface: no checks configured, empty combined status
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/status`) {
      return route.fulfill({ json: { state: 'pending', statuses: [] } })
    }

    // Comments / commits / contents — quiet defaults
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) {
      return route.fulfill({ json: [] })
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }
    if (path === '/graphql') {
      return route.fulfill({
        json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
      })
    }

    console.warn('[e2e/preview] unhandled GitHub API path:', path)
    return route.fulfill({ json: {} })
  })
}

test.describe('deploy-preview surfacing', () => {
  test('ready: header shows Open preview with state note', async ({ page }) => {
    await setupRoutes(page, 'ready')
    await page.goto(APP_REVIEW_UNDERSTAND)

    const link = page.getByRole('link', { name: /open deploy preview/i })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', PREVIEW_URL)
    await expect(link).toHaveAttribute('target', '_blank')

    // State note: platform · ready · freshness (no behind note — shas match)
    await expect(page.locator('.preview-note')).toContainText('vercel · ready')
    await expect(page.locator('.preview-note')).not.toContainText('behind')
  })

  test('panel: toggle opens iframe at the stub URL with fallback bar; open state survives reload', async ({
    page,
  }) => {
    await setupRoutes(page, 'ready')
    await page.goto(APP_REVIEW_UNDERSTAND)

    await page.getByRole('button', { name: 'Preview panel' }).click()

    const panel = page.locator('.preview-panel')
    await expect(panel).toBeVisible()

    // Persistent honesty bar — always above the frame
    await expect(panel.getByText(/If the preview stays blank, the site refuses embedding/)).toBeVisible()
    await expect(panel.getByRole('link', { name: /open in new tab/i })).toHaveAttribute(
      'href',
      PREVIEW_URL,
    )

    // The iframe points at the SANITIZED stub URL and is sandboxed
    const iframe = panel.locator('iframe.preview-frame')
    await expect(iframe).toBeVisible()
    await expect(iframe).toHaveAttribute('src', `${PREVIEW_URL}/`)
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
    await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer')

    // Persistence: the panel-open choice is per-browser (localStorage)
    await page.reload()
    await expect(page.locator('.preview-panel iframe.preview-frame')).toBeVisible()

    // Close puts it away again
    await page.getByRole('button', { name: 'Close preview panel' }).click()
    await expect(panel).toHaveCount(0)
  })

  test('behind: older-sha deployment surfaces with "1+ commits behind"', async ({ page }) => {
    await setupRoutes(page, 'behind')
    await page.goto(APP_REVIEW_UNDERSTAND)

    await expect(page.getByRole('link', { name: /open deploy preview/i })).toBeVisible()
    await expect(page.locator('.preview-note')).toContainText('vercel · ready')
    await expect(page.locator('.preview-behind')).toHaveText('1+ commits behind')
  })

  test('building: state note without an Open link', async ({ page }) => {
    await setupRoutes(page, 'building')
    await page.goto(APP_REVIEW_UNDERSTAND)

    await expect(page.locator('.preview-note')).toContainText('vercel · preview building')
    await expect(page.getByRole('link', { name: /open deploy preview/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Preview panel' })).toHaveCount(0)
  })

  test('none: no deployments → no preview affordance at all', async ({ page }) => {
    await setupRoutes(page, 'none')
    await page.goto(APP_REVIEW_UNDERSTAND)

    // The PR header is rendered…
    await expect(page.getByRole('link', { name: /view on github/i })).toBeVisible()
    // …but no preview affordance exists (zero-cost absence)
    await expect(page.locator('.preview-affordance')).toHaveCount(0)
  })
})
