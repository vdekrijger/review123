/**
 * e2e/deep-review.spec.ts — fixture-backed agentic deep-review flow (Plan G part 2)
 *
 * Seeds aiDeepReview=true + a DeepSeek key, then intercepts a 2-round tool
 * conversation on the DeepSeek route:
 *   round 1 (body has `tools`, no role:'tool' message yet)
 *           → assistant tool_calls: read_file src/feature.ts
 *   loop    → app fetches the file via the GitHub contents fixture (head ref)
 *   round 2 (messages now include role:'tool')
 *           → final VerdictResult JSON
 * Asserts the verdict renders WITH the deep-review tool-activity footer
 * ("Deep review: verified with 1 tool call").
 */

import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Constants — shared shape with review-flow.spec.ts / skill-reviewers.spec.ts
// ---------------------------------------------------------------------------

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

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
  return [
    {
      filename: 'src/feature.ts',
      status: 'modified',
      patch: PATCH_WITH_LINES,
      additions: 2,
      deletions: 1,
    },
  ]
}

function makeFileContent(text: string) {
  const b64 = Buffer.from(text).toString('base64')
  return { content: b64 + '\n', encoding: 'base64' }
}

const VERDICT_RESULT = {
  level: 'minor-changes',
  evidence: ['src/feature.ts — verified the new lines only extend the existing flow'],
  notAnalyzed: [],
}

const TESTS_RESULT = {
  covered: [
    { behavior: 'extends the existing flow', test: 'feature flow', file: 'src/feature.ts' },
  ],
  gaps: [],
}

const ALTERNATIVES_RESULT = {
  problem: 'add a feature to the existing flow',
  alternatives: [],
}

// Deep-diagram changeMap with a de-emphasized one-hop "context" neighbor
// (deep-diagrams-context, v12). The changed file is the focus; app.ts is the
// surrounding architecture pulled in via the verification tools.
const DIAGRAM_RESULT = {
  kind: 'flow',
  before: { nodes: [{ id: 'feature', label: 'feature.ts' }], edges: [] },
  after: { nodes: [{ id: 'feature', label: 'feature.ts' }], edges: [] },
  changeMap: {
    nodes: [
      { id: 'feature', label: 'feature.ts', status: 'changed' },
      { id: 'caller', label: 'AppRouter', status: 'context' },
    ],
    edges: [{ from: 'caller', to: 'feature', label: 'calls', status: 'context' }],
  },
}

// A verified hotspot the deep attention task reports after reading the file +
// its callers (deep-attention, v13). The single-pass path produces hotspots
// too, but only the deep path renders the "verified with N tool calls" footer.
const ATTENTION_RESULT = {
  readingOrder: ['src/feature.ts'],
  hotspots: [
    { path: 'src/feature.ts', reason: 'verified the new lines extend a load-bearing flow', level: 'high' },
  ],
  testFlags: [],
}

// Pick the deep-task result shape from the system prompt the loop carries.
function deepResultForSystem(system: string): string {
  if (/changed test files/i.test(system)) return JSON.stringify(TESTS_RESULT)
  if (/genuinely different approach/i.test(system)) return JSON.stringify(ALTERNATIVES_RESULT)
  if (/NO Mermaid syntax/i.test(system)) return JSON.stringify(DIAGRAM_RESULT)
  if (/testFlags/i.test(system)) return JSON.stringify(ATTENTION_RESULT)
  return JSON.stringify(VERDICT_RESULT)
}

// DeepSeek SSE response for the streaming summary task
function makeDeepSeekStreamResponse(text: string): string {
  const lines: string[] = []
  for (const word of text.split(' ')) {
    const chunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: word + ' ' }, index: 0, finish_reason: null }],
    }
    lines.push(`data: ${JSON.stringify(chunk)}`)
  }
  lines.push('data: [DONE]')
  return lines.join('\n') + '\n'
}

const SUMMARY_TEXT = 'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

function jsonChatCompletion(content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }
}

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

async function setupRoutes(page: import('@playwright/test').Page) {
  // Block PostHog analytics
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  // GitHub API
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

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
      const ref = url.searchParams.get('ref') ?? ''
      const filePath = decodeURIComponent(path.replace(`/repos/${OWNER}/${REPO}/contents/`, ''))
      if (filePath === 'src/feature.ts' && ref === BASE_SHA) {
        return route.fulfill({ json: makeFileContent('const old = 1\nremoved line\ntrailing context') })
      }
      if (filePath === 'src/feature.ts' && ref === HEAD_SHA) {
        return route.fulfill({
          json: makeFileContent('const old = 1\nunchanged line\nadded line\nanother added line\ntrailing context'),
        })
      }
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
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
    return route.fulfill({ json: {} })
  })

  // DeepSeek API — the deep-review (tool-loop) conversation is the ONLY one
  // that carries a `tools` array; route it through the 2-round script.
  const toolRounds: { round1: number; round2: number } = { round1: 0, round2: 0 }
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: {
      stream?: boolean
      tools?: unknown[]
      messages?: Array<{ role: string; content: string | null }>
    } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body
    }

    // Streaming summary task
    if (body?.stream === true) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: makeDeepSeekStreamResponse(SUMMARY_TEXT),
      })
    }

    // Deep-review tool conversation (verdict + tests + alternatives + diagrams,
    // tools enabled — diagrams now run deep too, see deepResultForSystem)
    if (Array.isArray(body?.tools) && body.tools.length > 0) {
      const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool')
      if (!hasToolResult) {
        // Round 1: the model asks to verify the file before judging
        toolRounds.round1++
        return route.fulfill({
          status: 200,
          json: {
            id: 'chatcmpl-tools-1',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/feature.ts' }) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 200, completion_tokens: 15, total_tokens: 215 },
          },
        })
      }
      // Round 2: tool result is in the conversation → final verified answer,
      // shaped per the task's system prompt (verdict / tests / alternatives).
      toolRounds.round2++
      return route.fulfill({ status: 200, json: jsonChatCompletion(deepResultForSystem(system)) })
    }

    // Fallback single-pass JSON tasks (summary reading-order is streamed above;
    // every JSON review task now carries tools in deep mode). Never reached in
    // the happy path, but kept honest.
    return route.fulfill({ status: 200, json: jsonChatCompletion(JSON.stringify(VERDICT_RESULT)) })
  })
  return toolRounds
}

