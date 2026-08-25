/**
 * e2e/prepare-ahead.spec.ts — Prepare-ahead from the landing queue.
 *
 * The whole point of Prepare is warm caches: clicking "Prepare" on a queue row
 * runs the full auto AI pipeline headlessly; opening the PR afterwards must
 * render every panel FROM CACHE without a single new LLM call. The DeepSeek
 * stub counts its calls to prove exactly that.
 *
 * Flow under test:
 *   1. Landing queue row shows the idle "Prepare" control.
 *   2. Click → status reaches "Ready ✓" (the pipeline ran: llmCalls > 0).
 *   3. Open the PR → summary/verdict panels render, and the LLM call count is
 *      UNCHANGED (pure cache hits).
 *   4. Back on the landing page, the Ready ✓ persists (localStorage record).
 *
 * All GitHub + DeepSeek traffic is intercepted (review-flow idiom); PostHog is
 * blocked. Skills are absent (fresh storage) so the reviewer phase is a no-op;
 * the auto tasks (summary, hotspots, diagrams, tests, alternatives, verdict,
 * intent, story, risk judge) are the pipeline being proven warm.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'preporg'
const REPO = 'preprepo'
const PR_NUMBER = 77
const HEAD_SHA = 'prephead1234567'
const BASE_SHA = 'prepbase7654321'
const UPDATED_AT = '2026-08-19T12:00:00Z'

const PATCH = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

function makePrMeta() {
  return {
    title: 'Prepare-ahead test PR',
    state: 'open',
    merged: false,
    body: 'This PR adds a new feature for testing.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 2,
    additions: 3,
    deletions: 1,
  }
}

function makePrFiles() {
  return [
    { filename: 'src/feature.ts', status: 'modified', patch: PATCH, additions: 2, deletions: 1 },
    { filename: 'src/old-utils.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n export {}\n+export const x = 1', additions: 1, deletions: 0 },
  ]
}

function makeFileContent(text: string) {
  const b64 = Buffer.from(text).toString('base64')
  return { content: b64 + '\n', encoding: 'base64' }
}

// ---- AI fixtures (per-task JSON, dispatched by system-prompt phrases) ------

const SUMMARY_TEXT =
  'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\nsrc/old-utils.ts\n===END==='

const ATTENTION_RESULT = {
  readingOrder: ['src/feature.ts', 'src/old-utils.ts'],
  hotspots: [{ path: 'src/feature.ts', reason: 'Critical logic change', level: 'high' }],
  testFlags: [],
}

const GRAPH_RESULT = {
  kind: 'flow',
  before: { nodes: [], edges: [] },
  after: { nodes: [], edges: [] },
  impact: {
    changed: [{ symbol: 'handleFeature', file: 'src/feature.ts', kind: 'changed' }],
    callers: [],
    callees: [],
  },
}

const VERDICT_RESULT = {
  level: 'minor-changes',
  evidence: ['src/feature.ts modified with 2 additions'],
  notAnalyzed: [],
}

const RISK_JUDGE_RESULT = { score: 1, rationale: 'Localized change.', snippets: [] }

const TEST_INSIGHT_RESULT = {
  covered: [{ behavior: 'feature adds lines', test: 'adds lines', file: 'src/feature.test.ts' }],
  gaps: ['no test covers the removal'],
}

const ALTERNATIVES_RESULT = {
  problem: 'The PR introduces a global cache.',
  alternatives: [
    {
      approach: 'Scope the cache per request.',
      tradeoffs: 'More plumbing.',
      assessment: 'comparable',
      rationale: 'Both work here.',
    },
  ],
}

const INTENT_RESULT = {
  intents: [{ id: 'i1', text: 'Add a new feature' }],
  matched: [
    { intentId: 'i1', evidence: [{ path: 'src/feature.ts', line: 2 }], note: 'Feature lands in src/feature.ts.' },
  ],
  unrequested: [],
  unfulfilled: [],
}

const STORY_RESULT = {
  steps: [
    { index: 0, files: ['src/feature.ts'], caption: 'The feature gains new lines.', layer: 'logic', relatedTests: [] },
    { index: 1, files: ['src/old-utils.ts'], caption: 'Utils export a helper.', layer: 'foundational', relatedTests: [] },
  ],
}

function sse(text: string): string {
  const lines = text.split(' ').map((word) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-prep',
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: word + ' ' }, index: 0, finish_reason: null }],
    })}`,
  )
  lines.push('data: [DONE]')
  return lines.join('\n') + '\n'
}

function jsonCompletion(result: unknown) {
  return {
    id: 'chatcmpl-prep',
    object: 'chat.completion',
    choices: [
      { message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop', index: 0 },
    ],
  }
}

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

async function setupRoutes(page: import('@playwright/test').Page): Promise<{ llmCalls: () => number }> {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  // ---- GitHub API ----------------------------------------------------------
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const q = url.searchParams.get('q') ?? ''

    // Queue search: one PR awaiting review; none authored.
    if (path === '/search/issues') {
      const isAuthor = q.includes('author:')
      const item = {
        number: PR_NUMBER,
        title: 'Prepare-ahead test PR',
        updated_at: UPDATED_AT,
        repository_url: `https://api.github.com/repos/${OWNER}/${REPO}`,
      }
      return route.fulfill({ json: { total_count: isAuthor ? 0 : 1, items: isAuthor ? [] : [item] } })
    }

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({ json: makePrMeta() })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: makePrFiles() })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      return route.fulfill({
        json: makeFileContent('unchanged line\nadded line\nanother added line\ntrailing context'),
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) {
      return route.fulfill({ json: [] })
    }
    if (path === '/graphql') {
      return route.fulfill({
        json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
      })
    }
    return route.fulfill({ json: {} })
  })

  // ---- DeepSeek API — counted, dispatched by system-prompt phrase ----------
  let calls = 0
  await page.route('**/api.deepseek.com/**', async (route) => {
    calls++
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body — fall through to JSON dispatch below
    }

    if (body?.stream === true) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: sse(SUMMARY_TEXT),
      })
    }

    const system = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    let result: unknown
    if (system.includes('checking the implementation against the stated intent')) {
      result = INTENT_RESULT
    } else if (/guided narrative walkthrough/.test(system)) {
      result = STORY_RESULT
    } else if (system.includes('hotspot') || system.includes('readingorder')) {
      result = ATTENTION_RESULT
    } else if (system.includes('execution path') || system.includes('mermaid')) {
      result = GRAPH_RESULT
    } else if (system.includes('covered') || system.includes('gaps')) {
      result = TEST_INSIGHT_RESULT
    } else if (system.includes('alternative-is-better') || (system.includes('alternatives') && system.includes('approaches'))) {
      result = ALTERNATIVES_RESULT
    } else if (system.includes('change-risk assessor')) {
      result = RISK_JUDGE_RESULT
    } else {
      result = VERDICT_RESULT
    }
    return route.fulfill({ status: 200, json: jsonCompletion(result) })
  })

  return { llmCalls: () => calls }
}

function seedSettings() {
  return {
    githubAuth: { token: 'ghp_test_prepare', method: 'pat', scopes: [] },
    deepseekKey: 'sk-test-prepare-key',
    // Classic Files flow at step 2 keeps assertions independent of the
    // story slideshow; the story TASK still runs (and must cache).
    storyMode: false,
  }
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

test('prepare on a queue row → Ready → opening the PR renders from cache with NO new LLM calls', async ({ page }) => {
  const counters = await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())

  await page.goto('/')

  // Queue row appears with the idle Prepare control.
  const queueRow = page.getByRole('button', { name: new RegExp(`${OWNER}/${REPO}#${PR_NUMBER}`, 'i') })
  await expect(queueRow).toBeVisible({ timeout: 10_000 })
  const prepareBtn = page.getByTestId('prepare-btn')
  await expect(prepareBtn).toBeVisible()
  await expect(prepareBtn).toBeEnabled()

  // Click Prepare → the pipeline runs headlessly → Ready ✓.
  await prepareBtn.click()
  await expect(page.getByTestId('prepare-status')).toContainText('Ready ✓', { timeout: 30_000 })

  const callsAfterPrepare = counters.llmCalls()
  // The full auto pipeline ran: summary (stream) + 8 JSON tasks.
  expect(callsAfterPrepare).toBeGreaterThanOrEqual(9)

  // Open the PR — panels must render from the caches the prepare populated.
  await queueRow.click()
  await expect(page).toHaveURL(new RegExp(`/review/github/${OWNER}/${REPO}/${PR_NUMBER}`), { timeout: 10_000 })

  const understand = page.locator('.understand-step')
  await expect(understand).toContainText('This PR adds a new feature', { timeout: 15_000 })
  await expect(understand.locator('.verdict-level')).toBeVisible({ timeout: 15_000 })
  await expect(understand).toContainText('Critical logic change', { timeout: 15_000 })

  // Give any stray task a moment to fire, then prove the warm-cache promise:
  // the review page made ZERO additional LLM calls.
  await page.waitForTimeout(1_500)
  expect(counters.llmCalls()).toBe(callsAfterPrepare)

  // Back on the landing page the Ready ✓ persists (localStorage record keyed
  // by PR identity + the queue row's unchanged updatedAt). Scope to the queue
  // container — the opened PR now ALSO appears under "Recent reviews".
  await page.goto('/')
  const queueRows = page.getByTestId('queue-rows')
  await expect(
    queueRows.getByRole('button', { name: new RegExp(`${OWNER}/${REPO}#${PR_NUMBER}`, 'i') }),
  ).toBeVisible({ timeout: 10_000 })
  await expect(queueRows.getByTestId('prepare-status')).toContainText('Ready ✓')
  expect(counters.llmCalls()).toBe(callsAfterPrepare)
})

test('keyless: the Prepare control is disabled with the add-a-key hint', async ({ page }) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { githubAuth: { token: 'ghp_test_prepare', method: 'pat', scopes: [] } })

  await page.goto('/')
  const prepareBtn = page.getByTestId('prepare-btn')
  await expect(prepareBtn).toBeVisible({ timeout: 10_000 })
  await expect(prepareBtn).toBeDisabled()
  await expect(prepareBtn).toHaveAttribute('title', /No API key configured/)
})
