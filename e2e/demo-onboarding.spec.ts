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

  // Diagrams: the demo ships a pre-generated change-impact / blast-radius view,
  // so the Understand step shows the real diagram — NOT the muted "enable in
  // AI settings" disabled state. Expand the diagrams panel (its in-panel title is
  // "Change impact") and confirm the impact view renders with a Mermaid SVG.
  const diagramsPanel = page.locator('.diagrams-panel')
  await diagramsPanel.locator('summary.detail-summary').click()
  await expect(diagramsPanel.locator('.changemap-title', { hasText: 'Change impact' })).toBeVisible()
  await expect(diagramsPanel.locator('.diagram-container svg').first()).toBeVisible()
  await expect(diagramsPanel.locator('.ai-panel-disabled')).toHaveCount(0)

  // Inspect step: MULTIPLE reviewer personas render, the confirmed finding
  // carries the "✓ verified" trust chip + multi-generator "raised by"
  // provenance, and the weak findings are TRIAGED into collapsed per-file
  // groups with a review-level line — the demo's differentiator showcase.
  await page.getByRole('button', { name: /next step/i }).click()
  await expect(page.getByText(/Security Reviewer \(OWASP-minded\)/i).first()).toBeVisible()
  await expect(page.getByText(/Performance Reviewer/i).first()).toBeVisible()
  await expect(page.getByText(/Resiliency & SRE Reviewer/i).first()).toBeVisible()
  // CONFIRMED cross-model finding: single trust chip, detail in the aria-label.
  const verifiedChip = page.locator('.skill-verify-chip').first()
  await expect(verifiedChip).toBeVisible()
  await expect(verifiedChip).toHaveText('✓ verified')
  await expect(verifiedChip).toHaveAttribute('aria-label', /confirmed by 3 of 4 models/i)
  await expect(page.getByText(/raised by GPT-5\.5, DeepSeek V4 Pro/i).first()).toBeVisible()
  // DEMOTED / minor findings: no per-card "lower confidence" chrome — they
  // collapse into per-file groups, reported by the review-level triage line.
  await expect(page.getByText(/lower confidence/i)).toHaveCount(0)
  const triageLine = page.getByTestId('findings-triage-line')
  await expect(triageLine).toContainText('Showing 1 of 3 findings')
  await expect(triageLine).toContainText('2 minor or low-confidence collapsed')
  await expect(page.getByTestId('secondary-findings')).toHaveCount(2)

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

test('cross-model verify tooltip escapes clipping ancestors (top layer, fully on-screen) on hover AND focus', async ({
  page,
}) => {
  await blockAnalytics(page)
  await page.goto('/demo')
  await expect(page).toHaveURL(/\/demo$/)

  // Inspect step hosts the Security reviewer's "✓ verified" trust chip whose
  // per-vote tooltip previously got clipped by the panel's overflow:hidden.
  // It now renders in the browser top layer (Popover API) so it can't be
  // cropped. (The demoted finding no longer shows a chip — it is triaged into
  // the collapsed group — so the verified chip is the tooltip trigger.)
  await page.getByRole('button', { name: /next step/i }).click()
  const verifiedChip = page.locator('.skill-verify-chip').first()
  await expect(verifiedChip).toBeVisible()

  // The tooltip is a popover sibling inside the same .skill-verify-tip-anchor.
  const anchor = page.locator('.skill-verify-tip-anchor', { has: verifiedChip })
  const tip = anchor.locator('.skill-verify-tip')

  async function assertFullyOnScreenAndTopLayer() {
    await expect(tip).toBeVisible()
    // It must be promoted to the top layer (popover is open) — not a plain
    // in-flow absolutely-positioned element that an ancestor can clip.
    expect(await tip.evaluate((el) => (el as HTMLElement).matches(':popover-open'))).toBe(true)
    // Fully within the viewport on every edge (no left/bottom/right/top clip).
    const box = await tip.boundingBox()
    const vp = page.viewportSize()!
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height)
  }

  // 1) HOVER shows it, fully visible.
  await verifiedChip.hover()
  await assertFullyOnScreenAndTopLayer()

  // Move away → it hides again.
  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  // 2) Keyboard FOCUS shows it too (keyboard-reachable), fully visible.
  await verifiedChip.focus()
  await assertFullyOnScreenAndTopLayer()
})
