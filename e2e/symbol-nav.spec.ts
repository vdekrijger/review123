/**
 * e2e/symbol-nav.spec.ts — Symbol click-through (Tier 1) on the Inspect step.
 *
 * Fixture: two TS files — src/util.ts DEFINES `computeTotal`, src/app.ts
 * CALLS it. Clicking the `computeTotal` identifier in app.ts's diff opens the
 * symbol popover with:
 *   1. a Definition section pointing at src/util.ts (snippet + file:line), and
 *   2. a "Call points in this PR (N)" section grouped by file.
 * Clicking the definition's file:line jumps ACROSS FILES to util.ts's diff row
 * (flash class). The definition entry expands (peek) to its actual code body
 * inline. Escape closes the popover. Clicking a keyword never opens it.
 *
 * Same mocking strategy as focus-mode.spec.ts (route-intercepted GitHub API,
 * no AI, PostHog blocked).
 */

import { test, expect } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 77
const HEAD_SHA = 'abc1234567890'
const BASE_SHA = 'def0987654321'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

// src/util.ts — adds the computeTotal definition.
const UTIL_PATCH = `@@ -1,1 +1,4 @@
+export function computeTotal(values: number[]): number {
+  return values.reduce((total, v) => total + v, 0)
+}
 export const UTIL_VERSION = 1`

// src/app.ts — adds a call to computeTotal.
const APP_PATCH = `@@ -1,2 +1,3 @@
 const items = [1, 2, 3]
+const grandTotal = computeTotal(items)
 export const APP_VERSION = 1`

test('inspect: clicking an identifier opens the symbol popover with definition + call points', async ({ page }) => {
  // Block PostHog
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Symbol nav test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 2,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          { filename: 'src/util.ts', status: 'modified', patch: UTIL_PATCH, additions: 3, deletions: 0 },
          { filename: 'src/app.ts', status: 'modified', patch: APP_PATCH, additions: 1, deletions: 0 },
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

  // No AI in this test
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

  await page.goto(APP_REVIEW_PATH)

  await expect(page.getByRole('heading', { name: /Symbol nav test PR/i })).toBeVisible({
    timeout: 10_000,
  })

  // Navigate to step 2 (Inspect)
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Both file diffs render.
  await expect(page.locator('article.file-diff')).toHaveCount(2)
  const defCell = page.locator('#file-src-util-ts .diff-line-content', { hasText: 'export function computeTotal' })
  await expect(defCell.first()).toBeVisible({ timeout: 10_000 })

  // Click the computeTotal identifier on its DEFINITION line in src/util.ts.
  // The lowlight highlighter wraps declaration names in their own hljs token
  // span (hljs-title), so the click target is exactly the identifier.
  const defToken = page
    .locator('#file-src-util-ts .diff-line-content span')
    .filter({ hasText: /^computeTotal$/ })
    .first()
  await expect(defToken).toBeVisible({ timeout: 10_000 })
  await defToken.click()

  // The popover opens with both sections.
  const popover = page.getByTestId('symbol-popover')
  await expect(popover).toBeVisible()
  await expect(popover.getByText('Definition')).toBeVisible()
  // Definition resolved from the patch text of this PR, with file:line.
  await expect(popover.getByText(/export function computeTotal/)).toBeVisible()
  await expect(popover.getByRole('button', { name: /^src\/util\.ts:1$/ })).toBeVisible()
  // Call points: exactly the app.ts call line (the def line is excluded).
  await expect(popover.getByText('Call points in this PR (1)')).toBeVisible()
  await expect(popover.locator('.ref-file-name', { hasText: 'src/app.ts' })).toBeVisible()

  // PEEK: expand the definition entry to its actual code body, inline.
  const peekToggle = popover.getByRole('button', { name: 'Definition body at src/util.ts:1' })
  await expect(peekToggle).toHaveAttribute('aria-expanded', 'false')
  await peekToggle.click()
  await expect(peekToggle).toHaveAttribute('aria-expanded', 'true')
  const peek = popover.getByTestId('definition-peek')
  await expect(peek).toBeVisible()
  await expect(peek).toContainText('return values.reduce((total, v) => total + v, 0)')
  // The toggle never unmounts, so the focusout idiom must NOT self-close the
  // popover on expand (the #210 lesson).
  await expect(popover).toBeVisible()
  // Collapse again — the body hides, the popover stays.
  await peekToggle.click()
  await expect(popover.getByTestId('definition-peek')).toBeHidden()
  await expect(popover).toBeVisible()

  // CROSS-FILE jump: clicking the app.ts reference row closes the popover and
  // flashes the target row in src/app.ts's diff.
  await popover.getByRole('button', { name: /grandTotal = computeTotal\(items\)/ }).click()
  await expect(popover).toBeHidden()
  await expect(page.locator('#file-src-app-ts tr.symbol-jump-flash')).toHaveCount(1, { timeout: 3000 })

  // Reopen and close with Escape.
  await defToken.click()
  await expect(popover).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()

  // Clicking a keyword token never opens the popover.
  const keywordToken = page
    .locator('#file-src-util-ts .diff-line-content span.hljs-keyword', { hasText: 'export' })
    .first()
  await keywordToken.click()
  await expect(popover).toBeHidden()
})

