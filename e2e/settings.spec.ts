/**
 * e2e/settings.spec.ts — Settings page tests.
 *
 * Previously tested SettingsPanel as a modal dialog; now retargeted to the
 * dedicated /settings page (feat/settings-page). The gear button navigates
 * to /settings instead of opening a dialog.
 *
 * RETIRED TESTS (showModal):
 *   - 'modal: settings dialog on Inspect step is a top-layer modal'
 *   - 'does NOT use the open attribute directly (no <dialog open>)'
 * These modal-dialog behaviours are still covered by ConsentDialog and
 * DiagramPanel tests (modal-dialog.test.ts). No coverage gap.
 *
 * NOTE on 'diff width' test: the settings page is navigated to from the Inspect
 * step; after changing settings, we navigate back and verify the attribute.
 */
import { test, expect } from '@playwright/test'

// Block PostHog and external APIs (we only need the settings page, no PR load)
async function blockExternal(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
}

// Navigate to the settings page via the gear button
async function openSettings(page: import('@playwright/test').Page) {
  const settingsBtn = page.getByRole('button', { name: /settings/i })
  await expect(settingsBtn).toBeVisible({ timeout: 5_000 })
  await settingsBtn.click()
  // Settings page is now rendered (not a dialog)
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })
}

test('appearance: pick Dark + Serif → documentElement has data-theme=dark & data-font=serif → reload → persist', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/')

  // Navigate to settings page via gear button
  await openSettings(page)

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

  // Navigate back (appearance is already saved on change)
  await page.getByRole('button', { name: /back/i }).click()

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

test('sample reviewer: adding Pragmatic Senior Reviewer from the Built-in reviewers library installs it and shows it enabled', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/')

  // Navigate to settings page
  await openSettings(page)

  // The Built-in reviewers section is visible
  await expect(page.getByText(/built-in reviewers/i)).toBeVisible()

  // The pragmatic sample entry has an [Add] button
  const addSampleBtn = page.getByRole('button', { name: /add Pragmatic Senior Reviewer \(sample\)/i })
  await expect(addSampleBtn).toBeVisible()

  // Click it
  await addSampleBtn.click()

  // The sample skill name should appear in the installed skills list
  await expect(page.locator('.skill-name', { hasText: /Pragmatic Senior Reviewer/i })).toBeVisible({ timeout: 3_000 })

  // The Add button should be hidden now
  await expect(page.getByRole('button', { name: /add Pragmatic Senior Reviewer \(sample\)/i })).not.toBeVisible()

  // The skill's checkbox should be checked (enabled)
  const skillCheckbox = page.locator('.skill-item input[type="checkbox"]').first()
  await expect(skillCheckbox).toBeChecked()
})


// ---------------------------------------------------------------------------
// Diff width: attribute-driven, applies immediately without remount
// ---------------------------------------------------------------------------

test('diff width: Full width sets data-diffwidth=full immediately and widens .review container on step 2', async ({
  page,
}) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.github.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/pulls/42')) {
      return route.fulfill({
        json: {
          title: 'Diff width test PR',
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
      diffMode: 'unified',
      railCollapsed: true,
    }))
  })

  await page.goto('/review/github/testorg/testrepo/42')
  await expect(page.getByRole('heading', { name: /Diff width test PR/i })).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 5_000 })

  // Measure centered max-width (should be ≤ 70rem = 1120px at 16px base)
  const centeredWidth = await page.locator('.review').evaluate((el) => el.getBoundingClientRect().width)

  // Open settings page via gear button
  const settingsBtn = page.getByRole('button', { name: /settings/i })
  await settingsBtn.click()
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })

  // Click Full width radio
  const fullRadio = page.getByRole('radio', { name: /full width/i })
  await expect(fullRadio).toBeVisible()
  await fullRadio.click()

  // data-diffwidth must be set immediately (no reload required)
  const dataDiffwidth = await page.evaluate(() => document.documentElement.getAttribute('data-diffwidth'))
  expect(dataDiffwidth).toBe('full')

  // Navigate back
  await page.getByRole('button', { name: /back/i }).click()

  // Wait for back navigation to the review page
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible({ timeout: 5_000 })

  // The .review container must now be wider than the centered width
  const fullWidth = await page.locator('.review').evaluate((el) => el.getBoundingClientRect().width)
  expect(fullWidth).toBeGreaterThan(centeredWidth)
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

  // Navigate to settings page
  await openSettings(page)

  await page.getByRole('radio', { name: /auto/i }).click()

  // data-theme attribute must be removed
  const afterAuto = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  expect(afterAuto).toBeNull()
})

// ---------------------------------------------------------------------------
// Built-in reviewer library: add Security reviewer → appears enabled in list
// ---------------------------------------------------------------------------

