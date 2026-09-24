/**
 * e2e/review-phases.spec.ts — the Implementation → Tests review phases on the
 * Inspect step (Files mode).
 *
 * Fixture: a PR mixing implementation files (one high-risk auth file, one small
 * file) with two test files. Asserts:
 *   1. The step opens in the Implementation phase: test files are absent from
 *      the diff list AND the file tree, and the deferred count is stated.
 *   2. "Implementation looks good" records the approval and moves to the Tests
 *      phase, which shows ONLY the test files, framed against the approval.
 *   3. The phase survives a reload (per-PR localStorage).
 *   4. "Re-open implementation" is reversible and puts the impl files back.
 *   5. The quiet override: a fresh PR lets the user preview the Tests phase
 *      before approving, and labels it as a preview.
 *
 * Same GitHub-mocking strategy as guided-review.spec.ts.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 92
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

const SMALL_PATCH = `@@ -1,2 +1,3 @@
 const existing = 1
 const keep = 2
+const added = 3`

const AUTH_PATCH = `@@ -0,0 +1,4 @@
+export function issueToken(user: string): string {
+  const secret = deriveSecret(user)
+  return sign(user, secret)
+}`

const TEST_PATCH = `@@ -1,2 +1,3 @@
 it('works', () => {
   expect(1).toBe(1)
+  expect(2).toBe(2)
 })`

async function setupRoutes(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Review phases test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 4,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          { filename: 'src/app.ts', status: 'modified', patch: SMALL_PATCH, additions: 1, deletions: 0 },
          // Test files interleaved so the split is a real partition, not a suffix.
          { filename: 'src/app.test.ts', status: 'modified', patch: TEST_PATCH, additions: 1, deletions: 0 },
          { filename: 'src/auth/core.ts', status: 'added', patch: AUTH_PATCH, additions: 400, deletions: 0 },
          { filename: 'src/auth/core.spec.ts', status: 'added', patch: TEST_PATCH, additions: 1, deletions: 0 },
        ],
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    return route.fulfill({ status: 404, json: { message: 'Not Found' } })
  })

  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })
}

/** Open the PR and land on step 2 (Inspect). */
async function gotoInspect(page: import('@playwright/test').Page) {
  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Review phases test PR/i })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
}

const fileNames = (page: import('@playwright/test').Page) =>
  page.locator('article.file-diff header code')

test('inspect: Implementation defers tests, approval unlocks the Tests phase, and it survives a reload', async ({ page }) => {
  await setupRoutes(page)
  await gotoInspect(page)

  // --- 1. Implementation phase is the default ----------------------------
  const phaseGroup = page.getByRole('group', { name: 'Review phase' })
  await expect(phaseGroup).toBeVisible()
  await expect(page.getByTestId('phase-btn-implementation')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'false')

  // Only the two implementation files render — the tests are gone from the list…
  await expect(page.locator('article.file-diff')).toHaveCount(2)
  await expect(fileNames(page)).toHaveText(['src/app.ts', 'src/auth/core.ts'])

  // …and the reviewer is told exactly where they went.
  await expect(page.getByTestId('phase-deferred-note')).toContainText(
    '2 test files — reviewed in the Tests phase',
  )

  // …and they are gone from the file tree too (no dead click targets).
  await page.getByRole('button', { name: 'Open file tree' }).click()
  const tree = page.locator('.file-tree-nav')
  await expect(tree).toBeVisible()
  await expect(tree).toContainText('app.ts')
  await expect(tree.getByText('app.test.ts')).toHaveCount(0)
  await expect(tree.getByText('core.spec.ts')).toHaveCount(0)
  await page.locator('button.tree-drawer-close').click()

  // The Tests tab reads as not-yet-unlocked until the user acts.
  await expect(page.getByTestId('phase-btn-tests')).toContainText('🔒')

  // --- 2. Approve → the Tests phase ---------------------------------------
  await page.getByTestId('phase-approve').click()

  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('article.file-diff')).toHaveCount(2)
  await expect(fileNames(page)).toHaveText(['src/app.test.ts', 'src/auth/core.spec.ts'])

  // Framed against the approval, and pinned to the head sha it was made on.
  await expect(page.getByTestId('phase-tests-lead')).toContainText(
    'against the implementation you approved at abc1234',
  )
  await expect(page.getByTestId('phase-tests-deferred-note')).toContainText(
    '2 implementation files hidden here',
  )
  await expect(page.getByTestId('phase-btn-tests')).not.toContainText('🔒')

  // --- 3. The phase survives a reload -------------------------------------
  // (The app restores the last-visited step, so jump to Inspect via the stepper.)
  await page.reload()
  await expect(page.getByRole('heading', { name: /Review phases test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '2 · Inspect' }).click()

  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')
  await expect(fileNames(page)).toHaveText(['src/app.test.ts', 'src/auth/core.spec.ts'])
  await expect(page.getByTestId('phase-tests-lead')).toContainText('you approved at abc1234')

  // --- 4. Re-open is reversible -------------------------------------------
  await page.getByTestId('phase-reopen').click()
  await expect(page.getByTestId('phase-btn-implementation')).toHaveAttribute('aria-pressed', 'true')
  await expect(fileNames(page)).toHaveText(['src/app.ts', 'src/auth/core.ts'])
  // The approval is withdrawn, so the Tests tab is locked again.
  await expect(page.getByTestId('phase-btn-tests')).toContainText('🔒')
})

