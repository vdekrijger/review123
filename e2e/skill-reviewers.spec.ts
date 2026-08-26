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
// The line-2 finding carries a suggestedFix (solutions-required) → its card
// renders the Fix block; the line-999 finding has NONE → no Fix block
// (absence-graceful, the old-cache shape).
const SKILL_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/feature.ts',
      line: 2,
      severity: 'high',
      body: 'Potential XSS vulnerability: user input is not sanitized',
      suggestedFix: 'Escape it with `sanitizeHtml(input)` before rendering.',
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
    // These tests exercise the MANUAL "Run my reviewers" button + retry flow, so
    // opt out of the early auto-start (default ON) to keep them deterministic.
    // The dedicated auto-start tests below re-enable it explicitly.
    autoRunReviewers: false,
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

    // Convergence pass (must dispatch BEFORE the persona branch — its system
    // prompt mentions "reviewer personas"): valid empty cluster set → unmerged.
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

    // Simplify pass (runs after convergence): a valid EMPTY rewrite set →
    // every card keeps its original body, so the placement/severity tests
    // stay byte-identical. The dedicated simplify test overrides this branch.
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

  // --- Fix block (solutions required) ---
  // The finding WITH a suggestedFix renders the labeled Fix block, with the
  // backticked call rendered as <code> (code-capable markdown).
  const fixBlock = inlineCard.getByTestId('finding-fix')
  await expect(fixBlock).toBeVisible()
  await expect(fixBlock).toContainText('Escape it with')
  await expect(fixBlock.locator('code')).toHaveText('sanitizeHtml(input)')
  // The finding WITHOUT one renders no Fix block (absence-graceful).
  await expect(blockCard.getByTestId('finding-fix')).toHaveCount(0)

  // Initial draft count from sticky bar (filter to the draft-count status element)
  const draftStatus = page.locator('.draft-status')
  await expect(draftStatus).toContainText('0 comments', { timeout: 3_000 })

  // Click "Add as draft" on the INLINE card
  const addDraftBtn = inlineCard.getByRole('button', { name: /add as draft/i })
  await expect(addDraftBtn).toBeVisible()
  await addDraftBtn.click()

  // Draft count should increment to 1
  await expect(draftStatus).toContainText('1 comment', { timeout: 5_000 })

  // Adding auto-hides the now-redundant finding card (the draft in the diff is
  // the confirmation). This is a visual cleanup — the decision is still recorded
  // as 'accepted', NOT a dismiss.
  await expect(inlineCard).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Test: SIMPLIFY pass — the plain-English rewrite renders on the card by
//       default and "Show original" discloses the raw finding text (per-card
//       toggle, loss-proof: the original is never gone).
// ---------------------------------------------------------------------------

const SIMPLIFIED_XSS = 'User input reaches the DOM unsanitized — escape it before rendering.'

test('skill-reviewers: simplify pass — simplified body renders, "Show original" reveals the raw text', async ({
  page,
}) => {
  await setupRoutes(page)

  // Override ONLY the simplify branch: routes registered later take precedence,
  // and everything that is not the simplify call falls through (route.fallback)
  // to the base handler above. f0 = the FIRST enumerated finding (the anchored
  // XSS one); f1 (the unanchored credential finding) gets NO rewrite, proving
  // per-finding application.
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body
    }
    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    if (body?.stream !== true && systemContent.includes('rewriting code-review findings into plain')) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ rewrites: [{ id: 'f0', simple: SIMPLIFIED_XSS }] }) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }
    return route.fallback()
  })

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

  await page.getByRole('button', { name: /run my reviewers \(1\)/i }).click()

  // The anchored card shows the SIMPLIFIED body, not the raw model text.
  const inlineCard = page.locator('.diff-line-extend .line-findings .skill-finding')
  await expect(inlineCard).toBeVisible({ timeout: 15_000 })
  await expect(inlineCard).toContainText('User input reaches the DOM unsanitized', { timeout: 10_000 })
  await expect(inlineCard).not.toContainText('Potential XSS vulnerability')

  // "Show original" discloses the raw finding text; the label flips.
  const toggle = inlineCard.getByTestId('finding-simple-toggle')
  await expect(toggle).toHaveText('Show original')
  await toggle.click()
  await expect(inlineCard).toContainText('Potential XSS vulnerability: user input is not sanitized')
  await expect(toggle).toHaveText('Show simplified')

  // …and back to the simplified text.
  await toggle.click()
  await expect(inlineCard).toContainText('User input reaches the DOM unsanitized')

  // The finding WITHOUT a rewrite (f1) keeps its original body and has no toggle.
  const blockCard = page.locator('.skill-findings-annotations .skill-finding')
  await expect(blockCard).toContainText('Hardcoded credential found outside the visible diff')
  await expect(blockCard.getByTestId('finding-simple-toggle')).toHaveCount(0)

  // Add as draft uses the DISPLAYED (simplified) text: the created inline draft
  // carries the simplified body, not the raw model text.
  await inlineCard.getByRole('button', { name: /add as draft/i }).click()
  const line2Annotations = page.locator('[data-testid="inline-annotations"][data-line="2"]')
  await expect(line2Annotations).toBeVisible({ timeout: 5_000 })
  await expect(line2Annotations).toContainText('User input reaches the DOM unsanitized')
  await expect(line2Annotations).not.toContainText('Potential XSS vulnerability')
})