// ---------------------------------------------------------------------------
// Tier 2: on-demand "Search repo" — call points OUTSIDE the PR's files via the
// stubbed /search/code endpoint + a contents fetch at the PR's head SHA.
// ---------------------------------------------------------------------------

// A repo file OUTSIDE the PR that calls computeTotal (served at HEAD_SHA).
const OTHER_TS = [
  "import { computeTotal } from './util'",
  'export function report(xs: number[]) {',
  '  return computeTotal(xs) * 2',
  '}',
].join('\n')

test('inspect: Search repo lists call points outside the PR files', async ({ page }) => {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname

    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Symbol nav test PR',
          state: 'open', merged: false, body: null,
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 2,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [
          { filename: 'src/util.ts', status: 'modified', patch: UTIL_PATCH, additions: 3, deletions: 0 },
          { filename: 'src/app.ts', status: 'modified', patch: APP_PATCH, additions: 1, deletions: 0 },
        ],
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments`) {
      return route.fulfill({ json: [] })
    }
    // Code search: one hit OUTSIDE the PR + one hit that IS a PR file (must be
    // excluded — Tier 1 already lists its call points).
    if (path === '/search/code') {
      return route.fulfill({
        json: {
          total_count: 2,
          items: [{ path: 'src/other.ts' }, { path: 'src/app.ts' }],
        },
      })
    }
    // The search result file fetched at the PR's HEAD SHA.
    if (path === `/repos/${OWNER}/${REPO}/contents/src/other.ts`) {
      expect(url.searchParams.get('ref')).toBe(HEAD_SHA)
      return route.fulfill({
        json: { content: Buffer.from(OTHER_TS, 'utf-8').toString('base64'), encoding: 'base64' },
      })
    }
    return route.fulfill({ status: 404, json: { message: 'Not Found' } })
  })

  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Symbol nav test PR/i })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

  // Open the popover on the computeTotal definition token in util.ts.
  const defToken = page
    .locator('#file-src-util-ts .diff-line-content span')
    .filter({ hasText: /^computeTotal$/ })
    .first()
  await expect(defToken).toBeVisible({ timeout: 10_000 })
  await defToken.click()

  const popover = page.getByTestId('symbol-popover')
  await expect(popover).toBeVisible()

  // The "In repo" section is idle: on-demand button, nothing searched yet.
  await expect(popover.getByText('In repo')).toBeVisible()
  const searchBtn = popover.getByRole('button', { name: 'Search repo' })
  await expect(searchBtn).toBeVisible()

  await searchBtn.click()

  // Results: grouped under the out-of-PR file, with real line + snippet rows.
  await expect(popover.getByText('In repo (2)')).toBeVisible({ timeout: 10_000 })
  await expect(popover.locator('.repo-file', { hasText: 'src/other.ts' })).toBeVisible()
  const repoRows = popover.locator('section.repo .ref-row.static')
  await expect(repoRows).toHaveCount(2)
  await expect(repoRows.nth(1)).toContainText('return computeTotal(xs) * 2')
  // Rows are honest about not being jumpable (these files aren't in the diff).
  await expect(repoRows.nth(0)).toHaveAttribute('title', "Not in this PR's diff")
  // The PR's own file (src/app.ts) was excluded from the repo results.
  await expect(popover.locator('section.repo .repo-file', { hasText: 'src/app.ts' })).toHaveCount(0)
  // Honest footnote about the default-branch index + head-SHA re-check.
  await expect(popover.getByText(/default branch index; results re-checked/)).toBeVisible()
})

// ---------------------------------------------------------------------------
// Auto-resolve over a local bridge — the reason the manual button existed was
// the provider's ~10 code-searches/min. A grounded local checkout has no such
// budget, so the popover resolves the definition ON OPEN and shows its body.
//
// The symbol is a Python @dataclass defined OUTSIDE the PR's changed files:
// exactly the case where Tier 1 can only say "not in the changed files".
// ---------------------------------------------------------------------------

/** 40-hex, because grounding compares it against the bridge's git head exactly. */
const BRIDGE_HEAD = 'abc1234567890abcdef1234567890abcdef12345'
const BRIDGE_PR = 78
const BRIDGE_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${BRIDGE_PR}`

// The struct the reader wants to read. It is NOT in the PR.
const PROPS_PY = [
  'from dataclasses import dataclass', // 1
  '', // 2
  '@dataclass', // 3
  'class AnalyticsProps:', // 4
  '    user_id: str', // 5
  '    events: list[str]', // 6
  '    sampled: bool = False', // 7
  '', // 8
  'DEFAULT_PROPS = None', // 9
].join('\n')

// The PR's own file merely USES it.
const TRACK_PATCH = `@@ -1,2 +1,3 @@
 from posthog.props import AnalyticsProps
+props = AnalyticsProps(user_id="u1", events=[])
 VERSION = 1`

async function stubBridgeForSymbols(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ({ head, files }) => {
      localStorage.setItem(
        'review123:bridge',
        JSON.stringify({ token: 'e2e-pairing-token-000000000000000000000000', port: 7321 }),
      )
      const realFetch = window.fetch.bind(window)
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)
        const body = typeof init?.body === 'string' ? init.body : null

        if (url.includes('/v1/health')) {
          return Promise.resolve(
            json({
              ok: true,
              protocol: 1,
              root: 'review123',
              capabilities: { inference: [], infer: false, inferStream: false, inferAgentic: false, files: true, search: true },
              git: { head, branch: 'main', dirty: false },
              version: '0.1.0',
            }),
          )
        }
        if (url.includes('/v1/search')) {
          const query = (JSON.parse(body ?? '{}') as { query?: string }).query ?? ''
          const matches = Object.entries(files).flatMap(([path, text]) =>
            (text as string)
              .split('\n')
              .map((line, i) => ({ path, line: i + 1, column: 1, preview: line }))
              .filter((m) => query !== '' && m.preview.includes(query)),
          )
          return Promise.resolve(json({ ok: true, matches, truncated: false }))
        }
        if (url.includes('/v1/files')) {
          const asked = (JSON.parse(body ?? '{}') as { paths?: string[] }).paths ?? []
          return Promise.resolve(
            json({
              ok: true,
              files: asked
                .filter((p) => p in files)
                .map((p) => ({ path: p, bytes: (files[p] as string).length, truncated: false, content: files[p], encoding: 'utf-8' })),
              missing: asked.filter((p) => !(p in files)),
              skipped: [],
            }),
          )
        }
        return Promise.resolve(json({ ok: false, error: 'not-found', message: 'no' }, 404))
      }
    },
    { head: BRIDGE_HEAD, files: { 'posthog/props.py': PROPS_PY } as Record<string, string> },
  )
}

