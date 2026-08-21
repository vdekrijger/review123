/**
 * e2e/review-flow.spec.ts — Full flow tests for Review 1-2-3
 *
 * All network calls to api.github.com and api.deepseek.com are intercepted via
 * page.route() — no real network, no MSW needed, deterministic.
 *
 * PostHog domain is blocked so analytics never fire during tests.
 *
 * Settings are seeded via page.addInitScript so the AI features activate and
 * the public-repo fixture skips the consent dialog (EC-11a).
 *
 * Draft widget note: The virtualized DiffView widget is difficult to reliably
 * trigger via Playwright (it fires on an internal "+" click that only appears
 * on virtual row hover, which is inconsistent in headless Chrome). Instead of
 * attempting a fragile hover-click, we seed a draft directly into IndexedDB via
 * addInitScript before page load and assert: the sticky bar shows "1 comment
 * drafted". This is documented here so future maintainers understand the choice.
 */

import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Constants — fixture data shared across tests
// ---------------------------------------------------------------------------

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`
const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`
const APP_REVIEW_UNDERSTAND = `${APP_REVIEW_PATH}/understand`
const APP_REVIEW_INSPECT = `${APP_REVIEW_PATH}/inspect`
const APP_REVIEW_VERDICT = `${APP_REVIEW_PATH}/verdict`

// A minimal patch with real +/- lines so the diff view renders colored rows
const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

// ---------------------------------------------------------------------------
// Fixture response builders
// ---------------------------------------------------------------------------

function makePrMeta() {
  return {
    title: 'Test PR: add feature',
    state: 'open',
    merged: false,
    body: 'This PR adds a new feature for testing.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 2,
  }
}

function makePrFiles() {
  return [
    {
      filename: 'src/feature.ts',
      status: 'modified',
      patch: PATCH_WITH_LINES,
      additions: 2,
      deletions: 1,
    },
    {
      filename: 'src/old-utils.ts',
      status: 'renamed',
      previous_filename: 'src/utils.ts',
      additions: 0,
      deletions: 0,
    },
  ]
}

function makeFileContent(text: string) {
  // GitHub contents API returns base64-encoded content
  const b64 = Buffer.from(text).toString('base64')
  return { content: b64 + '\n', encoding: 'base64' }
}

function makeCheckRuns() {
  return {
    total_count: 2,
    check_runs: [
      {
        name: 'Unit tests',
        status: 'completed',
        conclusion: 'success',
        id: 1,
        url: `https://api.github.com/repos/${OWNER}/${REPO}/check-runs/1`,
        details_url: `https://github.com/${OWNER}/${REPO}/runs/1`,
        output: { title: null, summary: null, text: null, annotations_count: 0 },
      },
      {
        name: 'Integration tests',
        status: 'completed',
        conclusion: 'failure',
        id: 2,
        url: `https://api.github.com/repos/${OWNER}/${REPO}/check-runs/2`,
        details_url: `https://github.com/${OWNER}/${REPO}/runs/2`,
        output: { title: 'Failed', summary: 'Some tests failed', text: null, annotations_count: 1 },
      },
    ],
  }
}

function makeAnnotations() {
  return [
    {
      path: 'src/feature.ts',
      start_line: 10,
      end_line: 10,
      annotation_level: 'failure',
      message: 'Expected value to equal 42',
      title: 'AssertionError',
    },
  ]
}

function makeReviewComments() {
  return [
    {
      id: 1001,
      user: { login: 'reviewer-bot', avatar_url: null },
      body: 'This inline comment is on src/feature.ts line 2.',
      created_at: '2024-01-01T10:00:00Z',
      path: 'src/feature.ts',
      line: 2,
      side: 'RIGHT',
      in_reply_to_id: null,
    },
    // Threaded reply to 1001 — exercises in_reply_to_id grouping in the UI
    {
      id: 1003,
      user: { login: 'author-dev', avatar_url: null },
      body: 'Thanks, will fix in the next push.',
      created_at: '2024-01-01T11:00:00Z',
      path: 'src/feature.ts',
      line: 2,
      side: 'RIGHT',
      in_reply_to_id: 1001,
    },
  ]
}

function makeIssueComments() {
  return [
    {
      id: 2001,
      user: { login: 'general-reviewer', avatar_url: null },
      body: 'Overall this PR looks good but needs cleanup.',
      created_at: '2024-01-01T09:00:00Z',
    },
  ]
}

/**
 * GraphQL response that marks comment id 1001 (from makeReviewComments) as resolved.
 * The databaseId matches the REST id used in makeReviewComments().
 */
function makeResolvedThreadsGraphQL() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                isResolved: true,
                comments: {
                  nodes: [{ databaseId: 1001 }],
                },
              },
            ],
          },
        },
      },
    },
  }
}

// Two commits for the PR (used by revision picker tests)
const COMMIT_1_SHA = '111111aaaaaaa'
const COMMIT_2_SHA = '222222bbbbbbb' // head commit

function makePrCommits() {
  return [
    {
      sha: COMMIT_1_SHA,
      commit: {
        message: 'feat: first commit\n\nLonger body here',
        author: { date: '2024-01-01T10:00:00Z' },
      },
    },
    {
      sha: COMMIT_2_SHA,
      commit: {
        message: 'fix: second commit (head)',
        author: { date: '2024-01-02T10:00:00Z' },
      },
    },
  ]
}