// ---------------------------------------------------------------------------
// Test: MULTI-DRAFTS PER LINE — a manual draft and an added finding COEXIST on
//       the same line (adding never clobbers); "Add another comment" appends a
//       third; removing one leaves the others intact.
// ---------------------------------------------------------------------------

/** Seed one manual draft at line 2 (the SAME line the anchored finding targets). */
function seedLine2DraftScript() {
  // The store binds to the PR IDENTITY prKey (provider:owner/repo#number, no sha).
  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}`
  return `
    (() => {
      const request = indexedDB.open('review123-drafts', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put({
          prKey: ${JSON.stringify(prKey)},
          path: 'src/feature.ts',
          line: 2,
          side: 'RIGHT',
          body: 'Seeded manual comment at line 2',
          n: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }, ${JSON.stringify(prKey)} + '|src/feature.ts|2|RIGHT|0');
      };
    })();
  `
}

test('skill-reviewers: two comments coexist on one line — manual draft + added finding; add-another appends; removing one keeps the rest', async ({
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
  await page.addInitScript(seedLine2DraftScript())

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for file contents to finish loading (expand affordances appear) —
  // the diff rebuilds when contents arrive, remounting inline annotations;
  // interacting before that races the remount (same guard as review-flow's
  // inline-ask-ai test).
  await expect(
    page.locator('button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]').first(),
  ).toBeVisible({ timeout: 10_000 })

  // The seeded manual draft is counted and rendered inline at line 2
  const draftStatus = page.locator('.draft-status')
  await expect(draftStatus).toContainText('1 comment', { timeout: 5_000 })
  const line2Annotations = page.locator('[data-testid="inline-annotations"][data-line="2"]')
  await expect(line2Annotations).toBeVisible({ timeout: 5_000 })
  await expect(line2Annotations).toContainText('Seeded manual comment at line 2')

  // Run reviewers → the anchored finding targets the SAME line 2
  await page.getByRole('button', { name: /run my reviewers \(1\)/i }).click()
  const inlineCard = page.locator('.diff-line-extend .line-findings .skill-finding')
  await expect(inlineCard).toBeVisible({ timeout: 15_000 })

  // "Add as draft" on the line-2 finding — must APPEND, never clobber the
  // manual draft (the reported bug: the first comment vanished here).
  const addDraftBtn = inlineCard.getByRole('button', { name: /add as draft/i })
  await addDraftBtn.click()
  await expect(draftStatus).toContainText('2 comments', { timeout: 5_000 })

  // BOTH comments are visible stacked at line 2
  await expect(line2Annotations).toContainText('Seeded manual comment at line 2')
  await expect(line2Annotations).toContainText('Potential XSS vulnerability')
  await expect(line2Annotations.locator('[data-testid="draft-thread"]')).toHaveCount(2)

  // "Add another comment" below the stack appends a THIRD comment via the UI
  const addAnother = line2Annotations.getByTestId('add-another-comment')
  await expect(addAnother).toBeVisible()
  await addAnother.evaluate((el: HTMLButtonElement) => el.click())
  const textarea = line2Annotations.getByRole('textbox', { name: /comment body/i })
  await expect(textarea).toBeVisible({ timeout: 5_000 })
  await textarea.evaluate((el: HTMLTextAreaElement, v) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, 'Third comment on the same line')
  const leaveBtn = line2Annotations.getByRole('button', { name: /^leave comment$/i })
  await leaveBtn.evaluate((el: HTMLButtonElement) => el.click())
  await expect(draftStatus).toContainText('3 comments', { timeout: 5_000 })
  await expect(line2Annotations.locator('[data-testid="draft-thread"]')).toHaveCount(3)

  // Remove ONE (the seeded manual comment) — the other two must survive
  const manualThread = line2Annotations.locator('[data-testid="draft-thread"]', {
    hasText: 'Seeded manual comment at line 2',
  })
  await manualThread.getByRole('button', { name: /delete/i }).evaluate((el: HTMLButtonElement) => el.click())
  await expect(draftStatus).toContainText('2 comments', { timeout: 5_000 })
  await expect(line2Annotations).not.toContainText('Seeded manual comment at line 2')
  await expect(line2Annotations).toContainText('Potential XSS vulnerability')
  await expect(line2Annotations).toContainText('Third comment on the same line')
})

// ---------------------------------------------------------------------------
// Test: clicking a reviewer's result chip (2 findings) opens a popover listing
//       both findings; clicking an entry scrolls to + flashes that finding.
// ---------------------------------------------------------------------------

test('skill-reviewers: result chip opens finding list → clicking an entry jumps to + flashes the finding', async ({
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
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers/i }).click()

  // The done result chip becomes a button: "Show 2 findings from Security Reviewer"
  const chip = page.getByRole('button', { name: /Show 2 findings from Security Reviewer/i })
  await expect(chip).toBeVisible({ timeout: 15_000 })

  // No popover until clicked
  await expect(page.locator('.findings-popover')).toHaveCount(0)
  await chip.click()

  // Popover lists BOTH findings (anchored line 2 + unanchored line 999)
  const menu = page.locator('.findings-popover[role="menu"]')
  await expect(menu).toBeVisible()
  const items = menu.locator('[role="menuitem"]')
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText('src/feature.ts:2')
  await expect(items.nth(1)).toContainText('src/feature.ts:999')

  // Click the SECOND entry (the unanchored finding in the per-file fallback block)
  await items.nth(1).click()

  // Popover closes; the target finding card gets the transient flash class.
  await expect(page.locator('.findings-popover')).toHaveCount(0)
  const target = page.locator('.skill-findings-annotations .skill-finding', { hasText: 'Hardcoded credential' })
  await expect(target).toBeVisible()
  // It's scrolled into the viewport (jumped to, not a dead link).
  await expect(target).toBeInViewport()
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

// ---------------------------------------------------------------------------
// Test: a FAILED reviewer's "↻ error" chip is a Retry button — clicking it
//       re-runs JUST that reviewer (errors are never cached → re-hits the LLM),
//       and the chip updates to a findings result.
// ---------------------------------------------------------------------------

test('skill-reviewers: errored reviewer chip retries and resolves to findings', async ({
  page,
}) => {
  // Block analytics
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  // GitHub API — same fixtures as setupRoutes
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

  // DeepSeek — fail the FIRST skill-review request (server error), succeed after.
  let skillCalls = 0
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }

    if (body?.stream === true) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: makeDeepSeekStreamResponse(SUMMARY_TEXT),
      })
    }

    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
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
    // Simplify pass: valid empty rewrite set → original bodies render.
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
      skillCalls += 1
      if (skillCalls === 1) {
        // First run fails → the reviewer enters the error state. Uses a
        // NON-transient status (400): transient 429/5xx are now auto-retried by
        // the transport (src/lib/llm/transientRetry.ts) and would self-heal
        // before the error chip — this test is about the MANUAL retry UI.
        return route.fulfill({ status: 400, json: { error: { message: 'server error' } } })
      }
      // Retry succeeds.
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
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ level: 'minor-changes', evidence: ['x'], notAnalyzed: [] }) }, finish_reason: 'stop', index: 0 }],
      },
    })
  })

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

  // Run reviewers — first attempt fails.
  await page.getByRole('button', { name: /run my reviewers/i }).click()

  // The errored reviewer's chip is a Retry button that surfaces the failure
  // reason on hover (title) and includes it in the accessible name.
  const retryBtn = page.getByRole('button', { name: /security reviewer failed:.*click to retry/i })
  await expect(retryBtn).toBeVisible({ timeout: 15_000 })
  await expect(retryBtn).toHaveAttribute('title', /click to retry$/i)

  // Click retry → the reviewer re-runs and resolves to findings.
  await retryBtn.click()

  // FIX 2: the retried reviewer's anchored finding (line 2) renders INLINE in the
  // diff (the regression: restarted-reviewer findings never appeared inline).
  const inlineCard = page.locator('.diff-line-extend .line-findings .skill-finding', {
    hasText: 'Potential XSS vulnerability',
  })
  await expect(inlineCard).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: /security reviewer failed:.*click to retry/i })).toHaveCount(0)
  // It re-hit the LLM (cache never served the error): two skill-review calls.
  expect(skillCalls).toBeGreaterThanOrEqual(2)
})

// ---------------------------------------------------------------------------
// Test: with >2 reviewers enabled, the queue caps in-flight reviewers at 2 —
//       the rest sit visibly in the "Waiting" region (queued), and never more
//       than 2 are "Running" at once.
// ---------------------------------------------------------------------------

test('skill-reviewers: queue caps running reviewers at 4, rest show in Waiting region', async ({
  page,
}) => {
  // Block analytics
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  // GitHub API — same fixtures as setupRoutes.
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

  // DeepSeek — hold each skill-review call open for a beat so several reviewers
  // are genuinely in flight at once. The cap must keep that at ≤2 while the
  // rest queue. The delay is generous enough that the waiting state is stable.
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }

    if (body?.stream === true) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: makeDeepSeekStreamResponse(SUMMARY_TEXT),
      })
    }

    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    if (systemContent.includes('consolidating overlapping code-review findings')) {
      // Six identical reviewers overlap → after the batch the convergence pass
      // fires; answer instantly with a valid empty cluster set (no merges).
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ clusters: [] }) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }
    // Simplify pass (must dispatch BEFORE the loose 'reviewer' matcher below —
    // the simplify prompt mentions code-review findings): valid empty set.
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
    if (systemContent.includes('reviewer persona') || systemContent.includes('reviewer')) {
      // Hold the response so concurrency is observable in the UI.
      await new Promise((r) => setTimeout(r, 900))
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
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ level: 'minor-changes', evidence: ['x'], notAnalyzed: [] }) }, finish_reason: 'stop', index: 0 }],
      },
    })
  })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())
  // Seed SIX enabled reviewers — more than the concurrency cap of 4.
  await page.addInitScript(() => {
    const skills = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `skill-e2e-${n}`,
      name: `Reviewer ${n}`,
      content: `## Reviewer ${n}\nCheck the diff.`,
      enabled: true,
      addedAt: 1700000000000 + n,
    }))
    localStorage.setItem('review123:reviewer-skills', JSON.stringify(skills))
  })
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Run all six reviewers.
  await page.getByRole('button', { name: /run my reviewers \(6\)/i }).click()

  // While the run is in flight: the Waiting region appears (queued reviewers),
  // and the global "Running… (N)" count never exceeds the cap of 4.
  const waiting = page.getByLabel('Reviewers waiting')
  await expect(waiting).toBeVisible({ timeout: 10_000 })
  // The running header shows at most 4 in flight.
  await expect(page.getByText(/Running…\s*\([1-4]\)/)).toBeVisible()
  await expect(page.getByText(/Running…\s*\([5-9]\)/)).toHaveCount(0)
  // At least one reviewer is queued in the waiting region.
  await expect(waiting.getByText('queued').first()).toBeVisible()

  // Eventually all six settle (the queue drains) and no waiting region remains.
  await expect(page.getByLabel('Reviewers waiting')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByLabel('Reviewer run results')).toBeVisible()
})

