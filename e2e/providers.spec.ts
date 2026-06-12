/**
 * e2e/providers.spec.ts — provider-specific flow tests
 *
 * Test (a): GitLab MR flow — seed token, intercept GitLab API, assert title + non-atomic note
 * Test (b): Bitbucket PR flow — seed auth, intercept Bitbucket API, assert title + file diff
 * Test (c): Legacy GitHub URL redirect — /review/owner/repo/n → /review/github/owner/repo/n/understand
 */

import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Constants shared across tests
// ---------------------------------------------------------------------------

// GitLab
const GL_OWNER = 'testgroup'
const GL_REPO = 'testrepo'
const GL_MR = 5
const GL_HEAD_SHA = 'head222'
const GL_BASE_SHA = 'base111'

// Bitbucket
const BB_WORKSPACE = 'testws'
const BB_REPO = 'testrepo'
const BB_PR = 3
const BB_HEAD_SHA = 'srcabc123'

// Legacy GitHub (same as review-flow.spec.ts)
const GH_OWNER = 'testorg'
const GH_REPO = 'testrepo'
const GH_PR = 42
const GH_HEAD_SHA = 'abc1234567890'
const GH_BASE_SHA = 'def0987654321'

// ---------------------------------------------------------------------------
// GitLab fixture data
// ---------------------------------------------------------------------------

function makeGlMrMeta() {
  return {
    title: 'GitLab MR: add feature',
    state: 'opened',
    description: 'Adds a new feature.',
    diff_refs: {
      base_sha: GL_BASE_SHA,
      head_sha: GL_HEAD_SHA,
      start_sha: GL_BASE_SHA,
    },
    changes_count: '1',
    blocking_discussions_resolved: true,
  }
}

function makeGlDiffs() {
  return [
    {
      new_path: 'src/feature.ts',
      old_path: 'src/feature.ts',
      new_file: false,
      deleted_file: false,
      renamed_file: false,
      diff: '@@ -1,2 +1,3 @@\n context\n-old line\n+new line\n+another line',
    },
  ]
}

function makeGlCommits() {
  return [
    {
      id: GL_HEAD_SHA,
      short_id: GL_HEAD_SHA.slice(0, 7),
      title: 'feat: add feature',
      message: 'feat: add feature',
      authored_date: '2024-01-01T10:00:00Z',
    },
  ]
}

// ---------------------------------------------------------------------------
// Bitbucket fixture data
// ---------------------------------------------------------------------------

function makeBbPrMeta() {
  return {
    title: 'Bitbucket PR: fix bug',
    state: 'OPEN',
    description: 'Fixes a bug.',
    source: {
      commit: { hash: BB_HEAD_SHA },
      repository: { is_private: false },
    },
    destination: { commit: { hash: 'dstdef456' } },
  }
}

function makeBbDiffstat() {
  return {
    values: [
      {
        status: 'modified',
        old: { path: 'src/fix.ts' },
        new: { path: 'src/fix.ts' },
        lines_added: 2,
        lines_removed: 1,
      },
    ],
    pagelen: 20,
  }
}

const BB_RAW_DIFF = `diff --git a/src/fix.ts b/src/fix.ts
--- a/src/fix.ts
+++ b/src/fix.ts
@@ -1,2 +1,3 @@
 context line
-old bug line
+fixed line
+another fix
`

function makeBbComments() {
  return { values: [], pagelen: 20 }
}

function makeBbCommits() {
  return {
    values: [
      {
        hash: BB_HEAD_SHA,
        message: 'fix: bug fix',
        date: '2024-01-01T10:00:00Z',
      },
    ],
    pagelen: 20,
  }
}

function makeBbStatuses() {
  return { values: [], pagelen: 20 }
}

// ---------------------------------------------------------------------------
// GitHub fixture (for legacy redirect test)
// ---------------------------------------------------------------------------

function makeGhPrMeta() {
  return {
    title: 'Test PR: add feature',
    state: 'open',
    merged: false,
    body: 'This PR adds a new feature for testing.',
    base: { sha: GH_BASE_SHA, repo: { private: false } },
    head: { sha: GH_HEAD_SHA },
    changed_files: 1,
  }
}

