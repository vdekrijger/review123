/**
 * e2e/settings.spec.ts — Appearance settings: theme + font persist across reload.
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

test('sample reviewer: clicking "Add sample reviewer" in Settings installs it and shows it in the list enabled', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/')

  // Open settings dialog
  const settingsBtn = page.getByRole('button', { name: /settings/i })
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
  await settingsBtn.click()

  await expect(page.getByRole('dialog', { name: /settings/i })).toBeVisible()

  // "Add sample reviewer" button should be visible
  const addSampleBtn = page.getByRole('button', { name: /add sample reviewer/i })
  await expect(addSampleBtn).toBeVisible()

  // Click it
  await addSampleBtn.click()

  // The sample skill name should appear in the list
  await expect(page.getByText(/Pragmatic Senior Reviewer/i)).toBeVisible({ timeout: 3_000 })

  // The button should be hidden now
  await expect(page.getByRole('button', { name: /add sample reviewer/i })).not.toBeVisible()

  // The skill's checkbox should be checked (enabled)
  const skillCheckbox = page.locator('.skill-item input[type="checkbox"]').first()
  await expect(skillCheckbox).toBeChecked()
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