// Compare endpoint response for base → first commit (1 file)
function makeCompareOneFile() {
  return {
    files: [
      {
        filename: 'src/feature.ts',
        status: 'modified',
        patch: '@@ -1,2 +1,3 @@\n context\n+added by commit 1\n context',
        additions: 1,
        deletions: 0,
      },
    ],
  }
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

const SUMMARY_TEXT =
  'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\nsrc/old-utils.ts\n===END==='

// Ask AI fixture response — plain text streamed answer
const ASK_ANSWER_TEXT = 'This code is in this location because it handles feature initialization.'

// Second ask fixture response — used to verify history retention
const ASK_ANSWER_2_TEXT = 'The second answer confirms context was retained.'

const ATTENTION_RESULT = {
  readingOrder: ['src/feature.ts', 'src/old-utils.ts'],
  hotspots: [{ path: 'src/feature.ts', reason: 'Critical logic change', level: 'high' }],
  testFlags: [{ path: 'src/feature.ts', note: 'No test covers this change' }],
}

// Change-impact contract: GRAPH_RESULT carries a blast-radius view (changed
// symbols + callers + callees). before/after/changeMap kept empty for the type.
const GRAPH_RESULT = {
  kind: 'flow',
  before: { nodes: [], edges: [] },
  after: { nodes: [], edges: [] },
  impact: {
    changed: [{ symbol: 'handleFeature', file: 'src/feature.ts', kind: 'changed' }],
    callers: [{ symbol: 'route', file: 'src/router.ts' }],
    callees: [{ symbol: 'validateInput', file: 'src/feature.ts' }],
  },
}

// Suppress fallback: a pure-data change has NO meaningful blast radius → the
// model returns an EMPTY impact and the panel shows an honest muted note.
const GRAPH_RESULT_NO_FLOW = {
  kind: 'flow',
  before: { nodes: [], edges: [] },
  after: { nodes: [], edges: [] },
  impact: { changed: [], callers: [], callees: [] },
}

const VERDICT_RESULT = {
  level: 'minor-changes',
  evidence: ['src/feature.ts modified with 2 additions'],
  notAnalyzed: [],
}

// LLM risk judge (PROMPT_VERSION 25): feeds the Review effort "AI judgment" factor
const RISK_JUDGE_RESULT = {
  score: 1,
  rationale: 'Localized feature change with limited reach.',
  snippets: [],
}

// v4 contract: TestInsight with 2 covered + 1 gap
const TEST_INSIGHT_RESULT = {
  covered: [
    {
      behavior: 'feature adds lines correctly',
      test: 'adds new lines to feature output',
      file: 'src/feature.test.ts',
    },
    {
      behavior: 'unchanged utils path preserved',
      test: 'utils module exports unchanged',
      file: 'src/old-utils.test.ts',
    },
  ],
  gaps: ['no test covers removal of removed line from feature.ts'],
}

// v9 contract: CoachResult with suggestion + accuracy + duplicate + specificity +
// grounded + per-dimension reasons + run-level verdictCoherence
const COACH_RESULT = {
  reviews: [
    {
      index: 0,
      clarity: 3,
      actionable: true,
      tone: 'blunt',
      biasQuestion: null,
      suggestion: 'Consider rephrasing this as a question to encourage discussion.',
      accuracy: 'consistent',
      accuracyNote: null,
      duplicate: false,
      specificity: true,
      grounded: true,
      reasons: {
        clarity: 'understandable but missing the why',
        tone: 'abrupt phrasing without hostility',
        actionable: 'asks for a concrete change',
        accuracy: 'matches the change shown in the diff',
        duplicate: 'no overlap with existing comments',
        specificity: 'names the exact line it concerns',
        grounded: 'every claim is visible in the provided hunk',
      },
    },
  ],
  verdictCoherence: {
    coherent: false,
    note: 'A blunt change request alongside a plain comment verdict reads fine, but double-check the verdict.',
  },
}

// Plan F: AlternativesResult with one alternative-is-better entry to trigger glance chip
const ALTERNATIVES_RESULT = {
  problem: 'The PR introduces a global singleton cache without per-request isolation.',
  alternatives: [
    {
      approach: 'Use a WeakMap keyed on the request context object for per-request cache scoping.',
      tradeoffs: 'Better isolation at the cost of passing context through more call sites.',
      assessment: 'alternative-is-better',
      rationale: 'Avoids cross-request data leaks in concurrent environments.',
    },
    {
      approach: 'Keep the singleton but add a reset() method for test isolation.',
      tradeoffs: 'Minimal change but still global state.',
      assessment: 'comparable',
      rationale: 'Acceptable when tests are the only concern.',
    },
  ],
}

// ---------------------------------------------------------------------------
// Helper: seed settings + draft into localStorage/IndexedDB before page load
// ---------------------------------------------------------------------------

function seedSettings(withGithubAuth: boolean) {
  const settings: Record<string, unknown> = {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
    // These tests exercise the classic FILES flow at step 2 (diff rows, viewed
    // state, file tree, drafts). Story mode is OFF so the deterministic
    // structural fallback (which now ALWAYS renders a walkthrough when story
    // mode is on) doesn't surface its slideshow nav and shadow these tests.
    // Story-mode behaviour has its own dedicated suite (story-mode.spec.ts).
    storyMode: false,
  }
  if (withGithubAuth) {
    settings.githubAuth = {
      token: 'ghp_test_token',
      method: 'pat',
      scopes: ['repo'],
    }
  }
  return settings
}

/**
 * Seed one draft directly into IndexedDB so we can assert the draft count bar
 * without having to interact with the virtualized diff widget.
 */
function seedDraftScript(prKey: string) {
  return `
    (async () => {
      const dbName = 'review123-drafts';
      const storeName = 'drafts';
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const draft = {
          path: 'src/feature.ts',
          line: 3,
          side: 'RIGHT',
          body: 'Seeded draft for testing',
          prKey: ${JSON.stringify(prKey)},
        };
        const key = ${JSON.stringify(prKey)} + '|src/feature.ts|3|RIGHT';
        store.put(draft, key);
      };
    })();
  `
}

// ---------------------------------------------------------------------------
// Shared route setup — intercept all external calls via a single dispatcher
// per domain (avoids Playwright LIFO ordering issues with multiple patterns)
// ---------------------------------------------------------------------------

async function setupRoutes(
  page: import('@playwright/test').Page,
  opts: {
    withGithubAuth?: boolean
    withResolvedThreads?: boolean
    /** Hold AI (DeepSeek) fixture responses for this many ms before fulfilling */
    aiDelayMs?: number
    /** Called with the JSON body of each POST to the review-comment reply endpoint */
    onReplyPost?: (body: unknown) => void
    /** Plan L: return the EMPTY-flow diagram fixture (graceful-fallback note). */
    emptyFlow?: boolean
  } = {},
) {
  // Block PostHog analytics
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  // ---- GitHub API — single handler, dispatches by URL path ----------------
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    // PR meta: /repos/:owner/:repo/pulls/:number
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({ json: makePrMeta() })
    }

    // PR files: /repos/:owner/:repo/pulls/:number/files
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: makePrFiles() })
    }

    // Check runs: /repos/:owner/:repo/commits/:sha/check-runs
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: makeCheckRuns() })
    }

    // Annotations for passed check (id=1)
    if (path === `/repos/${OWNER}/${REPO}/check-runs/1/annotations`) {
      return route.fulfill({ json: [] })
    }

    // Annotations for failed check (id=2)
    if (path === `/repos/${OWNER}/${REPO}/check-runs/2/annotations`) {
      return route.fulfill({ json: makeAnnotations() })
    }

    // File contents: /repos/:owner/:repo/contents/:filepath
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      const ref = url.searchParams.get('ref') ?? ''
      const filePath = decodeURIComponent(path.replace(`/repos/${OWNER}/${REPO}/contents/`, ''))

      if (filePath === 'src/feature.ts' && ref === BASE_SHA) {
        return route.fulfill({ json: makeFileContent('const old = 1\nremoved line\ntrailing context') })
      }
      if (filePath === 'src/feature.ts' && ref === HEAD_SHA) {
        return route.fulfill({
          json: makeFileContent(
            'const old = 1\nunchanged line\nadded line\nanother added line\ntrailing context',
          ),
        })
      }
      if (filePath === 'src/old-utils.ts') {
        return route.fulfill({ json: makeFileContent('export {}') })
      }
      // 404 for unknown files
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }

    // Review submission: POST /repos/:owner/:repo/pulls/:number/reviews
    if (
      path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews` &&
      route.request().method() === 'POST'
    ) {
      return route.fulfill({
        status: 200,
        json: {
          id: 1,
          state: 'COMMENTED',
          html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}#pullrequestreview-1`,
        },
      })
    }

    // PR commits: /repos/:owner/:repo/pulls/:number/commits
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) {
      return route.fulfill({ json: makePrCommits() })
    }

    // Compare: /repos/:owner/:repo/compare/:base...:head
    if (path.startsWith(`/repos/${OWNER}/${REPO}/compare/`)) {
      // base → commit1: return 1 file; other combos: empty
      const range = decodeURIComponent(path.replace(`/repos/${OWNER}/${REPO}/compare/`, ''))
      if (range === `${BASE_SHA}...${COMMIT_1_SHA}`) {
        return route.fulfill({ json: makeCompareOneFile() })
      }
      return route.fulfill({ json: { files: [] } })
    }

    // Reply to a review-comment thread:
    // POST /repos/:owner/:repo/pulls/:number/comments/:comment_id/replies
    const replyMatch = path.match(
      new RegExp(`^/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments/(\\d+)/replies$`),
    )
    if (replyMatch && route.request().method() === 'POST') {
      const posted = route.request().postDataJSON() as { body: string }
      opts.onReplyPost?.(posted)
      return route.fulfill({
        status: 201,
        json: {
          id: 5001,
          user: { login: 'test-user', avatar_url: null },
          body: posted.body,
          created_at: '2024-01-02T10:00:00Z',
          path: 'src/feature.ts',
          line: 2,
          side: 'RIGHT',
          in_reply_to_id: Number(replyMatch[1]),
        },
      })
    }

    // PR review comments: /repos/:owner/:repo/pulls/:number/comments
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: makeReviewComments() })
    }

    // PR issue comments: /repos/:owner/:repo/issues/:number/comments
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: makeIssueComments() })
    }

    // GraphQL endpoint: /graphql — used for resolved thread state
    if (path === '/graphql' && route.request().method() === 'POST') {
      if (opts.withResolvedThreads) {
        return route.fulfill({ json: makeResolvedThreadsGraphQL() })
      }
      // Default: no resolved threads
      return route.fulfill({
        json: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes: [] },
              },
            },
          },
        },
      })
    }

    // Fallback — return empty JSON rather than aborting so the app doesn't crash
    console.warn('[e2e] unhandled GitHub API path:', path)
    return route.fulfill({ json: {} })
  })

  // ---- DeepSeek API — single handler, dispatches by request body ----------
  await page.route('**/api.deepseek.com/**', async (route) => {
    // Optional artificial latency — used by the AI-skeleton test to observe
    // the pending state before any AI content arrives.
    if (opts.aiDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.aiDelayMs))
    }
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body — treat as non-streaming
    }

    if (body?.stream === true) {
      // Determine which streaming response to return based on system prompt
      const streamSystem = (
        body?.messages?.find((m) => m.role === 'system')?.content ?? ''
      ).toLowerCase()
      // Ask AI requests include "ask-marker" in user message or "senior engineer" in system
      const userContent = (
        body?.messages?.find((m) => m.role === 'user')?.content ?? ''
      )
      const isAskRequest = streamSystem.includes('senior engineer') || userContent.includes('ask-marker')
      // For the second ask request in the history threading test, we vary the answer
      const askCount = isAskRequest && userContent.includes('second-ask') ? 2 : 1
      const askAnswer = askCount === 2 ? ASK_ANSWER_2_TEXT : ASK_ANSWER_TEXT
      const sseText = isAskRequest
        ? makeDeepSeekStreamResponse(askAnswer)
        : makeDeepSeekStreamResponse(SUMMARY_TEXT)
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        body: sseText,
      })
    }

    // JSON mode — dispatch by what the system prompt is asking for
    const systemContent = (
      body?.messages?.find((m) => m.role === 'system')?.content ?? ''
    ).toLowerCase()

    let result: unknown

    if (systemContent.includes('consolidating overlapping code-review findings')) {
      // Convergence pass (PROMPT_VERSION 26): no overlaps — a valid empty
      // cluster set, so the flow renders findings unmerged (loss-proof path).
      result = { clusters: [] }
    } else if (systemContent.includes('rewriting code-review findings into plain')) {
      // Simplify pass (runs after convergence): a valid empty rewrite set,
      // so every finding card keeps its original body.
      result = { rewrites: [] }
    } else if (systemContent.includes('hotspot') || systemContent.includes('readingorder')) {
      result = ATTENTION_RESULT
    } else if (systemContent.includes('execution path') || systemContent.includes('mermaid')) {
      result = opts.emptyFlow ? GRAPH_RESULT_NO_FLOW : GRAPH_RESULT
    } else if (systemContent.includes('covered') || systemContent.includes('gaps')) {
      // testInsightPrompt system content mentions "covered" and "gaps" fields
      result = TEST_INSIGHT_RESULT
    } else if (systemContent.includes('reviews') && systemContent.includes('clarity')) {
      // coachPrompt system content mentions "reviews" and "clarity" fields
      result = COACH_RESULT
    } else if (systemContent.includes('alternative-is-better') || (systemContent.includes('alternatives') && systemContent.includes('approaches'))) {
      // alternativesPrompt system content mentions "alternative-is-better" enum value and "alternatives"/"approaches"
      result = ALTERNATIVES_RESULT
    } else if (systemContent.includes('change-risk assessor')) {
      // riskJudgePrompt system frames the model as a change-risk assessor
      result = RISK_JUDGE_RESULT
    } else {
      // Default to verdict (also covers summarize which is streaming so won't reach here)
      result = VERDICT_RESULT
    }

    return route.fulfill({
      status: 200,
      json: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [
          {
            message: { role: 'assistant', content: JSON.stringify(result) },
            finish_reason: 'stop',
            index: 0,
          },
        ],
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Test 1: Landing → Review route navigation
// ---------------------------------------------------------------------------

test('landing: paste PR URL navigates to review route', async ({ page }) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto('/')

  // Landing page should have the URL input
  const input = page.getByLabel('Pull request URL')
  await expect(input).toBeVisible()

  // Type in the PR URL and submit
  await input.fill(PR_URL)
  await page.getByRole('button', { name: 'Review', exact: true }).click()

  // Should navigate to the review route (URL canonicalized to /understand)
  await expect(page).toHaveURL(APP_REVIEW_UNDERSTAND, { timeout: 5_000 })

  // PR title should appear once loaded
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test 2: Full review flow — diff renders, AI panels populate, CI shows
// ---------------------------------------------------------------------------

test('review flow: diff renders with red/green rows, AI panels populate, CI shows failure', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  // Navigate directly to the review route
  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // --- Step 1 (Understand) should be active by default ---

  // CI badge in glance card should show failure
  await expect(page.locator('.ci-badge.ci-fail')).toBeVisible({ timeout: 10_000 })

  // PR description is inside a collapsed <details> — open it first to check
  // Scope to the understand-step so we don't match the rail copy (meta is now also in the rail)
  const prDescDetails = page.locator('details.pr-description-details')
  await prDescDetails.evaluate((el: HTMLDetailsElement) => { el.open = true })
  await expect(
    page.locator('.understand-step').getByText('This PR adds a new feature for testing.')
  ).toBeVisible()

  // AI summary should appear (may be in pre.prose while streaming or .prose-md when done)
  // Use containsText directly: it waits for text to appear and ignores empty/zero-size containers
  await expect(
    page.locator('.understand-step')
  ).toContainText('This PR adds a new feature', { timeout: 15_000 })

  // Verdict pill should appear — UnderstandStep renders the verdict-level div
  await expect(page.locator('.understand-step .verdict-level')).toBeVisible({ timeout: 20_000 })

  // Diagram panel: the understand-step section with the diagrams heading
  await expect(page.locator('.understand-step')).toBeVisible()

  // --- Navigate to step 2 (Inspect) ---
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Diff view: file-diff articles should be present
  const fileDiffs = page.locator('article.file-diff')
  await expect(fileDiffs.first()).toBeVisible({ timeout: 5_000 })

  // The diff container is visible (has content)
  await expect(fileDiffs).toHaveCount(2)

  // The rename-only file should show the rename note
  await expect(page.getByText(/Rename only — no content changes/i)).toBeVisible()

  // --- Mode toggle ---
  const splitBtn = page.getByRole('button', { name: 'Side-by-side' })
  await splitBtn.click()
  // After clicking, the button should be active (aria-pressed=true)
  await expect(splitBtn).toHaveAttribute('aria-pressed', 'true')

  // Toggle back to unified
  await page.getByRole('button', { name: 'Unified' }).click()

  // --- Context Rail: hotspot click jumps to step 2 ---
  // First navigate to step 1 to test the hotspot click
  await page.getByRole('button', { name: 'Previous step' }).click()
  await expect(page.locator('.understand-step')).toBeVisible()

  // Wait for AI attention to populate (hotspot buttons attached inside the rail)
  const hotspotBtn = page.locator('.hotspot-btn').first()
  await expect(hotspotBtn).toBeAttached({ timeout: 15_000 })

  // ALL rail sections start collapsed (default-collapsed rail) — expand Hotspots
  await expect(hotspotBtn).not.toBeVisible()
  const hotspotsSection = page
    .locator('aside.context-rail details.rail-section-details')
    .filter({ has: page.locator('summary', { hasText: 'Hotspots' }) })
  await hotspotsSection.locator('summary').click()
  await expect(hotspotBtn).toBeVisible()

  // The Hotspots section shows a one-line legend explaining the markers
  await expect(page.locator('.hotspot-legend')).toContainText('high risk')

  // Plant a marker on window — a full page reload would wipe it
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__review123SpaMarker = true
  })

  // Click hotspot — should jump to step 2
  await hotspotBtn.click()
  // After hotspot click, we should be in step 2 (diff mode toggle visible)
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible({ timeout: 3_000 })

  // SPA navigation: URL updated via pushState, NOT a full document load
  await expect(page).toHaveURL(APP_REVIEW_INSPECT)
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__review123SpaMarker,
    ),
  ).toBe(true)

  // The hotspot's diff card (src/feature.ts) is scrolled into view and expanded
  const hotspotCard = page.locator('#file-src-feature-ts article.file-diff')
  await expect(hotspotCard).toBeVisible()
  await expect(hotspotCard).not.toHaveClass(/is-collapsed/)
  await expect
    .poll(async () =>
      hotspotCard.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        return rect.top < window.innerHeight && rect.bottom > 0
      }),
    )
    .toBe(true)
})

