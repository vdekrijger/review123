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

// Deep change-impact result: the deep diagram task finds the REAL callers with
// the tools and emits a blast-radius view whose changed symbols carry change
// kinds (a changed + an added symbol → both classDefs round-trip).
const DIAGRAM_RESULT = {
  kind: 'flow',
  before: { nodes: [], edges: [] },
  after: { nodes: [], edges: [] },
  impact: {
    changed: [
      { symbol: 'handleFeature', file: 'src/feature.ts', kind: 'changed' },
      { symbol: 'persistFeature', file: 'src/feature.ts', kind: 'added' },
    ],
    callers: [{ symbol: 'route', file: 'src/router.ts' }],
    callees: [{ symbol: 'db', file: 'src/db.ts' }],
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

  // Diagram task ALSO ran through the deep harness (same toggle): its change-impact
  // view renders with the changed symbols' status classes (added + changed), plus
  // the same tool-call footer.
  const diagramsPanel = page.locator('details.diagrams-panel')
  await expect(diagramsPanel).toBeVisible({ timeout: 20_000 })
  await diagramsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })
  // The impact SVG renders; mermaid injects a <style> block with the status
  // classDefs (added/changed), proving the impact round-trips through the
  // deterministic serializer end-to-end.
  const flowSvg = diagramsPanel.locator('.diagram-container--full svg').first()
  await expect(flowSvg).toBeVisible({ timeout: 20_000 })
  await expect(flowSvg.locator('style')).toContainText('.changed', { timeout: 20_000 })
  await expect(flowSvg.locator('style')).toContainText('.added')
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

// ---------------------------------------------------------------------------
// fix/context-abort-errors — a tool-loop round whose RESPONSE BODY READ is torn
// down must render the calm cancelled state, never the engine's own text.
//
// This is the shape #233 missed. Its spec rejected the fetch PROMISE, which the
// adapter's try/catch already covered. Here the fetch RESOLVES — headers and
// all — and the failure happens while the body is being read, which is what
// really happens when a per-request window expires mid-response. That read used
// to sit OUTSIDE the mapped try/catch in llmToolLoop.postJson, so Blink's
// "The user aborted a request." DOMException reached the reviewer chip's hover
// under the unclassified "An unexpected error occurred. Please retry." lead.
//
// Playwright's route API cannot express "headers fine, body read rejects", and
// neither can a synthetic Response built from an errored ReadableStream —
// Blink normalises those to `TypeError: Failed to fetch`, losing the reason. So
// the patch reproduces the mechanism itself: let the real fetch resolve, then
// abort its signal before the app reads the body. Verified in Chromium, that
// yields `DOMException{ name: 'AbortError', message: 'The user aborted a
// request.' }` — the reported string, verbatim — and it does so even when the
// aborting signal is an AbortSignal.timeout, which is exactly why the mapping
// has to consult OUR window rather than the exception's name.
// ---------------------------------------------------------------------------

test('a body read aborted mid-response renders the calm cancelled state — never the engine text', async ({ page }) => {
  await setupRoutes(page)

  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('api.deepseek.com')) {
        const ctrl = new AbortController()
        const res = await realFetch(input as RequestInfo, { ...init, signal: ctrl.signal })
        // Headers have arrived; tear the body down before the app reads it.
        ctrl.abort()
        return res
      }
      return realFetch(input as RequestInfo, init)
    }) as typeof window.fetch
  })

  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ deepseekKey: 'sk-test-deepseek-key', aiDeepReview: true, diffMode: 'unified' }),
    )
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })

  // The panels settle into the calm cancelled state.
  await expect(page.locator('.ai-panel-cancelled').first()).toBeAttached({ timeout: 20_000 })

  // NOTHING on the page carries the engine's own words, or the unclassified
  // lead that proved the error had never been classified at all.
  await expect(page.getByText(/user aborted/i)).toHaveCount(0)
  await expect(page.getByText(/aborted a request/i)).toHaveCount(0)
  await expect(page.getByText(/unexpected error occurred/i)).toHaveCount(0)
  // Not the network story either — the connection was never the problem.
  await expect(page.getByText(/check your connection/i)).toHaveCount(0)

  // The same guarantee for every hover string, which is where the reported text
  // actually lived (title / aria-label, not visible text).
  const hoverText = await page.evaluate(() => {
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll('[title], [aria-label]'))) {
      const t = el.getAttribute('title')
      const a = el.getAttribute('aria-label')
      if (t) out.push(t)
      if (a) out.push(a)
    }
    return out.join(' | ')
  })
  expect(hoverText).not.toMatch(/user aborted/i)
  expect(hoverText).not.toMatch(/unexpected error occurred/i)

  // No error panel anywhere — a cancellation is not a failure.
  await expect(page.locator('.ai-panel-error')).toHaveCount(0)
})
