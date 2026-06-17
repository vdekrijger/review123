/**
 * e2e/unified-ai-progress.spec.ts — the converged AI progress treatment.
 *
 * Two assertions, across two different surfaces:
 *   1. A PENDING AI section (the panels) shows the unified status line + a
 *      content-shaped skeleton — NEVER a bare spinner. The DeepSeek route is
 *      held open briefly so the pending window is observable.
 *   2. A DEEP skill-reviewer run shows the same unified treatment: the honest
 *      "Running {name}…" status line + the activity log ("Reading …") streamed
 *      from the agentic tool loop — consistent with the panels.
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

const SKILL_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    { path: 'src/feature.ts', line: 2, severity: 'high', body: 'Potential XSS vulnerability: user input is not sanitized' },
  ],
}

const VERDICT_RESULT = { level: 'minor-changes', evidence: ['src/feature.ts modified'], notAnalyzed: [] }

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

const SUMMARY_TEXT = 'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

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

  // DeepSeek — deep skill-review loop (tools) is the 2-round agentic conversation;
  // non-tool JSON tasks are delayed so the pending status line + skeleton are
  // observable; the summary stream is delayed too.
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; tools?: unknown[]; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }

    if (body?.stream === true) {
      await sleep(1500)
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeDeepSeekStreamResponse(SUMMARY_TEXT) })
    }

    const system = (body?.messages ?? []).find((m) => m.role === 'system')?.content?.toLowerCase() ?? ''
    const isSkill = system.includes('reviewer persona') || system.includes('security reviewer')

    if (Array.isArray(body?.tools) && body.tools.length > 0) {
      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool')
      if (!hasToolResult) {
        // Round 1: the reviewer asks to read the file (activity-log line).
        await sleep(1500)
        return route.fulfill({
          status: 200,
          json: {
            id: 'chatcmpl-tools-1', object: 'chat.completion',
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/feature.ts' }) } }] } }],
            usage: { prompt_tokens: 200, completion_tokens: 15, total_tokens: 215 },
          },
        })
      }
      // Round 2: hold the final answer so the activity log (set after round 1's
      // tool event) stays on screen long enough to assert the unified treatment.
      await sleep(2000)
      return route.fulfill({ status: 200, json: jsonChatCompletion(isSkill ? JSON.stringify(SKILL_REVIEW_RESULT) : JSON.stringify(VERDICT_RESULT)) })
    }

    // Non-tool JSON tasks (attention/diagrams/tests/alternatives/story/verdict
    // single-pass) — delayed so the unified pending treatment is observable.
    await sleep(1500)
    return route.fulfill({ status: 200, json: jsonChatCompletion(JSON.stringify(VERDICT_RESULT)) })
  })
}

test('unified AI progress: pending panels show status line + skeleton (no bare spinner), deep skill reviewer shows the activity log', async ({ page }) => {
  await setupRoutes(page)

  await page.addInitScript(() => {
    // autoRunReviewers off so this test drives the reviewer via the MANUAL "Run
    // my reviewers" button (it observes the running/activity state on demand);
    // the default early auto-start would otherwise consume the run before step 2.
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test-deepseek-key', aiDeepReview: true, diffMode: 'unified', autoRunReviewers: false }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })
  await page.addInitScript(seedSkillScript())

  await page.goto(APP_REVIEW_PATH)

  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })

  // --- Surface 1: a PENDING panel shows the unified status line + skeleton ---
  // The summary stream is held 1.5s, so the always-visible at-a-glance TL;DR row
  // shows the honest summary status line during the pending window.
  const tldrRow = page.locator('.glance-row-tldr')
  await expect(tldrRow).toContainText('Summarizing the change…', { timeout: 5_000 })
  // Unified content-shaped skeletons are rendered by the pending panels (the
  // detail panels are collapsed by default, so assert presence, not visibility).
  expect(await page.locator('.ai-panel-loading .skeleton-block, .ai-panel-loading .skeleton-rect, .ai-panel-loading .skeleton-card').count()).toBeGreaterThan(0)
  // …and the divergent panel spinner rings are gone entirely — NEVER a bare spinner.
  await expect(page.locator('.ai-panel-loading .spinner')).toHaveCount(0)
  // The unified status line is what pending panels show (one per pending panel).
  expect(await page.locator('.ai-panel-loading .ai-status-line').count()).toBeGreaterThan(0)

  // --- Surface 2: deep skill reviewer shows the COMPACT bounded run layout ---
  // The many-concurrent case is organized as a single global "Running… (N)"
  // indicator + one compact row per reviewer (spinner + name + ONLY the latest
  // activity line, truncated) — NOT N stacked full activity logs.
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers \(1\)/i }).click()

  // Single global "Running… (1)" indicator heads the running region.
  const runningRegion = page.getByLabel('Reviewers running')
  await expect(runningRegion).toContainText(/Running…\s*\(1\)/, { timeout: 5_000 })
  // The compact row shows the reviewer NAME…
  await expect(runningRegion.locator('.skill-running-name')).toContainText('Security Reviewer')
  // …and ONLY its latest activity line (the single truncated row, not a full log).
  await expect(runningRegion.locator('.skill-running-activity')).toContainText('Reading src/feature.ts', { timeout: 10_000 })
  // The old per-reviewer full AiProgress treatment is gone — no stacked status line.
  await expect(page.getByText('Running Security Reviewer…')).toHaveCount(0)

  // Eventually the reviewer completes and the finding renders.
  await expect(page.getByText(/Potential XSS vulnerability/i)).toBeVisible({ timeout: 20_000 })
})
