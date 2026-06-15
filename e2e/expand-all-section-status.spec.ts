/**
 * e2e/expand-all-section-status.spec.ts — Understand-step bulk expand +
 * per-section header run-state indicator.
 *
 * Asserts, on the Understand step (step 1):
 *   1. Clicking "Expand all" opens every collapsible section.
 *   2. While the AI summary task is still pending, that section's HEADER shows a
 *      spinner (visible even though the section starts collapsed) — the same
 *      run-state that drives AiProgress.
 *   3. Once the task resolves, the header spinner is replaced by the quiet ready
 *      cue (no spinner).
 *
 * The DeepSeek routes are held open briefly so the pending window is observable,
 * mirroring unified-ai-progress.spec.ts.
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
  const b64 = Buffer.from(text).toString('base64')
  return { content: b64 + '\n', encoding: 'base64' }
}

const VERDICT_RESULT = { level: 'minor-changes', evidence: ['src/feature.ts modified'], notAnalyzed: [] }
const SUMMARY_TEXT = 'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

function jsonChatCompletion(content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }
}

function makeDeepSeekStreamResponse(text: string): string {
  const lines: string[] = []
  for (const word of text.split(' ')) {
    lines.push(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ delta: { content: word + ' ' }, index: 0, finish_reason: null }] })}`)
  }
  lines.push('data: [DONE]')
  return lines.join('\n') + '\n'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function setupRoutes(page: import('@playwright/test').Page) {
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
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) return route.fulfill({ json: [] })
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) return route.fulfill({ json: [] })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })

  // DeepSeek — stream (summary) and JSON (other tasks) both delayed so the
  // pending header spinner is observable before the task resolves.
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }

    if (body?.stream === true) {
      await sleep(1500)
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeDeepSeekStreamResponse(SUMMARY_TEXT) })
    }
    await sleep(1500)
    return route.fulfill({ status: 200, json: jsonChatCompletion(JSON.stringify(VERDICT_RESULT)) })
  })
}

test('Understand step: Expand all opens every section; a pending AI section shows the header spinner, then a ready cue', async ({ page }) => {
  await setupRoutes(page)

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test-deepseek-key', diffMode: 'unified' }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })

  // --- Pending: the Full summary section header shows a spinner while the
  // summary stream is held open, even though the section is collapsed. ---
  const summaryPanel = page.locator('.detail-panel.summary-panel')
  await expect(summaryPanel.locator('.detail-summary .ui-spinner')).toBeVisible({ timeout: 5_000 })

  // --- Expand all opens every collapsible page section. ---
  await page.getByRole('button', { name: /expand all sections/i }).click()
  const panels = page.locator('.detail-panel')
  const count = await panels.count()
  expect(count).toBeGreaterThan(0)
  for (let i = 0; i < count; i++) {
    await expect(panels.nth(i)).toHaveAttribute('open', '')
  }
  // Button label flips to Collapse all.
  await expect(page.getByRole('button', { name: /collapse all sections/i })).toBeVisible()

  // --- Resolved: once the summary task finishes, the header spinner is gone
  // and the quiet ready cue is present. ---
  await expect(summaryPanel.locator('.detail-summary .ui-spinner')).toHaveCount(0, { timeout: 20_000 })
  await expect(summaryPanel.locator('.detail-summary .section-status-ready')).toBeVisible()
})