// ---------------------------------------------------------------------------
// Test: FINDING TRIAGE — a mixed set (high unverified, medium unverified, lone
//       low, and one the convergence pass marks covered-by-draft) renders
//       exactly the strong findings inline; the rest collapse into the per-file
//       "N more findings" group; the review-level line + "Show all" work.
// ---------------------------------------------------------------------------

// TWO reviewers (the convergence pass only runs when ≥2 reviewers produce
// findings). Enumerated in seeding order: Security f0..f2, Duplication f3.
// Lines 2/3 are added lines in the patch; line 4 is trailing context (anchorable).
const TRIAGE_SECURITY_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    { path: 'src/feature.ts', line: 2, severity: 'high', body: 'Definite injection risk on the added line' },
    { path: 'src/feature.ts', line: 3, severity: 'medium', body: 'Unverified medium concern here' },
    { path: 'src/feature.ts', line: 4, severity: 'low', body: 'Minor style nit on trailing context' },
  ],
}
const TRIAGE_DUPLICATION_RESULT = {
  skillName: 'Duplication Reviewer',
  findings: [
    { path: 'src/feature.ts', line: 2, severity: 'medium', body: 'Duplicate of your own line-2 comment' },
  ],
}

test('skill-reviewers: finding triage — strong findings inline, weak + covered collapsed, Show all restores', async ({
  page,
}) => {
  await setupRoutes(page)

  // Override the persona branch (mixed 4-finding set) and the convergence
  // branch (clusters f3 with the user's seeded draft → covered-by-draft).
  // Everything else falls back to the base handler.
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body
    }
    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    if (body?.stream !== true && systemContent.includes('consolidating overlapping code-review findings')) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({ clusters: [{ members: ['f3', 'draft-0'], primary: 'f3', reason: 'same point as the draft' }] }),
            },
            finish_reason: 'stop',
            index: 0,
          }],
        },
      })
    }
    if (body?.stream !== true && systemContent.includes('duplication reviewer')) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(TRIAGE_DUPLICATION_RESULT) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }
    if (body?.stream !== true && (systemContent.includes('reviewer persona') || systemContent.includes('security reviewer'))) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(TRIAGE_SECURITY_RESULT) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }
    return route.fallback()
  })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())
  // Seed TWO reviewers — Security (3 findings) + Duplication (1 finding) — so
  // the convergence pass runs (it needs ≥2 reviewers with findings).
  await page.addInitScript(() => {
    const skills = [
      { id: 'skill-e2e-test', name: 'Security Reviewer', content: '## Security\nCheck for XSS.', enabled: true, addedAt: 1700000000000 },
      { id: 'skill-e2e-dup', name: 'Duplication Reviewer', content: '## Duplication\nFlag repeats.', enabled: true, addedAt: 1700000000001 },
    ]
    localStorage.setItem('review123:reviewer-skills', JSON.stringify(skills))
  })
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })
  // Seed the user's own draft at line 2 — the convergence cluster marks f3 as
  // covered by it (enumerated draft-0).
  await page.addInitScript(seedLine2DraftScript())

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for the seeded draft to load — the convergence pass must see it
  // (enumerated as draft-0) for the covered-by-draft cluster to apply.
  await expect(page.locator('.draft-status')).toContainText('1 comment', { timeout: 5_000 })

  await page.getByRole('button', { name: /run my reviewers \(2\)/i }).click()

  // INLINE: exactly the high and the unverified medium (severity is the signal
  // in a single-model setup) — the lone low and the covered finding do NOT
  // render inline. The screenshot bug — a weak card full-size mid-diff — is
  // impossible by construction.
  const inlineCards = page.locator('.line-findings .skill-finding')
  await expect(inlineCards.filter({ hasText: 'Definite injection risk' })).toHaveCount(1, { timeout: 15_000 })
  await expect(inlineCards.filter({ hasText: 'Unverified medium concern' })).toHaveCount(1)
  await expect(inlineCards).toHaveCount(2)

  // COLLAPSED: one per-file group holding the lone low + the covered finding.
  const group = page.getByTestId('secondary-findings')
  await expect(group).toBeVisible({ timeout: 10_000 })
  await expect(group.locator('summary')).toContainText('2 more findings — low confidence or minor')

  // Review-level line with the escape hatch.
  const triageLine = page.getByTestId('findings-triage-line')
  await expect(triageLine).toContainText('Showing 2 of 4 findings')
  await expect(triageLine).toContainText('2 minor or low-confidence collapsed')

  // Expanding the group discloses full, functional cards — including the
  // covered one in its collapsed "covered by your comment" state (#206).
  await group.locator('summary').click()
  const lowCard = group.locator('.skill-finding', { hasText: 'Minor style nit' })
  await expect(lowCard).toBeVisible()
  await expect(lowCard.getByRole('button', { name: /add as draft/i })).toBeVisible()
  await expect(lowCard.getByRole('button', { name: /dismiss/i })).toBeVisible()
  await expect(group.getByText(/covered by your comment on src\/feature\.ts:2/)).toBeVisible()

  // "Show all" renders every finding inline again; the group disappears.
  await page.getByTestId('findings-show-all').click()
  await expect(page.locator('.line-findings .skill-finding')).toHaveCount(4)
  await expect(page.getByTestId('secondary-findings')).toHaveCount(0)
  await expect(triageLine).toContainText('Showing all 4 findings')
})

