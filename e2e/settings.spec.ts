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
// AI models (Plan F Task F3 + provider context blocks): one card per provider
// (radio + own model dropdown + key + Save & test). Save & test runs against
// a fixture-backed openai-compat endpoint.
// OpenAI's transport routes through the same-origin serverless proxy
// (/api/llm/openai), which we intercept here — real adapter, fixture response.
// ---------------------------------------------------------------------------

test('ai models: switch to OpenAI card → per-card model dropdown → key saves → Save & test shows ok (fixture) and error (401 fixture)', async ({
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

  // One context card per provider; DeepSeek's card is active by default
  const aiSection = page.locator('#ai-models')
  await expect(aiSection.locator('.provider-card')).toHaveCount(4)
  await expect(aiSection.locator('.provider-card[data-active="true"]')).toHaveCount(1)

  // Provider radio (in the card header): switch DeepSeek → OpenAI
  const openaiRadio = page.getByRole('radio', { name: 'OpenAI' })
  await expect(openaiRadio).toBeVisible()
  await expect(page.getByRole('radio', { name: 'DeepSeek' })).toBeChecked()
  await openaiRadio.click()
  await expect(openaiRadio).toBeChecked()

  // The accent emphasis moved to the OpenAI card
  const openaiCard = aiSection.locator('.provider-card').filter({ has: openaiRadio })
  await expect(openaiCard).toHaveAttribute('data-active', 'true')

  // The OpenAI card's own dropdown lists only OpenAI models, default selected
  const modelSelect = page.getByRole('combobox', { name: 'OpenAI model' })
  await expect(modelSelect).toHaveValue('gpt-5.4')
  const optionValues = await modelSelect.locator('option').evaluateAll(
    (opts) => opts.map((o) => (o as HTMLOptionElement).value),
  )
  expect(optionValues).toContain('gpt-5.4-mini')
  expect(optionValues).not.toContain('deepseek-v4-flash')

  // The DeepSeek card keeps its own dropdown (per-card models)
  await expect(page.getByRole('combobox', { name: 'DeepSeek model' })).toHaveValue('deepseek-v4-flash')

  // Pick a non-default model — persisted as aiModel
  await modelSelect.selectOption('gpt-5.4-mini')

  // Enter the OpenAI key (in the OpenAI card) and Save & test → saved first, then pinged
  await page.getByLabel(/OpenAI API key/i).fill('sk-test-openai-e2e')
  await page.getByRole('button', { name: /save & test openai/i }).click()
  await expect(page.getByText('✓ Connected')).toBeVisible({ timeout: 5_000 })

  // The ping went through the real openai-compat adapter: proxy header + active model
  expect(lastPingHeaders['x-user-openai-key']).toBe('sk-test-openai-e2e')
  expect(lastPingBody?.model).toBe('gpt-5.4-mini')
  // OpenAI's GPT-5 family rejects max_tokens (400) → the cap rides on
  // max_completion_tokens for OpenAI (DeepSeek still uses max_tokens).
  expect(lastPingBody?.max_completion_tokens).toBe(1)
  expect(lastPingBody?.max_tokens).toBeUndefined()

  // Settings were persisted (key save + provider + model)
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('review123:settings') ?? '{}'),
  )
  expect(stored.aiProvider).toBe('openai')
  expect(stored.aiModel).toBe('gpt-5.4-mini')
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

// ---------------------------------------------------------------------------
// Save UX (feat/settings-save-clarity): section-scoped Save with dirty tracking
// and a transient Saved ✓ confirmation; connected providers render as compact
// chips. The AI models section has NO section-level Save (per-key Save & test
// persists keys; provider/model selection applies immediately).
// ---------------------------------------------------------------------------

test('providers save UX: single scoped Save, dirty tracking, Saved ✓ confirmation, OAuth session preserved, connected chip', async ({
  page,
}) => {
  await blockExternal(page)

  // Seed a GitHub OAuth session
  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'gho_e2e', method: 'oauth', scopes: ['public_repo'] } }),
    )
  })

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })

  // Connected provider renders as a compact chip with an icon sign-out button
  // (scoped to the Providers card: the navbar has its own GitHub sign-out)
  await expect(page.getByText(/GitHub · connected/)).toBeVisible()
  await expect(
    page.locator('#providers').getByRole('button', { name: /sign out of github/i }),
  ).toBeVisible()

  // Exactly ONE plain Save button on the whole page, inside the Providers card
  const saveBtn = page.getByRole('button', { name: /^save$/i })
  await expect(saveBtn).toHaveCount(1)
  const providersSection = page.locator('#providers')
  await expect(providersSection.getByRole('button', { name: /^save$/i })).toBeVisible()
  // The AI models section has no section-level Save at all
  await expect(page.locator('#ai-models').getByRole('button', { name: /^save$/i })).toHaveCount(0)

  // Clean section → Save is quiet/disabled, no unsaved hint
  await expect(saveBtn).toBeDisabled()
  await expect(page.getByText(/unsaved changes/i)).toHaveCount(0)

  // Edit a field → Save becomes enabled and the unsaved hint appears
  await providersSection.getByText(/advanced.*personal access token/i).click()
  await page.getByLabel(/gitlab host/i).fill('gitlab.corp.example')
  await expect(saveBtn).toBeEnabled()
  await expect(providersSection.getByText(/unsaved changes/i)).toBeVisible()

  // Save → transient Saved ✓ confirmation, section reads clean again
  await saveBtn.click()
  await expect(providersSection.getByText('Saved ✓')).toBeVisible()
  await expect(saveBtn).toBeDisabled()
  await expect(providersSection.getByText(/unsaved changes/i)).toHaveCount(0)

  // The edit was persisted AND the OAuth session survived an empty PAT field
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('review123:settings') ?? '{}'),
  )
  expect(stored.gitlabHost).toBe('gitlab.corp.example')
  expect(stored.githubAuth).toEqual({ token: 'gho_e2e', method: 'oauth', scopes: ['public_repo'] })

  // The Saved ✓ confirmation fades after ~2s
  await expect(providersSection.getByText('Saved ✓')).toHaveCount(0, { timeout: 4_000 })
})