test('inspect: the Tests phase is previewable before approval, and says so', async ({ page }) => {
  await setupRoutes(page)
  await gotoInspect(page)

  // The quiet override: clicking Tests works even with no approval on record.
  await page.getByTestId('phase-btn-tests').click()

  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')
  await expect(fileNames(page)).toHaveText(['src/app.test.ts', 'src/auth/core.spec.ts'])

  // It is labelled honestly as a preview — no approval was invented.
  await expect(page.getByTestId('phase-tests-lead')).toContainText(
    "Previewing the tests — the implementation isn't approved yet.",
  )
  await expect(page.getByTestId('phase-btn-tests')).toContainText('🔒')

  // Going back to Implementation still offers the un-taken approval action.
  await page.getByTestId('phase-btn-implementation').click()
  await expect(page.getByTestId('phase-approve')).toHaveText('Implementation looks good')
  await expect(page.getByTestId('phase-approved-note')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// The reviewer passes across the two phases (#237)
//
// The automatic reviewer run is SCOPED to the implementation, and the tests get
// their own on-demand, agentic pass. This exercises the whole arc end to end:
// what the automatic run actually SENDS, the action's honest cost framing, and
// where the tests-pass findings land.
// ---------------------------------------------------------------------------

/** The implementation-pass finding — anchored on an implementation file. */
const IMPL_FINDING = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/auth/core.ts',
      line: 2,
      severity: 'high',
      body: 'IMPL FINDING: deriveSecret is unsalted, so tokens are forgeable.',
      suggestedFix: 'Salt the secret with a per-user value.',
    },
  ],
}

/** The tests-pass finding — anchored on a TEST file, so it files into the Tests phase. */
const TESTS_FINDING = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/app.test.ts',
      line: 3,
      severity: 'medium',
      body: 'TESTS FINDING: this assertion passes whatever the implementation does.',
      suggestedFix: 'Assert on the value issueToken actually returns.',
    },
  ],
}