function makeGhPrFiles() {
  return [
    {
      filename: 'src/feature.ts',
      status: 'modified',
      patch: '@@ -1,3 +1,4 @@\n unchanged line\n-removed line\n+added line\n trailing context',
      additions: 1,
      deletions: 1,
    },
  ]
}

// ---------------------------------------------------------------------------
// Test (a): GitLab MR flow
// ---------------------------------------------------------------------------

test('gitlab: paste MR URL → navigates to /understand, title visible, non-atomic note in verdict', async ({
  page,
}) => {
  // Block PostHog analytics
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  // Block DeepSeek so AI doesn't interfere
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  // Intercept all GitLab API calls
  await page.route('**/gitlab.com/api/v4/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const pid = `testgroup%2Ftestrepo`

    // MR meta
    if (path === `/api/v4/projects/${pid}/merge_requests/${GL_MR}`) {
      return route.fulfill({ json: makeGlMrMeta() })
    }

    // MR diffs (paginated via glFetchPage, responds with X-Next-Page)
    if (path === `/api/v4/projects/${pid}/merge_requests/${GL_MR}/diffs`) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Next-Page': '' },
        body: JSON.stringify(makeGlDiffs()),
      })
    }

    // MR discussions (used by getComments and getResolvedCommentIds)
    if (path === `/api/v4/projects/${pid}/merge_requests/${GL_MR}/discussions`) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Next-Page': '' },
        body: JSON.stringify([]),
      })
    }

    // MR pipelines (getCiSummary)
    if (path === `/api/v4/projects/${pid}/merge_requests/${GL_MR}/pipelines`) {
      return route.fulfill({ json: [] })
    }

    // MR commits (getCommits)
    if (path === `/api/v4/projects/${pid}/merge_requests/${GL_MR}/commits`) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Next-Page': '' },
        body: JSON.stringify(makeGlCommits()),
      })
    }

    // File content (getFileAtRef)
    if (
      path === `/api/v4/projects/${pid}/repository/files/src%2Ffeature.ts/raw` &&
      url.searchParams.get('ref') === GL_HEAD_SHA
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: 'context\nnew line\nanother line',
      })
    }

    // Fallback — return empty JSON
    console.warn('[e2e] unhandled GitLab API path:', path)
    return route.fulfill({ json: {} })
  })

  // Seed settings with GitLab token
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { gitlabToken: 'glpat_test_token', deepseekKey: '' })

  await page.goto('/')

  // Fill in the GitLab MR URL and submit
  const input = page.getByLabel('Pull request URL')
  await expect(input).toBeVisible()
  await input.fill(`https://gitlab.com/${GL_OWNER}/${GL_REPO}/-/merge_requests/${GL_MR}`)
  await page.getByRole('button', { name: 'Review' }).click()

  // Should navigate to /review/gitlab/testgroup/testrepo/5/understand
  const expectedPath = `/review/gitlab/${GL_OWNER}/${GL_REPO}/${GL_MR}/understand`
  await expect(page).toHaveURL(expectedPath, { timeout: 8_000 })

  // PR title should appear
  await expect(
    page.getByRole('heading', { name: /GitLab MR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 3 (verdict)
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  // Non-atomic note should be visible in VerdictStep
  await expect(
    page.getByText(/On GitLab, submitting posts each comment individually/i),
  ).toBeVisible({ timeout: 5_000 })
})

// ---------------------------------------------------------------------------
// Test (b): Bitbucket PR flow
// ---------------------------------------------------------------------------

test('bitbucket: paste PR URL → navigates to /understand, title visible, file diff in inspect', async ({
  page,
}) => {
  // Block PostHog analytics
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  // Block DeepSeek
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  // Intercept all Bitbucket API calls
  await page.route('**/api.bitbucket.org/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    const base = `/2.0/repositories/${BB_WORKSPACE}/${BB_REPO}`

    // PR meta
    if (path === `${base}/pullrequests/${BB_PR}`) {
      return route.fulfill({ json: makeBbPrMeta() })
    }

    // Diffstat (paginated bbFetchAll)
    if (path === `${base}/pullrequests/${BB_PR}/diffstat`) {
      return route.fulfill({ json: makeBbDiffstat() })
    }

    // Raw diff (bbFetchRaw — returns text)
    if (path === `${base}/pullrequests/${BB_PR}/diff`) {
      return route.fulfill({
        status: 200,
        contentType: 'text/plain',
        body: BB_RAW_DIFF,
      })
    }

    // Comments (paginated bbFetchAll)
    if (path === `${base}/pullrequests/${BB_PR}/comments`) {
      return route.fulfill({ json: makeBbComments() })
    }

    // Commits (paginated bbFetchAll, fetched when step 2 activates)
    if (path === `${base}/pullrequests/${BB_PR}/commits`) {
      return route.fulfill({ json: makeBbCommits() })
    }

    // Build statuses (getCiSummary)
    if (path === `/2.0/repositories/${BB_WORKSPACE}/${BB_REPO}/commit/${BB_HEAD_SHA}/statuses`) {
      return route.fulfill({ json: makeBbStatuses() })
    }

    // Fallback
    console.warn('[e2e] unhandled Bitbucket API path:', path)
    return route.fulfill({ json: { values: [], pagelen: 20 } })
  })

  // Seed settings with Bitbucket auth
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    bitbucketAuth: { email: 'user@example.com', token: 'bb_token' },
    deepseekKey: '',
  })

  await page.goto('/')

  // Fill in the Bitbucket PR URL and submit
  const input = page.getByLabel('Pull request URL')
  await expect(input).toBeVisible()
  await input.fill(`https://bitbucket.org/${BB_WORKSPACE}/${BB_REPO}/pull-requests/${BB_PR}`)
  await page.getByRole('button', { name: 'Review' }).click()

  // Should navigate to /review/bitbucket/testws/testrepo/3/understand
  const expectedPath = `/review/bitbucket/${BB_WORKSPACE}/${BB_REPO}/${BB_PR}/understand`
  await expect(page).toHaveURL(expectedPath, { timeout: 8_000 })

  // PR title should appear
  await expect(
    page.getByRole('heading', { name: /Bitbucket PR: fix bug/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible({ timeout: 5_000 })

  // File diff article should render
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 8_000 })
})

