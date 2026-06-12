/**
 * e2e/skill-reviewers.spec.ts — End-to-end test for the "Run my reviewers" feature
 *
 * Fixture skill seeded via localStorage init script.
 * DeepSeek route recognises skill-marker prompts and returns SkillReviewResult.
 * Flow: run reviewers → suggestion appears → Add as draft → sticky bar count increments.
 */

import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Constants — shared with review-flow.spec.ts
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

// The SkillReviewResult our mock DeepSeek returns when it detects a skill persona prompt.
// Two findings exercise both placements:
//  - line 2 IS in the patch hunks → renders INLINE at the line (extend row)
//  - line 999 is NOT in the diff → falls back to the per-file block
const SKILL_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/feature.ts',
      line: 2,
      severity: 'high',
      body: 'Potential XSS vulnerability: user input is not sanitized',
    },
    {
      path: 'src/feature.ts',
      line: 999,
      severity: 'medium',
      body: 'Hardcoded credential found outside the visible diff',
    },
  ],
}

// DeepSeek SSE response for streaming summary
function makeDeepSeekStreamResponse(text: string): string {
  const words = text.split(' ')
  const lines: string[] = []
  for (const word of words) {
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedSettings() {
  return {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
  }
}

/**
 * Seed a reviewer skill into localStorage before page load.
 * Uses the same key as the skills store: 'review123:reviewer-skills'.
 */
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

  // DeepSeek API — detect skill persona prompts by checking for the skill persona marker
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

    // JSON mode — detect skill persona prompt by its system content
    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()

    // Skill review prompt contains "reviewer persona" and the persona name
    if (systemContent.includes('reviewer persona') || systemContent.includes('security reviewer')) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{
            message: { role: 'assistant', content: JSON.stringify(SKILL_REVIEW_RESULT) },
            finish_reason: 'stop',
            index: 0,
          }],
        },
      })
    }

    // Default: return verdict result for other tasks
    return route.fulfill({
      status: 200,
      json: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              level: 'minor-changes',
              evidence: ['src/feature.ts modified'],
              notAnalyzed: [],
            }),
          },
          finish_reason: 'stop',
          index: 0,
        }],
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Test: run reviewers → anchored finding renders INLINE at its line, unanchored
//       finding falls back to the per-file block, never both → Add as draft
//       from the inline card increments the sticky bar count
// ---------------------------------------------------------------------------

test('skill-reviewers: anchored finding inline at line, unanchored in per-file block, Add as draft increments count', async ({
  page,
}) => {
  await setupRoutes(page)

  // Seed settings + skill before page load
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())
  await page.addInitScript(seedSkillScript())

  // Also set consent so no dialog appears (public repo, consent already given)
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect) where the skill review button lives
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // The "Run my reviewers (1)" button should be visible
  const runBtn = page.getByRole('button', { name: /run my reviewers \(1\)/i })
  await expect(runBtn).toBeVisible({ timeout: 5_000 })

  // Click to run skill reviews
  await runBtn.click()

  // Both finding bodies should appear
  await expect(
    page.getByText(/Potential XSS vulnerability/i),
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText(/Hardcoded credential found outside the visible diff/i),
  ).toBeVisible({ timeout: 5_000 })

  // The persona summary line should appear: "Security Reviewer: 2 suggestions"
  await expect(
    page.getByText(/Security Reviewer.*2 suggestions/i),
  ).toBeVisible({ timeout: 5_000 })

  // --- Placement contract ---
  // Anchored finding (line 2 IS in the diff) renders INLINE in an extend row
  // inside the diff table, at its line.
  const inlineCard = page.locator('.diff-line-extend .line-findings .skill-finding')
  await expect(inlineCard).toBeVisible()
  await expect(inlineCard).toContainText('Potential XSS vulnerability')
  await expect(page.locator('[data-line-findings="2"]')).toBeVisible()

  // Unanchored finding (line 999 NOT in the diff) renders in the per-file
  // fallback block, with a labeled line note.
  const blockCard = page.locator('.skill-findings-annotations .skill-finding')
  await expect(blockCard).toBeVisible()
  await expect(blockCard).toContainText('Hardcoded credential')
  await expect(blockCard).toContainText('line 999 — not in this diff')

  // Never both: each finding body appears in exactly ONE card
  await expect(page.locator('.skill-finding', { hasText: 'Potential XSS vulnerability' })).toHaveCount(1)
  await expect(page.locator('.skill-finding', { hasText: 'Hardcoded credential' })).toHaveCount(1)

  // --- Severity visual system ---
  // high chip on the inline card, medium chip on the block card
  await expect(inlineCard.locator('.severity-chip-high')).toBeVisible()
  await expect(blockCard.locator('.severity-chip-medium')).toBeVisible()
  // Card severity classes match the chips (border/badge consistency)
  await expect(inlineCard).toHaveClass(/severity-high/)
  await expect(blockCard).toHaveClass(/severity-medium/)

  // Initial draft count from sticky bar (filter to the draft-count status element)
  const draftStatus = page.locator('.draft-status')
  await expect(draftStatus).toContainText('0 comments', { timeout: 3_000 })

  // Click "Add as draft" on the INLINE card
  const addDraftBtn = inlineCard.getByRole('button', { name: /add as draft/i })
  await expect(addDraftBtn).toBeVisible()
  await addDraftBtn.click()

  // Draft count should increment to 1
  await expect(draftStatus).toContainText('1 comment', { timeout: 5_000 })

  // The card shows the labeled "added as draft" state chip (the ONE state treatment)
  await expect(inlineCard.locator('.skill-state-chip')).toContainText('added as draft')

  // The finding card should still be visible (not dismissed)
  await expect(inlineCard.locator('.skill-finding-body')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Test: dismiss hides each finding from its placement
// ---------------------------------------------------------------------------

test('skill-reviewers: dismiss hides inline and block findings without affecting draft count', async ({
  page,
}) => {
  await setupRoutes(page)

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())
  await page.addInitScript(seedSkillScript())
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)

  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Run skill reviews
  await page.getByRole('button', { name: /run my reviewers/i }).click()

  // Wait for the inline (anchored) finding to appear
  const inlineCard = page.locator('.diff-line-extend .line-findings .skill-finding')
  await expect(inlineCard).toBeVisible({ timeout: 15_000 })

  // Dismiss the inline finding
  await inlineCard.getByRole('button', { name: /dismiss/i }).click()
  await expect(
    page.getByText(/Potential XSS vulnerability/i),
  ).not.toBeVisible({ timeout: 3_000 })

  // Dismiss the fallback-block finding too
  const blockCard = page.locator('.skill-findings-annotations .skill-finding')
  await expect(blockCard).toBeVisible()
  await blockCard.getByRole('button', { name: /dismiss/i }).click()
  await expect(
    page.getByText(/Hardcoded credential/i),
  ).not.toBeVisible({ timeout: 3_000 })

  // Draft count stays at 0 (use class selector to avoid ambiguity with skill-run-status-bar)
  await expect(page.locator('.draft-status')).toContainText('0 comments')
})
