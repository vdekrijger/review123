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
const APP_REVIEW_PATH = `/review/${OWNER}/${REPO}/${PR_NUMBER}`

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

// v4 contract: GRAPH_RESULT includes changeMap with status fields
const GRAPH_RESULT = {
  kind: 'flow',
  before: { nodes: [{ id: 'a', label: 'Utils' }], edges: [] },
  after: {
    nodes: [
      { id: 'a', label: 'Utils' },
      { id: 'b', label: 'Feature' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  },
  changeMap: {
    nodes: [
      { id: 'a', label: 'Utils', status: 'unchanged' },
      { id: 'b', label: 'Feature', status: 'added' },
    ],
    edges: [
      { from: 'a', to: 'b', status: 'added' },
    ],
  },
}

const VERDICT_RESULT = {
  level: 'minor-changes',
  evidence: ['src/feature.ts modified with 2 additions'],
  notAnalyzed: [],
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

// v4 contract: CoachResult with one review containing a suggestion
const COACH_RESULT = {
  reviews: [
    {
      index: 0,
      clarity: 3,
      actionable: true,
      tone: 'blunt',
      biasQuestion: null,
      suggestion: 'Consider rephrasing this as a question to encourage discussion.',
    },
  ],
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
  opts: { withGithubAuth?: boolean; withResolvedThreads?: boolean } = {},
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

    if (systemContent.includes('hotspot') || systemContent.includes('readingorder')) {
      result = ATTENTION_RESULT
    } else if (systemContent.includes('graphresult') || systemContent.includes('mermaid')) {
      result = GRAPH_RESULT
    } else if (systemContent.includes('covered') || systemContent.includes('gaps')) {
      // testInsightPrompt system content mentions "covered" and "gaps" fields
      result = TEST_INSIGHT_RESULT
    } else if (systemContent.includes('reviews') && systemContent.includes('clarity')) {
      // coachPrompt system content mentions "reviews" and "clarity" fields
      result = COACH_RESULT
    } else if (systemContent.includes('alternative-is-better') || (systemContent.includes('alternatives') && systemContent.includes('approaches'))) {
      // alternativesPrompt system content mentions "alternative-is-better" enum value and "alternatives"/"approaches"
      result = ALTERNATIVES_RESULT
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
  await page.getByRole('button', { name: 'Review' }).click()

  // Should navigate to the review route
  await expect(page).toHaveURL(APP_REVIEW_PATH)

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
  const prDescDetails = page.locator('details.pr-description-details')
  await prDescDetails.evaluate((el: HTMLDetailsElement) => { el.open = true })
  await expect(page.getByText('This PR adds a new feature for testing.')).toBeVisible()

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

  // Wait for AI attention to populate (hotspot buttons appear in the rail)
  const hotspotBtn = page.locator('.hotspot-btn').first()
  await expect(hotspotBtn).toBeVisible({ timeout: 15_000 })

  // Click hotspot — should jump to step 2
  await hotspotBtn.click()
  // After hotspot click, we should be in step 2 (diff mode toggle visible)
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible({ timeout: 3_000 })
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

  // Seed a draft into IndexedDB — the prKey is constructed from owner/repo/number@headSha
  // We seed before the page loads so the store picks it up on load()
  const prKey = `${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript(seedDraftScript(prKey))

  await page.goto(APP_REVIEW_PATH)

  // Wait for PR to load
  await expect(
    page.getByRole('heading', { name: /Test PR: add feature/i }),
  ).toBeVisible({ timeout: 10_000 })

  // Draft bar: the status region should eventually show draft count
  // The seeded draft should show "1 comment drafted"
  const draftStatus = page.getByRole('status')
  await expect(draftStatus).toContainText(/1 comment/i, { timeout: 5_000 })

  // --- Step 3: VerdictStep should show sign-in prompt when no auth ---
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()

  // VerdictStep renders a sign-in prompt / PAT prompt when signed out (EC-09c / EC-19b)
  await expect(page.getByText(/sign in|add a.*pat|authentication required/i)).toBeVisible({ timeout: 5_000 })

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
  await expect(page.locator('.tests-covered-item')).toHaveCount(2)

  // Gap rows should also be visible (1 gap)
  await expect(page.locator('.tests-gap-item')).toHaveCount(1)
})

// ---------------------------------------------------------------------------
// Test 6: change-map — diagrams panel shows legend chips (D1 / v4 contract)
// ---------------------------------------------------------------------------

test('change-map: diagrams panel shows Added/Removed/Changed/Unchanged legend chips', async ({
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

  // Open the diagrams detail panel inside UnderstandStep
  const diagramsPanel = page.locator('details').filter({ hasText: 'Diagrams' }).first()
  await diagramsPanel.evaluate((el: HTMLDetailsElement) => { el.open = true })

  // Wait for the change-map to render — the legend should appear
  // The change-map legend is rendered when result.changeMap is present (D1)
  // Use .first() to avoid strict-mode violation if multiple DiagramPanel instances exist
  const legend = page.locator('[aria-label="Change map legend"]').first()
  await expect(legend).toBeVisible({ timeout: 20_000 })

  // All four legend chips must be present
  await expect(legend.locator('.legend-chip.legend-added')).toContainText('Added')
  await expect(legend.locator('.legend-chip.legend-removed')).toContainText('Removed')
  await expect(legend.locator('.legend-chip.legend-changed')).toContainText('Changed')
  await expect(legend.locator('.legend-chip.legend-unchanged')).toContainText('Unchanged')
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

  // Navigate back to step 2
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(fileDiffs.first()).toBeVisible({ timeout: 5_000 })

  // After reload, first article should still be collapsed (persisted in localStorage)
  await expect(fileDiffs.first()).toHaveClass(/is-collapsed/, { timeout: 3_000 })

  // The sticky bar should show "viewed 1/2"
  const draftStatus = page.getByRole('status')
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
  const prKey = `${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
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

  // Problem statement should be visible
  await expect(
    page.getByText(/The PR introduces a global singleton cache/i),
  ).toBeVisible({ timeout: 5_000 })

  // Both alternative cards should be visible
  await expect(page.locator('.alternative-card')).toHaveCount(2)

  // The "alternative-is-better" chip should show "Worth considering"
  await expect(
    page.locator('.assessment-chip.assessment-alternative-is-better'),
  ).toContainText('Worth considering')

  // The "comparable" chip should show "Comparable"
  await expect(
    page.locator('.assessment-chip.assessment-comparable'),
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
// Test 12: Ask AI — open rail → type question → answer streams in →
//          second question retains first in view
// ---------------------------------------------------------------------------

test('ask-ai: open rail, type question, answer streams in; second question retains first in view', async ({
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

  // Open the Ask AI section (it is inside a <details> element)
  const askSection = rail.locator('details.ask-ai-section')
  await expect(askSection).toBeVisible({ timeout: 5_000 })
  await askSection.evaluate((el: HTMLDetailsElement) => { el.open = true })

  // Find the textarea and type a question with "ask-marker" so the DeepSeek fixture
  // route recognizes it as an Ask AI request
  const textarea = askSection.getByRole('textbox')
  await expect(textarea).toBeVisible()
  await textarea.fill('ask-marker: Why is this coded here?')

  // Submit with the Ask button — use JS click to bypass the draft-bar overlay
  const askBtn = askSection.getByRole('button', { name: /ask/i })
  await expect(askBtn).toBeEnabled()
  await askBtn.evaluate((el: HTMLButtonElement) => el.click())

  // The answer should stream in
  await expect(
    askSection.getByText(/This code is in this location/i),
  ).toBeVisible({ timeout: 15_000 })

  // First question should still be visible in the conversation
  await expect(
    askSection.getByText(/ask-marker: Why is this coded here\?/i),
  ).toBeVisible()

  // Second question — verify history retained from first
  await textarea.fill('ask-marker second-ask: What about the tests?')
  await askBtn.evaluate((el: HTMLButtonElement) => el.click())

  // Second answer should appear
  await expect(
    askSection.getByText(/second answer confirms context was retained/i),
  ).toBeVisible({ timeout: 15_000 })

  // Both questions should remain visible in the conversation
  await expect(
    askSection.getByText(/ask-marker: Why is this coded here\?/i),
  ).toBeVisible()
  await expect(
    askSection.getByText(/This code is in this location/i),
  ).toBeVisible()
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
  // Both should appear as buttons in the file tree
  const fileButtons = treeNav.getByRole('button')
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

test('progress-bar: visible when PR loaded; percent increases after marking file viewed', async ({
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

  // Progress bar should be visible (role=progressbar)
  const progressBar = page.getByRole('progressbar', { name: /review progress/i })
  await expect(progressBar).toBeVisible({ timeout: 5_000 })

  // At step 1 with 0 files viewed → 0%
  const initialPercent = Number(await progressBar.getAttribute('aria-valuenow'))
  expect(initialPercent).toBe(0)

  // Navigate to step 2 (Inspect) — progress should jump to 15%
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  const step2Percent = Number(await progressBar.getAttribute('aria-valuenow'))
  expect(step2Percent).toBe(15)

  // Wait for file diffs to appear
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 5_000 })

  // Mark the first file as viewed
  const firstViewedCheckbox = page.locator('input.viewed-checkbox').first()
  await expect(firstViewedCheckbox).toBeVisible()
  await firstViewedCheckbox.evaluate((el: HTMLInputElement) => {
    el.checked = true
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })

  // After marking 1 of 2 files viewed → 15 + 70*(1/2) = 50%
  await expect(async () => {
    const pct = Number(await progressBar.getAttribute('aria-valuenow'))
    expect(pct).toBeGreaterThan(step2Percent)
  }).toPass({ timeout: 5_000 })
})