// ---------------------------------------------------------------------------
// Test 2b: Hotspot click from a FRESH Understand step (Inspect never mounted)
// must be an SPA navigation (pushState) — no full document reload — and must
// scroll the target file's diff card into view.
// ---------------------------------------------------------------------------

test('hotspot click from fresh understand step: SPA-navigates to inspect and scrolls to file', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
    // Persisted per-browser rail state: a previously expanded Hotspots section
    // must be restored open (rail sections are otherwise collapsed by default).
    localStorage.setItem('review123:rail-expanded', JSON.stringify({ hotspots: true }))
  }, seedSettings(false))

  // Land directly on the Understand step — InspectStep has never rendered
  await page.goto(APP_REVIEW_UNDERSTAND)
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  const hotspotBtn = page.locator('.hotspot-btn').first()
  await expect(hotspotBtn).toBeVisible({ timeout: 15_000 })

  // Plant a marker on window — a full page reload would wipe it
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__review123SpaMarker = true
  })

  await hotspotBtn.click()

  // Step 2 active, URL pushed, marker intact (no reload)
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible({ timeout: 3_000 })
  await expect(page).toHaveURL(APP_REVIEW_INSPECT)
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__review123SpaMarker,
    ),
  ).toBe(true)

  // The hotspot's diff card is in view
  const hotspotCard = page.locator('#file-src-feature-ts article.file-diff')
  await expect(hotspotCard).toBeVisible()
  await expect
    .poll(async () =>
      hotspotCard.evaluate((el) => {
        const rect = el.getBoundingClientRect()
        return rect.top < window.innerHeight && rect.bottom > 0
      }),
    )
    .toBe(true)
})

// ---------------------------------------------------------------------------
// Test 3: Draft bar shows seeded draft count + verdict step sign-in guard
// ---------------------------------------------------------------------------

test('draft bar shows draft count; step 3 shows sign-in prompt when signed out', async ({
  page,
}) => {
  await setupRoutes(page)

  // Seed settings WITHOUT github auth (signed out)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  // Seed a draft into IndexedDB — the prKey is provider-qualified: github:owner/repo#number@headSha
  // We seed before the page loads so the store picks it up on load()
  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript(seedDraftScript(prKey))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Draft bar: the status region should eventually show draft count
  // The seeded draft should show "1 comment drafted"
  const draftStatus = page.locator('.draft-bar').getByRole('status')
  await expect(draftStatus).toContainText(/1 comment/i, { timeout: 5_000 })

  // --- Step 3: VerdictStep should show sign-in prompt when no auth ---
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  // VerdictStep renders a sign-in prompt / PAT prompt when signed out (EC-09c / EC-19b).
  // Scoped to the step's signed-out panel: the navbar also offers "Sign in with …" buttons.
  await expect(
    page.locator('.signed-out').getByText(/sign in|add a.*pat|authentication required/i).first(),
  ).toBeVisible({ timeout: 5_000 })

  // Submit button should NOT be present when signed out
  await expect(page.getByRole('button', { name: /submit review/i })).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// Test 4: Verdict submit with mocked auth — POST review → success panel
// ---------------------------------------------------------------------------

test('verdict step: with auth, submit review → success panel', async ({ page }) => {
  await setupRoutes(page, { withGithubAuth: true })

  // Seed settings WITH github auth token
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(true))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 3 (VerdictStep)
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  // Should show the verdict form (signed in)
  const approveRadio = page.getByRole('radio', { name: /approve/i })
  await expect(approveRadio).toBeVisible({ timeout: 5_000 })

  // Select APPROVE
  await approveRadio.click()

  // Submit the review
  const submitBtn = page.getByRole('button', { name: /submit review/i })
  await expect(submitBtn).toBeVisible()
  await submitBtn.click()

  // After successful submission, VerdictStep shows the success panel
  await expect(
    page.getByText('Your review was submitted successfully.'),
  ).toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test 5: tests-panel — glance chip + checklist rows (D2 / v4 contract)
// ---------------------------------------------------------------------------

test('tests-panel: glance chip shows covered/gap counts; open panel shows checklist rows', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Glance chip: "2 behaviors tested" from TEST_INSIGHT_RESULT.covered (2 items)
  await expect(
    page.locator('.tests-chip'),
  ).toContainText('2 behaviors tested', { timeout: 20_000 })

  // Glance chip: "1 gaps" from TEST_INSIGHT_RESULT.gaps (1 item)
  await expect(
    page.locator('.tests-chip-gaps'),
  ).toContainText('1 gap', { timeout: 5_000 })

  // Open the tests panel (it is collapsed by default)
  const testsPanel = page.locator('details.tests-panel')
  await testsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })

  // Covered checklist rows should be visible (2 covered items)
  // Scope to the tests-panel details so we don't count the rail's copy
  await expect(page.locator('details.tests-panel .tests-covered-item')).toHaveCount(2)

  // Gap rows should also be visible (1 gap)
  await expect(page.locator('details.tests-panel .tests-gap-item')).toHaveCount(1)
})