test('builtin-library: add Security Reviewer (OWASP-minded) from Built-in reviewers → appears enabled in the skill list', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/')

  // Navigate to settings page
  await openSettings(page)

  // The "Built-in reviewers" heading should be visible
  await expect(page.getByText(/built-in reviewers/i)).toBeVisible()

  // The Security Reviewer (OWASP-minded) [Add] button should be visible
  const addSecurityBtn = page.getByRole('button', { name: /add Security Reviewer \(OWASP-minded\)/i })
  await expect(addSecurityBtn).toBeVisible()

  // Click it
  await addSecurityBtn.click()

  // The skill name should appear in the installed skills list (.skill-name)
  await expect(page.locator('.skill-name', { hasText: 'Security Reviewer (OWASP-minded)' })).toBeVisible({ timeout: 3_000 })

  // The Add button for that skill should no longer be visible
  await expect(page.getByRole('button', { name: /add Security Reviewer \(OWASP-minded\)/i })).not.toBeVisible()

  // The skill's toggle checkbox should be checked (enabled)
  const skillCheckbox = page.locator('.skill-item').filter({ hasText: 'Security Reviewer (OWASP-minded)' }).locator('input[type="checkbox"]')
  await expect(skillCheckbox).toBeChecked()
})

// ---------------------------------------------------------------------------
// AI models (Plan F Task F3): provider switch + model dropdown + key save +
// Save & test against a fixture-backed openai-compat endpoint.
// OpenAI's transport routes through the same-origin serverless proxy
// (/api/llm/openai), which we intercept here — real adapter, fixture response.
// ---------------------------------------------------------------------------

test('ai models: switch to OpenAI → model dropdown updates → key saves → Save & test shows ok (fixture) and error (401 fixture)', async ({
  page,
}) => {
  await blockExternal(page)

  // Fixture-backed openai-compat endpoint (success first)
  let lastPingBody: Record<string, unknown> | null = null
  let lastPingHeaders: Record<string, string> = {}
  await page.route('**/api/llm/openai/chat/completions', async (route) => {
    lastPingBody = route.request().postDataJSON() as Record<string, unknown>
    lastPingHeaders = route.request().headers()
    return route.fulfill({ json: { choices: [{ message: { content: 'ok' } }] } })
  })

  await page.goto('/')
  await openSettings(page)

  // Provider radio: switch DeepSeek → OpenAI
  const openaiRadio = page.getByRole('radio', { name: 'OpenAI' })
  await expect(openaiRadio).toBeVisible()
  await expect(page.getByRole('radio', { name: 'DeepSeek' })).toBeChecked()
  await openaiRadio.click()
  await expect(openaiRadio).toBeChecked()

  // Model dropdown now lists OpenAI models with the provider default selected
  const modelSelect = page.getByRole('combobox', { name: 'Model' })
  await expect(modelSelect).toHaveValue('gpt-5.2')
  const optionValues = await modelSelect.locator('option').evaluateAll(
    (opts) => opts.map((o) => (o as HTMLOptionElement).value),
  )
  expect(optionValues).toContain('o4-mini')
  expect(optionValues).not.toContain('deepseek-chat')

  // Pick a non-default model — persisted as aiModel
  await modelSelect.selectOption('o4-mini')

  // Enter the OpenAI key and Save & test → saved first, then pinged
  await page.getByLabel(/OpenAI API key/i).fill('sk-test-openai-e2e')
  await page.getByRole('button', { name: /save & test openai/i }).click()
  await expect(page.getByText('✓ Connected')).toBeVisible({ timeout: 5_000 })

  // The ping went through the real openai-compat adapter: proxy header + active model
  expect(lastPingHeaders['x-user-openai-key']).toBe('sk-test-openai-e2e')
  expect(lastPingBody?.model).toBe('o4-mini')
  expect(lastPingBody?.max_tokens).toBe(1)

  // Settings were persisted (key save + provider + model)
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('review123:settings') ?? '{}'),
  )
  expect(stored.aiProvider).toBe('openai')
  expect(stored.aiModel).toBe('o4-mini')
  expect(stored.openaiKey).toBe('sk-test-openai-e2e')

  // Now swap the fixture to a 401 → Save & test shows the inline error state
  await page.unroute('**/api/llm/openai/chat/completions')
  await page.route('**/api/llm/openai/chat/completions', (route) =>
    route.fulfill({ status: 401, json: { error: { message: 'bad key' } } }),
  )
  await page.getByRole('button', { name: /save & test openai/i }).click()
  await expect(page.getByRole('alert').filter({ hasText: /unauthorized/i })).toBeVisible({
    timeout: 5_000,
  })
})
