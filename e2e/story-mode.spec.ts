/**
 * e2e/story-mode.spec.ts — guided narrative walkthrough (Plan H).
 *
 * Test 1 (key present): seeds a DeepSeek key + storyMode on, mocks the DeepSeek
 *   JSON tasks so the storyOrder task returns a 2-step StoryOrderResult and the
 *   diagrams task returns a change-map. Asserts:
 *     - the Story/Files switch is present, Story active;
 *     - the first step's caption + its diff render;
 *     - the related test file renders inline;
 *     - the change-map highlights the current step's node;
 *     - a draft comment left on a slide PERSISTS when navigating away and back.
 *
 * Test 2 (no key): no LLM key → Story is unavailable; the switch is absent and
 *   classic Files mode renders.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

const SCHEMA_PATCH = `@@ -1,2 +1,3 @@
 const schema = {}
 const keep = 1
+const provider = 'github'`

const SCHEMA_TEST_PATCH = `@@ -1,1 +1,2 @@
 test('schema', () => {})
+test('provider column', () => {})`

const UI_PATCH = `@@ -1,1 +1,2 @@
 const card = 1
+const badge = 2`

function makePrMeta() {
  return {
    title: 'Story mode test PR',
    state: 'open',
    merged: false,
    body: 'Adds a provider column.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 3,
  }
}

function makePrFiles() {
  return [
    { filename: 'src/db/schema.ts', status: 'modified', patch: SCHEMA_PATCH, additions: 1, deletions: 0 },
    { filename: 'src/db/schema.test.ts', status: 'modified', patch: SCHEMA_TEST_PATCH, additions: 1, deletions: 0 },
    { filename: 'src/ui/Card.ts', status: 'modified', patch: UI_PATCH, additions: 1, deletions: 0 },
  ]
}

const STORY_RESULT = {
  steps: [
    {
      index: 0,
      files: ['src/db/schema.ts'],
      caption: 'The schema gains a provider column.',
      layer: 'data',
      relatedTests: ['src/db/schema.test.ts'],
    },
    { index: 1, files: ['src/ui/Card.ts'], caption: 'The card renders a provider badge.', layer: 'ui', relatedTests: [] },
  ],
}

// Plan L: the diagram task returns an execution flow whose steps carry the same
// files as the story steps, so the flow doubles as the story progress map —
// highlighting the current step's node (by step.file) and supporting click-jump.
const DIAGRAM_RESULT = {
  kind: 'flow',
  before: { nodes: [], edges: [] },
  after: { nodes: [], edges: [] },
  flow: {
    steps: [
      { id: 'schema', label: 'add provider column', file: 'src/db/schema.ts', kind: 'entry', change: 'changed' },
      { id: 'card', label: 'render provider badge', file: 'src/ui/Card.ts', kind: 'effect', change: 'changed' },
    ],
    transitions: [{ from: 'schema', to: 'card' }],
  },
}

const ATTENTION_RESULT = { readingOrder: [], hotspots: [], testFlags: [] }
const VERDICT_RESULT = { level: 'minor-changes', evidence: ['schema changed'], notAnalyzed: [] }
const TESTS_RESULT = { covered: [], gaps: [] }
const ALTERNATIVES_RESULT = { problem: 'add a column', alternatives: [] }

function jsonChatCompletion(content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }
}

function makeStreamResponse(text: string): string {
  const lines: string[] = []
  for (const word of text.split(' ')) {
    lines.push(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ delta: { content: word + ' ' }, index: 0, finish_reason: null }] })}`)
  }
  lines.push('data: [DONE]')
  return lines.join('\n') + '\n'
}

const SUMMARY_TEXT = 'Adds a provider column.\n\n===READING-ORDER===\nsrc/db/schema.ts\n===END==='

// Map a single-pass JSON task to its fixture by the system prompt content.
function resultForSystem(system: string): string {
  if (/guided NARRATIVE walkthrough/i.test(system)) return JSON.stringify(STORY_RESULT)
  if (/NO Mermaid syntax/i.test(system)) return JSON.stringify(DIAGRAM_RESULT)
  if (/changed test files/i.test(system)) return JSON.stringify(TESTS_RESULT)
  if (/genuinely different approach/i.test(system)) return JSON.stringify(ALTERNATIVES_RESULT)
  if (/testFlags/i.test(system)) return JSON.stringify(ATTENTION_RESULT)
  return JSON.stringify(VERDICT_RESULT)
}

async function setupGithub(page: import('@playwright/test').Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) return route.fulfill({ json: makePrMeta() })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) return route.fulfill({ json: makePrFiles() })
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) return route.fulfill({ json: [] })
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) return route.fulfill({ json: [] })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
}

test('story mode: walk slides, related tests, diagram highlight, and a draft persists', async ({ page }) => {
  await setupGithub(page)

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    return route.fulfill({ status: 200, json: jsonChatCompletion(resultForSystem(system)) })
  })

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: true }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  // Seed a draft for the step-1 file directly into IndexedDB (the diff comment
  // widget is virtualized — same pattern as review-flow.spec.ts). The draft is
  // keyed by file, so it must surface on the slide that shows that file AND
  // survive slide navigation (drafts are shared with Files mode).
  const prKey = `github:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD_SHA}`
  await page.addInitScript((key) => {
    const request = indexedDB.open('review123-drafts', 1)
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts')
    }
    request.onsuccess = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      const store = db.transaction('drafts', 'readwrite').objectStore('drafts')
      store.put({ path: 'src/db/schema.ts', line: 3, side: 'RIGHT', body: 'Seeded story draft', prKey: key }, key + '|src/db/schema.ts|3|RIGHT')
    }
  }, prKey)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story mode test PR/i })).toBeVisible({ timeout: 10_000 })

  // Go to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()

  // The Story/Files switch is present and Story is active.
  const storyBtn = page.getByRole('button', { name: 'Story' })
  await expect(storyBtn).toBeVisible({ timeout: 15_000 })
  await expect(storyBtn).toHaveAttribute('aria-pressed', 'true')

  // First step caption + counter. 3 steps: 2 placed + the Plan K catch-all
  // (schema.test.ts is a relatedTest-only file, swept into "Other changes").
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('1 of 3').first()).toBeVisible()

  // The step's diff renders + the related test file renders inline.
  await expect(page.locator('#file-src-db-schema-ts article.file-diff')).toBeVisible()
  await expect(page.getByText('Related tests — sense-check the change')).toBeVisible()
  await expect(page.locator('#file-src-db-schema-test-ts')).toBeVisible()

  // The change-map highlights the current step's node (schema.ts).
  await expect(page.locator('.story-node-current')).toHaveCount(1, { timeout: 15_000 })

  // The seeded draft surfaces in the sticky draft bar while on the story slide
  // (drafts are keyed by file, shared with Files mode).
  await expect(page.getByText(/1 comment drafted/)).toBeVisible({ timeout: 10_000 })

  // Advance to step 2 then back to step 1 — the draft count persists across
  // slide navigation (the draft store is not per-slide).
  await page.getByRole('button', { name: 'Next step' }).first().click()
  await expect(page.getByText('The card renders a provider badge.')).toBeVisible()
  await expect(page.getByText('2 of 3').first()).toBeVisible()
  await expect(page.getByText(/1 comment drafted/)).toBeVisible()
  await page.getByRole('button', { name: 'Previous step' }).first().click()
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible()
  await expect(page.getByText(/1 comment drafted/)).toBeVisible()

  // Switching to Files shows the all-files diff (byte-identical flow).
  await page.getByRole('button', { name: 'Files' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await expect(page.locator('#file-src-ui-Card-ts')).toBeVisible()
})

// A story whose first step references an unmappable path — the mappable steps
// must still render (partial rendering), no fallback to Files.
const STORY_WITH_UNMAPPABLE = {
  steps: [
    { index: 0, files: ['ghost/removed.ts'], caption: 'A step for a file not in this PR.', layer: 'data', relatedTests: [] },
    { index: 1, files: ['src/db/schema.ts'], caption: 'The schema gains a provider column.', layer: 'data', relatedTests: ['src/db/schema.test.ts'] },
    { index: 2, files: ['src/ui/Card.ts'], caption: 'The card renders a provider badge.', layer: 'ui', relatedTests: [] },
  ],
}

test('story mode: a story with an unmappable path still renders the mappable steps', async ({ page }) => {
  await setupGithub(page)

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    if (/guided NARRATIVE walkthrough/i.test(system)) return route.fulfill({ status: 200, json: jsonChatCompletion(JSON.stringify(STORY_WITH_UNMAPPABLE)) })
    return route.fulfill({ status: 200, json: jsonChatCompletion(resultForSystem(system)) })
  })

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: true }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story mode test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  // No fallback note; the ghost step is dropped and the first mappable step shows.
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/showing all files/)).toHaveCount(0)
  // Two mappable steps survive (ghost dropped) + the Plan K catch-all for the
  // relatedTest-only schema.test.ts → counter reads "1 of 3".
  await expect(page.getByText('1 of 3').first()).toBeVisible()
  await expect(page.getByText('A step for a file not in this PR.')).toHaveCount(0)
})

// An errored story task → reason-specific note + Retry. The first story call
// returns malformed JSON (errors); Retry re-invokes ONLY the story task, which
// succeeds the second time and renders the walkthrough.
test('story mode: an errored story shows the reason + Retry, and Retry re-runs just the story', async ({ page }) => {
  await setupGithub(page)

  let storyCalls = 0
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    if (/guided NARRATIVE walkthrough/i.test(system)) {
      storyCalls++
      // First story request (+ its repair retry) returns unparseable junk → error.
      // After Retry, return a valid story so the walkthrough renders.
      if (storyCalls <= 2) return route.fulfill({ status: 200, json: jsonChatCompletion('not json at all') })
      return route.fulfill({ status: 200, json: jsonChatCompletion(JSON.stringify(STORY_RESULT)) })
    }
    return route.fulfill({ status: 200, json: jsonChatCompletion(resultForSystem(system)) })
  })

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: true }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story mode test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  // Error note with the reason + a Retry button; Files render underneath.
  await expect(page.getByText(/Couldn't build the walkthrough/)).toBeVisible({ timeout: 15_000 })
  const retry = page.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()

  await retry.click()

  // Retry re-runs just the story task → the walkthrough now renders.
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Couldn't build the walkthrough/)).toHaveCount(0)
})

test('story mode: no LLM key → unavailable, classic Files renders', async ({ page }) => {
  await setupGithub(page)
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: '', storyMode: true, diffMode: 'unified', railCollapsed: true }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story mode test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  // No Story switch (story unavailable without a key); Files diff renders.
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Story' })).toHaveCount(0)
  await expect(page.locator('#file-src-db-schema-ts article.file-diff')).toBeVisible({ timeout: 10_000 })
})

// Plan I — function↔test pairing: a changed function with a named test shows the
// inline "tested by" snippet. We give the impl file a named-function hunk header
// and serve the test file's CONTENTS (base64) at the head ref so the deterministic
// pairing engine can slice the test block from the already-fetched content.

const PAIR_IMPL_PATCH = `@@ -1,2 +1,3 @@ function buildKey(x) {
   const a = 1
+  return x + 1
 }`

const PAIR_STORY_RESULT = {
  steps: [
    { index: 0, files: ['src/keys.ts'], caption: 'buildKey now returns a derived value.', layer: 'logic', relatedTests: ['src/keys.test.ts'] },
  ],
}

const PAIR_TEST_SOURCE = [
  "import { buildKey } from './keys'",
  "describe('keys', () => {",
  "  it('buildKey adds one', () => {",
  '    expect(buildKey(1)).toBe(2)',
  '  })',
  '})',
].join('\n')

function makePairPrFiles() {
  return [
    { filename: 'src/keys.ts', status: 'modified', patch: PAIR_IMPL_PATCH, additions: 1, deletions: 0 },
    { filename: 'src/keys.test.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n x\n+y', additions: 1, deletions: 0 },
  ]
}

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64')
}

test('story mode: a changed function with a named test shows the inline "tested by" snippet', async ({ page }) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) return route.fulfill({ json: makePrMeta() })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) return route.fulfill({ json: makePairPrFiles() })
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    // Serve the test file's content at the head ref so it lands in contentsMap.
    if (path === `/repos/${OWNER}/${REPO}/contents/src/keys.test.ts`) {
      return route.fulfill({ json: { content: b64(PAIR_TEST_SOURCE), encoding: 'base64' } })
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) return route.fulfill({ json: [] })
    if (path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/comments`) return route.fulfill({ json: [] })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    if (/guided NARRATIVE walkthrough/i.test(system)) return route.fulfill({ status: 200, json: jsonChatCompletion(JSON.stringify(PAIR_STORY_RESULT)) })
    return route.fulfill({ status: 200, json: jsonChatCompletion(resultForSystem(system)) })
  })

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: true }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story mode test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  await expect(page.getByText('buildKey now returns a derived value.')).toBeVisible({ timeout: 15_000 })

  // The collapsed "Tested by" affordance appears beneath the function's diff.
  const toggle = page.getByRole('button', { name: /Tested by/i })
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  // Expanding reveals THAT test block, sliced from the fetched test content.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText(/expect\(buildKey\(1\)\)\.toBe\(2\)/)).toBeVisible()
})

// Plan K — coverage confidence. STORY_RESULT places schema.ts + Card.ts as
// primaries; schema.test.ts is ONLY a relatedTest, so the deterministic catch-all
// sweeps it into a final "Other changes" step → the walkthrough provably covers
// all 3 changed files. We walk to the end and assert the progress readout,
// catch-all, and the "you saw everything" reconciliation moment.
test('story mode: coverage parity, catch-all, and end-of-story reconciliation', async ({ page }) => {
  await setupGithub(page)

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    return route.fulfill({ status: 200, json: jsonChatCompletion(resultForSystem(system)) })
  })

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: true }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story mode test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  await expect(page.getByText('The schema gains a provider column.')).toBeVisible({ timeout: 15_000 })

  // 3 steps total: 2 placed + 1 catch-all (schema.test.ts swept in). Coverage
  // readout shows 1 of 3 files seen on the first slide.
  await expect(page.getByText('1 of 3').first()).toBeVisible()
  await expect(page.getByText(/1 \/ 3 files seen/)).toBeVisible()

  // Walk to the catch-all (last) step.
  const next = page.getByRole('button', { name: 'Next step' }).first()
  await next.click() // step 2: Card.ts
  await next.click() // step 3: catch-all
  await expect(page.getByText('Other changes (1)')).toBeVisible()
  await expect(page.locator('#file-src-db-schema-test-ts')).toBeVisible()

  // All 3 unique changed files seen → the reconciliation "you saw everything".
  await expect(page.getByText(/3 \/ 3 files seen/)).toBeVisible()
  await expect(page.getByText(/You've walked all 3 changed files/)).toBeVisible()
})

// A reviewer who jumps past a file leaves it unseen: the last step lists it with
// a Jump affordance. We reach the catch-all, manually un-view a file via the
// in-diff "Viewed" toggle, then assert the reconciliation lists it + Jump works.
test('story mode: reconciliation lists an unseen file and Jump navigates to it', async ({ page }) => {
  await setupGithub(page)

  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    return route.fulfill({ status: 200, json: jsonChatCompletion(resultForSystem(system)) })
  })

  // Pre-seed the viewed store so schema.ts + schema.test.ts are already viewed,
  // leaving Card.ts (step 2) as the only unseen file. We then jump from step 1
  // straight to the last step via the change-map node, skipping Card's slide.
  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: true }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story mode test PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible({ timeout: 15_000 })

  // Walk to step 2 (Card.ts), then UN-VIEW it via the in-diff Viewed checkbox —
  // modelling a reviewer who skimmed past a file. The auto-mark fires at most
  // once per file, so the manual un-view STICKS (Files-mode semantics preserved).
  const next = page.getByRole('button', { name: 'Next step' }).first()
  await next.click() // step 2: Card.ts
  await expect(page.getByText('The card renders a provider badge.')).toBeVisible()
  const cardViewed = page.locator('#file-src-ui-Card-ts').getByRole('checkbox', { name: /Mark .* as viewed/i }).first()
  await expect(cardViewed).toBeChecked() // auto-marked viewed on arrival
  await cardViewed.uncheck()

  // Advance to the catch-all (last) step. Card.ts stays unviewed.
  await next.click() // step 3: catch-all (schema.test.ts)
  await expect(page.getByText('Other changes (1)')).toBeVisible({ timeout: 10_000 })

  // The reconciliation lists Card.ts as unviewed with a Jump affordance.
  await expect(page.getByText(/You haven't viewed 1 file yet/)).toBeVisible()
  const jump = page.getByRole('button', { name: 'Jump to src/ui/Card.ts' })
  await expect(jump).toBeVisible()
  await jump.click()
  await expect(page.getByText('The card renders a provider badge.')).toBeVisible()
})