// ---------------------------------------------------------------------------
// Test 6: change-impact — blast-radius panel renders flowchart nodes with
// change classes + the legend (Plan L)
// ---------------------------------------------------------------------------

test('change impact: panel renders flowchart nodes with status classes + legend', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Open the change-impact detail panel inside UnderstandStep
  const diagramsPanel = page.locator('details').filter({ hasText: 'Change impact' }).first()
  await diagramsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })

  // The impact legend appears once the diagram renders
  const legend = page.locator('[aria-label="Change impact legend"]').first()
  await expect(legend).toBeVisible({ timeout: 20_000 })
  await expect(legend.locator('.legend-chip.legend-changed')).toContainText('Affected by this change')
  await expect(legend.locator('.legend-chip.legend-unchanged')).toContainText('This change uses')

  // The deterministic serializer emits classDef-styled nodes; mermaid injects a
  // <style> block applying each status class. Its presence proves the impact's
  // changed (accent) + context (de-emphasized) nodes round-trip end-to-end.
  const impactSvg = diagramsPanel.locator('.diagram-container--full svg').first()
  await expect(impactSvg).toBeVisible({ timeout: 20_000 })
  await expect(impactSvg.locator('style')).toContainText('.changed', { timeout: 20_000 })
  await expect(impactSvg.locator('style')).toContainText('.context')
})

// ---------------------------------------------------------------------------
// Test 6b: auto-suppress — a pure-data change (empty impact) renders the honest
// "no notable call-graph impact" note instead of a forced diagram
// ---------------------------------------------------------------------------

test('change impact: empty impact renders the auto-suppress note', async ({ page }) => {
  await setupRoutes(page, { emptyFlow: true })
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  const diagramsPanel = page.locator('details').filter({ hasText: 'Change impact' }).first()
  await diagramsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })

  // Honest suppressed note — never a forced/empty diagram.
  await expect(diagramsPanel.getByText(/no notable call-graph impact/i)).toBeVisible({ timeout: 20_000 })
})

// ---------------------------------------------------------------------------
// Test 7: viewed-state — mark viewed → collapse → reload → still collapsed + sticky bar
// ---------------------------------------------------------------------------

test('viewed-state: mark first file viewed → collapses → reload → still collapsed, sticky bar shows viewed 1/2', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load and navigate to step 2 (Inspect)
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  // Wait for file diffs to appear
  const fileDiffs = page.locator('article.file-diff')
  await expect(fileDiffs.first()).toBeVisible({ timeout: 5_000 })

  // Find the viewed checkbox for the first file (src/feature.ts)
  const firstViewedCheckbox = page.locator('input.viewed-checkbox').first()
  await expect(firstViewedCheckbox).toBeVisible()

  // Toggle the viewed state by dispatching a change event directly.
  // We use evaluate() because: (a) the context-rail SVG overlaps the header in headless
  // Chrome; (b) the FileDiff checkbox is a controlled Svelte 5 component — Playwright's
  // check() verifies checked state synchronously, but Svelte's reactive update lands after
  // the microtask boundary. Dispatching the event from JS sidesteps both issues.
  await firstViewedCheckbox.evaluate((el: HTMLInputElement) => {
    el.checked = true
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })

  // After toggling, the first article should be collapsed (has .is-collapsed class)
  await expect(fileDiffs.first()).toHaveClass(/is-collapsed/, { timeout: 5_000 })

  // Reload the page
  await page.reload()

  // Wait for PR to reload
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Step 2 is restored from URL (page was reloaded at /inspect)
  await expect(fileDiffs.first()).toBeVisible({ timeout: 5_000 })

  // After reload, first article should still be collapsed (persisted in localStorage)
  await expect(fileDiffs.first()).toHaveClass(/is-collapsed/, { timeout: 3_000 })

  // The sticky bar should show "viewed 1/2"
  const draftStatus = page.locator('.draft-bar').getByRole('status')
  await expect(draftStatus).toContainText('viewed 1/2', { timeout: 5_000 })
})

// ---------------------------------------------------------------------------
// Test 8: coach — seed draft + auth + key → step 3 → "Coach my comments" → suggestion → Apply
// ---------------------------------------------------------------------------

test('coach: seed draft, navigate to step 3, Coach my comments → suggestion card → Apply → recap shows updated body', async ({
  page,
}) => {
  await setupRoutes(page, { withGithubAuth: true })

  // Seed settings WITH github auth and deepseek key
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(true))

  // Seed a draft so the coach button becomes eligible
  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript(seedDraftScript(prKey))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 3 (VerdictStep)
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  // Should show the verdict form (signed in)
  const approveRadio = page.getByRole('radio', { name: /approve/i })
  await expect(approveRadio).toBeVisible({ timeout: 5_000 })

  // The "Coach my comments" button should be visible (auth + draft + key all present)
  const coachBtn = page.getByRole('button', { name: /coach my comments/i })
  await expect(coachBtn).toBeVisible({ timeout: 5_000 })

  // Click the Coach button — triggers the DeepSeek call which returns COACH_RESULT
  await coachBtn.click()

  // The suggestion card should appear (COACH_RESULT has suggestion: "Consider rephrasing...")
  await expect(
    page.getByText(/Consider rephrasing this as a question/i),
  ).toBeVisible({ timeout: 10_000 })

  // v9: the new dimension chips render with self-evident labels
  await expect(page.getByTestId('specificity-chip')).toHaveText(/points at concrete code/i)
  await expect(page.getByTestId('grounded-chip')).toHaveText(/claims verifiable in diff/i)
  await expect(page.getByTestId('accuracy-chip')).toHaveText(/matches the diff/i)

  // v9: the per-dimension rationale list is expandable and carries the reasons
  const reasonsDetails = page.getByTestId('coach-reasons')
  await expect(reasonsDetails).toBeVisible()
  await reasonsDetails.locator('summary').click()
  await expect(reasonsDetails).toContainText('abrupt phrasing without hostility')

  // v9: verdictCoherence.coherent=false → flag card at the top of the results
  await expect(page.getByTestId('coherence-card')).toContainText(/double-check the verdict/i)

  // Click Apply — this should replace the draft body in the store
  const applyBtn = page.getByRole('button', { name: /apply/i })
  await expect(applyBtn).toBeVisible()
  await applyBtn.click()

  // After applying, the draft recap should show the new (suggested) body text.
  // Scope to the recap section to avoid strict-mode violation with the suggestion blockquote.
  const recapSection = page.locator('[aria-label="Drafted comments"]')
  await expect(
    recapSection.getByText(/Consider rephrasing this as a question/i),
  ).toBeVisible({ timeout: 5_000 })
})

// ---------------------------------------------------------------------------
// Test 9: existing PR comments — inline comment in step 2
// ---------------------------------------------------------------------------

