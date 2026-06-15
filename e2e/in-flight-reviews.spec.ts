/**
 * e2e/in-flight-reviews.spec.ts — landing "In-flight reviews" section.
 *
 * Seeds unsubmitted draft comments straight into IndexedDB (review123-drafts /
 * drafts store, out-of-line keys), then verifies the landing page:
 *   - surfaces the In-flight section with the correct count
 *   - resumes to the inspect step on click
 *   - discards (with confirmation) → the row disappears
 */

import { test, expect } from '@playwright/test'

const OWNER = 'acme'
const REPO = 'widgets'
const PR = 42
const PR_KEY = `github:${OWNER}/${REPO}#${PR}@headsha1`

// Seed two drafts under one prKey before any app code runs.
async function seedDrafts(page: import('@playwright/test').Page) {
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
        store.put({ prKey, path: 'a.ts', line: 1, side: 'RIGHT', body: 'first draft', n: 0, updatedAt: now }, `${prKey}|a.ts|1|RIGHT|0`)
        store.put({ prKey, path: 'a.ts', line: 2, side: 'RIGHT', body: 'second draft', n: 0, updatedAt: now }, `${prKey}|a.ts|2|RIGHT|0`)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); resolve() }
      }
      open.onerror = () => resolve()
    })
  }, PR_KEY)
}

function blockNoise(page: import('@playwright/test').Page) {
  return Promise.all([
    page.route('**/*posthog.com/**', (route) => route.abort()),
    page.route('**/us.i.posthog.com/**', (route) => route.abort()),
    page.route('**/api.deepseek.com/**', (route) => route.abort()),
  ])
}

test('in-flight section surfaces drafted comments with a count', async ({ page }) => {
  await blockNoise(page)
  await seedDrafts(page)
  await page.goto('/')

  await expect(page.getByTestId('inflight-section')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('In-flight reviews')).toBeVisible()

  const row = page.getByRole('button', { name: new RegExp(`Resume review of ${OWNER}/${REPO}#${PR}`, 'i') })
  await expect(row).toBeVisible()
  await expect(row.getByTestId('inflight-count')).toContainText('2 comments drafted')
})

test('clicking the in-flight row resumes at the inspect step', async ({ page }) => {
  await blockNoise(page)
  await seedDrafts(page)
  await page.goto('/')

  const row = page.getByRole('button', { name: new RegExp(`Resume review of ${OWNER}/${REPO}#${PR}`, 'i') })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()

  await expect(page).toHaveURL(
    new RegExp(`/review/github/${OWNER}/${REPO}/${PR}/inspect`),
    { timeout: 8_000 },
  )
})

test('discard asks for confirmation, then removes the in-flight row', async ({ page }) => {
  await blockNoise(page)
  await seedDrafts(page)
  await page.goto('/')

  await expect(page.getByTestId('inflight-section')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: new RegExp(`Discard drafts for ${OWNER}/${REPO}#${PR}`, 'i') }).click()

  const dialog = page.getByRole('dialog', { name: /Discard drafts/i })
  await expect(dialog).toBeVisible()
  // Body text is interpolated across several DOM text nodes; assert on the
  // dialog's flattened textContent rather than a single text node.
  await expect(dialog).toContainText(`Discard 2 unsubmitted comments on ${OWNER}/${REPO}#${PR}?`)

  await dialog.getByRole('button', { name: /^Discard$/ }).click()

  // The whole section disappears once the only PR's drafts are cleared.
  await expect(page.getByTestId('inflight-section')).toHaveCount(0, { timeout: 8_000 })
})