// ---------------------------------------------------------------------------
// OAuth dispatch (regression): a settings-initiated GitHub sign-in must
// complete as a GITHUB flow even when a stale GitLab pending session is
// lying around from an earlier abandoned attempt. Before the fix, the
// callback dispatched on "a gitlab session key exists" and failed with
// "GitLab sign-in session expired or invalid".
// ---------------------------------------------------------------------------

test('oauth dispatch: settings-initiated GitHub sign-in completes despite a STALE GitLab pending session', async ({
  page,
}) => {
  await blockExternal(page)

  // Stale GitLab pending session from an abandoned attempt. addInitScript
  // re-seeds it on EVERY document load — including the /auth/callback load —
  // so this also proves the state-nonce match (not just clearing-on-begin).
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'review123:gitlab-oauth',
      JSON.stringify({ state: 'stale-gitlab-state', verifier: 'stale-verifier', provider: 'gitlab' }),
    )
  })

  // Intercept the GitHub authorize navigation: bounce straight back to our
  // callback carrying the SAME state nonce the app just generated.
  await page.route('**/github.com/login/oauth/authorize**', async (route) => {
    const url = new URL(route.request().url())
    const state = url.searchParams.get('state') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    await route.fulfill({
      status: 302,
      headers: { location: `${redirectUri}?code=e2e_code_123&state=${state}` },
    })
  })

  // Intercept the token exchange (the serverless function is not running in preview)
  await page.route('**/api/oauth/exchange', (route) =>
    route.fulfill({ json: { access_token: 'gho_e2e_oauth_token' } }),
  )

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })

  // Settings-initiated sign-in (the Providers section button, not the navbar one)
  await page.locator('#providers').getByRole('button', { name: /sign in with github/i }).click()

  // Round-trip lands back on /settings (returnTo) signed in as GITHUB —
  // and crucially there is NO GitLab-named error.
  await expect(page).toHaveURL(/\/settings$/, { timeout: 8_000 })
  await expect(page.getByText(/GitHub · connected/)).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText(/GitLab sign-in session expired/i)).toHaveCount(0)

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('review123:settings') ?? '{}'),
  )
  expect(stored.githubAuth).toEqual({
    token: 'gho_e2e_oauth_token',
    method: 'oauth',
    scopes: ['public_repo'],
  })
})

