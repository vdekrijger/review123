/**
 * e2e/verdict-agent-handover.spec.ts — handing the FINISHED review to the local
 * coding agent, from Step 3.
 *
 * What a real browser proves here that the unit tests cannot:
 *
 *   1. WITH NO BRIDGE PAIRED the Verdict step is byte-for-byte the step it was:
 *      "Copy as LLM prompt" is there and enabled, and the page says nothing at
 *      all about a bridge or an agent;
 *   2. WITH A READ-ONLY BRIDGE the refusal names the missing grant and hands over
 *      the command that starts one — no dead control to click;
 *   3. WITH A WRITE-ENABLED BRIDGE the handover renders BELOW the verdict and the
 *      actions (never under the readiness grade), sends the reviewer's ticked
 *      note, and what comes back reads as a proposal: no "fixed", no "resolved",
 *      no tick, and the Submit button and the draft are both still there;
 *   4. it survives a 400px window and renders in both themes.
 *
 * The bridge is stubbed at the `window.fetch` seam via addInitScript — the same
 * choice e2e/bridge.spec.ts documents, for the same reason: the real calls are
 * cross-origin with an Authorization header, so intercepting them would drag
 * CORS into the assertions.
 */
import { test, expect, type Page } from '@playwright/test'

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 44
// The bridge's checkout must be sitting on EXACTLY this commit, or the readiness
// rule refuses with head-mismatch rather than offering the send.
// A FULL 40-hex sha, not the short one the other fixtures use: the bridge's
// health parser rejects anything else, and `decideFixReadiness` compares the
// bridge's checkout against this exact string.
const HEAD_SHA = 'abc1234567890abcdef1234567890abcdef12345'
const BASE_SHA = 'def0987654321fedcba0987654321fedcba09876'

const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`
/** Identity prKey (NO head sha) — where the store keeps a PR's drafts. */
const PR_KEY = `github:${OWNER}/${REPO}#${PR_NUMBER}`

const BRIDGE_KEY = 'review123:bridge'
const TOKEN = 'e2e-pairing-token-000000000000000000000000'

const PATCH_WITH_LINES = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

function makePrMeta() {
  return {
    title: 'Test PR: hand it over',
    state: 'open',
    merged: false,
    body: 'This PR exercises the Verdict-step agent handover.',
    base: { sha: BASE_SHA, repo: { private: false } },
    head: { sha: HEAD_SHA },
    changed_files: 1,
  }
}

function makePrFiles() {
  return [
    { filename: 'src/feature.ts', status: 'modified', patch: PATCH_WITH_LINES, additions: 2, deletions: 1 },
  ]
}

function seedSettings() {
  return {
    githubAuth: { token: 'ghp_test_token', method: 'pat', scopes: ['repo'] },
    diffMode: 'unified',
    railCollapsed: true,
    storyMode: false,
    autoRunReviewers: false,
  }
}

/** One draft on an in-diff line — the note the agent is offered. */
async function seedDraft(page: Page) {
  await page.addInitScript(({ prKey }) => {
    return new Promise<void>((resolve) => {
      const open = indexedDB.open('review123-drafts', 1)
      open.onupgradeneeded = () => {
        const db = open.result
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts')
      }
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('drafts', 'readwrite')
        const now = Date.now()
        tx.objectStore('drafts').put(
          {
            prKey,
            path: 'src/feature.ts',
            line: 3,
            side: 'RIGHT',
            body: 'Use a Map here — this linear scan runs inside the render loop.',
            n: 0,
            createdAt: now,
            updatedAt: now,
          },
          `${prKey}|src/feature.ts|3|RIGHT|0`,
        )
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); resolve() }
      }
      open.onerror = () => resolve()
    })
  }, { prKey: PR_KEY })
}

async function setupRoutes(page: Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
  await page.route('**/api.deepseek.com/**', (route) => route.abort())

  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) return route.fulfill({ json: makePrMeta() })
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) return route.fulfill({ json: makePrFiles() })
    return route.fulfill({ json: [] })
  })
}

/**
 * Stub the three loopback routes this surface touches: health (pairing),
 * stack (the panel re-probes the tree on mount) and fix (the run itself).
 * Everything else falls through to the real fetch.
 */
