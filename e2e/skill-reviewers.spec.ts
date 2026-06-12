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

const APP_REVIEW_PATH = `/review/${OWNER}/${REPO}/${PR_NUMBER}`

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

// The SkillReviewResult our mock DeepSeek returns when it detects a skill persona prompt
const SKILL_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/feature.ts',
      line: 2,
      severity: 'high',
      body: 'Potential XSS vulnerability: user input is not sanitized',
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
// Test: run reviewers → suggestion appears → Add as draft → sticky bar increments
// ---------------------------------------------------------------------------

test('skill-reviewers: run my reviewers → suggestion appears → Add as draft → sticky bar count increments', async ({
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

  // The skill suggestion should appear (finding body text)
  await expect(
    page.getByText(/Potential XSS vulnerability/i),
  ).toBeVisible({ timeout: 15_000 })

  // The persona summary line should appear: "Security Reviewer: 1 suggestion"
  await expect(
    page.getByText(/Security Reviewer.*1 suggestion/i),
  ).toBeVisible({ timeout: 5_000 })

  // The severity chip should show "high"
  await expect(
    page.locator('.severity-chip-high'),
  ).toBeVisible()

  // Initial draft count from sticky bar
  const draftStatus = page.getByRole('status')
  await expect(draftStatus).toContainText('0 comments', { timeout: 3_000 })

  // Click "Add as draft" button
  const addDraftBtn = page.getByRole('button', { name: /add as draft/i })
  await expect(addDraftBtn).toBeVisible()
  await addDraftBtn.click()

  // Draft count should increment to 1
  await expect(draftStatus).toContainText('1 comment', { timeout: 5_000 })

  // The finding card should still be visible (not dismissed) — use first() to avoid
  // strict-mode violation since the text also appears in the draft thread after add-as-draft
  await expect(page.locator('.skill-finding-body').first()).toBeVisible()
})

// ---------------------------------------------------------------------------
// Test: dismiss hides the finding
// ---------------------------------------------------------------------------

test('skill-reviewers: dismiss hides the finding without affecting draft count', async ({
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

  // Wait for finding to appear
  await expect(
    page.getByText(/Potential XSS vulnerability/i),
  ).toBeVisible({ timeout: 15_000 })

  // Click Dismiss
  await page.getByRole('button', { name: /dismiss/i }).click()

  // Finding should be gone
  await expect(
    page.getByText(/Potential XSS vulnerability/i),
  ).not.toBeVisible({ timeout: 3_000 })

  // Draft count stays at 0
  await expect(page.getByRole('status')).toContainText('0 comments')
})
