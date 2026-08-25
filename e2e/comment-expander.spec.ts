/**
 * e2e/comment-expander.spec.ts — terse-note expander in the inline composer.
 *
 * Flow under test (stubbed LLM): open the inline draft widget → type a terse
 * note → click Expand → the stubbed expansion streams into the PREVIEW panel →
 * Use → the composer holds the expanded text (still editable) → Leave comment
 * → the saved draft body IS the expanded text.
 *
 * Also covered: Keep my note leaves the composer untouched.
 *
 * All network calls to api.github.com and api.deepseek.com are intercepted via
 * page.route() — no real network, deterministic. PostHog is blocked. The
 * streaming dispatch keys on the expand prompt's stable marker phrase
 * ("expanding a reviewer's terse note" — see expandCommentPrompt in
 * src/lib/ai/tasks.ts), the same pattern the simplify/convergence stubs use.
 *
 * Draft seeding note: as in review-flow.spec.ts, the composer is opened by
 * seeding a draft into IndexedDB and clicking its Edit button (triggering the
 * virtualized DiffView "+" widget is unreliable in headless Chrome).
 */

import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

const SUMMARY_TEXT =
  'This PR adds a new feature.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

/** The stubbed LLM's expanded comment — asserted end-to-end into the draft. */
const EXPANDED_TEXT =
  'This block is doing too much at once — extract the parsing into a named helper so the intent is readable at a glance.'

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makePrMeta() {
  return {
    title: 'Test PR: add feature',
    state: 'open',
    merged: false,
    body: 'This PR adds a new feature for testing.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 1,
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
  ]
}

function makeFileContent(text: string) {
  const b64 = Buffer.from(text).toString('base64')
  return { content: b64 + '\n', encoding: 'base64' }
}

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

function seedSettings() {
  return {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
    // Classic FILES flow at step 2 (same rationale as review-flow.spec.ts).
    storyMode: false,
  }
}

