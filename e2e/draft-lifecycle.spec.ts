/**
 * e2e/draft-lifecycle.spec.ts — pre-existing drafts banner + bulk clearing.
 *
 * Scenario: a reviewer returns to a PR that still carries draft comments from
 * an earlier session — one of them on a file that has since LEFT the diff.
 * Opening the PR must show the draft-lifecycle banner (count + oldest age +
 * stale count) with Keep / Clear stale / Clear all actions.
 *
 *   Test 1: banner appears → "Clear all" two-step confirm empties the store —
 *           the step-3 recap shows the empty state and the draft bar reads 0.
 *   Test 2: "Clear stale" removes only the draft whose file left the diff.
 *
 * Drafts are seeded under the IDENTITY prKey (no @sha) — the store's native
 * key — with createdAt timestamps (one 3 days old). Network for api.github.com
 * is intercepted (no real calls). PostHog / DeepSeek are blocked.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 43
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// Identity prKey (NO head sha) — where the store keeps a PR's drafts.
const PR_KEY = `github:${OWNER}/${REPO}#${PR_NUMBER}`

const DAY = 24 * 60 * 60 * 1000

const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

function makePrMeta() {
  return {
    title: 'Test PR: lifecycle',
    state: 'open',
    merged: false,
    body: 'This PR exercises draft lifecycle management.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 1,
  }
}

function makePrFiles() {
  // NOTE: src/gone.ts is NOT in the diff — the seeded draft on it is stale.
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

function seedSettings() {
  return {
    githubAuth: { token: 'ghp_test_token', method: 'pat', scopes: ['repo'] },
    diffMode: 'unified',
    railCollapsed: true,
    storyMode: false,
  }
}

// Seed three pre-existing drafts under the IDENTITY key before any app code
// runs: two on the in-diff file (oldest 3 days old), one on a file that has
// left the diff (stale).
async function seedPreexistingDrafts(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ({ prKey, day }) => {
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
          store.put(
            { prKey, path: 'src/feature.ts', line: 3, side: 'RIGHT', body: 'Old draft on line 3', n: 0, createdAt: now - 3 * day, updatedAt: now - 3 * day },
            `${prKey}|src/feature.ts|3|RIGHT|0`,
          )
          store.put(
            { prKey, path: 'src/feature.ts', line: 4, side: 'RIGHT', body: 'Old draft on line 4', n: 0, createdAt: now - day, updatedAt: now - day },
            `${prKey}|src/feature.ts|4|RIGHT|0`,
          )
          store.put(
            { prKey, path: 'src/gone.ts', line: 2, side: 'RIGHT', body: 'Draft on a file that left the diff', n: 0, createdAt: now - 2 * day, updatedAt: now - 2 * day },
            `${prKey}|src/gone.ts|2|RIGHT|0`,
          )
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => { db.close(); resolve() }
        }
        open.onerror = () => resolve()
      })
    },
    { prKey: PR_KEY, day: DAY },
  )
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
    return route.fulfill({ json: [] })
  })
}

async function openPr(page: import('@playwright/test').Page) {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())
  await seedPreexistingDrafts(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(
    page.getByRole('heading', { name: /Test PR: lifecycle/i }),
  ).toBeVisible({ timeout: 10_000 })
}

test('banner appears for pre-existing drafts; Clear all (two-step) empties the recap', async ({ page }) => {
  await openPr(page)

  // Banner: count + oldest age + stale count, with all three actions.
  const banner = page.getByTestId('draft-lifecycle-banner')
  await expect(banner).toBeVisible({ timeout: 8_000 })
  await expect(banner).toContainText('3 draft comments from a previous review')
  await expect(banner).toContainText('oldest 3d ago')
  await expect(banner).toContainText('1 on file no longer in this PR')
  await expect(banner.getByRole('button', { name: 'Keep' })).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Clear stale (1)' })).toBeVisible()

  // Clear all is a two-step confirm: the first click only arms it.
  await banner.getByRole('button', { name: 'Clear all' }).click()
  const confirm = banner.getByRole('button', { name: 'Really clear 3?' })
  await expect(confirm).toBeVisible()
  const draftStatus = page.locator('.draft-bar').getByRole('status')
  await expect(draftStatus).toContainText(/3 comments drafted/i)

  // Second click clears everything; the banner goes away.
  await confirm.click()
  await expect(banner).not.toBeVisible()
  await expect(draftStatus).toContainText(/0 comments drafted/i)

  // Step 3: the recap is empty.
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByText(/No line comments drafted yet/i)).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText(/Old draft on line 3/i)).not.toBeVisible()
})

test('Clear stale removes only the draft whose file left the diff', async ({ page }) => {
  await openPr(page)

  const banner = page.getByTestId('draft-lifecycle-banner')
  await expect(banner).toBeVisible({ timeout: 8_000 })

  await banner.getByRole('button', { name: 'Clear stale (1)' }).click()

  // The banner stays, with updated counts and no stale action left.
  await expect(banner).toContainText('2 draft comments from a previous review')
  await expect(banner).not.toContainText('no longer in this PR')
  await expect(banner.getByRole('button', { name: /Clear stale/ })).toHaveCount(0)

  // Step 3: the two in-diff drafts survive; the stale one is gone. The recap
  // rows carry created-at chips (relative age, e.g. "3d ago").
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()
  const recapSection = page.locator('[aria-label="Drafted comments"]')
  await expect(recapSection.getByText(/Old draft on line 3/i)).toBeVisible({ timeout: 5_000 })
  await expect(recapSection.getByText(/Old draft on line 4/i)).toBeVisible()
  await expect(recapSection.getByText(/file that left the diff/i)).not.toBeVisible()
  await expect(recapSection.getByTestId('recap-draft-time').first()).toContainText(/ago/)
})