function jsonCompletion(payload: unknown) {
  return {
    status: 200,
    json: {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [
        { message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop', index: 0 },
      ],
    },
  }
}

/** One recorded reviewer LLM call: which pass it was, and what context it saw. */
interface ReviewerCall {
  pass: 'implementation' | 'tests'
  user: string
}

/**
 * Routes with a WORKING AI stub + one seeded reviewer skill. Returns the live
 * list of reviewer calls so a test can assert what each pass actually sent.
 */
async function setupAiRoutes(page: import('@playwright/test').Page): Promise<ReviewerCall[]> {
  const reviewerCalls: ReviewerCall[] = []

  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Review phases test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 4,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          { filename: 'src/app.ts', status: 'modified', patch: SMALL_PATCH, additions: 1, deletions: 0 },
          { filename: 'src/app.test.ts', status: 'modified', patch: TEST_PATCH, additions: 1, deletions: 0 },
          { filename: 'src/auth/core.ts', status: 'added', patch: AUTH_PATCH, additions: 400, deletions: 0 },
          { filename: 'src/auth/core.spec.ts', status: 'added', patch: TEST_PATCH, additions: 1, deletions: 0 },
        ],
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    return route.fulfill({ json: [] })
  })

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body
    }

    // Streaming tasks (summary): a minimal SSE response.
    if (body?.stream === true) {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body:
          'data: ' +
          JSON.stringify({ choices: [{ delta: { content: 'A summary.' } }] }) +
          '\n\ndata: [DONE]\n',
      })
    }

    const system = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    const user = body?.messages?.find((m) => m.role === 'user')?.content ?? ''

    // Follow-up passes first — their prompts also mention reviewers.
    if (system.includes('consolidating overlapping code-review findings')) {
      return route.fulfill(jsonCompletion({ clusters: [] }))
    }
    if (system.includes('rewriting code-review findings into plain')) {
      return route.fulfill(jsonCompletion({ rewrites: [] }))
    }

    // The TESTS pass must be matched BEFORE the generic persona branch — its
    // prompt is also a persona prompt.
    if (system.includes('reviewing the tests of this pull request')) {
      reviewerCalls.push({ pass: 'tests', user })
      return route.fulfill(jsonCompletion(TESTS_FINDING))
    }
    if (system.includes('reviewer persona')) {
      reviewerCalls.push({ pass: 'implementation', user })
      return route.fulfill(jsonCompletion(IMPL_FINDING))
    }

    // Everything else (verdict, tests insight, alternatives, …).
    return route.fulfill(
      jsonCompletion({ level: 'minor-changes', evidence: ['src/auth/core.ts added'], notAnalyzed: [] }),
    )
  })

  await page.addInitScript(
    (seed) => {
      localStorage.setItem('review123:settings', JSON.stringify(seed.settings))
      localStorage.setItem('review123:reviewer-skills', JSON.stringify(seed.skills))
    },
    {
      settings: {
        deepseekKey: 'sk-test-deepseek-key',
        aiProvider: 'deepseek',
        diffMode: 'unified',
        railCollapsed: true,
        focusMode: 'off',
        // Phases are a Files-mode concept; Story mode is a walkthrough of the
        // WHOLE change and deliberately does not apply them. With a key present
        // the story task becomes available and Story is the default flow, so
        // pin Files mode explicitly.
        storyMode: false,
        // The automatic implementation pass is the behaviour under test.
        autoRunReviewers: true,
      },
      skills: [
        {
          id: 'skill-e2e-phase',
          name: 'Security Reviewer',
          content: '## Security\nCheck for XSS and injection vulnerabilities.',
          enabled: true,
          addedAt: 1700000000000,
        },
      ],
    },
  )

  return reviewerCalls
}

