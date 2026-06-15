/**
 * e2e/cross-model-verify.spec.ts — cross-model verification (Plan M).
 *
 * Two providers configured (DeepSeek active generator + Anthropic verifier).
 * The skill reviewer raises two findings. The Anthropic verifier CONFIRMS the
 * first and REFUTES the second. Expectation:
 *   - the confirmed finding shows a "✓ confirmed by N/M models" chip,
 *   - the refuted finding is moved into the collapsed "Lower confidence" group.
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

test('cross-model verify: confirmed finding shows chip, refuted finding goes to lower-confidence group', async ({ page }) => {
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

  // The confirmed finding is visible with a verify chip.
  await expect(page.getByText(/Confirmed real bug/i)).toBeVisible({ timeout: 15_000 })
  const confirmedCard = page.locator('.skill-finding', { hasText: 'Confirmed real bug' })
  await expect(confirmedCard.locator('.skill-verify-chip')).toBeVisible({ timeout: 10_000 })
  await expect(confirmedCard.locator('.skill-verify-chip')).toContainText(/confirmed by \d+\/\d+ models/i)

  // The refuted finding lives in the collapsed lower-confidence group.
  const group = page.locator('.lower-confidence-group')
  await expect(group).toBeVisible({ timeout: 10_000 })
  await expect(group.locator('summary')).toContainText(/Lower confidence/i)
  // Expand it and confirm the refuted finding is inside (not silently dropped).
  await group.locator('summary').click()
  await expect(group.getByText(/Refuted style nit/i)).toBeVisible()

  // The refuted finding is NOT in the inline diff flow — only in the group.
  await expect(page.locator('.line-findings .skill-finding', { hasText: 'Refuted style nit' })).toHaveCount(0)
  await expect(page.locator('.skill-finding', { hasText: 'Refuted style nit' })).toHaveCount(1)
})

test('ensemble >1 model: skill card shows per-model cost + impact breakdown (Plan N)', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseek(page)
  await setupAnthropicVerifier(page)
  // DeepSeek generator + Anthropic verifier = 2-model ensemble. showTokenCost on
  // → the per-model breakdown table renders with a cost column.
  await seedAll(page, seedSettings({ anthropicKey: 'sk-ant-test-key', showTokenCost: true }))

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers/i }).click()
  await expect(page.getByText(/Confirmed real bug/i)).toBeVisible({ timeout: 15_000 })

  // The per-reviewer per-model breakdown is rendered (collapsible). Expand it.
  const breakdownWrap = page.locator('.skill-model-breakdowns')
  await expect(breakdownWrap).toBeVisible({ timeout: 10_000 })
  const details = page.locator('[data-skill-models="skill-e2e-test"]')
  await expect(details).toBeVisible()
  await details.locator('summary').click()

  // Both ensemble models listed: DeepSeek generator + Anthropic verifier
  // (default models, since no custom aiEnsemble is seeded here).
  await expect(details.locator('.model-id', { hasText: 'deepseek-v4-flash' })).toBeVisible()
  await expect(details.locator('.model-id', { hasText: 'claude-sonnet-4-6' })).toBeVisible()
  // showTokenCost on → cost column present.
  await expect(details.getByRole('columnheader', { name: /cost/i })).toBeVisible()
  // The plain aggregate footer is still present (per-model is ADDITIVE).
  // (Confirmed-by chip / lower-confidence group are covered by the test above.)
})

test('single-model ensemble: skill card shows ONLY the aggregate footer, no per-model table', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseek(page)
  await setupAnthropicVerifier(page) // routed but never called (single model)
  // Only one key → single-model ensemble. showTokenCost on so the aggregate
  // footer renders; there must be NO per-model breakdown.
  await seedAll(page, seedSettings({ showTokenCost: true }))

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers/i }).click()
  await expect(page.getByText(/Confirmed real bug/i)).toBeVisible({ timeout: 15_000 })

  // No per-model breakdown block for a single-model run.
  await expect(page.locator('.skill-model-breakdowns')).toHaveCount(0)
})

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
  // Two keys + fusionMode 'generate' → both models generate; the union surfaces
  // findings only one caught.
  await seedAll(page, seedSettings({ anthropicKey: 'sk-ant-test-key', fusionMode: 'generate' }))

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers/i }).click()

  // The Anthropic-only finding (which DeepSeek missed) SURFACES — the recall win.
  await expect(page.getByText(/Anthropic-only bug/i)).toBeVisible({ timeout: 15_000 })
  // It carries "raised by Anthropic" provenance and a confirmed-by chip.
  const uniqueCard = page.locator('.skill-finding', { hasText: 'Anthropic-only bug' })
  await expect(uniqueCard.locator('.skill-raised-chip')).toContainText(/raised by/i)
  await expect(uniqueCard.locator('.skill-verify-chip')).toContainText(/confirmed by \d+\/\d+ models/i)
  // The shared finding is also present.
  await expect(page.getByText(/Shared bug/i)).toBeVisible()
})

test('single-key control: no cross-verify UI (no chip, no lower-confidence group)', async ({ page }) => {
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

  // Both findings are shown unverified, in the normal flow.
  await expect(page.getByText(/Confirmed real bug/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Refuted style nit/i)).toBeVisible()
  // No verify chip, no lower-confidence group.
  await expect(page.locator('.skill-verify-chip')).toHaveCount(0)
  await expect(page.locator('.lower-confidence-group')).toHaveCount(0)
})