// ---------------------------------------------------------------------------
// Test: with autoRunReviewers ON (default), the reviewers auto-start on step 1
//       (Understand) so by the time the user reaches Inspect the findings are
//       already there — NO manual "Run my reviewers" click needed.
// ---------------------------------------------------------------------------

test('skill-reviewers: auto-start on step 1 — findings ready at Inspect without clicking Run', async ({
  page,
}) => {
  await setupRoutes(page)

  // Seed settings with auto-start explicitly ON (the product default).
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify({ ...settings, autoRunReviewers: true }))
  }, seedSettings())
  await page.addInitScript(seedSkillScript())
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)

  // Land on step 1 (Understand) — we never click "Next step" before the reviewers
  // run. The auto-start fires here, while we're still on Understand.
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Now go to Inspect. The findings should already be present (auto-started on
  // step 1) WITHOUT us clicking the "Run my reviewers" button.
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await expect(
    page.getByText(/Potential XSS vulnerability/i),
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText(/Hardcoded credential found outside the visible diff/i),
  ).toBeVisible({ timeout: 5_000 })
})

// ---------------------------------------------------------------------------
// Test: with autoRunReviewers OFF, reviewers do NOT auto-start — the manual
//       "Run my reviewers" button is the only trigger (and still works).
// ---------------------------------------------------------------------------

