/**
 * e2e/story-highlight-diffwidth.spec.ts
 *
 * Two regression guards stemming from a Story-Mode review:
 *
 * FIX 1 — syntax highlighting renders in the diff. @git-diff-view's bundled
 *   lowlight/highlight.js tokenizes each content line into `hljs-*` span
 *   classes inside `.diff-line-syntax-raw` rows. A user reported "no coloring"
 *   but it works on main (stale deploy). These tests pin that the tokens render
 *   in BOTH the classic Files diff AND the primary Story-Mode FileDiff, so a
 *   future dep/chunk change that silently drops the highlighter is caught.
 *
 * FIX 2 — Story Mode honors the diff-width setting. The full-width CSS lifts the
 *   .review 70rem cap for step 2. Story Mode renders INSTEAD of .inspect-layout,
 *   so the cap must also lift via `.review:has(.story)`. We assert the story
 *   FileDiff is wider in full mode than in centered mode (boundingBox), mirroring
 *   the fullwidth-rail spec pattern.
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'
const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// A patch with clearly-tokenizable TS: keywords (const), a string literal — both
// produce distinct `hljs-*` token spans when highlighted.
const SCHEMA_PATCH = `@@ -1,2 +1,3 @@
 const schema = {}
 const keep = 1
+const provider = 'github'`

const UI_PATCH = `@@ -1,1 +1,2 @@
 const card = 1
+const badge = 2`

function makePrMeta() {
  return {
    title: 'Story highlight + diffwidth PR',
    state: 'open',
    merged: false,
    body: 'Adds a provider column.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 2,
  }
}

function makePrFiles() {
  return [
    { filename: 'src/db/schema.ts', status: 'modified', patch: SCHEMA_PATCH, additions: 1, deletions: 0 },
    { filename: 'src/ui/Card.ts', status: 'modified', patch: UI_PATCH, additions: 1, deletions: 0 },
  ]
}

const STORY_RESULT = {
  steps: [
    { index: 0, files: ['src/db/schema.ts'], caption: 'The schema gains a provider column.', layer: 'data', relatedTests: [] },
    { index: 1, files: ['src/ui/Card.ts'], caption: 'The card renders a provider badge.', layer: 'ui', relatedTests: [] },
  ],
}

const ATTENTION_RESULT = { readingOrder: [], hotspots: [], testFlags: [] }
const VERDICT_RESULT = { level: 'minor-changes', evidence: ['schema changed'], notAnalyzed: [] }
const TESTS_RESULT = { covered: [], gaps: [] }
const ALTERNATIVES_RESULT = { problem: 'add a column', alternatives: [] }
const DIAGRAM_RESULT = {
  kind: 'flow',
  before: { nodes: [{ id: 'schema', label: 'schema.ts' }], edges: [] },
  after: { nodes: [{ id: 'schema', label: 'schema.ts' }], edges: [] },
  changeMap: { nodes: [{ id: 'schema', label: 'schema.ts', status: 'changed' }], edges: [] },
}

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
    const path = new URL(route.request().url()).pathname
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

async function setupDeepseek(page: import('@playwright/test').Page) {
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: Array<{ role: string; content: string | null }> } = {}
    try { body = route.request().postDataJSON() as typeof body } catch { /* */ }
    if (body?.stream === true) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: makeStreamResponse(SUMMARY_TEXT) })
    }
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    return route.fulfill({ status: 200, json: jsonChatCompletion(resultForSystem(system)) })
  })
}

// ---------------------------------------------------------------------------
// FIX 1 — highlighting renders in BOTH Files mode and Story mode.
// The library tokenizes content lines into `hljs-*` spans inside
// `.diff-line-syntax-raw` rows (vs `.diff-line-content-raw` when NOT highlighted).
// ---------------------------------------------------------------------------

test('Files mode: the diff is syntax-highlighted (hljs token spans render)', async ({ page }) => {
  await setupGithub(page)
  await page.route('**/api.deepseek.com/**', (route) => route.abort())
  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: '', diffMode: 'unified', railCollapsed: true }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story highlight \+ diffwidth PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  const article = page.locator('#file-src-db-schema-ts article.file-diff')
  await expect(article).toBeVisible({ timeout: 10_000 })

  // Highlighter loads + tokenizes after the library's initSyntax effect. The
  // tokenized rows carry `.diff-line-syntax-raw`; the `hljs-*` token spans live
  // inside them (e.g. hljs-keyword for `const`, hljs-string for 'github').
  // hljs token spans are inline (no layout box) → assert COUNT, not visibility.
  await expect(article.locator('[data-highlighter="lowlight"]')).toHaveCount(1, { timeout: 10_000 })
  await expect.poll(async () => article.locator('[class*="hljs-"]').count(), { timeout: 10_000 }).toBeGreaterThan(0)
  expect(await article.locator('.diff-line-syntax-raw').count()).toBeGreaterThan(0)
})

