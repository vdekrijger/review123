/**
 * e2e/demo-onboarding.spec.ts
 *
 * The "Try a live demo — no setup" onboarding path. A fresh visitor (no auth,
 * no LLM key) lands, clicks the prominent demo CTA, and sees the FULL review
 * experience on a bundled example PR with pre-generated AI output:
 *   - a clearly-labelled demo banner with a set-up CTA to settings,
 *   - the pre-generated summary + verdict evidence on the Understand step,
 *   - a skill-reviewer finding on the Inspect step,
 * all with ZERO calls to GitHub or any LLM provider (the demo is offline).
 */

import { test, expect } from '@playwright/test'

// Keep analytics out of the run; everything else external is a failure.
async function blockAnalytics(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
}

test('landing CTA opens the demo with banner, summary, verdict, finding — no external network', async ({
  page,
}) => {
  await blockAnalytics(page)

  // Fail loudly if the demo ever contacts GitHub or an LLM provider.
  const externalHits: string[] = []
  await page.route('**/*', (route) => {
    const url = route.request().url()
    if (/github\.com|githubusercontent|gitlab\.com|bitbucket|deepseek|openai|anthropic/i.test(url)) {
      externalHits.push(url)
      return route.abort()
    }
    return route.continue()
  })

  await page.goto('/')

  // The cold-start CTA is a prominent button.
  const cta = page.getByRole('button', { name: /try a live demo — no setup needed/i })
  await expect(cta).toBeVisible()
  await cta.click()

  await expect(page).toHaveURL(/\/demo$/)

  // Demo banner is unmistakable and links to set-up.
  await expect(page.getByText(/these results are pre‑generated/i)).toBeVisible()
  await expect(page.getByRole('link', { name: /add your api key or sign in/i })).toBeVisible()

  // Understand step: pre-generated summary + the verdict pill (glance card).
  await expect(page.getByText(/fixes a race condition in the search box/i).first()).toBeVisible()
  await expect(page.getByText('minor-changes')).toBeVisible()

  // Expand the "Why this verdict" panel to reveal the pre-generated evidence.
  await page.getByText('Why this verdict', { exact: true }).click()
  await expect(page.getByText(/Adds a 250ms debounce in useSearch/i)).toBeVisible()

  // Inspect step: a skill-reviewer finding renders.
  await page.getByRole('button', { name: /next step/i }).click()
  await expect(page.getByText(/does not show src\/search\/api\.ts honouring it/i)).toBeVisible()

  // The banner's set-up CTA goes to settings.
  await page.getByRole('link', { name: /add your api key or sign in/i }).click()
  await expect(page).toHaveURL(/\/settings\/providers$/)

  expect(externalHits, `unexpected external requests: ${externalHits.join(', ')}`).toEqual([])
})
