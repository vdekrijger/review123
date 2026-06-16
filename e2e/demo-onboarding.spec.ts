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

  // Inspect step: MULTIPLE reviewer personas render, and the cross-model
  // verification chips (confirmed + demoted) + the multi-generator "raised by"
  // provenance show — the demo's differentiator showcase.
  await page.getByRole('button', { name: /next step/i }).click()
  await expect(page.getByText(/Security Reviewer \(OWASP-minded\)/i).first()).toBeVisible()
  await expect(page.getByText(/Performance Reviewer/i).first()).toBeVisible()
  await expect(page.getByText(/Resiliency & SRE Reviewer/i).first()).toBeVisible()
  // CONFIRMED cross-model finding chip + multi-generator provenance.
  await expect(page.getByText(/confirmed by 3\/4 models/i).first()).toBeVisible()
  await expect(page.getByText(/raised by GPT-5\.5, DeepSeek V4 Pro/i).first()).toBeVisible()
  // DEMOTED / lower-confidence cross-model finding chip.
  await expect(page.getByText(/flagged by 1\/5 · lower confidence/i).first()).toBeVisible()

  // Story mode: the Inspect step exposes a Story|Files flow toggle (the demo
  // ships a canned multi-layer walkthrough). Switching to Story renders the
  // step captions/layer chips; Files is the default (diff-first).
  const storyToggle = page.getByRole('button', { name: /^Story$/ })
  await expect(storyToggle).toBeVisible()
  await expect(page.getByRole('button', { name: /^Files$/ })).toBeVisible()
  await storyToggle.click()
  // First step is the data layer: caption + layer chip + step counter.
  await expect(page.getByText('Data model')).toBeVisible()
  await expect(page.getByText(/so a request can be aborted mid-flight/i)).toBeVisible()
  await expect(page.locator('.story-counter').first()).toContainText('1 of 6')
  // Advance one step (the slideshow's own Next, inside the .story controls) to
  // the API layer — the walkthrough is navigable.
  await page.locator('.story-controls').first().getByRole('button', { name: /next step/i }).click()
  await expect(page.getByText('API / service')).toBeVisible()
  await expect(page.getByText(/so cancelling a request actually reaches the network/i)).toBeVisible()

  // Verdict step: the "Review cost & model performance" panel renders with the
  // aggregate $ total + per-model rows (the demo turns showTokenCost on). With
  // Story mode active there are two "Next step" buttons (slideshow + draft-bar);
  // use the draft-bar's step nav to advance the demo route to step 3.
  await page.locator('.draft-bar').getByRole('button', { name: /next step/i }).click()
  await expect(
    page.getByRole('region', { name: /review cost and model performance/i }),
  ).toBeVisible()
  await expect(page.getByText(/this review used .* total/i)).toBeVisible()
  await expect(page.getByText('deepseek-v4-pro')).toBeVisible()
  await expect(page.getByText('gpt-5.5')).toBeVisible()

  // The banner's set-up CTA goes to settings.
  await page.getByRole('link', { name: /add your api key or sign in/i }).click()
  await expect(page).toHaveURL(/\/settings\/providers$/)

  expect(externalHits, `unexpected external requests: ${externalHits.join(', ')}`).toEqual([])
})