// ---------------------------------------------------------------------------
// Test (c): Legacy GitHub URL redirect
// ---------------------------------------------------------------------------

test('legacy-redirect: /review/owner/repo/n redirects to /review/github/owner/repo/n/understand', async ({
  page,
}) => {
  // Block PostHog analytics
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  // Block DeepSeek
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  // Intercept GitHub API — just the PR meta endpoint is needed for the redirect to work
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    // PR meta
    if (path === `/repos/${GH_OWNER}/${GH_REPO}/pulls/${GH_PR}`) {
      return route.fulfill({ json: makeGhPrMeta() })
    }

    // PR files
    if (path === `/repos/${GH_OWNER}/${GH_REPO}/pulls/${GH_PR}/files`) {
      return route.fulfill({ json: makeGhPrFiles() })
    }

    // Check runs
    if (path === `/repos/${GH_OWNER}/${GH_REPO}/commits/${GH_HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }

    // PR review comments
    if (path === `/repos/${GH_OWNER}/${GH_REPO}/pulls/${GH_PR}/comments`) {
      return route.fulfill({ json: [] })
    }

    // PR issue comments
    if (path === `/repos/${GH_OWNER}/${GH_REPO}/issues/${GH_PR}/comments`) {
      return route.fulfill({ json: [] })
    }

    // GraphQL — no resolved threads
    if (path === '/graphql') {
      return route.fulfill({
        json: {
          data: {
            repository: { pullRequest: { reviewThreads: { nodes: [] } } },
          },
        },
      })
    }

    // Fallback
    return route.fulfill({ json: {} })
  })

  // Seed settings (no auth needed for public repo redirect)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '' })

  // Navigate directly to the legacy route (no provider segment)
  await page.goto(`/review/${GH_OWNER}/${GH_REPO}/${GH_PR}`)

  // The app should canonicalize the URL to the provider-qualified form
  const expectedPath = `/review/github/${GH_OWNER}/${GH_REPO}/${GH_PR}/understand`
  await expect(page).toHaveURL(expectedPath, { timeout: 8_000 })
})