async function stubBridge(page: Page, opts: { write: boolean }) {
  await page.addInitScript(
    ({ head, write }) => {
      const realFetch = window.fetch.bind(window)
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const json = (body: unknown) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)

        if (url.includes('/v1/health')) {
          return json({
            ok: true,
            protocol: 1,
            root: 'review123',
            capabilities: {
              inference: ['claude'],
              infer: true,
              inferStream: false,
              inferAgentic: false,
              files: true,
              search: true,
              fix: write,
            },
            git: { head, branch: 'feat/handover', dirty: false },
            version: '0.1.0',
          })
        }
        if (url.includes('/v1/stack')) {
          return json({
            ok: true,
            git: { head, branch: 'feat/handover', dirty: false },
            dirtyPaths: [],
            dirtyCount: 0,
            prior: null,
            app: { url: null, source: 'unknown', reachable: false, detail: '' },
            checkoutEnabled: false,
          })
        }
        if (url.includes('/v1/fix')) {
          const sent = JSON.parse(String(init?.body ?? '{}')) as {
            findings: { id: string; path: string }[]
          }
          ;(window as unknown as { __fixSent: unknown }).__fixSent = sent.findings
          return json({
            ok: true,
            cli: 'claude',
            baseSha: head,
            branch: 'review123/fix/e2e',
            changes: sent.findings.map((f, i) => ({
              findingId: f.id,
              commit: String(i + 1).repeat(40).slice(0, 40),
              subject: 'use a Map for the lookup',
              intent: 'Replaced the linear scan with a Map lookup.',
              files: [f.path],
              diff: `--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n-const hit = list.find(x => x.id === id)\n+const hit = index.get(id)\n`,
              truncated: false,
              rounds: 1,
              stopReason: 'all-addressed',
              tests: { status: 'passed', command: 'pnpm test', durationMs: 900, output: 'ok' },
            })),
            skipped: [],
            rounds: 1,
            stopReason: 'all-addressed',
            tests: null,
            durationMs: 1200,
          })
        }
        return realFetch(input as RequestInfo, init)
      }
    },
    { head: HEAD_SHA, write: opts.write },
  )
}

async function seedPairing(page: Page) {
  await page.addInitScript(
    ({ key, token }) => localStorage.setItem(key, JSON.stringify({ token, port: 7321 })),
    { key: BRIDGE_KEY, token: TOKEN },
  )
}

/** Load the PR with one seeded draft and walk to the Verdict step. */
async function reachVerdictStep(page: Page, bridge: 'none' | 'read-only' | 'write') {
  await setupRoutes(page)
  await page.addInitScript((settings) => {
    localStorage.setItem('review123:settings', JSON.stringify(settings))
  }, seedSettings())
  await seedDraft(page)
  if (bridge !== 'none') {
    await stubBridge(page, { write: bridge === 'write' })
    await seedPairing(page)
  }

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: hand it over/i })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('radio', { name: /approve/i })).toBeVisible({ timeout: 10_000 })
}

test('no bridge paired: the Verdict step is exactly what it was, and says nothing about one', async ({
  page,
}) => {
  await reachVerdictStep(page, 'none')

  await expect(page.getByTestId('agent-fix-panel')).toHaveCount(0)
  await expect(page.getByTestId('verdict-handover-empty')).toHaveCount(0)

  // The existing export is untouched: same label, still enabled.
  const copy = page.getByRole('button', { name: 'Copy as LLM prompt' })
  await expect(copy).toBeVisible()
  await expect(copy).toBeEnabled()

  // Telling somebody who has never paired a bridge what they are missing is
  // noise, not honesty — the rule the grounding indicator already follows. (The
  // readiness basis names the bridge in its "code read from" row; that predates
  // this and is a different claim, so the assertion is about the handover.)
  const body = (await page.locator('body').textContent()) ?? ''
  expect(body).not.toMatch(/coding agent/i)
  expect(body).not.toMatch(/hands over your notes/i)
  await expect(page.getByTestId('verdict-handover-separable')).toHaveCount(0)
  await expect(page.getByTestId('verdict-handover-payload')).toHaveCount(0)
})

test('read-only bridge: the refusal names the grant and hands over the command', async ({ page }) => {
  await reachVerdictStep(page, 'read-only')

  const readiness = page.getByTestId('agent-fix-readiness')
  await expect(readiness).toBeVisible({ timeout: 10_000 })
  await expect(readiness).toHaveAttribute('data-reason', 'write-disabled')
  await expect(readiness).toContainText('--allow-write')
  await expect(page.getByTestId('agent-fix-start-command')).toContainText('review123-bridge')

  // No control at all rather than a disabled one. Only the person at the
  // terminal can grant this, and the panel does not pretend otherwise.
  await expect(page.getByTestId('agent-fix-send')).toHaveCount(0)
  // But it still says what was being refused.
  await expect(page.getByTestId('verdict-handover-separable')).toContainText(
    'hands over your notes, not your review',
  )
})

