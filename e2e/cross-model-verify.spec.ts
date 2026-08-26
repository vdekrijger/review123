/**
 * e2e/cross-model-verify.spec.ts — cross-model verification (Plan M).
 *
 * Two providers configured (DeepSeek active generator + Anthropic verifier).
 * The skill reviewer raises two findings. The Anthropic verifier CONFIRMS the
 * first and REFUTES the second. Expectation (finding-triage):
 *   - the confirmed finding renders INLINE with the single "✓ verified" chip,
 *   - the refuted (demoted) finding collapses into the per-file
 *     "N more findings" group — no inline card, no "lower confidence" chrome —
 *     and the review-level triage line offers the "Show all" escape hatch.
 *
 * A single-key control (no Anthropic key) shows NO cross-verify UI.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

function makePrMeta() {
  return {
    title: 'Test PR: add feature',
    state: 'open',
    merged: false,
    body: 'This PR adds a new feature.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 1,
  }
}

const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

function makePrFiles() {
  return [{ filename: 'src/feature.ts', status: 'modified', patch: PATCH_WITH_LINES, additions: 2, deletions: 1 }]
}

function makeFileContent(text: string) {
  return { content: Buffer.from(text).toString('base64') + '\n', encoding: 'base64' }
}

// Two findings, both anchored at line 2 vs line 4 (in the visible diff hunk).
const SKILL_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    { path: 'src/feature.ts', line: 2, severity: 'high', body: 'Confirmed real bug: unsanitized input' },
    { path: 'src/feature.ts', line: 4, severity: 'low', body: 'Refuted style nit: prefer const' },
  ],
}

function makeDeepSeekStreamResponse(text: string): string {
  const lines = text.split(' ').map((word) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ delta: { content: word + ' ' }, index: 0, finish_reason: null }] })}`,
  )
  lines.push('data: [DONE]')
  return lines.join('\n') + '\n'
}

const SUMMARY_TEXT = 'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

function seedSettings(extra: Record<string, unknown> = {}) {
  return {
    deepseekKey: 'sk-test-deepseek-key',
    aiProvider: 'deepseek',
    diffMode: 'unified',
    railCollapsed: false,
    ...extra,
  }
}

function seedSkillScript() {
  return `
    (() => {
      const skill = {
        id: 'skill-e2e-test',
        name: 'Security Reviewer',
        content: '## Security\\nCheck for XSS and injection vulnerabilities.',
        enabled: true,
        addedAt: 1700000000000,
      };
      localStorage.setItem('review123:reviewer-skills', JSON.stringify([skill]));
    })();
  `
}

async function setupGithub(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) return route.fulfill({ json: makePrMeta() })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) return route.fulfill({ json: makePrFiles() })
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      const ref = url.searchParams.get('ref') ?? ''
      const filePath = decodeURIComponent(path.replace(`/repos/${OWNER}/${REPO}/contents/`, ''))
      if (filePath === 'src/feature.ts' && ref === BASE_SHA) return route.fulfill({ json: makeFileContent('const old = 1\nremoved line\ntrailing context') })
      if (filePath === 'src/feature.ts' && ref === HEAD_SHA) return route.fulfill({ json: makeFileContent('const old = 1\nunchanged line\nadded line\nanother added line\ntrailing context') })
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }
    if (path.endsWith('/comments') || path.endsWith('/commits')) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
}

async function setupDeepseek(page: import('@playwright/test').Page) {
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeDeepSeekStreamResponse(SUMMARY_TEXT) })
    }
    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    if (systemContent.includes('reviewer persona') || systemContent.includes('security reviewer')) {
      return route.fulfill({ status: 200, json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(SKILL_REVIEW_RESULT) }, finish_reason: 'stop', index: 0 }] } })
    }
    return route.fulfill({ status: 200, json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ level: 'minor-changes', evidence: ['src/feature.ts modified'], notAnalyzed: [] }) }, finish_reason: 'stop', index: 0 }] } })
  })
}

// Anthropic verifier: confirm finding 1, refute finding 2. The verify prompt
// is JSON-only; we reply with the verdicts shape the engine validates.
async function setupAnthropicVerifier(page: import('@playwright/test').Page) {
  await page.route('**/api.anthropic.com/**', async (route) => {
    let body: { system?: string; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    const user = body?.messages?.find((m) => m.role === 'user')?.content ?? ''
    // The verify payload carries the finding bodies + ids. Build a verdict map by
    // confirming the "Confirmed real bug" finding and refuting the "Refuted" one.
    const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
    const verdicts = ids.map((id) => {
      // The id is path:line:hash. Match by line (2 = confirm, 4 = refute).
      const isLine2 = /:2:/.test(id)
      return { id, verdict: isLine2 ? 'confirm' : 'refute', reason: isLine2 ? 'real' : 'nit' }
    })
    return route.fulfill({
      status: 200,
      json: {
        content: [{ type: 'text', text: JSON.stringify({ verdicts }) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
  })
}

// OpenAI verifier (via the serverless proxy /api/llm/openai). Also refutes the
// line-4 nit so that, with two refuting verifiers, it drops below the surface
// threshold (generator 1 / polled 3 < 1.5 → demoted).
async function setupOpenAiVerifier(page: import('@playwright/test').Page) {
  await page.route('**/api/llm/openai/**', async (route) => {
    let body: { messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    const user = body?.messages?.find((m) => m.role === 'user')?.content ?? ''
    const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
    const verdicts = ids.map((id) => {
      const isLine2 = /:2:/.test(id)
      return { id, verdict: isLine2 ? 'confirm' : 'refute', reason: isLine2 ? 'real' : 'nit' }
    })
    return route.fulfill({
      status: 200,
      json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdicts }) }, finish_reason: 'stop', index: 0 }] },
    })
  })
}

async function seedAll(page: import('@playwright/test').Page, settings: Record<string, unknown>) {
  await page.addInitScript((s) => { localStorage.setItem('review123:settings', JSON.stringify(s)) }, settings)
  await page.addInitScript(seedSkillScript())
  await page.addInitScript(() => { localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false })) })
}

test('cross-model verify triage: confirmed finding inline with "✓ verified", refuted finding collapsed; Show all restores it', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseek(page)
  await setupAnthropicVerifier(page)
  await setupOpenAiVerifier(page)
  // Three keys → two verifiers (Anthropic + OpenAI), both refuting line 4 →
  // it drops below the surface threshold and is demoted.
  await seedAll(page, seedSettings({ anthropicKey: 'sk-ant-test-key', openaiKey: 'sk-openai-test-key' }))

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers/i }).click()

  // The confirmed (high, 3/3-confirmed) finding renders INLINE with the single
  // "✓ verified" trust chip — the vote detail lives in the accessible name.
  await expect(page.getByText(/Confirmed real bug/i)).toBeVisible({ timeout: 15_000 })
  const confirmedCard = page.locator('.line-findings .skill-finding', { hasText: 'Confirmed real bug' })
  await expect(confirmedCard).toBeVisible({ timeout: 10_000 })
  const verifyChip = confirmedCard.locator('.skill-verify-chip')
  await expect(verifyChip).toBeVisible({ timeout: 10_000 })
  await expect(verifyChip).toHaveText('✓ verified')
  await expect(verifyChip).toHaveAttribute('aria-label', /confirmed by \d+ of \d+ models/i)

  // The refuted (demoted, low) finding does NOT render inline — a
  // failed-verification low card sitting full-size mid-diff is impossible by
  // construction. No "lower confidence" chrome exists anywhere.
  await expect(page.locator('.line-findings .skill-finding', { hasText: 'Refuted style nit' })).toHaveCount(0)
  await expect(page.locator('.skill-lower-confidence-chip')).toHaveCount(0)
  await expect(page.getByText(/lower confidence/i)).toHaveCount(0)

  // It collapses into the per-file group; the review-level line reports it.
  const group = page.getByTestId('secondary-findings')
  await expect(group).toBeVisible()
  await expect(group.locator('summary')).toContainText('1 more finding — low confidence or minor')
  const triageLine = page.getByTestId('findings-triage-line')
  await expect(triageLine).toContainText('Showing 1 of 2 findings')
  await expect(triageLine).toContainText('1 minor or low-confidence collapsed')

  // Expanding the group discloses the FULL card — body + working actions.
  await group.locator('summary').click()
  const collapsedCard = group.locator('.skill-finding', { hasText: 'Refuted style nit' })
  await expect(collapsedCard).toBeVisible()
  await expect(collapsedCard.getByRole('button', { name: /add as draft/i })).toBeVisible()
  await expect(collapsedCard.getByRole('button', { name: /dismiss/i })).toBeVisible()

  // "Show all" renders every finding inline again (the escape hatch).
  await page.getByTestId('findings-show-all').click()
  await expect(page.locator('.line-findings .skill-finding', { hasText: 'Refuted style nit' })).toHaveCount(1)
  await expect(page.getByTestId('secondary-findings')).toHaveCount(0)
  await expect(triageLine).toContainText('Showing all 2 findings')

  // And back: collapsing restores the triaged view.
  await page.getByTestId('findings-show-all').click()
  await expect(page.getByTestId('secondary-findings')).toBeVisible()
  await expect(page.locator('.line-findings .skill-finding', { hasText: 'Refuted style nit' })).toHaveCount(0)
})

// NOTE: the per-REVIEWER per-model cost/impact breakdown (`.skill-model-breakdowns`,
// Plan N) was REMOVED from Step 3 — per-model cost/impact now lives only in the
// consolidated end-of-verdict ReviewCostPanel. The two tests that asserted on the
// per-reviewer breakdown were dropped with that change.

// ---------------------------------------------------------------------------
// Plan O — multi-generator fusion ('generate' mode)
// ---------------------------------------------------------------------------

// In 'generate' mode BOTH providers generate skill findings. DeepSeek raises
// only the line-2 finding; Anthropic raises a UNIQUE line-4 finding DeepSeek
// missed. On cross-confirm both confirm the other's → both surface, and the
// line-4 finding shows "raised by Anthropic" provenance (the recall win).
const DEEPSEEK_GEN = {
  skillName: 'Security Reviewer',
  findings: [
    { path: 'src/feature.ts', line: 2, severity: 'high', body: 'Shared bug: unsanitized input' },
  ],
}
const ANTHROPIC_GEN = {
  skillName: 'Security Reviewer',
  findings: [
    { path: 'src/feature.ts', line: 4, severity: 'high', body: 'Anthropic-only bug: missing authz check' },
  ],
}

// DeepSeek in 'generate' mode: skill-review system prompt → its generated set;
// verify (adversarial) prompt → confirm everything; summary stream unchanged.
async function setupDeepseekGenerate(page: import('@playwright/test').Page) {
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeDeepSeekStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    const user = body?.messages?.find((m) => m.role === 'user')?.content ?? ''
    if (system.includes('adversarial verifier')) {
      const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
      const verdicts = ids.map((id) => ({ id, verdict: 'confirm', reason: 'agree' }))
      return route.fulfill({ status: 200, json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdicts }) }, finish_reason: 'stop', index: 0 }] } })
    }
    if (system.includes('reviewer persona') || system.includes('security reviewer')) {
      return route.fulfill({ status: 200, json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(DEEPSEEK_GEN) }, finish_reason: 'stop', index: 0 }] } })
    }
    return route.fulfill({ status: 200, json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ level: 'minor-changes', evidence: ['src/feature.ts modified'], notAnalyzed: [] }) }, finish_reason: 'stop', index: 0 }] } })
  })
}

// Anthropic in 'generate' mode: skill-review prompt → its UNIQUE finding;
// verify prompt → confirm everything.
async function setupAnthropicGenerate(page: import('@playwright/test').Page) {
  await page.route('**/api.anthropic.com/**', async (route) => {
    let body: { system?: string; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    const system = (body?.system ?? '').toLowerCase()
    const user = body?.messages?.find((m) => m.role === 'user')?.content ?? ''
    if (system.includes('adversarial verifier')) {
      const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
      const verdicts = ids.map((id) => ({ id, verdict: 'confirm', reason: 'agree' }))
      return route.fulfill({ status: 200, json: { content: [{ type: 'text', text: JSON.stringify({ verdicts }) }], usage: { input_tokens: 10, output_tokens: 5 } } })
    }
    return route.fulfill({ status: 200, json: { content: [{ type: 'text', text: JSON.stringify(ANTHROPIC_GEN) }], usage: { input_tokens: 10, output_tokens: 5 } } })
  })
}

test('fusion generate: a finding only one model raised surfaces with "raised by" provenance (recall)', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseekGenerate(page)
  await setupAnthropicGenerate(page)
  // Two keys + an all-generate panel (both providers role 'generator') → both
  // models generate; the union surfaces findings only one caught. The mode is
  // now emergent from the ≥2-generator panel (Plan P).
  await seedAll(page, seedSettings({
    anthropicKey: 'sk-ant-test-key',
    aiPanel: {
      participants: [
        { provider: 'deepseek', model: 'deepseek-v4-flash', role: 'generator' },
        { provider: 'anthropic', model: 'claude-sonnet-4-6', role: 'generator' },
      ],
    },
  }))

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers/i }).click()

  // The Anthropic-only finding (which DeepSeek missed) SURFACES — the recall win.
  await expect(page.getByText(/Anthropic-only bug/i)).toBeVisible({ timeout: 15_000 })
  // It carries "raised by Anthropic" provenance and the "✓ verified" trust chip
  // (majority-confirmed; vote detail in the accessible name).
  const uniqueCard = page.locator('.skill-finding', { hasText: 'Anthropic-only bug' })
  await expect(uniqueCard.locator('.skill-raised-chip')).toContainText(/raised by/i)
  await expect(uniqueCard.locator('.skill-verify-chip')).toHaveText('✓ verified')
  await expect(uniqueCard.locator('.skill-verify-chip')).toHaveAttribute('aria-label', /confirmed by \d+ of \d+ models/i)
  // The shared finding is also present.
  await expect(page.getByText(/Shared bug/i)).toBeVisible()
})

test('single-key control: no cross-verify UI; severity alone drives the triage', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseek(page)
  await setupAnthropicVerifier(page) // routed but should never be called
  // Only one key → verification is a no-op.
  await seedAll(page, seedSettings())

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers/i }).click()

  // The unverified HIGH renders inline (single-model setups are not punished);
  // no verify chip anywhere (verification never ran).
  await expect(page.getByText(/Confirmed real bug/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.skill-verify-chip')).toHaveCount(0)

  // The lone unverified LOW is minor → collapses into the per-file group.
  const group = page.getByTestId('secondary-findings')
  await expect(group).toBeVisible({ timeout: 10_000 })
  await expect(group.locator('summary')).toContainText('1 more finding')
  await group.locator('summary').click()
  await expect(group.locator('.skill-finding', { hasText: 'Refuted style nit' })).toBeVisible()
})

// ---------------------------------------------------------------------------
// Story mode: a DEMOTED reviewer finding still has a real card in the DOM
// (inside the collapsed secondary group) and chip navigation opens the group
// and lands on it. Regression for the bug where demoted (and null-line)
// findings rendered nowhere in Story mode, so the reviewer chip said
// "N findings" but clicking a finding was a silent no-op (no jump target).
// ---------------------------------------------------------------------------

// A story whose single step covers src/feature.ts, so the reviewer's findings on
// that file render in the story slide.
const STORY_FOR_FEATURE = {
  steps: [
    { index: 0, files: ['src/feature.ts'], caption: 'The feature is added.', layer: 'logic', relatedTests: [] },
  ],
}

// DeepSeek in story mode: streams the summary, returns the story for the
// storyOrder task, the skill findings for the reviewer prompt, a verdict
// otherwise. Distinguished by the system prompt content.
async function setupDeepseekStory(page: import('@playwright/test').Page) {
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeDeepSeekStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    if (/guided narrative walkthrough/i.test(system)) {
      return route.fulfill({ status: 200, json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(STORY_FOR_FEATURE) }, finish_reason: 'stop', index: 0 }] } })
    }
    if (system.includes('reviewer persona') || system.includes('security reviewer')) {
      return route.fulfill({ status: 200, json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(SKILL_REVIEW_RESULT) }, finish_reason: 'stop', index: 0 }] } })
    }
    return route.fulfill({ status: 200, json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ level: 'minor-changes', evidence: ['src/feature.ts modified'], notAnalyzed: [] }) }, finish_reason: 'stop', index: 0 }] } })
  })
}

test('story mode: a demoted finding renders a visible, clickable card and chip navigation lands on it', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseekStory(page)
  await setupAnthropicVerifier(page)
  await setupOpenAiVerifier(page)
  // storyMode on + three keys → the line-4 finding is demoted by the two verifiers.
  await seedAll(page, seedSettings({ anthropicKey: 'sk-ant-test-key', openaiKey: 'sk-openai-test-key', storyMode: true }))

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  // Story is the active flow.
  const storyBtn = page.getByRole('button', { name: 'Story' })
  await expect(storyBtn).toBeVisible({ timeout: 15_000 })
  await expect(storyBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.story')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /run my reviewers/i }).click()

  // The demoted finding collapses into the story slide's per-file secondary
  // group — present in the DOM (a real jump target), not full-size mid-diff.
  const storyGroup = page.locator('.story [data-testid="secondary-findings"]')
  await expect(storyGroup).toBeVisible({ timeout: 15_000 })
  await expect(storyGroup.locator('summary')).toContainText('1 more finding')
  const demotedCard = page.locator('.story .skill-finding', { hasText: 'Refuted style nit' })

  // The reviewer chip counts BOTH findings; clicking the chip opens the popover.
  const chip = page.getByRole('button', { name: /Show 2 findings from Security Reviewer/i })
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()
  const menu = page.locator('.findings-popover[role="menu"]')
  await expect(menu).toBeVisible()

  // Click the demoted finding's entry → navigation OPENS the collapsed group and
  // lands on the real card (scrolled into view), proving the jump target exists
  // in story mode even while triaged into the group.
  const entry = menu.locator('[role="menuitem"]', { hasText: 'Refuted style nit' })
  await expect(entry).toHaveCount(1)
  await entry.click()
  await expect(page.locator('.findings-popover')).toHaveCount(0)
  await expect(demotedCard).toBeVisible({ timeout: 10_000 })
  await expect(demotedCard).toBeInViewport()
})