// ---------------------------------------------------------------------------
// Navbar provider parity: GitLab status/sign-in next to GitHub's, sessions
// independent, compact (icon-only sign-in chips) below 700px.
// ---------------------------------------------------------------------------

test('navbar parity: GitLab ✓ chip with sign-out when connected; Sign in with GitLab when not; compact below 700px', async ({
  page,
}) => {
  await blockExternal(page)

  // Seed a connected GitLab OAuth session (GitHub stays signed out)
  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({
        gitlabOAuth: { token: 'glo_e2e', refreshToken: 'glr_e2e', expiresAt: Date.now() + 3_600_000 },
      }),
    )
  })

  await page.goto('/')

  const topbar = page.locator('.topbar')
  // GitLab: connected chip + sign-out affordance
  await expect(topbar.getByText('GitLab ✓')).toBeVisible()
  await expect(topbar.getByRole('button', { name: /sign out of gitlab/i })).toBeVisible()
  // GitHub: independent — still offers sign-in
  await expect(topbar.getByRole('button', { name: /sign in with github/i })).toBeVisible()

  // Sign out of GitLab only → reverts to its sign-in button
  await topbar.getByRole('button', { name: /sign out of gitlab/i }).click()
  await expect(topbar.getByText('GitLab ✓')).toHaveCount(0)
  await expect(topbar.getByRole('button', { name: /sign in with gitlab/i })).toBeVisible()

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('review123:settings') ?? '{}'),
  )
  expect(stored.gitlabOAuth).toBeNull()

  // Compact below 700px: both navbar sign-in buttons collapse to icon-only
  // chips (label hidden, accessible name preserved via aria-label).
  await page.setViewportSize({ width: 540, height: 800 })
  for (const selector of ['.topbar .gh-signin-btn .btn-label', '.topbar .gl-signin-btn .btn-label']) {
    const display = await page.locator(selector).evaluate((el) => getComputedStyle(el).display)
    expect(display).toBe('none')
  }
  await expect(topbar.getByRole('button', { name: /sign in with gitlab/i })).toBeVisible()
  await expect(topbar.getByRole('button', { name: /sign in with github/i })).toBeVisible()
})

// ---------------------------------------------------------------------------
// Progress bar setting: fieldset with Show/Hide radios (consistent with the
// other Appearance groups), persists across reload
// ---------------------------------------------------------------------------

test('progress bar: Show/Hide radio fieldset persists showProgress=false after Hide + reload', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/')
  await openSettings(page)

  // The Progress bar group is a styled fieldset with radios (no bare checkbox)
  const group = page.getByRole('group', { name: /progress bar/i })
  await expect(group).toBeVisible()
  const showRadio = group.getByRole('radio', { name: /^show$/i })
  const hideRadio = group.getByRole('radio', { name: /^hide$/i })
  await expect(showRadio).toBeChecked()

  // Pick Hide — applies immediately (no Save needed)
  await hideRadio.click()
  await expect(hideRadio).toBeChecked()

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('review123:settings') ?? '{}'),
  )
  expect(stored.showProgress).toBe(false)

  // Reload → Hide stays selected
  await page.reload()
  await expect(
    page.getByRole('group', { name: /progress bar/i }).getByRole('radio', { name: /^hide$/i }),
  ).toBeChecked()
})