test('write-enabled bridge: the handover sits below the actions and sends the note', async ({
  page,
}) => {
  await reachVerdictStep(page, 'write')

  const panel = page.getByTestId('agent-fix-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Hand these notes to your coding agent' })).toBeVisible()

  // Document order: the grade, then the verdict, then the actions, and only
  // then this. A "hand it all over" control directly under a grade is exactly
  // where a reader could conclude the checking has been discharged.
  const order = await page.evaluate(() => {
    const basis = document.querySelector('[data-testid="readiness-basis"], .verdict-group')
    const actions = document.querySelector('.actions')
    const handover = document.querySelector('[data-testid="agent-fix-panel"]')
    if (!basis || !actions || !handover) return 'missing'
    const after = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    return after(basis, actions) && after(actions, handover) ? 'handover-last' : 'out-of-order'
  })
  expect(order).toBe('handover-last')

  // The framing that keeps this from reading as the grade's answer.
  await expect(page.getByTestId('verdict-handover-proposal')).toContainText('a proposal, not a change')
  await expect(page.getByTestId('verdict-handover-proposal')).toContainText(
    'an agent writing code is not that being done',
  )

  // Opt-in: nothing leaves until the reviewer ticks it.
  const send = page.getByTestId('agent-fix-send')
  await expect(send).toBeDisabled()
  await page.getByTestId('agent-fix-note-checkbox').click()
  await expect(send).toBeEnabled()
  await send.click()

  // What comes back is the agent's own commit, read as a proposal.
  await expect(page.getByTestId('agent-fix-result').first()).toBeVisible({ timeout: 20_000 })
  const sent = await page.evaluate(
    () => (window as unknown as { __fixSent?: { path: string; line: number; body: string }[] }).__fixSent,
  )
  expect(sent).toHaveLength(1)
  expect(sent![0].path).toBe('src/feature.ts')
  expect(sent![0].body).toContain('Use a Map here')

  // NOT submitted, NOT cleared: the recap still holds the draft and Submit is
  // still the thing that posts a review.
  await expect(page.getByRole('heading', { name: /Drafted comments \(1\)/ })).toBeVisible()
  const submit = page.getByRole('button', { name: /submit review/i })
  await expect(submit).toBeVisible()
  await expect(submit).toBeEnabled()

  // The vocabulary #280/#282/#285 settled on: a commit is not a fix, and
  // nothing here is resolved.
  const body = (await page.locator('body').textContent()) ?? ''
  expect(body).not.toMatch(/\bfixed\b/i)
  expect(body).not.toMatch(/\bresolved\b/i)
  expect(body).not.toContain('✅')
})

test('the handover survives a 400px window and renders in both themes', async ({ page }) => {
  await reachVerdictStep(page, 'write')
  await expect(page.getByTestId('agent-fix-panel')).toBeVisible({ timeout: 10_000 })
  await page.setViewportSize({ width: 400, height: 900 })

  // Nothing inside pushes the page sideways.
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="agent-fix-panel"]') as HTMLElement | null
    if (!el) return -1
    return el.scrollWidth - el.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(1)
  // Its widest child — the cherry-pick / start-command row, which holds a
  // <code> that cannot wrap — stays inside its own scroller rather than pushing
  // the panel sideways.
  const rows = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="agent-fix-panel"]') as HTMLElement | null
    if (!panel) return -1
    return Math.max(
      0,
      ...[...panel.querySelectorAll('*')].map(
        (el) => (el as HTMLElement).getBoundingClientRect().right,
      ),
    ) - panel.getBoundingClientRect().right
  })
  expect(rows).toBeLessThanOrEqual(1)

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    const painted = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="agent-fix-panel"]') as HTMLElement | null
      const lead = document.querySelector('[data-testid="verdict-handover-proposal"]') as HTMLElement | null
      if (!el || !lead) return null
      return { background: getComputedStyle(el).backgroundColor, ink: getComputedStyle(lead).color }
    })
    expect(painted, theme).not.toBeNull()
    // Framing whose ink matches its ground is framing nobody reads.
    expect(painted!.ink, theme).not.toBe(painted!.background)
  }
})