/**
 * Click an identifier by CARET POSITION rather than by locating a span.
 *
 * highlight.js gives a Python class reference no wrapper of its own —
 * `props = AnalyticsProps(...)` highlights only the string literal — so there
 * is no element to target. The popover's own click handler resolves the token
 * from the caret under the pointer (see lib/symbols/clickToken), so measuring
 * the token's rect with a Range and clicking its centre exercises exactly the
 * path a reader's click takes.
 */
async function clickIdentifier(page: import('@playwright/test').Page, fileSlug: string, token: string) {
  const point = await page.evaluate(
    ({ slug, needle }) => {
      const root = document.querySelector(`#file-${slug}`)
      if (!root) return null
      for (const raw of root.querySelectorAll('.diff-line-syntax-raw, .diff-line-content-raw')) {
        const walker = document.createTreeWalker(raw, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const index = (node.textContent ?? '').indexOf(needle)
          if (index >= 0) {
            const range = document.createRange()
            range.setStart(node, index)
            range.setEnd(node, index + needle.length)
            const rect = range.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
            }
          }
          node = walker.nextNode()
        }
      }
      return null
    },
    { slug: fileSlug, needle: token },
  )
  expect(point, `identifier ${token} not found in #file-${fileSlug}`).not.toBeNull()
  await page.mouse.click(point!.x, point!.y)
}

