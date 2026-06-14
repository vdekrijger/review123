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

const DIAGRAM_RESULT = {
  kind: 'flow',
  before: { nodes: [{ id: 'schema', label: 'schema.ts' }], edges: [] },
  after: { nodes: [{ id: 'schema', label: 'schema.ts' }, { id: 'card', label: 'Card.ts' }], edges: [] },
  changeMap: {
    nodes: [
      { id: 'schema', label: 'schema.ts', status: 'changed' },
      { id: 'card', label: 'Card.ts', status: 'changed' },
    ],
    edges: [],
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

  // First step caption + counter.
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('1 of 2').first()).toBeVisible()

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
  await expect(page.getByText('2 of 2').first()).toBeVisible()
  await expect(page.getByText(/1 comment drafted/)).toBeVisible()
  await page.getByRole('button', { name: 'Previous step' }).first().click()
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible()
  await expect(page.getByText(/1 comment drafted/)).toBeVisible()

  // Switching to Files shows the all-files diff (byte-identical flow).
  await page.getByRole('button', { name: 'Files' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await expect(page.locator('#file-src-ui-Card-ts')).toBeVisible()
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