test('skill-reviewers: opt-out — no auto-start, manual button still works', async ({
  page,
}) => {
  await setupRoutes(page)

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify({ ...settings, autoRunReviewers: false }))
  }, seedSettings())
  await page.addInitScript(seedSkillScript())
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Reviewers did NOT auto-start: the Run button is present and no findings yet.
  const runBtn = page.getByRole('button', { name: /run my reviewers \(1\)/i })
  await expect(runBtn).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText(/Potential XSS vulnerability/i)).toHaveCount(0)

  // The manual button still works.
  await runBtn.click()
  await expect(page.getByText(/Potential XSS vulnerability/i)).toBeVisible({ timeout: 15_000 })
})

// ---------------------------------------------------------------------------
// Test: MOOTNESS GATE — verifiers CONFIRM both findings as real but judge both
//       NOT worth a busy reviewer's time (worth: false ×2 → majority-moot).
//       The real-but-moot MEDIUM lands in the collapsed secondary group (never
//       inline); the majority-verified-real HIGH keeps its inline slot (the one
//       carve-out) and wears the honest "judged minor by verification" chip.
// ---------------------------------------------------------------------------

const MOOT_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/feature.ts',
      line: 2,
      severity: 'high',
      body: 'Real high issue the panel judges moot',
      suggestedFix: 'Guard the call with a null check.',
    },
    {
      path: 'src/feature.ts',
      line: 3,
      severity: 'medium',
      body: 'Real but moot medium point',
      suggestedFix: 'Rename the variable for clarity.',
    },
  ],
}