test('themed form controls: radios are custom-styled (appearance:none) with verdigris accent in BOTH themes', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/')
  await openSettings(page)

  // Pick Dark theme — the checked radio must render the custom control,
  // not the native browser-blue one.
  const darkRadio = page.getByRole('radio', { name: 'Dark', exact: true })
  await darkRadio.click()
  await expect(darkRadio).toBeChecked()

  // Non-transitioned properties can be read synchronously
  const darkStatic = await darkRadio.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { appearance: cs.appearance, borderRadius: cs.borderRadius }
  })
  expect(darkStatic.appearance).toBe('none')
  // Radio is round
  expect(darkStatic.borderRadius).toBe('50%')

  // border-color transitions 150ms — use auto-retrying assertions.
  // Dark verdigris accent (#4db6a0) on the checked control's border.
  await expect(darkRadio).toHaveCSS('border-top-color', 'rgb(77, 182, 160)')
  // Checked indicator dot is scaled in (identity matrix, not scale(0))
  await expect
    .poll(() =>
      darkRadio.evaluate((el) => getComputedStyle(el, '::before').transform),
    )
    .toBe('matrix(1, 0, 0, 1, 0, 0)')

  // Switch to Light theme — accent must follow the light palette
  const lightRadio = page.getByRole('radio', { name: 'Light', exact: true })
  await lightRadio.click()
  await expect(lightRadio).toBeChecked()

  expect(
    await lightRadio.evaluate((el) => getComputedStyle(el).appearance),
  ).toBe('none')
  // Light verdigris accent (#2e8b78)
  await expect(lightRadio).toHaveCSS('border-top-color', 'rgb(46, 139, 120)')

  // The now-UNCHECKED Dark radio reverts to the hairline border and a
  // scaled-out (hidden) indicator — in light theme hairline is #e3dfd6.
  await expect(darkRadio).toHaveCSS('border-top-color', 'rgb(227, 223, 214)')
  await expect
    .poll(() =>
      darkRadio.evaluate((el) => getComputedStyle(el, '::before').transform),
    )
    .toBe('matrix(0, 0, 0, 0, 0, 0)')
})

test('themed form controls: skill checkbox is custom-styled and fills with accent when checked', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/')
  await openSettings(page)

  // Install a built-in reviewer so a skill checkbox exists
  const addBtn = page
    .locator('.builtin-entry')
    .first()
    .getByRole('button', { name: /^add /i })
  await expect(addBtn).toBeVisible()
  await addBtn.click()

  const toggle = page.locator('.skill-item input[type="checkbox"]').first()
  await expect(toggle).toBeChecked()

  const styles = await toggle.evaluate((el) => {
    const cs = getComputedStyle(el)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    return {
      appearance: cs.appearance,
      background: cs.backgroundColor,
      accent,
    }
  })
  expect(styles.appearance).toBe('none')
  // Checked checkbox is filled with the theme accent (resolve var → rgb)
  const accentAsRgb = await page.evaluate((hex) => {
    const probe = document.createElement('div')
    probe.style.color = hex
    document.body.appendChild(probe)
    const rgb = getComputedStyle(probe).color
    probe.remove()
    return rgb
  }, styles.accent)
  expect(styles.background).toBe(accentAsRgb)
})

// ---------------------------------------------------------------------------
// API key fields: show/hide eye toggle + invalid-character rejection at save
// (fix/settings-keys-scrollspy). The toggle flips masked ↔ plain text; a key
// with a copy-paste artifact (em dash) is rejected with a human message —
// never the raw "Cannot convert value to ByteString" DOMException text.
// ---------------------------------------------------------------------------

test('api keys: eye toggle reveals/remasks the key; an em-dash key is rejected with a friendly inline error', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })

  const aiSection = page.locator('#ai-models')
  const deepseekCard = aiSection.locator('.provider-card').filter({
    has: page.getByRole('radio', { name: 'DeepSeek' }),
  })
  const keyInput = deepseekCard.getByLabel(/deepseek api key/i)

  // Masked by default; the eye toggle reveals the plain text
  await keyInput.fill('sk-peekaboo')
  await expect(keyInput).toHaveAttribute('type', 'password')
  const showToggle = deepseekCard.getByRole('button', { name: 'Show key' })
  await expect(showToggle).toHaveAttribute('aria-pressed', 'false')
  await showToggle.click()
  await expect(keyInput).toHaveAttribute('type', 'text')
  await expect(keyInput).toHaveValue('sk-peekaboo')

  // …and back to masked
  const hideToggle = deepseekCard.getByRole('button', { name: 'Hide key' })
  await expect(hideToggle).toHaveAttribute('aria-pressed', 'true')
  await hideToggle.click()
  await expect(keyInput).toHaveAttribute('type', 'password')

  // The PAT field in Providers & access has its own toggle
  await page.locator('#providers summary').click()
  const patInput = page.getByLabel(/github token/i)
  await patInput.fill('github_pat_peek')
  await page.locator('#providers').getByRole('button', { name: 'Show key' }).first().click()
  await expect(patInput).toHaveAttribute('type', 'text')

  // Em dash (U+2014) pasted into the key → friendly message, nothing saved,
  // and no raw ByteString/DOMException text anywhere.
  await keyInput.fill('sk-bad—key')
  await deepseekCard.getByRole('button', { name: /save & test deepseek/i }).click()
  const alert = deepseekCard.getByRole('alert')
  await expect(alert).toBeVisible({ timeout: 5_000 })
  await expect(alert).toContainText(/invalid character/i)
  await expect(alert).toContainText(/re-copy it from the provider/i)
  await expect(alert).not.toContainText(/ByteString/i)
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('review123:settings') ?? '{}'),
  )
  expect(stored.deepseekKey ?? null).toBeNull()
})