/** Seed one draft into IndexedDB so the inline widget appears at line 3. */
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
          n: 0,
          updatedAt: Date.now(),
        };
        const key = ${JSON.stringify(prKey)} + '|src/feature.ts|3|RIGHT|0';
        store.put(draft, key);
      };
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

  // ---- GitHub API ---------------------------------------------------------
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
        // One line beyond the hunk so the contents-loaded signal (an Expand
        // Up/Down/All affordance) actually renders — same as review-flow's fixture.
        return route.fulfill({
          json: makeFileContent(
            'const old = 1\nunchanged line\nadded line\nanother added line\ntrailing context',
          ),
        })
      }
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    if (path === '/graphql' && route.request().method() === 'POST') {
      return route.fulfill({
        json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
      })
    }
    return route.fulfill({ json: {} })
  })

  // ---- DeepSeek API — dispatch by request body ----------------------------
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      // non-JSON body — treat as non-streaming
    }

    const systemContent = body?.messages?.find((m) => m.role === 'system')?.content ?? ''
    const systemLower = systemContent.toLowerCase()

    if (body?.stream === true) {
      // Expand requests carry the expandCommentPrompt marker phrase.
      if (systemLower.includes("expanding a reviewer's terse note")) {
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          body: makeDeepSeekStreamResponse(EXPANDED_TEXT),
        })
      }
      // Everything else streamed (summary / ask) gets the summary fixture.
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: makeDeepSeekStreamResponse(SUMMARY_TEXT),
      })
    }

    // JSON mode — same dispatch shape as review-flow.spec.ts, minimal fixtures.
    let result: unknown
    if (systemLower.includes('consolidating overlapping code-review findings')) {
      result = { clusters: [] }
    } else if (systemLower.includes('rewriting code-review findings into plain')) {
      result = { rewrites: [] }
    } else if (systemLower.includes('hotspot') || systemLower.includes('readingorder')) {
      result = { readingOrder: ['src/feature.ts'], hotspots: [], testFlags: [] }
    } else if (systemLower.includes('execution path') || systemLower.includes('mermaid')) {
      result = {
        kind: 'flow',
        before: { nodes: [], edges: [] },
        after: { nodes: [], edges: [] },
        impact: { changed: [], callers: [], callees: [] },
      }
    } else if (systemLower.includes('covered') || systemLower.includes('gaps')) {
      result = { covered: [], gaps: [] }
    } else if (systemLower.includes('reviews') && systemLower.includes('clarity')) {
      result = { reviews: [] }
    } else if (
      systemLower.includes('alternative-is-better') ||
      (systemLower.includes('alternatives') && systemLower.includes('approaches'))
    ) {
      result = { problem: 'None.', alternatives: [] }
    } else if (systemLower.includes('change-risk assessor')) {
      result = { score: 0, rationale: 'Trivial fixture change.', snippets: [] }
    } else {
      result = { level: 'lgtm', evidence: [], notAnalyzed: [] }
    }

    return route.fulfill({
      status: 200,
      json: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [
          { message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop', index: 0 },
        ],
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Shared helper: load the PR, go to step 2, open the seeded draft's editor
// ---------------------------------------------------------------------------

async function openComposerWithNote(page: import('@playwright/test').Page, note: string) {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())

  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript(seedDraftScript(prKey))

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })

  // Step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await expect(page.locator('article.file-diff').first()).toBeVisible({ timeout: 5_000 })

  // Wait for file contents (diff rebuild remounts inline annotations —
  // opening the editor before that would lose editing state).
  await expect(
    page
      .locator('button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]')
      .first(),
  ).toBeVisible({ timeout: 10_000 })

  const draftAnnotations = page.locator('[data-testid="inline-annotations"][data-line="3"]')
  await expect(draftAnnotations).toBeVisible({ timeout: 5_000 })

  // Open the editor on the seeded draft
  const editBtn = draftAnnotations.getByRole('button', { name: /edit/i })
  await expect(editBtn).toBeVisible({ timeout: 5_000 })
  await editBtn.evaluate((el: HTMLButtonElement) => el.click())

  const commentTextarea = draftAnnotations.getByRole('textbox', { name: /comment body/i })
  await expect(commentTextarea).toBeVisible()

  // Type the terse note (replace the seeded body)
  await commentTextarea.evaluate((el: HTMLTextAreaElement, v) => {
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, note)

  return { draftAnnotations, commentTextarea }
}

// ---------------------------------------------------------------------------
// Test 1: the full happy path — note → Expand → preview → Use → Save
// ---------------------------------------------------------------------------

test('expander: type note → Expand → preview → Use → Save → draft body is the expanded text', async ({
  page,
}) => {
  const { draftAnnotations, commentTextarea } = await openComposerWithNote(
    page,
    'too clever, simplify',
  )

  // The Expand button appears once the composer has text
  const expandBtn = draftAnnotations.getByTestId('expand-btn')
  await expect(expandBtn).toBeVisible()
  await expect(expandBtn).toBeEnabled()
  await expandBtn.evaluate((el: HTMLButtonElement) => el.click())

  // Preview: the stubbed expansion streams in, then renders with Use / Keep my note
  const previewBody = draftAnnotations.getByTestId('expand-preview-body')
  await expect(previewBody).toBeVisible({ timeout: 15_000 })
  await expect(previewBody).toContainText('extract the parsing into a named helper')

  // The composer still holds the terse note (nothing replaced yet)
  await expect(commentTextarea).toHaveValue('too clever, simplify')

  // Use → the expanded text lands in the (still editable) composer
  await draftAnnotations.getByTestId('expand-use').evaluate((el: HTMLButtonElement) => el.click())
  await expect(commentTextarea).toHaveValue(EXPANDED_TEXT)
  await expect(draftAnnotations.getByTestId('expand-preview-body')).not.toBeVisible()

  // Save → the draft body IS the expanded text (view mode renders it)
  await draftAnnotations
    .getByRole('button', { name: /leave comment/i })
    .evaluate((el: HTMLButtonElement) => el.click())
  await expect(draftAnnotations.locator('.draft-body')).toContainText(
    'extract the parsing into a named helper',
  )
})

// ---------------------------------------------------------------------------
// Test 2: Keep my note leaves the composer untouched
// ---------------------------------------------------------------------------

test('expander: Keep my note dismisses the preview and preserves the terse note', async ({
  page,
}) => {
  const { draftAnnotations, commentTextarea } = await openComposerWithNote(
    page,
    'too clever, simplify',
  )

  await draftAnnotations.getByTestId('expand-btn').evaluate((el: HTMLButtonElement) => el.click())
  await expect(draftAnnotations.getByTestId('expand-preview-body')).toBeVisible({ timeout: 15_000 })

  await draftAnnotations.getByTestId('expand-keep').evaluate((el: HTMLButtonElement) => el.click())

  await expect(draftAnnotations.getByTestId('expand-preview-body')).not.toBeVisible()
  await expect(commentTextarea).toHaveValue('too clever, simplify')
})