/** Verdicts for the verify payload: confirm reality, judge NOT worth (moot). */
function mootVerdictsFor(user: string) {
  const ids = [...user.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])
  return ids.map((id) => ({ id, verdict: 'confirm', reason: 'real but minor', worth: false }))
}

// Anthropic verifier: confirms everything as real, worth: false on everything.
async function setupAnthropicMootVerifier(page: import('@playwright/test').Page) {
  await page.route('**/api.anthropic.com/**', async (route) => {
    let body: { system?: string; messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    const user = body?.messages?.find((m) => m.role === 'user')?.content ?? ''
    return route.fulfill({
      status: 200,
      json: {
        content: [{ type: 'text', text: JSON.stringify({ verdicts: mootVerdictsFor(user) }) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
  })
}

// OpenAI verifier (via the serverless proxy): same confirm-but-moot verdicts.
async function setupOpenAiMootVerifier(page: import('@playwright/test').Page) {
  await page.route('**/api/llm/openai/**', async (route) => {
    let body: { messages?: Array<{ role: string; content: string }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    const user = body?.messages?.find((m) => m.role === 'user')?.content ?? ''
    return route.fulfill({
      status: 200,
      json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdicts: mootVerdictsFor(user) }) }, finish_reason: 'stop', index: 0 }] },
    })
  })
}

test('skill-reviewers: mootness gate — real-but-moot medium collapses; verified-real high stays inline with the moot chip', async ({
  page,
}) => {
  await setupRoutes(page)
  await setupAnthropicMootVerifier(page)
  await setupOpenAiMootVerifier(page)

  // Override the persona branch with the two-finding moot fixture; everything
  // else (convergence/simplify/verdict/summary) falls back to the base handler.
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body
    }
    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    if (body?.stream !== true && (systemContent.includes('reviewer persona') || systemContent.includes('security reviewer'))) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(MOOT_REVIEW_RESULT) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }
    return route.fallback()
  })

  // Three keys → DeepSeek generates, Anthropic + OpenAI verify. Both verifiers
  // confirm reality but judge worth=false → worth score 1 (raiser) + 0 + 0 = 1
  // < 1.5 (polled 3 / 2) → both findings are majority-moot.
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { ...seedSettings(), aiProvider: 'deepseek', anthropicKey: 'sk-ant-test-key', openaiKey: 'sk-openai-test-key' })
  await page.addInitScript(seedSkillScript())
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers \(1\)/i }).click()

  // The HIGH is majority-verified-real (3/3 confirms) → the carve-out keeps it
  // INLINE, wearing BOTH the verified chip and the honest moot chip.
  const highCard = page.locator('.line-findings .skill-finding', { hasText: 'Real high issue' })
  await expect(highCard).toBeVisible({ timeout: 15_000 })
  await expect(highCard.locator('.skill-verify-chip')).toHaveText('✓ verified')
  await expect(highCard.getByTestId('finding-moot-chip')).toHaveText('judged minor by verification')
  // Its fix still renders — demotion signals never eat the solution.
  await expect(highCard.getByTestId('finding-fix')).toContainText('Guard the call with a null check.')

  // The real-but-moot MEDIUM never renders inline — it lands in the collapsed
  // secondary group (the mootness gate's whole point).
  await expect(page.locator('.line-findings .skill-finding', { hasText: 'Real but moot medium' })).toHaveCount(0)
  const group = page.getByTestId('secondary-findings')
  await expect(group).toBeVisible({ timeout: 10_000 })
  await expect(group.locator('summary')).toContainText('1 more finding')

  // Expanding discloses the full card, carrying the moot chip as its reason.
  await group.locator('summary').click()
  const mootCard = group.locator('.skill-finding', { hasText: 'Real but moot medium' })
  await expect(mootCard).toBeVisible()
  await expect(mootCard.getByTestId('finding-moot-chip')).toBeVisible()
  await expect(mootCard.getByRole('button', { name: /add as draft/i })).toBeVisible()

  // "Show all" restores it inline (the escape hatch still wins).
  await page.getByTestId('findings-show-all').click()
  await expect(page.locator('.line-findings .skill-finding', { hasText: 'Real but moot medium' })).toHaveCount(1)
  await expect(page.getByTestId('secondary-findings')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Test: GROUNDED VERIFICATION — the Anthropic verifier USES a repo lookup
//       (search_code, answered by the stubbed GitHub /search/code endpoint)
//       before confirming, and reports what it checked in groundedNote. The
//       "✓ verified" chip's hover title carries that note.
// ---------------------------------------------------------------------------

// One finding, anchored in the diff (line 2). Body deliberately avoids the
// absence-claim phrasings so the Part B absence gate stays out of this test.
const GROUNDED_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/feature.ts',
      line: 2,
      severity: 'high',
      body: 'Unsafe HTML built from user input in renderCard',
      suggestedFix: 'Escape with sanitizeHtml() before insertion.',
    },
  ],
}