// ---------------------------------------------------------------------------
// Scrollspy edges (fix/settings-keys-scrollspy): at the very top the FIRST
// section (Appearance) must be active — not "Providers & access" — and the
// bottom edge still reaches the last section.
// ---------------------------------------------------------------------------

test('scrollspy: Appearance is active at the top, the last section at the bottom, and the top again after scrolling back', async ({
  page,
}) => {
  await blockExternal(page)

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })

  const nav = page.getByRole('navigation', { name: /settings sections/i })
  const appearanceLink = nav.getByRole('link', { name: 'Appearance' })
  const providersLink = nav.getByRole('link', { name: 'Providers & access' })
  const skillsLink = nav.getByRole('link', { name: 'Reviewer skills' })

  // At the very top: Appearance — the user report was Providers highlighted here
  await expect(appearanceLink).toHaveAttribute('aria-current', 'true')
  await expect(providersLink).not.toHaveAttribute('aria-current', 'true')

  // Scroll to the bottom: the last section wins even if it is short
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await expect(skillsLink).toHaveAttribute('aria-current', 'true', { timeout: 5_000 })

  // Scroll back to the very top: Appearance again
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(appearanceLink).toHaveAttribute('aria-current', 'true', { timeout: 5_000 })
  await expect(providersLink).not.toHaveAttribute('aria-current', 'true')
})

// ---------------------------------------------------------------------------
// Plan P — unified model panel: ONE section, per-row role toggles, presets,
// and NO separate verify/generate radio.
// ---------------------------------------------------------------------------
test('model panel: ONE section with role toggles + presets, no verify/generate radio', async ({
  page,
}) => {
  await blockExternal(page)

  // Seed two Anthropic models on one key so the panel has 2 participants.
  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({
        aiProvider: 'anthropic',
        anthropicKey: 'sk-ant-test-key',
        aiPanel: {
          participants: [
            { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
            { provider: 'anthropic', model: 'claude-haiku-4-5', role: 'verifier' },
          ],
        },
      }),
    )
  })

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })

  // ONE unified panel section.
  const panel = page.getByTestId('model-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText(/^Model panel$/)).toBeVisible()

  // No old separate verify/generate "How models combine" radio.
  await expect(page.getByText(/How models combine/i)).toHaveCount(0)
  await expect(page.getByText(/Ensemble \/ verification panel/i)).toHaveCount(0)

  // Per-row role toggles present + the two presets.
  await expect(panel.getByRole('button', { name: /One generator/i })).toBeVisible()
  await expect(panel.getByRole('button', { name: /All generate/i })).toBeVisible()

  // "All generate" flips both rows to generator.
  await panel.getByRole('button', { name: /All generate/i }).click()
  const roles = await page.evaluate(
    () => (JSON.parse(localStorage.getItem('review123:settings') ?? '{}').aiPanel?.participants ?? []).map((p: { role: string }) => p.role),
  )
  expect(roles).toEqual(['generator', 'generator'])

  // "One generator" flips back to a single generator.
  await panel.getByRole('button', { name: /One generator/i }).click()
  const roles2 = await page.evaluate(
    () => (JSON.parse(localStorage.getItem('review123:settings') ?? '{}').aiPanel?.participants ?? []).map((p: { role: string }) => p.role),
  )
  expect(roles2).toEqual(['generator', 'verifier'])
})