test('Story mode: the primary FileDiff is syntax-highlighted (hljs token spans render)', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseek(page)
  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: true }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story highlight \+ diffwidth PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()

  // Story is active and the first step's primary FileDiff renders.
  await expect(page.getByRole('button', { name: 'Story' })).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible({ timeout: 15_000 })

  const article = page.locator('#file-src-db-schema-ts article.file-diff')
  await expect(article).toBeVisible({ timeout: 10_000 })

  // ROOT CAUSE GUARD: the story slide auto-marks its primary file viewed for
  // coverage the instant the slide is reached. Without forceExpanded that
  // collapses the narrated diff to a header-only card (no DiffView, no hljs
  // tokens) — which reads as "highlighting is broken". forceExpanded keeps the
  // body rendered. Assert the diff body (the library wrapper) is present, NOT
  // collapsed.
  await expect(article).not.toHaveClass(/is-collapsed/)
  await expect(article.locator('[data-component="git-diff-view"]')).toHaveCount(1, { timeout: 10_000 })

  // Same highlighter assertion INSIDE Story Mode — the primary diff is tokenized.
  await expect(article.locator('[data-highlighter="lowlight"]')).toHaveCount(1, { timeout: 10_000 })
  await expect.poll(async () => article.locator('[class*="hljs-"]').count(), { timeout: 10_000 }).toBeGreaterThan(0)
  expect(await article.locator('.diff-line-syntax-raw').count()).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// FIX 2 — Story Mode honors diffWidth. The story FileDiff is wider in full mode
// than in centered mode (the .review cap lifts via `.review:has(.story)`).
// ---------------------------------------------------------------------------

async function gotoStoryInspect(page: import('@playwright/test').Page) {
  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Story highlight \+ diffwidth PR/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByText('The schema gains a provider column.')).toBeVisible({ timeout: 15_000 })
  const article = page.locator('#file-src-db-schema-ts article.file-diff')
  await expect(article).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(200)
  return article
}

test('Story mode: full-width renders a wider FileDiff than centered', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseek(page)
  await page.setViewportSize({ width: 1600, height: 900 })

  // Pass 1: centered (seed only if absent so pass 2's flip survives re-nav).
  await page.addInitScript(() => {
    if (!localStorage.getItem('review123:settings')) {
      localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: true, diffWidth: 'centered' }))
    }
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  const centeredArticle = await gotoStoryInspect(page)
  const centeredBox = await centeredArticle.boundingBox()
  expect(centeredBox).not.toBeNull()

  // Pass 2: flip to full, re-navigate, walk back into the inspect step.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('review123:settings') ?? '{}')
    s.diffWidth = 'full'
    localStorage.setItem('review123:settings', JSON.stringify(s))
  })
  const fullArticle = await gotoStoryInspect(page)
  const fullBox = await fullArticle.boundingBox()
  expect(fullBox).not.toBeNull()

  // KEY: the story diff genuinely widens in full mode (the .review cap lifts).
  // At 1600px the 70rem (~1120px) cap is well below the viewport, so the
  // difference is large; require a comfortable margin.
  expect(fullBox!.width).toBeGreaterThan(centeredBox!.width + 50)
  // And it starts closer to the viewport's left edge.
  expect(fullBox!.x).toBeLessThan(centeredBox!.x)
})

test('Story mode: full-width + expanded rail — the story FileDiff never slides under the rail', async ({ page }) => {
  await setupGithub(page)
  await setupDeepseek(page)
  await page.setViewportSize({ width: 1600, height: 900 })

  await page.addInitScript(() => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', storyMode: true, diffMode: 'unified', railCollapsed: false, diffWidth: 'full' }))
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })

  const article = await gotoStoryInspect(page)
  const rail = page.locator('aside.context-rail')
  await expect(rail).toBeVisible({ timeout: 5_000 })
  await page.waitForTimeout(200)

  const articleBox = await article.boundingBox()
  const railBox = await rail.boundingBox()
  expect(articleBox).not.toBeNull()
  expect(railBox).not.toBeNull()

  // The expanded-rail reservation (mirrored for .review:has(.story)) keeps the
  // story diff left of the rail — content never slides under it.
  expect(articleBox!.x + articleBox!.width).toBeLessThanOrEqual(railBox!.x + 2)
})