const GROUNDED_NOTE_E2E = 'searched repo for sanitizeHtml: 2 consumers found'

test('skill-reviewers: grounded verification — verifier searches the repo (stubbed) and the verified chip hover carries the note', async ({
  page,
}) => {
  await setupRoutes(page)

  // Positive /search/code hits (registered AFTER setupRoutes so it wins over
  // the base GitHub catch-all). Counts calls so we can assert the verifier
  // really USED the tool.
  let searchCalls = 0
  await page.route('**/api.github.com/search/code**', async (route) => {
    searchCalls += 1
    return route.fulfill({
      json: {
        total_count: 2,
        items: [
          { path: 'src/render.ts', text_matches: [{ fragment: 'sanitizeHtml(input)' }] },
          { path: 'src/preview.ts', text_matches: [{ fragment: 'sanitizeHtml(body)' }] },
        ],
      },
    })
  })

  // Override the persona branch with the grounded fixture; everything else
  // falls back to the base handler.
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body
    }
    const systemContent = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    if (body?.stream !== true && (systemContent.includes('reviewer persona') || systemContent.includes('security reviewer'))) {
      return route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(GROUNDED_REVIEW_RESULT) }, finish_reason: 'stop', index: 0 }],
        },
      })
    }
    return route.fallback()
  })

  // Anthropic verifier — a real (stubbed) TOOL LOOP: the first round answers
  // with a search_code tool_use; once the transport feeds back a tool_result,
  // the second round returns the grounded verdicts with a groundedNote.
  await page.route('**/api.anthropic.com/**', async (route) => {
    let body: {
      system?: string
      messages?: Array<{ role: string; content: string | Array<{ type?: string }> }>
    } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* non-JSON */ }
    const messages = body?.messages ?? []
    const hasToolResult = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c?.type === 'tool_result'),
    )
    const firstUser = messages.find((m) => m.role === 'user')
    const userText = typeof firstUser?.content === 'string' ? firstUser.content : ''
    const ids = [...userText.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1])

    if (!hasToolResult) {
      // Round 1: the verifier decides it needs to SEE the repo before voting.
      return route.fulfill({
        status: 200,
        json: {
          content: [
            { type: 'text', text: 'Checking whether sanitizeHtml is actually used elsewhere.' },
            { type: 'tool_use', id: 'toolu_e2e_1', name: 'search_code', input: { query: 'sanitizeHtml' } },
          ],
          usage: { input_tokens: 12, output_tokens: 6 },
        },
      })
    }
    // Round 2: grounded confirmation, reporting what was looked up.
    const verdicts = ids.map((id) => ({
      id,
      verdict: 'confirm',
      worth: true,
      reason: 'real: the sink is unescaped',
      groundedNote: GROUNDED_NOTE_E2E,
    }))
    return route.fulfill({
      status: 200,
      json: {
        content: [{ type: 'text', text: JSON.stringify({ verdicts }) }],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    })
  })

  // Two keys → DeepSeek generates, Anthropic verifies (grounded, always on).
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { ...seedSettings(), aiProvider: 'deepseek', anthropicKey: 'sk-ant-test-key' })
  await page.addInitScript(seedSkillScript())
  await page.addInitScript(() => {
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  await page.getByRole('button', { name: /run my reviewers \(1\)/i }).click()

  // The finding surfaces inline, majority-confirmed → the "✓ verified" chip.
  const card = page.locator('.line-findings .skill-finding', { hasText: 'Unsafe HTML built from user input' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  const chip = card.locator('.skill-verify-chip')
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await expect(chip).toHaveText('✓ verified')

  // GROUNDED evidence: the hover title carries WHAT the verifier looked up.
  await expect(chip).toHaveAttribute('title', GROUNDED_NOTE_E2E)

  // And the lookup really happened: the stubbed GitHub code search was hit.
  expect(searchCalls).toBeGreaterThanOrEqual(1)
})
