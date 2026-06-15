/**
 * e2e/per-task-modes.spec.ts — Plan J: per-task AI mode controls
 *
 * Two flows, fixture-backed (shared shape with deep-review.spec.ts):
 *  1. diagrams set OFF in settings → the Diagrams section renders the compact
 *     "Disabled — enable in AI settings" state (NOT a skeleton), and NO diagram
 *     LLM request ever fires. Other tasks (verdict) still run.
 *  2. verdict set DEEP → it runs the agentic tool loop (round1 + round2) and the
 *     verdict renders with the "verified with N tool calls" footer.
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

const VERDICT_RESULT = {
  level: 'minor-changes',
  evidence: ['src/feature.ts — verified the new lines only extend the existing flow'],
  notAnalyzed: [],
}
const TESTS_RESULT = { covered: [], gaps: [] }
const ALTERNATIVES_RESULT = { problem: 'add a feature', alternatives: [] }
const ATTENTION_RESULT = { readingOrder: ['src/feature.ts'], hotspots: [], testFlags: [] }
const DIAGRAM_RESULT = {
  kind: 'flow',
  before: { nodes: [{ id: 'feature', label: 'feature.ts' }], edges: [] },
  after: { nodes: [{ id: 'feature', label: 'feature.ts' }], edges: [] },
}

function singlePassResultForSystem(system: string): string {
  if (/changed test files/i.test(system)) return JSON.stringify(TESTS_RESULT)
  if (/genuinely different approach/i.test(system)) return JSON.stringify(ALTERNATIVES_RESULT)
  if (/NO Mermaid syntax/i.test(system)) return JSON.stringify(DIAGRAM_RESULT)
  if (/testFlags/i.test(system)) return JSON.stringify(ATTENTION_RESULT)
  return JSON.stringify(VERDICT_RESULT)
}

function makeStream(text: string): string {
  const lines = text.split(' ').map((word) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ delta: { content: word + ' ' }, index: 0, finish_reason: null }] })}`,
  )
  lines.push('data: [DONE]')
  return lines.join('\n') + '\n'
}

const SUMMARY_TEXT = 'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

function jsonChatCompletion(content: string) {
  return {
    id: 'c', object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }
}

interface Tracking {
  /** system prompts seen on every non-stream DeepSeek JSON request */
  systems: string[]
  toolRounds: { round1: number; round2: number }
}

async function setupRoutes(page: import('@playwright/test').Page): Promise<Tracking> {
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

  const tracking: Tracking = { systems: [], toolRounds: { round1: 0, round2: 0 } }
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; tools?: unknown[]; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }

    if (body?.stream === true) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: makeStream(SUMMARY_TEXT),
      })
    }

    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    tracking.systems.push(system)

    if (Array.isArray(body?.tools) && body.tools.length > 0) {
      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool')
      if (!hasToolResult) {
        tracking.toolRounds.round1++
        return route.fulfill({
          status: 200,
          json: {
            id: 'c', object: 'chat.completion',
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/feature.ts' }) } }] } }],
            usage: { prompt_tokens: 200, completion_tokens: 15, total_tokens: 215 },
          },
        })
      }
      tracking.toolRounds.round2++
      return route.fulfill({ status: 200, json: jsonChatCompletion(singlePassResultForSystem(system)) })
    }

    return route.fulfill({ status: 200, json: jsonChatCompletion(singlePassResultForSystem(system)) })
  })

  return tracking
}

test('diagrams Off → section shows disabled (no skeleton), no diagram LLM call fires', async ({ page }) => {
  const tracking = await setupRoutes(page)

  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ deepseekKey: 'sk-test', diffMode: 'unified', aiTaskModes: { diagrams: 'off' } }),
    )
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)

  // Verdict still runs (proves the run started normally).
  await expect(page.locator('.understand-step .verdict-level')).toBeVisible({ timeout: 20_000 })

  // The Diagrams section renders the disabled state, NOT a skeleton/spinner.
  const diagramsPanel = page.locator('details.diagrams-panel')
  await expect(diagramsPanel).toBeVisible()
  await diagramsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })
  await expect(diagramsPanel.locator('.ai-panel-disabled')).toContainText(/disabled/i)
  await expect(diagramsPanel.locator('.ai-panel-loading')).toHaveCount(0)
  await expect(diagramsPanel.locator('.skeleton')).toHaveCount(0)

  // No diagram LLM request ever fired (the diagrams system prompt is unique).
  expect(tracking.systems.some((s) => /NO Mermaid syntax/i.test(s))).toBe(false)
})

test('verdict Deep → runs the tool loop and shows the verified-with-tool-calls footer', async ({ page }) => {
  const tracking = await setupRoutes(page)

  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({
        deepseekKey: 'sk-test', aiProvider: 'deepseek', aiModel: 'deepseek-v4-flash',
        diffMode: 'unified', aiTaskModes: { verdict: 'deep' },
      }),
    )
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)

  await expect(page.locator('.understand-step .verdict-level')).toBeVisible({ timeout: 20_000 })
  expect(tracking.toolRounds.round1).toBeGreaterThanOrEqual(1)
  expect(tracking.toolRounds.round2).toBeGreaterThanOrEqual(1)

  const verdictDetails = page.locator('details.verdict-panel')
  await expect(verdictDetails).toBeVisible()
  if ((await verdictDetails.getAttribute('open')) === null) {
    await verdictDetails.locator('summary').click()
  }
  await expect(verdictDetails.locator('.ai-deep-footer')).toHaveText(/Deep review: verified with 1 tool call/)
})