test('inspect: the automatic run reviews the implementation only, and the tests get their own on-demand pass', async ({ page }) => {
  const reviewerCalls = await setupAiRoutes(page)
  await gotoInspect(page)

  // --- 1. The AUTOMATIC pass is scoped to the implementation ---------------
  await expect(page.getByText(/IMPL FINDING: deriveSecret is unsalted/)).toBeVisible({ timeout: 15_000 })

  const implCalls = reviewerCalls.filter((c) => c.pass === 'implementation')
  expect(implCalls.length).toBeGreaterThan(0)
  // It saw the implementation…
  expect(implCalls[0].user).toContain('src/auth/core.ts')
  expect(implCalls[0].user).toContain('issueToken')
  // …and NOT the tests. This is the cost/timeout win: smaller context.
  expect(implCalls[0].user).not.toContain('src/app.test.ts')
  expect(implCalls[0].user).not.toContain('src/auth/core.spec.ts')

  // Nothing fired the tests pass on its own.
  expect(reviewerCalls.filter((c) => c.pass === 'tests')).toHaveLength(0)

  // The Tests phase is not even offering the action yet — we are on
  // Implementation, where that pass already ran.
  await expect(page.getByTestId('tests-review-run')).toHaveCount(0)

  // --- 2. Approve → the Tests phase offers the on-demand pass -------------
  await page.getByTestId('phase-approve').click()
  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')

  // The implementation finding is deferred to its own phase, not lost.
  await expect(page.getByText(/IMPL FINDING: deriveSecret is unsalted/)).toHaveCount(0)

  const runTests = page.getByTestId('tests-review-run')
  await expect(runTests).toBeVisible()
  await expect(runTests).toHaveText(/Review the tests/)
  // The cost is stated BEFORE the click — this is the expensive pass.
  await expect(page.getByTestId('tests-review-hint')).toContainText('1 reviewer · agentic · runs on demand')

  // --- 3. Click it → the tests findings land in the Tests phase ------------
  await runTests.click()
  await expect(page.getByText(/TESTS FINDING: this assertion passes whatever/)).toBeVisible({
    timeout: 15_000,
  })

  const testsCalls = reviewerCalls.filter((c) => c.pass === 'tests')
  expect(testsCalls).toHaveLength(1)
  // It reads the tests AND the implementation they exercise.
  expect(testsCalls[0].user).toContain('src/app.test.ts')
  expect(testsCalls[0].user).toContain('src/auth/core.ts')

  // The status bar shows the pass, tagged so the two runs are distinguishable.
  await expect(page.locator('.skill-pass-tag')).toHaveCount(1)

  // --- 4. Back on Implementation, that pass's finding is still there -------
  await page.getByTestId('phase-btn-implementation').click()
  await expect(page.getByText(/IMPL FINDING: deriveSecret is unsalted/)).toBeVisible()
  await expect(page.getByText(/TESTS FINDING: this assertion passes whatever/)).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Two fixes to the phase flow:
//
//  1. The Tests phase stops burying its own test files. "tests only" is a
//     DEFERRAL — "read this later, in the Tests phase" — so it must stop firing
//     once the reviewer is standing in that phase, or the entire list collapses
//     into one "N low-attention files — skim or mark all viewed" row.
//  2. The Implementation|Tests switch is reachable from the bottom of the list,
//     so changing phase never costs a scroll back to the top.
// ---------------------------------------------------------------------------

test('inspect: the Tests phase never buries its own test files in the low-attention tail', async ({ page }) => {
  await setupRoutes(page)
  await gotoInspect(page)

  // The low-attention tail only exists under Risk first.
  await page.getByRole('group', { name: 'File order' }).getByRole('button', { name: 'Risk first' }).click()

  // Implementation phase: the deferral rule is intact — the test files are
  // absent from this list entirely, and both implementation files are novel.
  await expect(page.locator('details.attention-tail')).toHaveCount(0)
  await expect(fileNames(page)).toHaveText(['src/auth/core.ts', 'src/app.ts'])

  await page.getByTestId('phase-btn-tests').click()

  // THE FIX: the reviewer came here to read these, so they ARE the list — not
  // one collapsed row, and not an empty tail either.
  await expect(page.locator('details.attention-tail')).toHaveCount(0)
  await expect(page.locator('article.file-diff')).toHaveCount(2)
  await expect(fileNames(page)).toHaveText(['src/app.test.ts', 'src/auth/core.spec.ts'])
})

test('inspect: the phase switch is reachable from the list bottom, without scrolling back up', async ({ page }) => {
  // A short viewport guarantees the top phase bar really does leave the screen.
  await page.setViewportSize({ width: 900, height: 400 })
  await setupRoutes(page)
  await gotoInspect(page)

  const dock = page.getByTestId('phase-dock')
  await expect(dock).toBeVisible()

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

  // The top control is out of reach now — exactly the moment the dock exists
  // for — and the dock is on screen.
  await expect(page.getByTestId('phase-bar')).not.toBeInViewport()
  await expect(dock).toBeInViewport()

  // It states which phase you are in, not merely that a switch exists…
  await expect(page.getByTestId('phase-dock-implementation')).toHaveAttribute('aria-pressed', 'true')
  // …and carries the same preview signal as the top switch: no quiet skip.
  await expect(page.getByTestId('phase-dock-tests')).toContainText('🔒')

  await page.getByTestId('phase-dock-tests').click()

  // One state, two controls: the top switch followed, and the list changed.
  await expect(page.getByTestId('phase-dock-tests')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')
  await expect(fileNames(page)).toHaveText(['src/app.test.ts', 'src/auth/core.spec.ts'])
})

test('inspect: the phase dock stays usable at a narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 640 })
  await setupRoutes(page)
  await gotoInspect(page)

  const dock = page.getByTestId('phase-dock')
  await expect(dock).toBeVisible()

  // The pill has not overflowed the viewport at phone width.
  const overflows = await dock.evaluate((el) => {
    const pill = el.querySelector('[role="group"]') as HTMLElement
    return pill.getBoundingClientRect().width > document.documentElement.clientWidth
  })
  expect(overflows).toBe(false)

  await page.getByTestId('phase-dock-tests').click()
  await expect(page.getByTestId('phase-btn-tests')).toHaveAttribute('aria-pressed', 'true')
})