for (const theme of ['light', 'dark'] as const) {
  test(`inspect (${theme}): a definition outside the PR resolves on open and shows its body`, async ({ page }) => {
    await page.route('**/*posthog.com/**', (route) => route.abort())
    await page.route('**/us.i.posthog.com/**', (route) => route.abort())
    await page.route('**/api.deepseek.com/**', (route) => route.abort())

    await page.route('**/api.github.com/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === `/repos/${OWNER}/${REPO}/pulls/${BRIDGE_PR}`) {
        return route.fulfill({
          json: {
            title: 'Bridge symbol PR',
            state: 'open', merged: false, body: null,
            base: { sha: BASE_SHA, repo: { private: false } },
            head: { sha: BRIDGE_HEAD },
            changed_files: 1,
          },
        })
      }
      if (path === `/repos/${OWNER}/${REPO}/pulls/${BRIDGE_PR}/files`) {
        return route.fulfill({
          json: [{ filename: 'posthog/track.py', status: 'modified', patch: TRACK_PATCH, additions: 1, deletions: 0 }],
        })
      }
      if (path === `/repos/${OWNER}/${REPO}/commits/${BRIDGE_HEAD}/check-runs`) {
        return route.fulfill({ json: { total_count: 0, check_runs: [] } })
      }
      if (path === `/repos/${OWNER}/${REPO}/pulls/${BRIDGE_PR}/comments`) {
        return route.fulfill({ json: [] })
      }
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    })

    await stubBridgeForSymbols(page)
    await page.addInitScript((settings) => {
      localStorage.setItem('review123:settings', JSON.stringify(settings))
    }, { deepseekKey: '', diffMode: 'unified', railCollapsed: true, focusMode: 'off' })

    await page.goto(BRIDGE_REVIEW_PATH)
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await expect(page.getByRole('heading', { name: /Bridge symbol PR/i })).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Next step' }).click()
    await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()

    // Local grounding is live for this PR — the precondition for auto-resolve.
    await expect(page.getByTestId('grounding-indicator')).toHaveAttribute('data-mode', 'local', { timeout: 10_000 })

    await expect(page.locator('#file-posthog-track-py')).toBeVisible({ timeout: 10_000 })
    await clickIdentifier(page, 'posthog-track-py', 'AnalyticsProps')

    const popover = page.getByTestId('symbol-popover')
    await expect(popover).toBeVisible()

    // THE POINT: the body is there with no second click, and no button to press.
    const peek = popover.getByTestId('definition-peek')
    await expect(peek).toBeVisible({ timeout: 10_000 })
    await expect(peek).toContainText('@dataclass')
    await expect(peek).toContainText('user_id: str')
    await expect(peek).toContainText('sampled: bool = False')
    await expect(peek).not.toContainText('DEFAULT_PROPS')
    await expect(popover.getByRole('button', { name: 'Search repo' })).toHaveCount(0)
    await expect(popover.getByText(/Definition not in the changed files/)).toHaveCount(0)

    // Honesty signals survive: the repo tag, the real file:line, and a
    // provenance line that says LOCAL rather than the default-branch caveat.
    await expect(popover.getByTestId('repo-definition')).toContainText('posthog/props.py:4')
    await expect(popover.getByTestId('repo-definition')).toContainText('repo')
    await expect(popover.getByText(/Searched your local checkout at this PR's head/)).toBeVisible()

    // The popover is inside the viewport and the code block is not a second
    // vertical scroll surface inside it.
    const box = await popover.boundingBox()
    const viewport = page.viewportSize()!
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
    const scrollers = await popover.locator('.peek-scroll').evaluateAll((els) =>
      els.filter((el) => el.scrollHeight > el.clientHeight).length,
    )
    expect(scrollers).toBe(0)
  })
}