test('existing comments: inline review comment visible in step 2, no error note shown', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Inline review comment on src/feature.ts should appear
  await expect(
    page.getByText(/This inline comment is on src\/feature\.ts line 2\./i)
  ).toBeVisible({ timeout: 8_000 })

  // No error note — comments loaded successfully
  await expect(
    page.getByText(/couldn't load existing comments/i)
  ).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// Test 10: Revision picker — open, compare base→commit1, swap files, Full diff restores
// ---------------------------------------------------------------------------

test('revision picker: open picker, choose base→first-commit, compare files swap, Full diff restores', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Revision picker should appear after commits load
  const fromSelect = page.getByRole('combobox', { name: /from revision/i })
  const toSelect = page.getByRole('combobox', { name: /to revision/i })
  await expect(fromSelect).toBeVisible({ timeout: 5_000 })
  await expect(toSelect).toBeVisible({ timeout: 5_000 })

  // "PR base" option should exist in both selects
  await expect(fromSelect.locator('option', { hasText: 'PR base' })).toHaveCount(1)

  // Both commit shas should appear as options (short shas from fixture)
  // COMMIT_1_SHA = '111111aaaaaaa' → shortSha = '111111a'
  // COMMIT_2_SHA = '222222bbbbbbb' → shortSha = '222222b'
  const fromOptions = await fromSelect.locator('option').allTextContents()
  expect(fromOptions.some(o => o.includes('111111a'))).toBeTruthy()
  expect(fromOptions.some(o => o.includes('222222b'))).toBeTruthy()

  // Select base → first commit
  await fromSelect.selectOption({ label: 'PR base' })
  await toSelect.selectOption({ value: COMMIT_1_SHA })

  // Apply comparison
  const compareBtn = page.getByRole('button', { name: /apply revision comparison/i })
  await expect(compareBtn).not.toBeDisabled()
  await compareBtn.click()

  // Wait for compare to activate — the mock returns 1 file (src/feature.ts)
  // After compare is active, InspectStep should show 1 file
  await expect(page.locator('article.file-diff')).toHaveCount(1, { timeout: 8_000 })

  // The PR base → commit1 comparison returns only src/feature.ts
  await expect(page.locator('article.file-diff')).toHaveCount(1)

  // "Full diff" button should be visible in the picker (clear action)
  const fullDiffBtn = page.getByRole('button', { name: /full diff/i })
  await expect(fullDiffBtn).toBeVisible()

  // Click "Full diff" — restores original 2 files
  await fullDiffBtn.click()

  // After restore, should show original 2 files again
  await expect(page.locator('article.file-diff')).toHaveCount(2, { timeout: 5_000 })
})

// ---------------------------------------------------------------------------
// Test 11: alternatives panel — glance chip + panel content
// ---------------------------------------------------------------------------

test('alternatives-panel: glance chip appears when alternative-is-better; panel shows problem + cards + chips', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Wait for AI alternatives to populate — glance chip should appear because
  // ALTERNATIVES_RESULT has one alternative-is-better assessment
  await expect(
    page.locator('.alternatives-glance-chip'),
  ).toBeVisible({ timeout: 20_000 })

  // The glance chip should contain the expected text
  await expect(
    page.locator('.alternatives-glance-chip'),
  ).toContainText('alternative worth considering')

  // Open the alternatives panel (it is collapsed by default)
  const altPanel = page.locator('details.alternatives-panel')
  await altPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })

  // Problem statement should be visible — scope to the alternatives panel
  // to avoid the rail's copy matching too
  await expect(
    page.locator('details.alternatives-panel').getByText(/The PR introduces a global singleton cache/i),
  ).toBeVisible({ timeout: 5_000 })

  // Both alternative cards should be visible (scoped to the step-1 panel)
  await expect(page.locator('details.alternatives-panel .alternative-card')).toHaveCount(2)

  // The "alternative-is-better" chip should show "Worth considering"
  await expect(
    page.locator('details.alternatives-panel .assessment-chip.assessment-alternative-is-better'),
  ).toContainText('Worth considering')

  // The "comparable" chip should show "Comparable"
  await expect(
    page.locator('details.alternatives-panel .assessment-chip.assessment-comparable'),
  ).toContainText('Comparable')
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Test: Context-line expansion affordance appears in Inspect diff view
//
// This test uses a custom file fixture with many context lines so the hunk
// is in the MIDDLE of the file — hidden lines above and below trigger expand
// button rendering by the @git-diff-view library.
// ---------------------------------------------------------------------------

test('inspect: context-line expand affordance renders when full file contents are available', async ({
  page,
}) => {
  // A patch that touches line 6 of a 12-line file — lines 1-4 above and 9-12
  // below are hidden → the library renders Expand Up / Expand Down buttons.
  const EXPAND_PATCH = `@@ -5,4 +5,4 @@\n context above\n-old value\n+new value\n context below`
  const OLD_CONTENT = [
    'line 1', 'line 2', 'line 3', 'line 4',
    'context above', 'old value', 'context below',
    'line 8', 'line 9', 'line 10', 'line 11', 'line 12',
  ].join('\n')
  const NEW_CONTENT = [
    'line 1', 'line 2', 'line 3', 'line 4',
    'context above', 'new value', 'context below',
    'line 8', 'line 9', 'line 10', 'line 11', 'line 12',
  ].join('\n')

  // Block PostHog
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  // GitHub API mock — only what's needed for this test
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Expand test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 1,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          {
            filename: 'src/module.ts',
            status: 'modified',
            patch: EXPAND_PATCH,
            additions: 1,
            deletions: 1,
          },
        ],
      })
    }
    // File contents for expansion
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      const ref = url.searchParams.get('ref') ?? ''
      const filePath = decodeURIComponent(path.replace(`/repos/${OWNER}/${REPO}/contents/`, ''))
      if (filePath === 'src/module.ts') {
        const content = ref === BASE_SHA ? OLD_CONTENT : NEW_CONTENT
        const b64 = Buffer.from(content).toString('base64')
        return route.fulfill({ json: { content: b64 + '\n', encoding: 'base64' } })
      }
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    return route.fulfill({ status: 404, json: { message: 'Not Found' } })
  })

  // DeepSeek — just 404 so AI features don't block the test
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true })

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Expand test PR/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // File diff should be rendered
  const fileDiff = page.locator('article.file-diff').first()
  await expect(fileDiff).toBeVisible({ timeout: 8_000 })

  // Wait for file contents to load (the expand buttons appear after the
  // contentsMap resolves — give it a moment then assert expansion is available)
  const expandBtn = page.locator(
    'button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]',
  ).first()
  await expect(expandBtn).toBeVisible({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test 12: Ask AI removed from context rail (line-level widget supersedes it)
//
// Per product decision: the rail no longer hosts an Ask AI panel.
// The AskAi component lives in the line-level DraftThread widget path.
// This test verifies:
//   1. The rail does NOT contain a details.ask-ai-section.
//   2. The rail DOES contain registry-driven sections (ci-details + pr-description).
// ---------------------------------------------------------------------------

test('ask-ai: NOT in context rail; rail shows ci-details and pr-description sections', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // The context rail should be visible (railCollapsed: false in settings)
  const rail = page.locator('aside.context-rail')
  await expect(rail).toBeVisible()

  // Ask AI section must NOT be in the rail body
  await expect(rail.locator('details.ask-ai-section')).not.toBeVisible()

  // Registry sections must be present — CI details and PR description now included
  // Collect all <details> summary texts in the rail body
  const railBody = rail.locator('.rail-body')
  const summaryTexts = await railBody.locator('details > summary').allTextContents()
  const lower = summaryTexts.map((t) => t.toLowerCase())

  // ci-details section
  expect(lower.some((t) => t.includes('ci'))).toBe(true)
  // pr-description section
  expect(lower.some((t) => t.includes('pr description') || t.includes('original pr'))).toBe(true)
})

// ---------------------------------------------------------------------------
// Test 13: File tree explorer visible in Inspect view; clicking second file
//          scrolls that article into view
// ---------------------------------------------------------------------------

test('file-tree: drawer closed by default; toggle opens tree; clicking second file scrolls to its article', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for file diffs to appear
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 5_000 })

  // Drawer is closed by default: toggle tab exists with aria-expanded="false"
  const toggleTab = page.locator('.tree-toggle-tab')
  await expect(toggleTab).toBeVisible()
  await expect(toggleTab).toHaveAttribute('aria-expanded', 'false')

  // File tree nav should NOT be visible when drawer is closed
  const treeNav = page.locator('nav[aria-label="File tree"]')
  await expect(treeNav).not.toBeVisible()

  // Open the drawer by clicking the toggle tab
  await toggleTab.click()
  await expect(toggleTab).toHaveAttribute('aria-expanded', 'true')

  // Now the file tree nav should be visible
  await expect(treeNav).toBeVisible()

  // The fixture has 2 files: src/feature.ts and src/old-utils.ts
  // Both should appear as file-selection buttons in the file tree (not counting close button)
  const fileButtons = treeNav.locator('.file-btn')
  await expect(fileButtons).toHaveCount(2)

  // Get the second file button (src/old-utils.ts)
  const secondFileBtn = fileButtons.nth(1)
  const secondFileName = await secondFileBtn.textContent()
  expect(secondFileName).toMatch(/old-utils\.ts/)

  // Click the second file in the tree
  await secondFileBtn.click()

  // The second article should now be visible in the viewport
  // (scrolled to) — assert via locator visibility
  const secondArticle = page.locator('article.file-diff').nth(1)
  await expect(secondArticle).toBeVisible({ timeout: 5_000 })
  await expect(secondArticle).toBeInViewport({ ratio: 0.1 })
})

// ---------------------------------------------------------------------------
// file-tree: close via ✕ button inside drawer header
// ---------------------------------------------------------------------------

test('file-tree: drawer can be closed via the ✕ close button inside the drawer', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 5_000 })

  const toggleTab = page.locator('.tree-toggle-tab')
  const treeNav = page.locator('nav[aria-label="File tree"]')

  // Open drawer
  await toggleTab.click()
  await expect(toggleTab).toHaveAttribute('aria-expanded', 'true')
  await expect(treeNav).toBeVisible()

  // Close via ✕ button inside the drawer header
  const closeBtn = page.locator('.tree-drawer-close')
  await expect(closeBtn).toBeVisible()
  await closeBtn.click()

  // Drawer should be closed
  await expect(toggleTab).toHaveAttribute('aria-expanded', 'false')
  await expect(treeNav).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// Test 14: Resolved comment threads — collapsed with indicator, expandable
// ---------------------------------------------------------------------------

test('resolved-threads: resolved thread renders collapsed with ✓ Resolved summary; expanding shows full thread', async ({
  page,
}) => {
  // Use auth so the GraphQL call fires; withResolvedThreads so comment 1001 is marked resolved
  await setupRoutes(page, { withGithubAuth: true, withResolvedThreads: true })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(true))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect) where comments appear
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // The resolved thread (comment 1001) should render as a collapsed <details>
  // with a summary showing "✓ Resolved"
  const resolvedDetails = page.locator('details.resolved-thread')
  await expect(resolvedDetails).toBeVisible({ timeout: 8_000 })

  // Summary should contain "Resolved" label
  const summary = resolvedDetails.locator('summary.resolved-summary')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('Resolved')

  // Summary should contain author and truncated body from the fixture comment
  await expect(summary).toContainText('reviewer-bot')
  await expect(summary).toContainText('This inline comment is on src/feature.ts line 2')

  // The full CommentThread should NOT be visible while collapsed
  // (details element is closed, content is hidden from the accessibility tree)
  await expect(resolvedDetails).not.toHaveAttribute('open')

  // Expand the details by clicking the summary
  await summary.click()

  // After expanding, the full CommentThread content should be visible.
  // Scope to the comment-body div to distinguish from the summary snippet.
  await expect(
    resolvedDetails.locator('.comment-body').first(),
  ).toBeVisible({ timeout: 3_000 })

  // details should now be open
  await expect(resolvedDetails).toHaveAttribute('open', '')
})

