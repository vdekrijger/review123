/**
 * e2e/submit-anchors.spec.ts — off-diff comment re-routing at submit time.
 *
 * User-reported bug: a review containing a comment anchored to a line NOT in
 * the diff used to 422 the whole create-review POST, losing every comment.
 * The fix splits drafts pre-submit: anchorable comments ride the review POST,
 * off-diff comments post as file-level review comments (subject_type: "file"),
 * and the UI says so before AND after submitting.
 *
 * Same stubbing approach as review-flow.spec.ts: all api.github.com calls are
 * intercepted with page.route(); drafts are seeded straight into IndexedDB
 * (the virtualized diff widget is unreliable to drive in headless Chrome).
 * No LLM key is seeded, so AI features stay off — no consent dialog.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'anchororg'
const REPO = 'anchorrepo'
const PR_NUMBER = 7
const HEAD_SHA = 'aaa1111222233334444'
const BASE_SHA = 'bbb5555666677778888'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// Patch hunks for src/feature.ts — RIGHT side contains lines 1..4 ONLY.
// A draft at RIGHT line 99 is therefore off-diff.
const PATCH = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

function makePrMeta() {
  return {
    title: 'Anchor PR: off-diff submit',
    state: 'open',
    merged: false,
    body: 'Exercises off-diff comment re-routing.',
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
      patch: PATCH,
      additions: 2,
      deletions: 1,
    },
  ]
}

/**
 * Seed TWO drafts into IndexedDB under the PR's identity prKey:
 *   - line 3 RIGHT  → IN the diff (anchorable)
 *   - line 99 RIGHT → NOT in the diff (off-diff)
 */
function seedDraftsScript(prKey: string) {
  return `
    (async () => {
      const dbName = 'review123-drafts';
      const storeName = 'drafts';
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const put = (line, body) => {
          const draft = {
            path: 'src/feature.ts',
            line,
            side: 'RIGHT',
            body,
            prKey: ${JSON.stringify(prKey)},
            n: 0,
            updatedAt: Date.now(),
          };
          store.put(draft, ${JSON.stringify(prKey)} + '|src/feature.ts|' + line + '|RIGHT|0');
        };
        put(3, 'In-diff comment on line 3');
        put(99, 'Off-diff comment on line 99');
      };
    })();
  `
}

test('off-diff draft: pre-submit note, review POST carries only inline, file comment posted, outcome visible', async ({ page }) => {
  // Block analytics + any stray LLM calls
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/api.deepseek.com/**', (route) => route.fulfill({ json: {} }))

  const reviewPosts: Record<string, unknown>[] = []
  const fileCommentPosts: Record<string, unknown>[] = []

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}` && method === 'GET') {
      return route.fulfill({ json: makePrMeta() })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: makePrFiles() })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    // The review submission POST — must carry ONLY the in-diff comment
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews` && method === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      reviewPosts.push(body)
      const comments = (body.comments ?? []) as { line: number }[]
      if (comments.some((c) => c.line > 4)) {
        // GitHub-faithful: any off-diff line 422s the whole review
        return route.fulfill({
          status: 422,
          json: { message: 'Unprocessable Entity', errors: ['line must be part of the diff'] },
        })
      }
      return route.fulfill({ json: { id: 501, state: 'COMMENTED' } })
    }
    // File-level review comment POST (off-diff re-route target)
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments` && method === 'POST') {
      fileCommentPosts.push(route.request().postDataJSON() as Record<string, unknown>)
      return route.fulfill({ json: { id: 601 } })
    }
    // Existing review comments (GET) / issue comments / commits — empty
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) {
      return route.fulfill({
        json: [{ sha: HEAD_SHA, commit: { message: 'feat: change', author: { date: '2024-01-01T10:00:00Z' } } }],
      })
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }
    if (path === '/graphql') {
      return route.fulfill({
        json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
      })
    }
    return route.fulfill({ json: {} })
  })

  // Seed settings (GitHub PAT, no LLM key) + the two drafts
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, {
    diffMode: 'unified',
    railCollapsed: false,
    storyMode: false,
    githubAuth: { token: 'ghp_test_token', method: 'pat', scopes: ['repo'] },
  })
  await page.addInitScript(seedDraftsScript(`github:${OWNER}/${REPO}#${PR_NUMBER}`))

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Anchor PR: off-diff submit/i })).toBeVisible({ timeout: 10_000 })

  // Both seeded drafts loaded
  await expect(page.getByText('2 comments drafted')).toBeVisible({ timeout: 10_000 })

  // Navigate to step 3 (VerdictStep)
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  // Pre-submit: the off-diff chip on the recap row + the calm heads-up note
  await expect(page.getByTestId('recap-draft-offdiff')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('offdiff-presubmit-note')).toContainText(
    "1 comment isn't on a line in the current diff — it'll post as a file comment.",
  )

  // Submit (default verdict COMMENT; 2 drafts satisfy the client guard)
  await page.getByRole('button', { name: /submit review/i }).click()

  // Success + the honest routing readout
  await expect(page.getByText('Your review was submitted successfully.')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('submit-outcome-breakdown')).toContainText('1 posted inline')
  await expect(page.getByTestId('submit-outcome-breakdown')).toContainText(
    '1 posted as a file comment (line not in diff)',
  )

  // Network truth: ONE review POST carrying only the in-diff comment…
  expect(reviewPosts).toHaveLength(1)
  const comments = reviewPosts[0].comments as { line: number; body: string }[]
  expect(comments).toHaveLength(1)
  expect(comments[0].line).toBe(3)

  // …and ONE file-level comment for the off-diff draft, prefix intact
  expect(fileCommentPosts).toHaveLength(1)
  expect(fileCommentPosts[0]).toMatchObject({
    subject_type: 'file',
    path: 'src/feature.ts',
    commit_id: HEAD_SHA,
  })
  expect(fileCommentPosts[0].body).toBe(
    '**Re: line 99** _(line not in the current diff)_ — Off-diff comment on line 99',
  )
})
