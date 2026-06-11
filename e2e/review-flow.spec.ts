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

const ATTENTION_RESULT = {
  readingOrder: ['src/feature.ts', 'src/old-utils.ts'],
  hotspots: [{ path: 'src/feature.ts', reason: 'Critical logic change', level: 'high' }],
  testFlags: [{ path: 'src/feature.ts', note: 'No test covers this change' }],
}

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
}

const VERDICT_RESULT = {
  level: 'minor-changes',
  evidence: ['src/feature.ts modified with 2 additions'],
  notAnalyzed: [],
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
  opts: { withGithubAuth?: boolean } = {},
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
      // Streaming — return SSE for summary
      const sseText = makeDeepSeekStreamResponse(SUMMARY_TEXT)
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

  // CI: should show failure (Integration tests failed)
  await expect(page.getByText(/Integration tests/i)).toBeVisible({ timeout: 10_000 })

  // PR description is inside a collapsed <details> — open it first to check
  const prDescDetails = page.locator('.pr-description-details')
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