// ---------------------------------------------------------------------------
// Test 15: Review progress bar — visible at step 2, percent increases after
//          marking a file viewed
// ---------------------------------------------------------------------------

test('progress-bar: only shown on step 2; displays percent number and viewed counts', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Progress bar should NOT be visible on step 1 (Understand)
  const stickyFooter = page.locator('.draft-bar')
  await expect(stickyFooter).toBeVisible({ timeout: 5_000 })
  await expect(
    stickyFooter.getByRole('progressbar', { name: /review progress/i })
  ).not.toBeVisible()

  // Navigate to step 2 (Inspect) — progress bar should appear
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  const progressBar = stickyFooter.getByRole('progressbar', { name: /review progress/i })
  await expect(progressBar).toBeVisible({ timeout: 5_000 })

  // aria-valuenow must be a number 0–100 (scroll-based)
  const pct = Number(await progressBar.getAttribute('aria-valuenow'))
  expect(pct).toBeGreaterThanOrEqual(0)
  expect(pct).toBeLessThanOrEqual(100)

  // The label text contains a percent number (e.g. "0% · 0/2 viewed")
  const progressText = await stickyFooter.locator('.progress-pct').textContent()
  expect(progressText).toMatch(/\d+%/)
  expect(progressText).toContain('viewed')

  // Wait for file diffs to appear
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 5_000 })

  // Navigate to step 3 (Verdict) — progress bar should disappear
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(
    stickyFooter.getByRole('progressbar', { name: /review progress/i })
  ).not.toBeVisible()

  // The Prev/Next buttons in the footer should use the .btn class (themed)
  const prevBtn = stickyFooter.getByRole('button', { name: /previous step/i })
  const nextBtn = stickyFooter.getByRole('button', { name: /next step/i })
  await expect(prevBtn).toBeVisible()
  await expect(nextBtn).toBeVisible()
  const prevClass = await prevBtn.getAttribute('class')
  expect(prevClass).toContain('btn')
})

// ---------------------------------------------------------------------------
// Test 16: Inline Ask AI — open draft annotation widget, switch to Ask AI tab,
//          ask a question, fixture answer streams in and is visible
// ---------------------------------------------------------------------------

test('inline-ask-ai: seed draft, step 2, switch widget tab to Ask AI, ask streams in', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  // Seed a draft so the annotation panel shows up in step 2
  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript(seedDraftScript(prKey))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect) where the draft annotation appears
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for file diffs to appear
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 5_000 })

  // Wait for file contents to finish loading (expand affordances appear).
  // The diff rebuilds when contents arrive, remounting inline annotations —
  // opening the editor before that would lose the editing state.
  await expect(
    page.locator('button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]').first(),
  ).toBeVisible({ timeout: 10_000 })

  // The seeded draft (line 3 — anchored in the patch) renders INLINE at its
  // line via the extend annotation row (dedupe: anchored drafts no longer
  // appear in the bottom-of-file .draft-annotations list). Select by line:
  // the existing-comment thread at line 2 renders its own inline row.
  const draftAnnotations = page.locator('[data-testid="inline-annotations"][data-line="3"]')
  await expect(draftAnnotations).toBeVisible({ timeout: 5_000 })
  await expect(draftAnnotations).toContainText('Seeded draft for testing')
  // No bottom-of-file fallback block (inline rows carry .inline-annotation)
  await expect(page.locator('.draft-annotations:not(.inline-annotation)')).toHaveCount(0)

  // New action-row UI: No tabs — instead there is a single editor surface
  // with "Leave comment" + "Ask AI" + "Cancel" buttons at the bottom.
  // Tab buttons must NOT be present.
  await expect(draftAnnotations.getByRole('tab', { name: /comment/i })).not.toBeVisible()
  await expect(draftAnnotations.getByRole('tab', { name: /ask ai/i })).not.toBeVisible()

  // The seeded draft starts in view mode — click Edit to open the editor.
  // (await visibility first: the inline row can re-render briefly while the
  // diff finishes building, so a bare isVisible() check is racy)
  const editBtn = draftAnnotations.getByRole('button', { name: /edit/i })
  await expect(editBtn).toBeVisible({ timeout: 5_000 })
  await editBtn.evaluate((el: HTMLButtonElement) => el.click())

  // The "Ask AI" action button should be visible in the action row
  const askAiBtn = draftAnnotations.getByRole('button', { name: /ask ai/i })
  await expect(askAiBtn).toBeVisible({ timeout: 5_000 })

  // The comment body textarea is the single editor surface
  const commentTextarea = draftAnnotations.getByRole('textbox', { name: /comment body/i })
  await expect(commentTextarea).toBeVisible()

  // Type a question into the textarea — include "ask-marker" so the fixture route recognizes it
  await commentTextarea.evaluate((el: HTMLTextAreaElement, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, 'ask-marker: Why is this change needed?')

  // Click Ask AI button via JS to bypass overlay
  await expect(askAiBtn).toBeEnabled()
  await askAiBtn.evaluate((el: HTMLButtonElement) => el.click())

  // The answer should stream in from the fixture
  await expect(
    draftAnnotations.getByText(/This code is in this location/i),
  ).toBeVisible({ timeout: 15_000 })

  // The question should remain visible in the conversation
  await expect(
    draftAnnotations.getByText(/ask-marker: Why is this change needed\?/i),
  ).toBeVisible()

  // Copy button should appear under the answer
  await expect(
    draftAnnotations.getByRole('button', { name: /copy answer/i }),
  ).toBeVisible()
})

// ---------------------------------------------------------------------------
// Test 17: multi-line comment — seeded draft with startLine → submit payload
//          contains start_line + start_side
// ---------------------------------------------------------------------------

/**
 * Seed a multi-line draft directly into IndexedDB (startLine field).
 */
function seedMultilineDraftScript(prKey: string) {
  return `
    (async () => {
      const dbName = 'review123-drafts';
      const storeName = 'drafts';
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const draft = {
          path: 'src/feature.ts',
          line: 4,
          startLine: 3,
          side: 'RIGHT',
          body: 'Multi-line seeded draft',
          prKey: ${JSON.stringify(prKey)},
          n: 0,
          updatedAt: Date.now(),
        };
        const key = ${JSON.stringify(prKey)} + '|src/feature.ts|4|RIGHT|0';
        store.put(draft, key);
      };
    })();
  `
}

test('multi-line draft: submit payload contains start_line and start_side', async ({ page }) => {
  await setupRoutes(page, { withGithubAuth: true })
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(true))

  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript(seedMultilineDraftScript(prKey))

  // Intercept the review POST and capture its body
  let capturedBody: Record<string, unknown> | null = null
  await page.route(`**/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`, async (route) => {
    if (route.request().method() === 'POST') {
      capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
      await route.fulfill({ status: 200, json: { id: 1, state: 'COMMENTED', html_url: 'https://github.com' } })
    } else {
      await route.continue()
    }
  })

  await page.goto(APP_REVIEW_PATH)

  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 3 (VerdictStep)
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  const approveRadio = page.getByRole('radio', { name: /comment/i })
  await expect(approveRadio).toBeVisible({ timeout: 5_000 })
  await approveRadio.click()

  const submitBtn = page.getByRole('button', { name: /submit review/i })
  await expect(submitBtn).toBeVisible()
  await submitBtn.click()

  // Wait for success
  await expect(
    page.getByText('Your review was submitted successfully.'),
  ).toBeVisible({ timeout: 10_000 })

  // Assert the captured payload has start_line and start_side
  expect(capturedBody).not.toBeNull()
  const comments = (capturedBody as { comments: unknown[] }).comments
  expect(comments).toBeDefined()
  expect(comments).toHaveLength(1)
  const comment = comments[0] as Record<string, unknown>
  expect(comment.start_line).toBe(3)
  expect(comment.start_side).toBe('RIGHT')
  expect(comment.line).toBe(4)
})

// ---------------------------------------------------------------------------
// Test 18: suggestion button inserts fence in CommentEditor
// (Unit-level test via the component test suite — here we verify via page render)
// ---------------------------------------------------------------------------

