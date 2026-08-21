/**
 * e2e/finding-reanchor.spec.ts — drag a mis-anchored AI finding to the correct
 * diff line (and the keyboard "Move to line…" fallback).
 *
 * Fixture: one skill reviewer returning two findings on src/feature.ts —
 *   - line 2 ("wrong line"): anchored, but the reviewer meant line 3
 *   - line 999: not in the diff at all → per-file fallback block
 *
 * Covered flows:
 *   1. DRAG the inline card's handle onto the line-3 row → card re-anchors
 *      (moved chip) → "Add as draft" appends the draft at the CORRECTED line.
 *   2. RESCUE the off-diff (999) finding via the keyboard path onto a real
 *      diff line → it leaves the fallback block and renders inline.
 *   3. UNDO (✕ on the moved chip) restores the original anchor.
 *
 * Scaffolding mirrors skill-reviewers.spec.ts (helpers duplicated by design —
 * specs own their fixtures; that spec is owned by other work).
 */

import { test, expect, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Constants + fixtures
// ---------------------------------------------------------------------------

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

// New-file lines: 1 "unchanged line" (ctx), 2 "added line" (+),
// 3 "another added line" (+), 4 "trailing context" (ctx)
const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

function makePrFiles() {
  return [
    { filename: 'src/feature.ts', status: 'modified', patch: PATCH_WITH_LINES, additions: 2, deletions: 1 },
  ]
}

function makeFileContent(text: string) {
  const b64 = Buffer.from(text).toString('base64')
  return { content: b64 + '\n', encoding: 'base64' }
}

// Finding 1 anchors at line 2 but DESCRIBES line 3 (the classic off-by-a-line
// LLM anchor). Finding 2's line isn't in the diff → fallback block.
const SKILL_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    { path: 'src/feature.ts', line: 2, severity: 'high', body: 'Unvalidated input on the second added line' },
    { path: 'src/feature.ts', line: 999, severity: 'medium', body: 'Hardcoded credential outside the visible diff' },
  ],
}

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

function seedSettings() {
  return {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
    // Manual "Run my reviewers" keeps the flow deterministic (no auto-start).
    autoRunReviewers: false,
  }
}

function seedSkillScript() {
  return `
    (() => {
      const skill = {
        id: 'skill-e2e-reanchor',
        name: 'Security Reviewer',
        content: '## Security\\nCheck for XSS and injection vulnerabilities.',
        enabled: true,
        addedAt: 1700000000000,
      };
      localStorage.setItem('review123:reviewer-skills', JSON.stringify([skill]));
    })();
  `
}

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

async function setupRoutes(page: Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

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
        // One line beyond the hunks so context expansion is possible — the
        // Expand affordance doubles as the "contents finished loading" signal.
        return route.fulfill({ json: makeFileContent('const old = 1\nunchanged line\nadded line\nanother added line\ntrailing context') })
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

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body
    }

    if (body?.stream === true) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: makeDeepSeekStreamResponse(SUMMARY_TEXT),
      })
    }

    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()

    // Convergence pass (dispatch BEFORE the persona branch): empty cluster set.
    if (systemContent.includes('consolidating overlapping code-review findings')) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ clusters: [] }) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }

    // Simplify pass: valid empty rewrite set → original bodies (re-anchor
    // identity hashes are computed over the ORIGINAL body, so keep it shown).
    if (systemContent.includes('rewriting code-review findings into plain')) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ rewrites: [] }) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }

    if (systemContent.includes('reviewer persona') || systemContent.includes('security reviewer')) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(SKILL_REVIEW_RESULT) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }

    return route.fulfill({
      status: 200,
      json: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({ level: 'minor-changes', evidence: ['src/feature.ts modified'], notAnalyzed: [] }),
          },
          finish_reason: 'stop',
          index: 0,
        }],
      },
    })
  })
}

/** Load the PR, go to Inspect, run the reviewers, and wait for both cards. */
async function openInspectWithFindings(page: Page) {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())
  await page.addInitScript(seedSkillScript())
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for file contents to finish loading (expand affordances appear) —
  // the diff rebuilds when contents arrive, remounting inline annotations;
  // interacting before that races the remount (guard borrowed from the
  // sibling specs).
  await expect(
    page.locator('button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]').first(),
  ).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: /run my reviewers \(1\)/i }).click()
  await expect(page.getByText(/Unvalidated input on the second added line/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Hardcoded credential outside the visible diff/i)).toBeVisible({ timeout: 5_000 })
}

// ---------------------------------------------------------------------------
// Test 1: DRAG the wrong-line inline card onto the correct row → moved chip →
//         "Add as draft" lands the draft at the corrected line (append path).
// ---------------------------------------------------------------------------

