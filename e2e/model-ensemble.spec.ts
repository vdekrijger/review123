/**
 * e2e/model-ensemble.spec.ts — configurable ensemble + per-model cost/impact
 * (Plan N).
 *
 * A SINGLE Anthropic key with a TWO-MODEL ensemble (claude-opus-4-8 generator +
 * claude-haiku-4-5 verifier). This is the Plan N unlock: cross-verify runs with
 * one provider key. In step 3 (Verdict) the consolidated "Review cost & model
 * performance" panel shows a per-model IMPACT readout (always) and, with
 * showTokenCost on, an aggregate token total + a per-model COST column.
 *
 * All Anthropic traffic hits api.anthropic.com; the route handler branches on the
 * request body to serve generation (summary/verdict) vs adversarial verification.
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
    user: { login: 'someone-else' },
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

const SUMMARY_TEXT = 'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

const VERDICT_RESULT = {
  level: 'minor-changes',
  evidence: ['src/feature.ts adds an unsanitized input path', 'src/feature.ts changes a default value'],
  notAnalyzed: [],
}

function seedSettings() {
  return {
    anthropicKey: 'sk-ant-test-key',
    aiProvider: 'anthropic',
    aiModel: 'claude-opus-4-8',
    // Plan P: single-key, two-model panel — one generator + one verifier.
    aiPanel: {
      participants: [
        { provider: 'anthropic', model: 'claude-opus-4-8', role: 'generator' },
        { provider: 'anthropic', model: 'claude-haiku-4-5', role: 'verifier' },
      ],
    },
    showTokenCost: true,
    diffMode: 'unified',
    railCollapsed: false,
    // Files flow at step 2 — story mode off so the deterministic structural
    // fallback's slideshow nav doesn't shadow the step navigation here.
    storyMode: false,
    githubAuth: { token: 'gho_test', method: 'oauth', scopes: ['repo'] },
  }
}

async function setupGithub(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/user') return route.fulfill({ json: { login: 'me-the-reviewer' } })
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

// One Anthropic handler for BOTH the generator and the verifier model. Branches
// on the request body: streaming → summary; verify prompt → adversarial verdicts
// (confirm evidence 0, refute evidence 1 → demoted); otherwise → verdict JSON.
async function setupAnthropic(page: import('@playwright/test').Page) {
  await page.route('**/api.anthropic.com/**', async (route) => {
    let body: { stream?: boolean; model?: string; system?: string; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    const system = (body?.system ?? '').toLowerCase()
    const user = body?.messages?.find((m) => m.role === 'user')?.content ?? ''

    if (body?.stream === true) {
      // Anthropic SSE streaming for the summary task.
      const evt = (o: unknown) => `event: content_block_delta\ndata: ${JSON.stringify(o)}\n\n`
      const sse = SUMMARY_TEXT.split(' ').map((w) =>
        evt({ type: 'content_block_delta', delta: { type: 'text_delta', text: w + ' ' } }),
      ).join('') + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse })
    }

    if (system.includes('adversarial verifier')) {
      // Verifier model: confirm evidence ev:0, refute ev:1.
      const ids = [...user.matchAll(/"id":\s*"(ev:\d+)"/g)].map((m) => m[1])
      const verdicts = ids.map((id) => ({ id, verdict: id === 'ev:0' ? 'confirm' : 'refute', reason: id === 'ev:0' ? 'real' : 'nit' }))
      return route.fulfill({
        status: 200,
        json: { content: [{ type: 'text', text: JSON.stringify({ verdicts }) }], usage: { input_tokens: 80, output_tokens: 20 } },
      })
    }

    // Generation (verdict + any other JSON task): return the verdict result.
    return route.fulfill({
      status: 200,
      json: { content: [{ type: 'text', text: JSON.stringify(VERDICT_RESULT) }], usage: { input_tokens: 1000, output_tokens: 500 } },
    })
  })
}

async function seedAll(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => { localStorage.setItem('review123:settings', JSON.stringify(s)) }, seedSettings())
  await page.addInitScript(() => { localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false })) })
}

test('single-key 2-model ensemble: step-3 shows per-model cost + impact readout', async ({ page }) => {
  await setupGithub(page)
  await setupAnthropic(page)
  await seedAll(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })

  // Walk to step 3 (Verdict).
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  // The consolidated per-model breakdown appears (cross-verify ran). Each model
  // is now an expandable row whose total reconciles with the review total.
  const breakdown = page.locator('.review-cost')
  await expect(breakdown).toBeVisible({ timeout: 15_000 })
  await expect(breakdown.getByText('Model performance')).toBeVisible()

  // Generator row: impact = surfaced findings count. With a SINGLE verifier,
  // a tie surfaces, so both evidence rows surface → "2 surfaced findings".
  await expect(breakdown.locator('.model-id', { hasText: 'claude-opus-4-8' })).toBeVisible()
  await expect(breakdown.getByText(/2 surfaced findings/i)).toBeVisible()

  // Verifier row: 1 confirm + 1 refute, neither decisive (one dissent can't bury
  // a finding) → rubber-stamped tally. The impact readout leads with that.
  await expect(breakdown.locator('.model-id', { hasText: 'claude-haiku-4-5' })).toBeVisible()
  await expect(breakdown.getByText(/1c\/1r/i)).toBeVisible()

  // showTokenCost is on → a per-row cost shows. Expanding a row reveals its
  // per-task drilldown (which task spent what).
  const genRow = breakdown.locator('.model-row-toggle', { hasText: 'claude-opus-4-8' })
  await expect(genRow).toHaveAttribute('aria-expanded', 'false')
  await genRow.click()
  await expect(genRow).toHaveAttribute('aria-expanded', 'true')
  await expect(breakdown.locator('.task-name', { hasText: 'Verdict' })).toBeVisible()
})