test('suggestion fence: body with suggestion fence survives verbatim through submitReview', async ({ page }) => {
  const suggestionBody = '```suggestion\nconst x = newValue\n```'

  await setupRoutes(page, { withGithubAuth: true })
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(true))

  // Seed a draft with a suggestion body
  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript(`
    (async () => {
      const dbName = 'review123-drafts';
      const storeName = 'drafts';
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.put({
          path: 'src/feature.ts',
          line: 2,
          side: 'RIGHT',
          body: ${JSON.stringify(suggestionBody)},
          prKey: ${JSON.stringify(prKey)},
          n: 0,
          updatedAt: Date.now(),
        }, ${JSON.stringify(prKey)} + '|src/feature.ts|2|RIGHT|0');
      };
    })();
  `)

  let capturedBody: Record<string, unknown> | null = null
  await page.route(`**/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`, async (route) => {
    if (route.request().method() === 'POST') {
      capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
      await route.fulfill({ status: 200, json: { id: 2, state: 'COMMENTED', html_url: 'https://github.com' } })
    } else {
      await route.continue()
    }
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  const commentRadio = page.getByRole('radio', { name: /comment/i })
  await expect(commentRadio).toBeVisible({ timeout: 5_000 })
  await commentRadio.click()

  await page.getByRole('button', { name: /submit review/i }).click()
  await expect(page.getByText('Your review was submitted successfully.')).toBeVisible({ timeout: 10_000 })

  // The suggestion fence must be verbatim in the submitted body
  expect(capturedBody).not.toBeNull()
  const comments = (capturedBody as { comments: unknown[] }).comments
  const comment = comments[0] as Record<string, unknown>
  expect(comment.body).toBe(suggestionBody)
})

// ---------------------------------------------------------------------------
// Test 19: browser back exits revision compare instead of leaving the PR
// ---------------------------------------------------------------------------

test('compare-back: browser back while compare is active exits compare and stays on /review/...', async ({
  page,
}) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Wait for revision picker to appear (commits loaded)
  const fromSelect = page.getByRole('combobox', { name: /from revision/i })
  await expect(fromSelect).toBeVisible({ timeout: 5_000 })

  // Confirm 2 files in full diff before entering compare
  await expect(page.locator('article.file-diff')).toHaveCount(2, { timeout: 5_000 })

  // Select base → first commit and apply
  const toSelect = page.getByRole('combobox', { name: /to revision/i })
  await fromSelect.selectOption({ label: 'PR base' })
  await toSelect.selectOption({ value: COMMIT_1_SHA })

  const compareBtn = page.getByRole('button', { name: /apply revision comparison/i })
  await compareBtn.click()

  // Wait for compare to activate — 1 file (src/feature.ts from makeCompareOneFile)
  await expect(page.locator('article.file-diff')).toHaveCount(1, { timeout: 8_000 })

  // Verify we are in compare mode: URL is still the inspect path
  await expect(page).toHaveURL(APP_REVIEW_INSPECT)

  // Browser BACK — should exit compare, NOT navigate to the landing/homepage.
  // Use waitUntil: 'commit' because a same-URL popstate doesn't trigger a full
  // page load event; 'commit' resolves as soon as the navigation is committed.
  await page.goBack({ waitUntil: 'commit' })

  // After back: full diff is restored (2 files again) — give Svelte time to re-render
  await expect(page.locator('article.file-diff')).toHaveCount(2, { timeout: 8_000 })

  // URL must still be the inspect route (not / or anything else)
  await expect(page).toHaveURL(APP_REVIEW_INSPECT)
})

// ---------------------------------------------------------------------------
// Test 20: browser back from verdict step lands on inspect URL
// ---------------------------------------------------------------------------

test('step-back: browser back from verdict returns to /inspect URL', async ({ page }) => {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (inspect) — URL becomes .../inspect
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page).toHaveURL(APP_REVIEW_INSPECT, { timeout: 3_000 })

  // Navigate to step 3 (verdict) — URL becomes .../verdict
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page).toHaveURL(APP_REVIEW_VERDICT, { timeout: 3_000 })

  // Browser back — should return to /inspect
  await page.goBack({ waitUntil: 'commit' })
  await expect(page).toHaveURL(APP_REVIEW_INSPECT, { timeout: 3_000 })

  // Step 2 content should be visible (diff mode toggle)
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible({ timeout: 5_000 })
})

// ---------------------------------------------------------------------------
// Syntax highlighting: hljs token spans render in unified + split mode, and
// token colors stay readable against add/remove row backgrounds in both the
// light and dark diff themes (diffViewTheme is wired to the app theme).
// ---------------------------------------------------------------------------

// A TypeScript patch with real keywords so lowlight produces hljs-keyword
// tokens on context, removed AND added lines.
const TS_KEYWORD_PATCH = [
  '@@ -1,4 +1,5 @@',
  ' const keep = 1',
  '-export function removed(arg: string) { return arg }',
  '+export function added(arg: number) { return arg * 2 }',
  '+const extra: number = 42',
  ' const tail = 2',
].join('\n')

function makeTsPrFiles() {
  return [
    {
      filename: 'src/typed.ts',
      status: 'modified',
      patch: TS_KEYWORD_PATCH,
      additions: 2,
      deletions: 1,
    },
  ]
}

/**
 * Computes the minimum WCAG contrast ratio between every hljs-keyword token
 * and its effective (alpha-composited) row background inside the first
 * file-diff article. Returns null when no token spans are present.
 */
async function minKeywordContrast(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => {
    const spans = [...document.querySelectorAll('article.file-diff span.hljs-keyword')]
    if (spans.length === 0) return null

    const parseColor = (c: string): number[] => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]
      if (m.length === 3) m.push(1)
      return m
    }
    const luminance = (r: number, g: number, b: number): number => {
      const f = (v: number) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    // Effective background: composite every ancestor backgroundColor (handles
    // the library's semi-transparent add/del row colors in dark mode).
    const effectiveBg = (el: Element): number[] => {
      const stack: number[][] = []
      let cur: Element | null = el
      while (cur) {
        stack.push(parseColor(getComputedStyle(cur).backgroundColor))
        cur = cur.parentElement
      }
      let [r, g, b] = [255, 255, 255]
      for (const [cr, cg, cb, ca] of stack.reverse()) {
        r = cr * ca + r * (1 - ca)
        g = cg * ca + g * (1 - ca)
        b = cb * ca + b * (1 - ca)
      }
      return [r, g, b]
    }

    let min = Infinity
    for (const span of spans) {
      const [fr, fg, fb] = parseColor(getComputedStyle(span).color)
      const [br, bg, bb] = effectiveBg(span)
      const l1 = luminance(fr, fg, fb)
      const l2 = luminance(br, bg, bb)
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      min = Math.min(min, ratio)
    }
    return min
  })
}

test('syntax-highlighting: TS keywords get hljs spans in unified + split (light theme)', async ({
  page,
}, testInfo) => {
  await setupRoutes(page)
  // Override just the files endpoint with a TypeScript fixture — registered
  // after setupRoutes, so Playwright's LIFO route matching picks it first;
  // all other GitHub API calls fall back to the shared dispatcher.
  await page.route('**/api.github.com/**', async (route) => {
    if (new URL(route.request().url()).pathname === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: makeTsPrFiles() })
    }
    return route.fallback()
  })
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_INSPECT)
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  const article = page.locator('article.file-diff').first()
  await expect(article).toBeVisible({ timeout: 5_000 })

  // The diff view wrapper is themed and uses the built-in lowlight engine
  const wrapper = article.locator('.diff-tailwindcss-wrapper')
  await expect(wrapper).toHaveAttribute('data-theme', 'light')
  await expect(wrapper).toHaveAttribute('data-highlighter', 'lowlight')

  // Unified mode: a TS keyword ends up inside an hljs token span
  await expect(
    article.locator('span.hljs-keyword', { hasText: 'export' }).first(),
  ).toBeVisible({ timeout: 5_000 })
  await expect(
    article.locator('span.hljs-keyword', { hasText: 'const' }).first(),
  ).toBeVisible()

  // Token colors must stay readable on add/remove/context row backgrounds
  const unifiedContrast = await minKeywordContrast(page)
  expect(unifiedContrast).not.toBeNull()
  expect(unifiedContrast!).toBeGreaterThan(2.5)

  await testInfo.attach('diff-unified-light', {
    body: await article.screenshot(),
    contentType: 'image/png',
  })

  // Split mode: keyword tokens render too (both sides share the same engine)
  await page.getByRole('button', { name: 'Side-by-side' }).click()
  await expect(page.getByRole('button', { name: 'Side-by-side' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(
    article.locator('span.hljs-keyword', { hasText: 'export' }).first(),
  ).toBeVisible({ timeout: 5_000 })

  const splitContrast = await minKeywordContrast(page)
  expect(splitContrast).not.toBeNull()
  expect(splitContrast!).toBeGreaterThan(2.5)

  await testInfo.attach('diff-split-light', {
    body: await article.screenshot(),
    contentType: 'image/png',
  })
})

test('syntax-highlighting: dark app theme switches the diff to dark tokens, still readable', async ({
  page,
}, testInfo) => {
  await setupRoutes(page)
  await page.route('**/api.github.com/**', async (route) => {
    if (new URL(route.request().url()).pathname === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({ json: makeTsPrFiles() })
    }
    return route.fallback()
  })
  // Seed the app theme to dark — FileDiff resolves it and passes
  // diffViewTheme="dark" to DiffView.
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { ...seedSettings(false), theme: 'dark' })

  await page.goto(APP_REVIEW_INSPECT)
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  const article = page.locator('article.file-diff').first()
  await expect(article).toBeVisible({ timeout: 5_000 })

  // Diff view wrapper follows the app theme
  const wrapper = article.locator('.diff-tailwindcss-wrapper')
  await expect(wrapper).toHaveAttribute('data-theme', 'dark')

  // Keyword tokens render in dark mode too
  await expect(
    article.locator('span.hljs-keyword', { hasText: 'export' }).first(),
  ).toBeVisible({ timeout: 5_000 })

  // Dark token colors must stay readable on the dark add/remove backgrounds
  const darkContrast = await minKeywordContrast(page)
  expect(darkContrast).not.toBeNull()
  expect(darkContrast!).toBeGreaterThan(2.5)

  await testInfo.attach('diff-unified-dark', {
    body: await article.screenshot(),
    contentType: 'image/png',
  })
})