test('finding-reanchor: drag the card to the correct line; Add as draft uses the corrected anchor', async ({ page }) => {
  await openInspectWithFindings(page)

  // The wrong-line finding renders INLINE at line 2.
  await expect(page.locator('[data-line-findings="2"]')).toBeVisible()
  const inlineCard = page.locator('.line-findings .skill-finding', { hasText: 'Unvalidated input' })
  await expect(inlineCard).toBeVisible()

  // Drag its handle onto the row for NEW line 3 ("another added line").
  const handle = inlineCard.getByTestId('finding-drag-handle')
  await expect(handle).toBeVisible()
  const targetRow = page.locator('tr:has([data-line-new-num="3"])').first()
  await expect(targetRow).toBeVisible()
  await handle.dragTo(targetRow)

  // The card re-anchors: renders at line 3, gone from line 2, with the chip.
  await expect(page.locator('[data-line-findings="3"]')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('[data-line-findings="2"]')).toHaveCount(0)
  const movedChip = page.getByTestId('finding-moved-chip')
  await expect(movedChip).toContainText('moved from line 2')

  // "Add as draft" → the draft APPENDS at the CORRECTED line 3.
  const draftStatus = page.locator('.draft-status')
  await expect(draftStatus).toContainText('0 comments', { timeout: 3_000 })
  const movedCard = page.locator('[data-line-findings="3"] .skill-finding', { hasText: 'Unvalidated input' })
  await movedCard.getByRole('button', { name: /add as draft/i }).click()
  await expect(draftStatus).toContainText('1 comment', { timeout: 5_000 })
  const line3Annotations = page.locator('[data-testid="inline-annotations"][data-line="3"]')
  await expect(line3Annotations).toBeVisible({ timeout: 5_000 })
  await expect(line3Annotations).toContainText('Unvalidated input on the second added line')
  // Nothing landed at the ORIGINAL (wrong) line.
  await expect(page.locator('[data-testid="inline-annotations"][data-line="2"]')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Test 2: RESCUE the off-diff (999) fallback finding via the keyboard path —
//         it anchors onto a real diff line and leaves the fallback block, and
//         Add as draft then works at the rescued line (off-diff comments
//         can't post to GitHub; rescued ones can).
// ---------------------------------------------------------------------------

test('finding-reanchor: keyboard path rescues an off-diff finding onto a real diff line', async ({ page }) => {
  await openInspectWithFindings(page)

  // The 999 finding sits in the per-file fallback block with the line note.
  const blockCard = page.locator('.skill-findings-annotations .skill-finding')
  await expect(blockCard).toBeVisible()
  await expect(blockCard).toContainText('line 999 — not in this diff')

  // Keyboard path: "Move to line…" → 1 (a real context line) → Move.
  await blockCard.getByRole('button', { name: /move this finding to another diff line/i }).click()
  const lineInput = blockCard.getByRole('spinbutton', { name: /target line number/i })
  await lineInput.fill('1')
  await blockCard.getByTestId('finding-move-form').getByRole('button', { name: 'Move' }).click()

  // The finding leaves the fallback block and renders INLINE at line 1.
  await expect(page.locator('.skill-findings-annotations')).toHaveCount(0, { timeout: 5_000 })
  const rescued = page.locator('[data-line-findings="1"] .skill-finding', { hasText: 'Hardcoded credential' })
  await expect(rescued).toBeVisible()
  await expect(rescued.getByTestId('finding-moved-chip')).toContainText('moved from line 999')

  // Add as draft at the rescued anchor.
  const draftStatus = page.locator('.draft-status')
  await rescued.getByRole('button', { name: /add as draft/i }).click()
  await expect(draftStatus).toContainText('1 comment', { timeout: 5_000 })
  const line1Annotations = page.locator('[data-testid="inline-annotations"][data-line="1"]')
  await expect(line1Annotations).toContainText('Hardcoded credential outside the visible diff')
})

// ---------------------------------------------------------------------------
// Test 3: UNDO — the ✕ on the moved chip restores the original anchor. Also
//         guards the invalid-line error on the keyboard path.
// ---------------------------------------------------------------------------

test('finding-reanchor: undo restores the original line; invalid target shows an inline error', async ({ page }) => {
  await openInspectWithFindings(page)

  const inlineCard = page.locator('.line-findings .skill-finding', { hasText: 'Unvalidated input' })

  // An invalid line (not in the diff) errors inline and moves nothing.
  await inlineCard.getByRole('button', { name: /move this finding to another diff line/i }).click()
  await inlineCard.getByRole('spinbutton', { name: /target line number/i }).fill('777')
  await inlineCard.getByTestId('finding-move-form').getByRole('button', { name: 'Move' }).click()
  await expect(inlineCard.getByRole('alert')).toContainText("line 777 isn't in this diff")
  await expect(page.locator('[data-line-findings="2"]')).toBeVisible()

  // A valid line moves it…
  await inlineCard.getByRole('spinbutton', { name: /target line number/i }).fill('3')
  await inlineCard.getByTestId('finding-move-form').getByRole('button', { name: 'Move' }).click()
  await expect(page.locator('[data-line-findings="3"]')).toBeVisible({ timeout: 5_000 })

  // …and undo (✕ on the chip) brings it back to line 2.
  const movedCard = page.locator('[data-line-findings="3"] .skill-finding', { hasText: 'Unvalidated input' })
  await movedCard.getByRole('button', { name: /undo move — restore line 2/i }).click()
  await expect(page.locator('[data-line-findings="2"]')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('[data-line-findings="3"]')).toHaveCount(0)
  await expect(page.getByTestId('finding-moved-chip')).toHaveCount(0)
})
