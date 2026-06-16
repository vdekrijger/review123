/**
 * e2e/orphan-draft-recovery.spec.ts — old-commit drafts stay visible after re-key.
 *
 * Scenario: a reviewer drafted comments on an EARLIER commit of a PR. The PR
 * then received a new commit. Drafts are now keyed by STABLE PR IDENTITY (no
 * head-sha), so they can never orphan: load() migrates the legacy `@sha`-keyed
 * drafts into the identity key, tagging each with its source commit.
 *
 * Here we seed two legacy `@oldsha`-keyed drafts, open the PR (the fixture meta
 * serves the NEW head-sha), and assert:
 *   - the drafts are LOADED + visible (no "restored" note — migration is silent)
 *   - they carry a "from commit …" note (made on an older commit)
 *   - they show up in the step-3 recap (lossless)
 *
 * Network for api.github.com is intercepted (no real calls). PostHog / DeepSeek
 * are blocked.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890' // the CURRENT head sha the fixture serves
const BASE_SHA = 'def0987654321'
const OLD_SHA = 'oldsha000000' // the sha the drafts were authored against

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// The drafts are seeded under the OLD-sha prKey — a different @sha than the
// session will compute from the fixture's head sha.
const OLD_PR_KEY = `github:${OWNER}/${REPO}#${PR_NUMBER}@${OLD_SHA}`

const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

function makePrMeta() {
  return {
    title: 'Test PR: add feature',
    state: 'open',
    merged: false,
    body: 'This PR adds a new feature for testing.',
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

function seedSettings(withGithubAuth: boolean) {
  const settings: Record<string, unknown> = {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
  }
  if (withGithubAuth) {
    settings.githubAuth = { token: 'ghp_test_token', method: 'pat', scopes: ['repo'] }
  }
  return settings
}

// Seed two drafts under the OLD-sha prKey before any app code runs.
async function seedOldShaDrafts(page: import('@playwright/test').Page) {
  await page.addInitScript((prKey) => {
    return new Promise<void>((resolve) => {
      const open = indexedDB.open('review123-drafts', 1)
      open.onupgradeneeded = () => {
        const db = open.result
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts')
      }
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('drafts', 'readwrite')
        const store = tx.objectStore('drafts')
        const now = Date.now()
        store.put({ prKey, path: 'src/feature.ts', line: 3, side: 'RIGHT', body: 'Orphaned draft on line 3', n: 0, updatedAt: now }, `${prKey}|src/feature.ts|3|RIGHT|0`)
        store.put({ prKey, path: 'src/feature.ts', line: 4, side: 'RIGHT', body: 'Orphaned draft on line 4', n: 0, updatedAt: now }, `${prKey}|src/feature.ts|4|RIGHT|0`)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); resolve() }
      }
      open.onerror = () => resolve()
    })
  }, OLD_PR_KEY)
}

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({ json: makePrMeta() })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: makePrFiles() })
    }
    // Everything else: empty/no-op so the page doesn't error.
    return route.fulfill({ json: [] })
  })
}

test('old-commit drafts stay visible after re-key migration (from-commit note + recap)', async ({ page }) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(true))
  await seedOldShaDrafts(page)

  await page.goto(APP_REVIEW_PATH)

  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Step 2: the legacy @oldsha drafts are migrated into the identity key and
  // loaded (no "Restored …" banner — migration is silent now).
  await page.getByRole('button', { name: 'Next step' }).click()

  // The sticky draft bar reflects the migrated count.
  const draftStatus = page.locator('.draft-bar').getByRole('status')
  await expect(draftStatus).toContainText(/2 comments drafted/i, { timeout: 8_000 })

  // Each draft made on an older commit carries a "from commit …" note.
  const fromCommitNotes = page.getByTestId('draft-from-commit')
  await expect(fromCommitNotes.first()).toBeVisible({ timeout: 5_000 })
  await expect(fromCommitNotes).toHaveCount(2)

  // Step 3: the drafts appear in the recap (lossless — none dropped).
  await page.getByRole('button', { name: 'Next step' }).click()
  const recapSection = page.locator('[aria-label="Drafted comments"]')
  await expect(recapSection.getByText(/Orphaned draft on line 3/i)).toBeVisible({ timeout: 5_000 })
  await expect(recapSection.getByText(/Orphaned draft on line 4/i)).toBeVisible()
  await expect(page.getByText(/No line comments drafted yet/i)).not.toBeVisible()
})