// ---------------------------------------------------------------------------
// Test: deep review verdict — 2-round tool conversation → verdict rendered
//       with the tool-activity footer
// ---------------------------------------------------------------------------

test('deep review: 2-round tool conversation renders verdict with the tool-call footer', async ({ page }) => {
  const toolRounds = await setupRoutes(page)

  // Seed settings: DeepSeek key + deep review ON (the agentic toggle)
  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ deepseekKey: 'sk-test-deepseek-key', aiDeepReview: true, diffMode: 'unified' }),
    )
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)

  // Verdict pill appears once the deep verdict task completes
  await expect(page.locator('.understand-step .verdict-level')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.understand-step .verdict-level')).toHaveText(/minor-changes/i)

  // The deep conversation really took 2 rounds through the tool loop
  expect(toolRounds.round1).toBeGreaterThanOrEqual(1)
  expect(toolRounds.round2).toBeGreaterThanOrEqual(1)

  // Open the verdict evidence panel (details may be collapsed by default)
  const verdictDetails = page.locator('details.verdict-panel')
  await expect(verdictDetails).toBeVisible()
  if ((await verdictDetails.getAttribute('open')) === null) {
    await verdictDetails.locator('summary').click()
  }

  // Verified evidence rendered + the deep-review footer counts the tool call
  await expect(verdictDetails).toContainText('verified the new lines')
  await expect(verdictDetails.locator('.ai-deep-footer')).toHaveText(/Deep review: verified with 1 tool call/)

  // Test-insight task ALSO ran through the deep harness (same toggle) — its
  // panel renders the verified covered behavior + the same tool-call footer.
  const testsPanel = page.locator('details.tests-panel')
  await expect(testsPanel).toBeVisible({ timeout: 20_000 })
  await testsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })
  await expect(testsPanel).toContainText('extends the existing flow')
  await expect(testsPanel.locator('.ai-deep-footer')).toHaveText(/Deep review: verified with 1 tool call/)

  // Diagram task ALSO ran through the deep harness (same toggle): its change-map
  // renders the de-emphasized one-hop "context" neighbor (AppRouter) alongside
  // the changed file, plus the same tool-call footer.
  const diagramsPanel = page.locator('details.diagrams-panel')
  await expect(diagramsPanel).toBeVisible({ timeout: 20_000 })
  await diagramsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })
  // The change-map SVG renders with the de-emphasized one-hop neighbor.
  const changeMapSvg = diagramsPanel.locator('.changemap-section svg')
  await expect(changeMapSvg).toBeVisible({ timeout: 20_000 })
  // Mermaid emits the `context` classDef styling ONLY when a node/edge carries
  // status:'context'. Its presence in the rendered change-map SVG proves the deep
  // diagram added the de-emphasized one-hop neighbor and that the new status
  // round-trips through the serializer end-to-end (the diff-scoped single-pass
  // path never produces context nodes).
  await expect(changeMapSvg.locator('style')).toContainText('.context', { timeout: 20_000 })
  await expect(diagramsPanel.locator('.ai-deep-footer')).toHaveText(/Deep review: verified with 1 tool call/)

  // Attention/hotspots task ALSO ran through the deep harness (same toggle): the
  // rail Hotspots section renders the verified hotspot AND the same tool-call
  // footer the other deep panels use (run.attention.toolCallsUsed channel).
  const hotspotBtn = page.locator('.hotspot-btn').first()
  await expect(hotspotBtn).toBeAttached({ timeout: 20_000 })
  // ALL rail sections start collapsed — expand Hotspots to reveal its body.
  const hotspotsSection = page
    .locator('aside.context-rail details.rail-section-details')
    .filter({ has: page.locator('summary', { hasText: 'Hotspots' }) })
  if ((await hotspotsSection.getAttribute('open')) === null) {
    await hotspotsSection.locator('summary').click()
  }
  await expect(hotspotBtn).toBeVisible()
  // The verified hotspot the deep attention loop reported is shown…
  await expect(hotspotBtn).toContainText('src/feature.ts')
  // …with the deep-review footer counting the tool call.
  await expect(hotspotsSection.locator('.ai-deep-footer')).toHaveText(/Deep review: verified with 1 tool call/)
})
