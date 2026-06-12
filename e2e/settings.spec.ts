/**
 * e2e/settings.spec.ts — Appearance settings: theme + font persist across reload.
 * Also tests that SettingsPanel renders as a true top-layer modal (showModal),
 * so that diff content (sticky line numbers, annotations) cannot paint through it.
 */
import { test, expect } from '@playwright/test'

// Block PostHog and external APIs (we only need the settings dialog, no PR load)
async function blockExternal(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
}

test('appearance: pick Dark + Serif → documentElement has data-theme=dark & data-font=serif → reload → persist', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/')

  // Open settings dialog — the gear/settings button on the landing page
  const settingsBtn = page.getByRole('button', { name: /settings/i })
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
  await settingsBtn.click()

  // Dialog should appear
  await expect(page.getByRole('dialog', { name: /settings/i })).toBeVisible()

  // Pick Dark theme
  const darkRadio = page.getByRole('radio', { name: /dark/i })
  await expect(darkRadio).toBeVisible()
  await darkRadio.click()

  // Pick Serif font
  const serifRadio = page.getByRole('radio', { name: /serif/i })
  await expect(serifRadio).toBeVisible()
  await serifRadio.click()

  // Verify documentElement attributes were set immediately
  const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(dataTheme).toBe('dark')

  const dataFont = await page.evaluate(() => document.documentElement.getAttribute('data-font'))
  expect(dataFont).toBe('serif')

  // Close the dialog (Cancel — keys section; appearance is already saved)
  await page.getByRole('button', { name: /cancel/i }).click()

  // Reload
  await page.reload()

  // After reload, applyAppearance() runs at startup — attributes must persist
  const dataThemeAfterReload = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  )
  expect(dataThemeAfterReload).toBe('dark')

  const dataFontAfterReload = await page.evaluate(() =>
    document.documentElement.getAttribute('data-font'),
  )
  expect(dataFontAfterReload).toBe('serif')
})

// ---------------------------------------------------------------------------
// Modal top-layer test: settings dialog opened on Inspect step is a real modal
// Fix for: <dialog open> (non-modal) let sticky diff internals paint through it
// ---------------------------------------------------------------------------

test('modal: settings dialog on Inspect step is a top-layer modal — interactable, not painted over by diff', async ({
  page,
}) => {
  // Minimal GitHub API mock so the Inspect step renders
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.github.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/pulls/42')) {
      return route.fulfill({
        json: {
          title: 'Modal test PR',
          state: 'open', merged: false, body: null,
          base: { sha: 'base000', repo: { private: false } },
          head: { sha: 'head000' },
          changed_files: 1,
        },
      })
    }
    if (path.endsWith('/pulls/42/files')) {
      return route.fulfill({
        json: [{
          filename: 'src/example.ts',
          status: 'modified',
          patch: '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+extra',
          additions: 2, deletions: 1,
        }],
      })
    }
    if (path.endsWith('/commits/head000/check-runs')) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path.endsWith('/pulls/42/comments')) {
      return route.fulfill({ json: [] })
    }
    return route.fulfill({ json: {} })
  })
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({
      deepseekKey: '',
      diffMode: 'unified',
      railCollapsed: true,
    }))
  })

  await page.goto('/review/testorg/testrepo/42')

  // Wait for the PR to load
  await expect(page.getByRole('heading', { name: /Modal test PR/i })).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for diff content to render
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 5_000 })

  // Open the settings dialog while on the Inspect step.
  // Use JS click to bypass any z-index overlaps from the context rail header.
  const settingsBtn = page.getByRole('button', { name: /settings/i })
  await settingsBtn.evaluate((el: HTMLButtonElement) => el.click())

  const dialog = page.getByRole('dialog', { name: /settings/i })
  await expect(dialog).toBeVisible({ timeout: 3_000 })

  // The dialog must be a real modal: verify it has the open attribute set
  // (showModal() sets this, unlike <dialog open> which also sets it but without top-layer)
  // The key test: we can interact with a radio inside the dialog
  const darkRadio = dialog.getByRole('radio', { name: /dark/i })
  await expect(darkRadio).toBeVisible()
  await darkRadio.click()

  // Verify the setting took effect (interactable, not blocked by diff internals)
  const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(dataTheme).toBe('dark')

  // Verify the dialog is rendered as a modal: evaluate dialog.matches(':modal')
  // showModal() puts the dialog in the :modal pseudo-class; <dialog open> does not
  const isModal = await dialog.evaluate((el) => el.matches(':modal'))
  expect(isModal).toBe(true)

  // Close via Cancel button
  await dialog.getByRole('button', { name: /cancel/i }).click()
  await expect(dialog).not.toBeVisible()
})

test('appearance: Auto theme removes data-theme attribute', async ({ page }) => {
  await blockExternal(page)

  // Pre-seed dark theme
  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ theme: 'dark', uiFont: 'system', diffMode: 'unified', railCollapsed: false }),
    )
  })

  await page.goto('/')

  // After applyAppearance() runs at startup, data-theme should be 'dark'
  const initial = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(initial).toBe('dark')

  // Open settings and pick Auto
  const settingsBtn = page.getByRole('button', { name: /settings/i })
  await settingsBtn.click()
  await expect(page.getByRole('dialog', { name: /settings/i })).toBeVisible()

  await page.getByRole('radio', { name: /auto/i }).click()

  // data-theme attribute must be removed
  const afterAuto = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(afterAuto).toBeNull()
})