// ---------------------------------------------------------------------------
// AI skeletons — pending AI sections show content-shaped skeletons from the
// first render (no blank gap, no late spinner pop-in), then real content
// replaces them. Uses aiDelayMs to hold all DeepSeek responses back.
// ---------------------------------------------------------------------------

test('ai-skeletons: expanded AI sections show skeletons while pending, content replaces them', async ({
  page,
}) => {
  await setupRoutes(page, { aiDelayMs: 3_000 })
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load — AI run starts now, but all LLM responses are delayed
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Open the page summary + diagrams + tests panels while AI is still pending
  const summaryPanel = page.locator('details.summary-panel')
  await summaryPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })
  const diagramsPanel = page.locator('details.diagrams-panel')
  await diagramsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })
  const testsPanel = page.locator('details.tests-panel')
  await testsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })

  // Skeletons must be visible immediately — content-shaped per section
  await expect(summaryPanel.locator('.ai-panel-loading .skeleton-block')).toBeVisible({ timeout: 2_000 })
  await expect(diagramsPanel.locator('.skeleton-rect')).toBeVisible()
  await expect(testsPanel.locator('.skeleton-card')).toHaveCount(2)

  // The context rail starts with ALL sections collapsed — pending AI state
  // must NOT force any section open, and skeletons stay hidden until expanded.
  const rail = page.locator('aside.context-rail')
  await expect(rail.locator('details.rail-section-details').first()).toBeVisible()
  await expect(rail.locator('details.rail-section-details[open]')).toHaveCount(0)
  await expect(rail.locator('.ai-panel-loading .skeleton-block').first()).toBeHidden()

  // Expanding the rail Summary section reveals its skeleton while pending
  const railSummarySection = rail
    .locator('details.rail-section-details')
    .filter({ has: page.locator('summary', { hasText: 'Full summary' }) })
  await railSummarySection.locator('summary').click()
  await expect(rail.locator('.ai-panel-loading .skeleton-block').first()).toBeVisible()

  // Eventually the real content replaces the skeleton (delayed fixtures resolve)
  await expect(summaryPanel).toContainText('This PR adds a new feature', { timeout: 20_000 })
  await expect(summaryPanel.locator('.ai-panel-loading')).toHaveCount(0)
  await expect(testsPanel.locator('.tests-covered-item')).toHaveCount(2, { timeout: 20_000 })
  await expect(testsPanel.locator('.skeleton-card')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Test 21: instant step navigation — no PR refetch, no loading skeleton
// ---------------------------------------------------------------------------

test('step-nav: 1→2→3→back→forward is instant — no PR refetch, no loading skeleton', async ({
  page,
}) => {
  await setupRoutes(page)

  // Count PR-load fetches (meta + files). Registered AFTER setupRoutes so this
  // handler runs first (Playwright routes are LIFO); fallback() passes the
  // request through to the setupRoutes dispatcher.
  let prLoadFetches = 0
  await page.route('**/api.github.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (
      path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}` ||
      path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`
    ) {
      prLoadFetches++
    }
    await route.fallback()
  })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(false))

  // Track every APPEARANCE of the PR loading skeleton (.pr-loading). The
  // initial page load legitimately shows it; step navigation must never
  // re-show it. A polling check via expect(...).toHaveCount(0) could miss a
  // brief flash, so we observe DOM mutations instead.
  await page.addInitScript(() => {
    const w = window as unknown as { __skeletonAppearances: number }
    w.__skeletonAppearances = 0
    let wasPresent = false
    const check = () => {
      const present = document.querySelector('.pr-loading') !== null
      if (present && !wasPresent) w.__skeletonAppearances++
      wasPresent = present
    }
    new MutationObserver(check).observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  })

  await page.goto(APP_REVIEW_UNDERSTAND)
  const heading = page.getByRole('heading', { name: /Test PR: add feature/i })
  await expect(heading).toBeVisible({ timeout: 10_000 })

  const initialAppearances = await page.evaluate(
    () => (window as unknown as { __skeletonAppearances: number }).__skeletonAppearances,
  )
  expect(prLoadFetches).toBe(2) // 1× meta + 1× files from the initial load

  // Step 1 → 2
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page).toHaveURL(APP_REVIEW_INSPECT)
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Step 2 → 3
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page).toHaveURL(APP_REVIEW_VERDICT)

  // Browser back: verdict → inspect
  await page.goBack({ waitUntil: 'commit' })
  await expect(page).toHaveURL(APP_REVIEW_INSPECT)
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Browser back: inspect → understand
  await page.goBack({ waitUntil: 'commit' })
  await expect(page).toHaveURL(APP_REVIEW_UNDERSTAND)
  await expect(page.locator('.understand-step')).toBeVisible()

  // Browser forward: understand → inspect
  await page.goForward({ waitUntil: 'commit' })
  await expect(page).toHaveURL(APP_REVIEW_INSPECT)
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // The PR title stayed rendered and the skeleton never re-appeared
  await expect(heading).toBeVisible()
  const finalAppearances = await page.evaluate(
    () => (window as unknown as { __skeletonAppearances: number }).__skeletonAppearances,
  )
  expect(finalAppearances).toBe(initialAppearances)

  // And the PR was fetched exactly once — no refetch on any step change
  expect(prLoadFetches).toBe(2)
})

// ---------------------------------------------------------------------------
// Comment threads — grouped inline render + immediate reply post
// ---------------------------------------------------------------------------

test('comment threads: root + reply grouped inline at the line; Reply (posts now) posts via reply API and shows in thread', async ({
  page,
}) => {
  const replyPosts: Array<{ body: string }> = []
  await setupRoutes(page, { onReplyPost: (b) => replyPosts.push(b as { body: string }) })
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(true))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // The thread (root 1001 + reply 1003) renders grouped INLINE at its line
  const inline = page.locator('[data-testid="inline-annotations"]').first()
  await expect(inline).toBeVisible({ timeout: 8_000 })
  await expect(inline).toContainText('This inline comment is on src/feature.ts line 2.')
  await expect(inline).toContainText('Thanks, will fix in the next push.')
  // The reply is visually indented/connected (CommentThread reply styling)
  await expect(inline.locator('.comment-item.reply')).toBeVisible()

  // Dedupe: the anchored thread is NOT repeated in a bottom-of-file list
  await expect(page.locator('.existing-comments')).toHaveCount(0)
  await expect(
    page.getByText('This inline comment is on src/feature.ts line 2.'),
  ).toHaveCount(1)

  // ---- Reply flow: posts immediately via the reply API ----
  await inline.getByRole('button', { name: 'Reply (posts now)' }).click()
  await expect(inline.getByText(/posts immediately to the PR/i)).toBeVisible()
  await inline.getByRole('textbox', { name: /comment body/i }).fill('Replying from e2e')
  await inline.getByRole('button', { name: 'Reply (posts now)' }).click()

  // The intercepted POST went to /pulls/:n/comments/1001/replies with the body
  await expect.poll(() => replyPosts.length, { timeout: 8_000 }).toBe(1)
  expect(replyPosts[0]).toEqual({ body: 'Replying from e2e' })

  // The reply appears in the thread right away (immediate display)
  await expect(inline).toContainText('Replying from e2e', { timeout: 8_000 })
  // Editor closed after successful post
  await expect(inline.getByRole('textbox', { name: /comment body/i })).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Copy as LLM prompt — deterministic export at step 3 (Verdict)
//
// Seeds a draft, navigates to the Verdict step, clicks "Copy as LLM prompt",
// and asserts the clipboard text carries the file:line anchor + the request.
// Clipboard permissions are granted so navigator.clipboard.writeText resolves
// and the value can be read back. No review is submitted by this action.
// ---------------------------------------------------------------------------
test('copy-as-llm-prompt: seed draft, step 3, copy → clipboard has file:line + request', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await setupRoutes(page, { withGithubAuth: true })

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings(true))

  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript(seedDraftScript(prKey))

  await page.goto(APP_REVIEW_PATH)

  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Navigate to step 3 (VerdictStep)
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  // The seeded draft should be recapped
  await expect(page.getByText(/Drafted comments/i)).toBeVisible({ timeout: 5_000 })

  // Click "Copy as LLM prompt"
  const copyBtn = page.getByRole('button', { name: /copy as llm prompt/i })
  await expect(copyBtn).toBeEnabled()
  await copyBtn.click()

  // Transient confirmation appears
  await expect(page.getByText(/copied ✓/i)).toBeVisible({ timeout: 5_000 })

  // The clipboard carries the file:line anchor + the request body
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('src/feature.ts:3')
  expect(clip).toContain('Seeded draft for testing')
  expect(clip).toContain('PR #42')

  // Copying does NOT submit — the verdict form is still present
  await expect(page.getByRole('button', { name: /submit review/i })).toBeVisible()

  // GitHub-only "Copy review command": a split menu button — open it and pick
  // the gh format, which copies a gh api command carrying the same review
  // payload — no submit, no app install.
  const cmdBtn = page.getByRole('button', { name: /copy review command/i })
  await expect(cmdBtn).toBeEnabled()
  await cmdBtn.click()
  await page.getByRole('menuitem', { name: /gh cli/i }).click()
  const cmdClip = await page.evaluate(() => navigator.clipboard.readText())
  expect(cmdClip).toContain('gh api --method POST')
  expect(cmdClip).toContain(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`)
  expect(cmdClip).toContain('Seeded draft for testing')

  // Still not submitted.
  await expect(page.getByRole('button', { name: /submit review/i })).toBeVisible()
})
