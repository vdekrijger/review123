/**
 * e2e/bridge.spec.ts — the Local bridge, end to end.
 *
 * Two halves:
 *   1. the settings section — absent, present, paired, and the guarantee that
 *      an UNPAIRED app touches the loopback address not once;
 *   2. INFERENCE through the bridge — a real review task answered by a stubbed
 *      `/v1/infer`, and the failure case that matters most: when the bridge
 *      stops answering, the review must fail visibly rather than quietly
 *      spending the API key the user also has configured.
 *
 * MOST of the bridge here is STUBBED at the `window.fetch` seam via
 * addInitScript, because a stub is the only way to pin how the UI reacts to
 * two dozen server states. That is deliberate over `page.route`: the real
 * calls are cross-origin with an Authorization header and a JSON content type,
 * so interception would drag CORS into the assertions.
 *
 * But a fetch stub can never fail the way a browser fails, and that blind spot
 * shipped a bridge no one could connect to. So the LAST describe block in this
 * file — "real browser → real bridge" — stubs nothing: it compiles and spawns
 * the actual bridge process and lets Chrome talk to it. Read the long comment
 * above that block for exactly what it does and does not cover.
 */
import { test, expect, type Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_KEY = 'review123:bridge'
const TOKEN = 'e2e-pairing-token-000000000000000000000000'

async function blockExternal(page: Page) {
  await page.route('**/*posthog.com/**', (route) => route.abort())
  await page.route('**/us.i.posthog.com/**', (route) => route.abort())
}

/**
 * Stub GET http://127.0.0.1:<port>/v1/health. Everything else falls through to
 * the real fetch, so the rest of the app is untouched.
 */
async function stubBridge(page: Page, body: Record<string, unknown>, status = 200) {
  await page.addInitScript(
    ({ payload, code }) => {
      const realFetch = window.fetch.bind(window)
      const calls: string[] = []
      ;(window as unknown as { __bridgeCalls: string[] }).__bridgeCalls = calls
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('127.0.0.1') && url.includes('/v1/health')) {
          calls.push(url)
          return Promise.resolve(
            new Response(JSON.stringify(payload), {
              status: code,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
        return realFetch(input as RequestInfo, init)
      }
    },
    { payload: body, code: status },
  )
}

/**
 * Stub a WHOLE working bridge: `/v1/health` plus `/v1/infer`.
 *
 * `infer` decides what the CLI "answers", chosen from the outgoing prompt the
 * same way the vendor stubs in the other specs do. Set `down` to make every
 * loopback call fail the way a stopped bridge does (a rejected fetch), which is
 * the mid-review disconnect this spec is really about.
 */
async function stubBridgeInference(
  page: Page,
  opts: {
    health: Record<string, unknown>
    answers: Record<string, string>
    down?: boolean
    /**
     * Answer `/v1/infer/stream` with real NDJSON instead of 404ing it.
     *
     * Absent is the OLDER-BRIDGE case, and it is the default on purpose: every
     * pre-existing test in this file then exercises the transparent fallback
     * to `/v1/infer`, which is exactly the behaviour a user on a bridge they
     * have not updated will get.
     */
    stream?: boolean
    /** ms of silence in the middle of a streamed answer, so a test can see it arrive in pieces. */
    streamGapMs?: number
  },
) {
  await page.addInitScript(
    ({ health, answers, down, stream, streamGapMs }) => {
      const realFetch = window.fetch.bind(window)
      const calls: { url: string; body: string | null }[] = []
      ;(window as unknown as { __bridgeCalls: typeof calls }).__bridgeCalls = calls

      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })

      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)

        const body = typeof init?.body === 'string' ? init.body : null
        calls.push({ url, body })

        // A bridge that is not running: the connection is refused, which the
        // browser surfaces as a rejected fetch (a TypeError).
        if (down) return Promise.reject(new TypeError('Failed to fetch'))

        if (url.includes('/v1/health')) return Promise.resolve(json(health))

        /** The CLI's "answer" for this prompt, chosen the way the vendor stubs do. */
        const answerFor = (): string => {
          const sent = (body ?? '').toLowerCase()
          const match = Object.keys(answers).find((needle) => sent.includes(needle.toLowerCase()))
          return match ? answers[match]! : answers['default'] ?? ''
        }

        // Checked BEFORE /v1/infer: the streaming path contains it as a prefix.
        if (url.includes('/v1/infer/stream')) {
          if (!stream) {
            // An older bridge: the route does not exist. Nothing was spawned,
            // so the client may fall back to /v1/infer for free.
            return Promise.resolve(
              json({ ok: false, error: 'not-found', message: 'No route POST /v1/infer/stream' }, 404),
            )
          }
          const text = answerFor()
          // Split in the middle so a test can watch half the answer render
          // while the other half is still in flight.
          const cut = Math.floor(text.length / 2)
          const encoder = new TextEncoder()
          const line = (event: unknown) => encoder.encode(JSON.stringify(event) + '\n')
          const ndjson = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(line({ type: 'start', cli: 'claude', streaming: true }))
              controller.enqueue(line({ type: 'delta', text: text.slice(0, cut) }))
              await new Promise((r) => setTimeout(r, streamGapMs ?? 0))
              controller.enqueue(line({ type: 'delta', text: text.slice(cut) }))
              controller.enqueue(line({ type: 'done', text, truncated: false, durationMs: 12 }))
              controller.close()
            },
          })
          return Promise.resolve(
            new Response(ndjson, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
          )
        }

        if (url.includes('/v1/infer')) {
          return Promise.resolve(
            json({ ok: true, cli: 'claude', text: answerFor(), truncated: false, durationMs: 12 }),
          )
        }
        return Promise.resolve(json({ ok: false, error: 'not-found', message: 'no' }, 404))
      }
    },
    {
      health: opts.health,
      answers: opts.answers,
      down: opts.down === true,
      stream: opts.stream === true,
      streamGapMs: opts.streamGapMs ?? 0,
    },
  )
}

/** Every non-loopback API host this spec must prove is NEVER called. */
async function forbidPaidProviders(page: Page) {
  await page.addInitScript(() => {
    const calls: string[] = []
    ;(window as unknown as { __paidCalls: string[] }).__paidCalls = calls
    const patched = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (
        url.includes('api.deepseek.com') ||
        url.includes('api.anthropic.com') ||
        url.includes('openrouter.ai') ||
        url.includes('generativelanguage.googleapis.com') ||
        url.includes('/api/llm/openai')
      ) {
        calls.push(url)
      }
      return patched(input as RequestInfo, init)
    }
  })
}

/** Record every loopback fetch WITHOUT stubbing anything, to prove silence. */
async function recordBridgeCalls(page: Page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    const calls: string[] = []
    ;(window as unknown as { __bridgeCalls: string[] }).__bridgeCalls = calls
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('127.0.0.1:7321') || url.includes('/v1/health')) calls.push(url)
      return realFetch(input as RequestInfo, init)
    }
  })
}

async function seedPairing(page: Page, port = 7321) {
  await page.addInitScript(
    ({ key, token, storedPort }) => {
      localStorage.setItem(key, JSON.stringify({ token, port: storedPort }))
    },
    { key: BRIDGE_KEY, token: TOKEN, storedPort: port },
  )
}

/** A plausible 40-hex commit id for the health fixtures. */
const BRIDGE_HEAD = 'abc1234567890abcdef1234567890abcdef12345'

function healthBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    protocol: 1,
    root: 'review123',
    capabilities: { inference: ['claude', 'codex'], infer: true, inferStream: true, files: true, search: true },
    git: { head: BRIDGE_HEAD, branch: 'main', dirty: false },
    version: '0.1.0',
    ...overrides,
  }
}

async function openSettings(page: Page) {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 5_000 })
}

test('no bridge paired: the section reads Not connected and NOTHING is requested from 127.0.0.1', async ({
  page,
}) => {
  await blockExternal(page)
  await recordBridgeCalls(page)

  await openSettings(page)

  const section = page.getByTestId('bridge-section')
  await expect(section).toBeVisible()
  await expect(page.getByTestId('bridge-status')).toHaveText(/not connected/i)

  // The whole point of the foundation: an unpaired user pays nothing.
  const calls = await page.evaluate(() => (window as unknown as { __bridgeCalls: string[] }).__bridgeCalls)
  expect(calls).toEqual([])
})

test('the section explains what pairing grants before offering the field', async ({ page }) => {
  await blockExternal(page)
  await openSettings(page)

  const section = page.getByTestId('bridge-section')
  await expect(section).toContainText(/read access to that repo/i)
  await expect(section).toContainText(/127\.0\.0\.1/)
  await expect(page.getByLabel(/bridge pairing token/i)).toBeVisible()
})

test('paired + bridge running: shows the repo, the detected CLIs and the port', async ({ page }) => {
  await blockExternal(page)
  await stubBridge(page, healthBody())
  await seedPairing(page)

  await openSettings(page)

  await expect(page.getByTestId('bridge-status')).toHaveText(/connected to review123/i, {
    timeout: 5_000,
  })
  await expect(page.getByTestId('bridge-root')).toHaveText('review123')
  await expect(page.getByTestId('bridge-clis')).toHaveText('claude, codex')
  await expect(page.getByTestId('bridge-section')).toContainText('127.0.0.1:7321')
  await expect(page.getByTestId('bridge-inference-note')).toContainText(/ready to run reviews/i)
  // Grounding: the section states WHERE the checkout is and the rule that
  // decides whether a given PR reads from it. It deliberately does not promise
  // "local" — no PR is open here, so it cannot know.
  await expect(page.getByTestId('bridge-grounding-note')).toContainText(/checked out at main \(abc1234\)/i)
  await expect(page.getByTestId('bridge-grounding-note')).toContainText(/head matches that commit/i)
})

test('a bridge with no grounding routes is told to update, not silently trusted', async ({ page }) => {
  await blockExternal(page)
  await stubBridge(
    page,
    healthBody({ capabilities: { inference: ['claude'], infer: true, files: false, search: false } }),
  )
  await seedPairing(page)

  await openSettings(page)

  await expect(page.getByTestId('bridge-grounding-note')).toContainText(/too old to serve repo files/i, {
    timeout: 5_000,
  })
})

test('a bridge serving a non-repo says so, instead of implying it can ground a review', async ({ page }) => {
  await blockExternal(page)
  await stubBridge(page, healthBody({ git: null }))
  await seedPairing(page)

  await openSettings(page)

  await expect(page.getByTestId('bridge-grounding-note')).toContainText(/not a git repository/i, {
    timeout: 5_000,
  })
})

test('an OLDER bridge — health but no infer route — is told to update, not silently used', async ({
  page,
}) => {
  await blockExternal(page)
  // Same protocol version, CLIs detected, but no `infer` readiness flag.
  await stubBridge(
    page,
    healthBody({ capabilities: { inference: ['claude'], files: false, search: false } }),
  )
  await seedPairing(page)

  await openSettings(page)

  await expect(page.getByTestId('bridge-inference-note')).toContainText(/too old to run inference/i, {
    timeout: 5_000,
  })
})

test('the AI models picker offers the bridge as a source, with no API key field', async ({ page }) => {
  await blockExternal(page)
  await stubBridge(page, healthBody())
  await seedPairing(page)

  await openSettings(page)

  const radio = page.getByRole('radio', { name: 'Local bridge' })
  await expect(radio).toBeVisible()
  await expect(page.getByLabel(/local bridge api key/i)).toHaveCount(0)
  await expect(page.getByTestId('bridge-source-status')).toContainText(/no api key/i, {
    timeout: 5_000,
  })

  await radio.check()
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('review123:settings') ?? '{}'),
  )
  expect(stored.aiProvider).toBe('bridge')
})

test('paired but the bridge is NOT running: a calm status, no error alert', async ({ page }) => {
  await blockExternal(page)
  await seedPairing(page)
  // No stub at all: the fetch to 127.0.0.1:7321 genuinely fails.

  await openSettings(page)

  await expect(page.getByTestId('bridge-status')).toHaveText(/the bridge is not running/i, {
    timeout: 8_000,
  })
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('pairing by hand: paste the token, connect, then disconnect', async ({ page }) => {
  await blockExternal(page)
  await stubBridge(page, healthBody({ root: 'my-checkout', capabilities: { inference: ['claude'], files: false, search: false } }))

  await openSettings(page)

  await page.getByLabel(/bridge pairing token/i).fill(TOKEN)
  await page.getByRole('button', { name: /^connect$/i }).click()

  await expect(page.getByTestId('bridge-status')).toHaveText(/connected to my-checkout/i, {
    timeout: 5_000,
  })
  await expect(page.getByTestId('bridge-clis')).toHaveText('claude')

  // The token is remembered for the next visit.
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
    BRIDGE_KEY,
  )
  expect(stored).toMatchObject({ token: TOKEN, port: 7321 })

  await page.getByRole('button', { name: /disconnect/i }).click()
  await expect(page.getByTestId('bridge-status')).toHaveText(/not connected/i)
  const cleared = await page.evaluate((key) => localStorage.getItem(key), BRIDGE_KEY)
  expect(cleared).toBeNull()
})

test('a wrong token is reported without connecting, and is not stored', async ({ page }) => {
  await blockExternal(page)
  await stubBridge(page, { ok: false, error: 'unauthorized', message: 'nope' }, 401)

  await openSettings(page)

  await page.getByLabel(/bridge pairing token/i).fill('stale-token')
  await page.getByRole('button', { name: /^connect$/i }).click()

  await expect(page.getByRole('alert')).toContainText(/rejected/i, { timeout: 5_000 })
  await expect(page.getByTestId('bridge-status')).toHaveText(/not connected/i)
  const stored = await page.evaluate((key) => localStorage.getItem(key), BRIDGE_KEY)
  expect(stored).toBeNull()
})

test('the rest of the app is unchanged with no bridge: the landing page still loads', async ({
  page,
}) => {
  await blockExternal(page)
  await recordBridgeCalls(page)

  await page.goto('/')
  await expect(page.getByRole('button', { name: /settings/i })).toBeVisible({ timeout: 5_000 })

  const calls = await page.evaluate(() => (window as unknown as { __bridgeCalls: string[] }).__bridgeCalls)
  expect(calls).toEqual([])
})

// ===========================================================================
// Inference THROUGH the bridge
// ===========================================================================

const OWNER = 'testorg'
const REPO = 'testrepo'
const PR_NUMBER = 42
// A real 40-hex sha, because grounding compares it against the one the bridge
// reports and the client refuses anything that is not a full commit id.
const HEAD_SHA = BRIDGE_HEAD
const BASE_SHA = 'def0987654321fedcba0987654321fedcba09876'
const APP_REVIEW_PATH = `/review/github/${OWNER}/${REPO}/${PR_NUMBER}`

const PATCH = `@@ -1,3 +1,4 @@
 unchanged line
-removed line
+added line
+another added line
 trailing context`

/** The text the stubbed CLI "answers" the summary task with. */
const BRIDGE_SUMMARY =
  'Reviewed by your local CLI.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

function fileContent(text: string) {
  return { content: Buffer.from(text).toString('base64') + '\n', encoding: 'base64' }
}

async function setupGithub(page: Page) {
  await page.route('**/api.github.com/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`) {
      return route.fulfill({
        json: {
          title: 'Test PR: add feature',
          state: 'open',
          merged: false,
          body: 'This PR adds a new feature.',
          base: { sha: BASE_SHA, repo: { private: false } },
          head: { sha: HEAD_SHA },
          changed_files: 1,
        },
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`) {
      return route.fulfill({
        json: [{ filename: 'src/feature.ts', status: 'modified', patch: PATCH, additions: 2, deletions: 1 }],
      })
    }
    if (path === `/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs`) {
      return route.fulfill({ json: { total_count: 0, check_runs: [] } })
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/contents/`)) {
      const ref = url.searchParams.get('ref') ?? ''
      if (ref === BASE_SHA) return route.fulfill({ json: fileContent('const old = 1\nremoved line\ntrailing context') })
      if (ref === HEAD_SHA) return route.fulfill({ json: fileContent('const old = 1\nunchanged line\nadded line\nanother added line\ntrailing context') })
      return route.fulfill({ status: 404, json: { message: 'Not Found' } })
    }
    if (path.endsWith('/comments') || path.endsWith('/commits')) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
}

/**
 * Settings with the bridge selected AND a paid key present.
 *
 * The key is the whole point: it is what a silent fallback would spend.
 */
async function seedBridgeAsProvider(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({
        aiProvider: 'bridge',
        aiModel: 'claude',
        deepseekKey: 'sk-test-deepseek-key',
        diffMode: 'unified',
      }),
    )
    localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
  })
}

test('a review task is answered BY THE BRIDGE, and no paid provider is called', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await stubBridgeInference(page, {
    health: healthBody(),
    answers: {
      // The summary task is the one whose output is rendered verbatim.
      'reading-order': BRIDGE_SUMMARY,
      default: JSON.stringify({ level: 'minor-changes', evidence: [], notAnalyzed: [] }),
    },
  })
  await forbidPaidProviders(page)
  await seedPairing(page)
  await seedBridgeAsProvider(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })

  // The CLI's answer reached the UI. Attached, not visible: the AI detail
  // panels render collapsed by default, exactly as the other review specs
  // assert.
  await expect(page.getByText(/reviewed by your local cli/i).first()).toBeAttached({
    timeout: 20_000,
  })

  // It went to the loopback /v1/infer route…
  const bridgeCalls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  expect(bridgeCalls.some((c) => c.url.includes('/v1/infer'))).toBe(true)

  // …carrying a CLI ID and the prompt on the body — never a command.
  const infer = bridgeCalls.find((c) => c.url.includes('/v1/infer'))!
  const sent = JSON.parse(infer.body ?? '{}')
  expect(sent.cli).toBe('claude')
  expect(typeof sent.prompt).toBe('string')
  expect(Object.keys(sent).sort()).toEqual(['cli', 'prompt', 'system', 'timeoutMs'])

  // …and the configured DeepSeek key was never spent.
  const paid = await page.evaluate(() => (window as unknown as { __paidCalls: string[] }).__paidCalls)
  expect(paid).toEqual([])
})

// ===========================================================================
// STREAMING through the bridge — the thing users feel every session.
//
// #238 shipped inference with the whole answer in one delta, so the summary
// panel sat blank for the length of a CLI turn and then filled instantly.
// These two tests pin the two halves of the fix: a bridge that HAS the
// streaming route renders the answer progressively, and a bridge that does NOT
// still answers, through the one-shot route, without spending an API key.
// ===========================================================================

/** The first half of the streamed summary — rendered while the rest is still coming. */
const STREAM_HEAD = 'Reviewed live by your local CLI, arriving as it is written. '
/** The second half, held back by streamGapMs so the two are distinguishable. */
const STREAM_TAIL = 'The second half landed later.\n\n===READING-ORDER===\nsrc/feature.ts\n===END==='

test('streaming bridge: the summary renders PROGRESSIVELY, not all at once', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await stubBridgeInference(page, {
    health: healthBody(),
    answers: {
      'reading-order': STREAM_HEAD + STREAM_TAIL,
      default: JSON.stringify({ level: 'minor-changes', evidence: [], notAnalyzed: [] }),
    },
    stream: true,
    // Long enough that "the first half is on screen and the second is not" is
    // a fact rather than a race.
    streamGapMs: 2_500,
  })
  await forbidPaidProviders(page)
  await seedPairing(page)
  await seedBridgeAsProvider(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })

  // THE POINT OF THE WHOLE PR: the opening of the answer is in the DOM while
  // the rest of it is still on the wire.
  await expect(page.getByText(/arriving as it is written/i).first()).toBeAttached({
    timeout: 25_000,
  })
  await expect(page.getByText(/the second half landed later/i)).toHaveCount(0)

  // …and then the rest arrives and completes the answer.
  await expect(page.getByText(/the second half landed later/i).first()).toBeAttached({
    timeout: 25_000,
  })

  // The SUMMARY went to the streaming route. (The review's other tasks are
  // single-shot JSON calls and legitimately use `/v1/infer`; only the tasks
  // that stream — summary and Ask — use this one.)
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  const streamCalls = calls.filter((c) => c.url.includes('/v1/infer/stream'))
  expect(streamCalls.length).toBeGreaterThan(0)
  expect(streamCalls.some((c) => (c.body ?? '').toLowerCase().includes('reading-order'))).toBe(true)

  // Still a CLI id and a prompt on the body — never a command.
  const streamed = calls.find((c) => c.url.includes('/v1/infer/stream'))!
  const sent = JSON.parse(streamed.body ?? '{}')
  expect(sent.cli).toBe('claude')
  expect(Object.keys(sent).sort()).toEqual(['cli', 'prompt', 'system', 'timeoutMs'])

  const paid = await page.evaluate(() => (window as unknown as { __paidCalls: string[] }).__paidCalls)
  expect(paid).toEqual([])
})

test('an OLDER bridge with no streaming route still answers, via the one-shot route', async ({
  page,
}) => {
  await blockExternal(page)
  await setupGithub(page)
  // `stream` absent → /v1/infer/stream 404s, exactly as a pre-streaming bridge
  // does. Nothing was spawned to produce that 404, so the fallback is free.
  await stubBridgeInference(page, {
    health: healthBody({
      capabilities: { inference: ['claude'], infer: true, files: true, search: true },
    }),
    answers: {
      'reading-order': BRIDGE_SUMMARY,
      default: JSON.stringify({ level: 'minor-changes', evidence: [], notAnalyzed: [] }),
    },
  })
  await forbidPaidProviders(page)
  await seedPairing(page)
  await seedBridgeAsProvider(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByText(/reviewed by your local cli/i).first()).toBeAttached({
    timeout: 25_000,
  })

  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  // It TRIED the streaming route, was told it does not exist, and fell back.
  expect(calls.some((c) => c.url.includes('/v1/infer/stream'))).toBe(true)
  expect(calls.some((c) => /\/v1\/infer$/.test(c.url))).toBe(true)

  // The fallback is to the bridge's OWN other route — never to a paid one.
  const paid = await page.evaluate(() => (window as unknown as { __paidCalls: string[] }).__paidCalls)
  expect(paid).toEqual([])
})

test('bridge DOWN mid-review: an honest error, and still no silent paid fallback', async ({
  page,
}) => {
  await blockExternal(page)
  await setupGithub(page)
  // Every loopback call fails, exactly as it does when the terminal was closed.
  await stubBridgeInference(page, { health: healthBody(), answers: {}, down: true })
  await forbidPaidProviders(page)
  await seedPairing(page)
  await seedBridgeAsProvider(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })

  // The failure is VISIBLE and says what to do about it.
  const errorPanel = page.locator('.ai-panel-error').first()
  await expect(errorPanel).toBeAttached({ timeout: 25_000 })
  await expect(errorPanel).toContainText(/local bridge is not responding/i)

  // THE INVARIANT: a DeepSeek key is sitting right there, and it was not used.
  // Falling back would spend the user's money on a run they deliberately put on
  // their own subscription.
  const paid = await page.evaluate(() => (window as unknown as { __paidCalls: string[] }).__paidCalls)
  expect(paid).toEqual([])
})

// ===========================================================================
// GROUNDING through the bridge — where a review's code comes from.
//
// The rule these tests exist for: local files are used ONLY when the bridge's
// head sha equals the PR's. A mismatch must fall back to GitHub AND say so,
// because a silent fallback is indistinguishable from the far worse failure —
// silently grounding a review in another branch's code.
// ===========================================================================

/**
 * Stub `/v1/health` plus `/v1/files`, recording every loopback call so a test
 * can assert not only what happened but what did NOT.
 */
async function stubBridgeGrounding(
  page: Page,
  opts: { health: Record<string, unknown>; contents?: Record<string, string> },
) {
  await page.addInitScript(
    ({ health, contents }) => {
      const realFetch = window.fetch.bind(window)
      const calls: { url: string; body: string | null }[] = []
      ;(window as unknown as { __bridgeCalls: typeof calls }).__bridgeCalls = calls

      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })

      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)

        const body = typeof init?.body === 'string' ? init.body : null
        calls.push({ url, body })

        if (url.includes('/v1/health')) return Promise.resolve(json(health))

        if (url.includes('/v1/files')) {
          const asked = (JSON.parse(body ?? '{}') as { paths?: string[] }).paths ?? []
          const files = asked
            .filter((p) => p in contents)
            .map((p) => ({
              path: p,
              bytes: contents[p]!.length,
              truncated: false,
              content: contents[p]!,
              encoding: 'utf-8',
            }))
          const missing = asked.filter((p) => !(p in contents))
          return Promise.resolve(json({ ok: true, files, missing, skipped: [] }))
        }
        return Promise.resolve(json({ ok: false, error: 'not-found', message: 'no' }, 404))
      }
    },
    { health: opts.health, contents: opts.contents ?? {} },
  )
}

/** File content only the LOCAL bridge serves — GitHub's copy is different. */
const LOCAL_ONLY_CONTENT = 'const fromLocalCheckout = true\n'

test('head MATCHES: the review reads code from the local checkout, and says so', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await stubBridgeGrounding(page, {
    health: healthBody(),
    contents: { 'src/feature.ts': LOCAL_ONLY_CONTENT },
  })
  await seedPairing(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })

  const indicator = page.getByTestId('grounding-indicator')
  await expect(indicator).toHaveAttribute('data-mode', 'local', { timeout: 10_000 })
  await expect(indicator).toHaveAttribute('data-reason', 'local-clean')
  await expect(page.getByTestId('grounding-label')).toContainText(/local checkout/i)

  // Not just the label: the bridge was actually asked for the file.
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  const fileCalls = calls.filter((c) => c.url.includes('/v1/files'))
  expect(fileCalls.length).toBeGreaterThan(0)
  expect(fileCalls.some((c) => (c.body ?? '').includes('src/feature.ts'))).toBe(true)
})

test('head MISMATCH: the review falls back to GitHub and names both shas', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  // The user's terminal is on main; this PR is not.
  await stubBridgeGrounding(page, {
    health: healthBody({
      git: { head: 'fee1111111111111111111111111111111111111', branch: 'main', dirty: false },
    }),
    contents: { 'src/feature.ts': LOCAL_ONLY_CONTENT },
  })
  await seedPairing(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })

  const indicator = page.getByTestId('grounding-indicator')
  await expect(indicator).toHaveAttribute('data-mode', 'github', { timeout: 10_000 })
  await expect(indicator).toHaveAttribute('data-reason', 'head-mismatch')

  // The sentence names the branch and BOTH short shas, so the user can act on it.
  const why = page.getByTestId('grounding-why')
  await expect(why).toContainText('main')
  await expect(why).toContainText('fee1111')
  await expect(why).toContainText(HEAD_SHA.slice(0, 7))

  // THE INVARIANT: not one file was read from the wrong checkout.
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  expect(calls.filter((c) => c.url.includes('/v1/files'))).toEqual([])
})

test('a DIRTY matching checkout is used, but flagged as possibly-uncommitted code', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await stubBridgeGrounding(page, {
    health: healthBody({ git: { head: HEAD_SHA, branch: 'feat/thing', dirty: true } }),
    contents: { 'src/feature.ts': LOCAL_ONLY_CONTENT },
  })
  await seedPairing(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })

  const indicator = page.getByTestId('grounding-indicator')
  await expect(indicator).toHaveAttribute('data-reason', 'local-dirty', { timeout: 10_000 })
  await expect(page.getByTestId('grounding-why')).toContainText(/in no commit of this PR/i)
})

test('with NO bridge paired, the review says nothing about grounding at all', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await recordBridgeCalls(page)

  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })

  // Reading from GitHub is the unremarkable default; telling someone who has
  // never heard of the bridge that they are "falling back" is noise, not honesty.
  await expect(page.getByTestId('grounding-indicator')).toHaveCount(0)
  const calls = await page.evaluate(() => (window as unknown as { __bridgeCalls: string[] }).__bridgeCalls)
  expect(calls).toEqual([])
})

// ===========================================================================
// THE AGENT FIX LOOP — findings straight to the user's coding agent.
//
// The rule these tests exist for: only a finding with a CONCRETE fix is sent.
// The honest "No clean fix — <tradeoff>" form is a judgment call and must
// never be handed to a machine, and a read-only bridge must never be offered
// as a write one — that flag lives at the user's terminal, not in a web page.
// ===========================================================================

/** A reviewer skill, seeded the way skill-reviewers.spec.ts seeds one. */
const FIX_SKILL_ID = 'skill-e2e-fix'

/**
 * Three findings that exercise the whole routing rule:
 *   - two with a CONCRETE fix, high severity   → eligible, offered, selected
 *   - one with the "No clean fix — …" form     → NEVER offered to the agent
 */
const FIX_REVIEW_RESULT = {
  skillName: 'Security Reviewer',
  findings: [
    {
      path: 'src/feature.ts',
      line: 2,
      severity: 'high',
      body: 'Unescaped user input reaches the DOM',
      suggestedFix: 'Escape it with `sanitizeHtml(input)` before rendering.',
    },
    {
      path: 'src/feature.ts',
      line: 3,
      severity: 'high',
      body: 'The loop reads one past the end of the array',
      suggestedFix: 'Change the loop bound to `i < items.length`.',
    },
    {
      path: 'src/feature.ts',
      line: 4,
      severity: 'high',
      body: 'This query is N+1 across the request',
      suggestedFix: 'No clean fix — batching adds latency; accept the N+1 here or restructure the caller.',
    },
  ],
}

function fixSettings() {
  return {
    deepseekKey: 'sk-test-deepseek-key',
    diffMode: 'unified',
    railCollapsed: false,
    // Deterministic: this spec clicks "Run my reviewers" itself.
    autoRunReviewers: false,
  }
}

async function seedFixSkill(page: Page) {
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem(
        'review123:reviewer-skills',
        JSON.stringify([
          {
            id,
            name: 'Security Reviewer',
            content: '## Security\nCheck for XSS and injection vulnerabilities.',
            enabled: true,
            addedAt: 1700000000000,
          },
        ]),
      )
      localStorage.setItem('review123:ai-consent', JSON.stringify({ public: true, private: false }))
    },
    { id: FIX_SKILL_ID },
  )
}

/** DeepSeek stub that answers the reviewer, convergence and simplify passes. */
async function setupReviewerProvider(page: Page) {
  await page.route('**/api.deepseek.com/**', async (route) => {
    let body: { stream?: boolean; messages?: { role: string; content: string }[] } = {}
    try {
      body = route.request().postDataJSON() as typeof body
    } catch {
      /* non-JSON body */
    }
    const json = (content: unknown) =>
      route.fulfill({
        status: 200,
        json: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop', index: 0 }],
        },
      })

    if (body?.stream === true) {
      const chunk = {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        choices: [{ delta: { content: 'Summary. ' }, index: 0, finish_reason: null }],
      }
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body: `data: ${JSON.stringify(chunk)}\ndata: [DONE]\n`,
      })
    }

    const system = (body?.messages?.find((m) => m.role === 'system')?.content ?? '').toLowerCase()
    if (system.includes('consolidating overlapping code-review findings')) return json({ clusters: [] })
    if (system.includes('rewriting code-review findings into plain')) return json({ rewrites: [] })
    if (system.includes('reviewer persona') || system.includes('security reviewer')) {
      return json(FIX_REVIEW_RESULT)
    }
    return json({ level: 'minor-changes', evidence: [], notAnalyzed: [] })
  })
}

interface FixStubOptions {
  /** `capabilities.fix` — the bridge's `--allow-write` flag. */
  writeEnabled: boolean
  /** When set, `/v1/fix` answers with this status + body instead of succeeding. */
  refuse?: { status: number; error: string; message: string }
}

/**
 * Stub a whole bridge: `/v1/health`, `/v1/files` (grounding reads it) and
 * `/v1/fix`. The fix stub ECHOES the ids it was sent, so the test can assert
 * that each returned commit lands against the finding it came from.
 */
async function stubBridgeFix(page: Page, opts: FixStubOptions) {
  await page.addInitScript(
    ({ health, refuse }) => {
      const realFetch = window.fetch.bind(window)
      const calls: { url: string; body: string | null }[] = []
      ;(window as unknown as { __bridgeCalls: typeof calls }).__bridgeCalls = calls

      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)

        const body = typeof init?.body === 'string' ? init.body : null
        calls.push({ url, body })

        if (url.includes('/v1/health')) return Promise.resolve(json(health))
        if (url.includes('/v1/files')) {
          const asked = (JSON.parse(body ?? '{}') as { paths?: string[] }).paths ?? []
          return Promise.resolve(json({ ok: true, files: [], missing: asked, skipped: [] }))
        }
        if (url.includes('/v1/fix')) {
          if (refuse) {
            return Promise.resolve(
              json({ ok: false, error: refuse.error, message: refuse.message }, refuse.status),
            )
          }
          const sent = JSON.parse(body ?? '{}') as {
            findings?: { id: string; path: string }[]
            headSha?: string
          }
          const findings = sent.findings ?? []
          const sha = (n: number) => String(n).repeat(40).slice(0, 40)
          return Promise.resolve(
            json({
              ok: true,
              cli: 'claude',
              baseSha: sent.headSha,
              branch: 'review123/fix/abc1234567890',
              changes: findings.map((f, i) => ({
                findingId: f.id,
                commit: sha(i + 1),
                subject: `fix: change ${i + 1}`,
                intent: `Agent intent ${i + 1}: made the smallest change that addresses it.`,
                files: [f.path],
                diff: `--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n-old ${i}\n+new ${i}\n`,
                truncated: false,
                rounds: 1,
                stopReason: 'all-addressed',
                tests: { status: 'passed', command: 'pnpm test', durationMs: 900, output: '1 passing' },
              })),
              skipped: [],
              rounds: 1,
              stopReason: 'all-addressed',
              tests: { status: 'passed', command: 'pnpm test', durationMs: 900, output: '1 passing' },
              durationMs: 4200,
            }),
          )
        }
        return Promise.resolve(json({ ok: false, error: 'not-found', message: 'no' }, 404))
      }
    },
    {
      health: healthBody({
        capabilities: {
          inference: ['claude'],
          infer: true,
          files: true,
          search: true,
          fix: opts.writeEnabled,
        },
      }),
      refuse: opts.refuse ?? null,
    },
  )
}

/** Load the review, run the reviewers, and land on the Inspect step. */
async function runReviewers(page: Page) {
  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('group', { name: 'Diff mode' })).toBeVisible()
  await page.getByRole('button', { name: /run my reviewers \(1\)/i }).click()
  await expect(page.getByText(/Unescaped user input reaches the DOM/i).first()).toBeVisible({
    timeout: 20_000,
  })
}

test('fix loop: two eligible findings go to the agent, one is approved and one rejected', async ({
  page,
}) => {
  await blockExternal(page)
  await setupGithub(page)
  await setupReviewerProvider(page)
  await stubBridgeFix(page, { writeEnabled: true })
  await seedPairing(page)
  await seedFixSkill(page)
  await page.addInitScript((s) => localStorage.setItem('review123:settings', JSON.stringify(s)), fixSettings())

  await runReviewers(page)

  const panel = page.getByTestId('agent-fix-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(panel).toHaveAttribute('data-ready', 'true')

  // THE ROUTING RULE, on screen: the two concrete fixes are offered, and the
  // "No clean fix — tradeoff" finding is NOT — it stays with the human.
  const candidates = panel.getByTestId('agent-fix-candidate')
  await expect(candidates).toHaveCount(2)
  await expect(panel).toContainText('Unescaped user input reaches the DOM')
  await expect(panel).toContainText('The loop reads one past the end')
  await expect(panel).not.toContainText('This query is N+1')

  // Everything eligible starts ticked — the user unticks what they keep.
  await expect(panel.getByTestId('agent-fix-count')).toHaveText(/2 of 2 selected/)
  for (const box of await panel.getByTestId('agent-fix-checkbox').all()) {
    await expect(box).toBeChecked()
  }

  await panel.getByTestId('agent-fix-send').click()

  // Two attributed commits come back, each against the finding it came from.
  const results = panel.getByTestId('agent-fix-result')
  await expect(results).toHaveCount(2, { timeout: 15_000 })
  await expect(results.first().getByTestId('agent-fix-intent')).toContainText('Agent intent 1')
  await expect(results.nth(1).getByTestId('agent-fix-intent')).toContainText('Agent intent 2')
  await expect(results.first().getByTestId('agent-fix-tests')).toHaveAttribute('data-status', 'passed')

  // The diff is there to read before deciding.
  await results.first().getByTestId('agent-fix-diff').locator('summary').click()
  await expect(results.first().getByTestId('agent-fix-diff')).toContainText('+new 0')

  // What the bridge was actually sent: ids for the two eligible findings and a
  // sha — no command, no cwd, no environment.
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  const fixCall = calls.find((c) => c.url.includes('/v1/fix'))!
  const sent = JSON.parse(fixCall.body ?? '{}')
  expect(Object.keys(sent).sort()).toEqual(['cli', 'findings', 'headSha'])
  expect(sent.headSha).toBe(HEAD_SHA)
  expect(sent.findings).toHaveLength(2)
  expect(sent.findings.every((f: { suggestedFix: string }) => !/^no clean fix/i.test(f.suggestedFix))).toBe(true)

  // ---- Approve one, reject the other ----
  await results.first().getByTestId('agent-fix-approve').click()
  await results.nth(1).getByTestId('agent-fix-reject').click()
  await expect(results.first()).toHaveAttribute('data-verdict', 'approved')
  await expect(results.nth(1)).toHaveAttribute('data-verdict', 'rejected')

  // The cherry-pick line carries ONLY the approved commit — that is what
  // "accept four of six" means, and it is the user's own command to run.
  const cherry = panel.getByTestId('agent-fix-cherry-pick')
  await expect(cherry).toContainText('git cherry-pick 111111111111')
  await expect(cherry).not.toContainText('222222222222')
  await expect(panel).toContainText(/Nothing has been applied/i)
})

test('fix loop: a READ-ONLY bridge is never offered as a write one', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await setupReviewerProvider(page)
  // Same bridge, same CLIs, same matching checkout — only --allow-write is off.
  await stubBridgeFix(page, { writeEnabled: false })
  await seedPairing(page)
  await seedFixSkill(page)
  await page.addInitScript((s) => localStorage.setItem('review123:settings', JSON.stringify(s)), fixSettings())

  await runReviewers(page)

  const panel = page.getByTestId('agent-fix-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(panel).toHaveAttribute('data-ready', 'false')
  // It says WHY, and that only the terminal can change it.
  await expect(panel.getByTestId('agent-fix-readiness')).toHaveAttribute('data-reason', 'write-disabled')
  await expect(panel.getByTestId('agent-fix-readiness')).toContainText('--allow-write')
  // No way in: no selection, no send button.
  await expect(panel.getByTestId('agent-fix-send')).toHaveCount(0)
  await expect(panel.getByTestId('agent-fix-candidate')).toHaveCount(0)

  // THE INVARIANT: the route was never called.
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  expect(calls.filter((c) => c.url.includes('/v1/fix'))).toEqual([])
})

test('fix loop: a bridge that refuses mid-run says so, and applies nothing', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await setupReviewerProvider(page)
  // The bridge ADVERTISES write capability but refuses the call — the race
  // where the user restarted it read-only between the health probe and the run.
  await stubBridgeFix(page, {
    writeEnabled: true,
    refuse: { status: 403, error: 'write-disabled', message: 'This bridge is read-only.' },
  })
  await seedPairing(page)
  await seedFixSkill(page)
  await page.addInitScript((s) => localStorage.setItem('review123:settings', JSON.stringify(s)), fixSettings())

  await runReviewers(page)

  const panel = page.getByTestId('agent-fix-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await panel.getByTestId('agent-fix-send').click()

  const error = panel.getByTestId('agent-fix-error')
  await expect(error).toBeVisible({ timeout: 15_000 })
  await expect(error).toHaveAttribute('data-kind', 'write-disabled')
  await expect(error).toContainText('--allow-write')
  // A failure is a failure: no results surface, nothing to approve.
  await expect(panel.getByTestId('agent-fix-result')).toHaveCount(0)
  await expect(panel.getByTestId('agent-fix-cherry-pick')).toHaveCount(0)
})

test('fix loop: a checkout on another commit is told so, not quietly used', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await setupReviewerProvider(page)
  await page.addInitScript(
    ({ health }) => {
      const realFetch = window.fetch.bind(window)
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)
        const json = (p: unknown, s = 200) =>
          new Response(JSON.stringify(p), { status: s, headers: { 'Content-Type': 'application/json' } })
        if (url.includes('/v1/health')) return Promise.resolve(json(health))
        return Promise.resolve(json({ ok: false, error: 'not-found', message: 'no' }, 404))
      }
    },
    {
      health: healthBody({
        capabilities: { inference: ['claude'], infer: true, files: true, search: true, fix: true },
        git: { head: 'fee1111111111111111111111111111111111111', branch: 'main', dirty: false },
      }),
    },
  )
  await seedPairing(page)
  await seedFixSkill(page)
  await page.addInitScript((s) => localStorage.setItem('review123:settings', JSON.stringify(s)), fixSettings())

  await runReviewers(page)

  const readiness = page.getByTestId('agent-fix-panel').getByTestId('agent-fix-readiness')
  await expect(readiness).toHaveAttribute('data-reason', 'head-mismatch', { timeout: 10_000 })
  // It names the branch and BOTH short shas, so the user can act on it.
  await expect(readiness).toContainText('main')
  await expect(readiness).toContainText('fee1111')
  await expect(readiness).toContainText(HEAD_SHA.slice(0, 7))
  await expect(page.getByTestId('agent-fix-send')).toHaveCount(0)
})

// ===========================================================================
// RUN THIS PR — check the pull request out in the user's own repo so the dev
// server they already have running serves it.
//
// This is the only feature that moves the user's working tree, and it has its
// own grant (--allow-checkout) precisely so that enabling the fix loop does
// not silently enable it. These tests walk the whole round trip — check out,
// indicator, preview points local, restore — and pin the two gates that must
// never soften: the flag, and the "this runs its code" confirmation.
// ===========================================================================

/** The commit the PR ref resolves to once checked out — the PR's own head. */
const CHECKED_OUT_SHA = HEAD_SHA
/** Where the user's checkout sits before anything happens. */
const MAIN_SHA = 'fee1111111111111111111111111111111111111'
const LOCAL_APP_URL = 'http://localhost:8010'

interface StackStubOptions {
  /** `--allow-checkout`. False → capabilities.checkout false and a 403. */
  checkoutEnabled: boolean
  /** Start already ON the pull request, to test the indicator and restore. */
  startOnPr?: boolean
  /** Is the dev server answering? */
  appReachable?: boolean
  /** Make the checkout call refuse with this. */
  refuse?: { status: number; error: string; message: string; dirtyPaths?: string[]; dirtyCount?: number }
  /** Report the tree as dirty, with these paths. */
  dirty?: string[]
}

/**
 * Stub a bridge that speaks the stack routes.
 *
 * Stateful on purpose: a checkout flips the stubbed tree onto the PR and a
 * restore flips it back, so the test drives the SAME transitions the real
 * thing does rather than asserting against three unrelated fixtures.
 */
async function stubBridgeStack(page: Page, opts: StackStubOptions) {
  await page.addInitScript(
    ({ health, config }) => {
      const realFetch = window.fetch.bind(window)
      const calls: { url: string; body: string | null }[] = []
      ;(window as unknown as { __bridgeCalls: typeof calls }).__bridgeCalls = calls

      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

      // The stub's own mutable world.
      let onPr = config.startOnPr
      let prior: unknown = config.startOnPr
        ? {
            branch: 'main',
            head: config.mainSha,
            recordedAt: '2026-01-01T00:00:00.000Z',
            checkedOutRef: 'refs/pull/42/head',
            checkedOutSha: config.prSha,
            stashRef: null,
          }
        : null

      const app = () => ({
        url: config.appUrl,
        source: 'posthog',
        reachable: config.appReachable,
        detail: 'This is a PostHog checkout, whose dev stack is fronted at port 8010.',
      })
      const git = () =>
        onPr
          ? { head: config.prSha, branch: null, dirty: false }
          : { head: config.mainSha, branch: 'main', dirty: config.dirty.length > 0 }

      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes('127.0.0.1')) return realFetch(input as RequestInfo, init)

        const body = typeof init?.body === 'string' ? init.body : null
        calls.push({ url, body })

        if (url.includes('/v1/health')) return Promise.resolve(json(health))
        if (url.includes('/v1/files')) {
          const asked = (JSON.parse(body ?? '{}') as { paths?: string[] }).paths ?? []
          return Promise.resolve(json({ ok: true, files: [], missing: asked, skipped: [] }))
        }
        if (url.includes('/v1/stack')) {
          return Promise.resolve(
            json({
              ok: true,
              git: git(),
              dirtyPaths: onPr ? [] : config.dirty,
              dirtyCount: onPr ? 0 : config.dirty.length,
              prior,
              app: app(),
              checkoutEnabled: config.checkoutEnabled,
            }),
          )
        }
        if (url.includes('/v1/checkout')) {
          if (!config.checkoutEnabled) {
            return Promise.resolve(
              json(
                {
                  ok: false,
                  error: 'checkout-disabled',
                  message:
                    'This bridge may not change your working tree. Restart it with --allow-checkout. (--allow-write does not enable this.)',
                },
                403,
              ),
            )
          }
          if (config.refuse) {
            return Promise.resolve(json({ ok: false, ...config.refuse }, config.refuse.status))
          }
          onPr = true
          prior = {
            branch: 'main',
            head: config.mainSha,
            recordedAt: '2026-01-01T00:00:00.000Z',
            checkedOutRef: 'refs/pull/42/head',
            checkedOutSha: config.prSha,
            stashRef: null,
          }
          return Promise.resolve(json({ ok: true, git: git(), prior, stash: null, app: app() }))
        }
        if (url.includes('/v1/restore')) {
          if (!config.checkoutEnabled) {
            return Promise.resolve(
              json({ ok: false, error: 'checkout-disabled', message: 'read-only' }, 403),
            )
          }
          onPr = false
          prior = null
          return Promise.resolve(json({ ok: true, git: git(), prior: null, stash: null, app: app() }))
        }
        return Promise.resolve(json({ ok: false, error: 'not-found', message: 'no' }, 404))
      }
    },
    {
      health: healthBody({
        capabilities: {
          inference: ['claude'],
          infer: true,
          files: true,
          search: true,
          // The fix grant is ON in every one of these fixtures, so that
          // "checkout is refused" can never be explained by a read-only bridge.
          fix: true,
          checkout: opts.checkoutEnabled,
        },
        git: { head: MAIN_SHA, branch: 'main', dirty: false },
      }),
      config: {
        checkoutEnabled: opts.checkoutEnabled,
        startOnPr: opts.startOnPr === true,
        appReachable: opts.appReachable !== false,
        appUrl: LOCAL_APP_URL,
        mainSha: MAIN_SHA,
        prSha: CHECKED_OUT_SHA,
        refuse: opts.refuse ?? null,
        dirty: opts.dirty ?? [],
      },
    },
  )
}

async function openReview(page: Page) {
  await page.goto(APP_REVIEW_PATH)
  await expect(page.getByRole('heading', { name: /Test PR: add feature/i })).toBeVisible({
    timeout: 10_000,
  })
}

test('run this PR: check out → indicator → preview points at the local app → restore', async ({
  page,
}) => {
  await blockExternal(page)
  await setupGithub(page)
  await stubBridgeStack(page, { checkoutEnabled: true })
  await seedPairing(page)

  await openReview(page)

  // ---- Before: the action is offered, and nothing has been checked out ----
  const panel = page.getByTestId('runpr-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(panel).toHaveAttribute('data-on-pr', 'false')
  await page.getByTestId('runpr-checkout').click()

  // ---- The untrusted-code confirmation, which is NOT optional ----
  const trust = page.getByTestId('runpr-trust-dialog')
  await expect(trust).toBeVisible()
  await expect(page.getByTestId('runpr-trust-text')).toContainText(/runs its code on your machine/i)
  await page.getByTestId('runpr-trust-accept').click()

  // ---- After: the indicator, and a way into the running app ----
  await expect(panel).toHaveAttribute('data-on-pr', 'true', { timeout: 10_000 })
  await expect(page.getByTestId('runpr-on-pr')).toContainText(/checked out here/i)
  await expect(page.getByTestId('runpr-open-app')).toHaveAttribute('href', LOCAL_APP_URL)
  // The way home is named, not implied.
  await expect(page.getByTestId('runpr-restore')).toContainText('Restore main')

  // What the bridge was actually sent: a ref and the acknowledgement. No
  // command, no cwd, no environment.
  const sent = JSON.parse(
    (
      await page.evaluate(
        () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
      )
    ).find((c) => c.url.includes('/v1/checkout'))!.body ?? '{}',
  )
  expect(Object.keys(sent).sort()).toEqual(['acknowledgeUntrusted', 'ref'])
  expect(sent.ref).toBe(`refs/pull/${PR_NUMBER}/head`)
  expect(sent.acknowledgeUntrusted).toBe(true)

  // ---- The preview panel now frames the LOCAL app, not a deployment ----
  await page.getByTestId('runpr-panel-toggle').click()
  const preview = page.locator('.preview-panel')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute('data-source', 'local')
  await expect(page.getByTestId('preview-source')).toHaveAttribute('data-reason', 'local-live')
  await expect(page.getByTestId('preview-panel-title')).toContainText(/your local app/i)
  // It always says WHICH source, and names the URL.
  await expect(page.getByTestId('preview-source')).toContainText(LOCAL_APP_URL)

  // ---- Restore: back to the branch, indicator gone ----
  await page.getByTestId('runpr-restore').click()
  await expect(panel).toHaveAttribute('data-on-pr', 'false', { timeout: 10_000 })
  await expect(page.getByTestId('runpr-on-pr')).toHaveCount(0)
  await expect(page.getByTestId('runpr-checkout')).toBeVisible()
  // …and the preview panel stops claiming local. This fixture has no deploy
  // preview either, so there is nothing left to frame and the panel closes
  // rather than sitting there empty — the important half being that it never
  // goes on showing a "local app" that is no longer serving this PR.
  await expect(page.locator('.preview-panel')).toHaveCount(0)
})

test('run this PR: a bridge WITHOUT --allow-checkout is never offered one', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  // Note `fix: true` inside the stub: writing IS granted. Only --allow-checkout
  // is off, which is exactly the confusion this separate flag exists to prevent.
  await stubBridgeStack(page, { checkoutEnabled: false })
  await seedPairing(page)

  await openReview(page)

  const reason = page.getByTestId('runpr-reason')
  await expect(reason).toBeVisible({ timeout: 10_000 })
  await expect(reason).toHaveAttribute('data-reason', 'checkout-disabled')
  // It names the right flag AND rules out the one they already have.
  await expect(reason).toContainText('--allow-checkout')
  await expect(reason).toContainText('--allow-write does not enable this')
  // No way in.
  await expect(page.getByTestId('runpr-checkout')).toHaveCount(0)

  // THE INVARIANT: the route was never called.
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  expect(calls.filter((c) => c.url.includes('/v1/checkout'))).toEqual([])
})

test('run this PR: a dirty tree is named file by file before anything is stashed', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await stubBridgeStack(page, {
    checkoutEnabled: true,
    dirty: ['src/feature.ts', 'notes.md'],
  })
  await seedPairing(page)

  await openReview(page)

  await expect(page.getByTestId('runpr-dirty-note')).toContainText('2 uncommitted changes')
  await page.getByTestId('runpr-checkout').click()
  await page.getByTestId('runpr-trust-accept').click()

  // The stash prompt LISTS the files. A prompt that said "you have
  // uncommitted changes" without naming them would ask for trust the user
  // cannot check.
  const list = page.getByTestId('runpr-dirty-list')
  await expect(list).toBeVisible()
  await expect(list).toContainText('src/feature.ts')
  await expect(list).toContainText('notes.md')

  // Backing out sends nothing at all.
  await page.getByTestId('runpr-stash-cancel').click()
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  expect(calls.filter((c) => c.url.includes('/v1/checkout'))).toEqual([])
})

test('run this PR: cancelling the untrusted-code prompt checks nothing out', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await stubBridgeStack(page, { checkoutEnabled: true })
  await seedPairing(page)

  await openReview(page)

  await page.getByTestId('runpr-checkout').click()
  await expect(page.getByTestId('runpr-trust-dialog')).toBeVisible()
  await page.getByTestId('runpr-trust-cancel').click()

  await expect(page.getByTestId('runpr-trust-dialog')).toHaveCount(0)
  await expect(page.getByTestId('runpr-panel')).toHaveAttribute('data-on-pr', 'false')
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: { url: string; body: string | null }[] }).__bridgeCalls,
  )
  expect(calls.filter((c) => c.url.includes('/v1/checkout'))).toEqual([])
})

test('run this PR: checked out but the dev server is down says so, and does not claim local', async ({
  page,
}) => {
  await blockExternal(page)
  await setupGithub(page)
  await stubBridgeStack(page, { checkoutEnabled: true, startOnPr: true, appReachable: false })
  await seedPairing(page)

  await openReview(page)

  await expect(page.getByTestId('runpr-panel')).toHaveAttribute('data-on-pr', 'true', {
    timeout: 10_000,
  })
  // Honest about the port it tried, rather than a dead "Open your app" link.
  await expect(page.getByTestId('runpr-app-down')).toContainText(LOCAL_APP_URL)
  await expect(page.getByTestId('runpr-open-app')).toHaveCount(0)
})

test('run this PR: with no bridge paired the surface does not exist at all', async ({ page }) => {
  await blockExternal(page)
  await setupGithub(page)
  await recordBridgeCalls(page)

  await openReview(page)

  await expect(page.getByTestId('runpr-panel')).toHaveCount(0)
  // Zero-cost absence: nothing was asked of 127.0.0.1.
  const calls = await page.evaluate(() => (window as unknown as { __bridgeCalls: string[] }).__bridgeCalls)
  expect(calls).toEqual([])
})

// ---------------------------------------------------------------------------
// THE SEAM NO TEST EVER CROSSED: a REAL browser talking to a REAL bridge.
//
// Everything above this line stubs `window.fetch`, and the bridge's own ~620
// unit tests drive the server from Node. Both are blind to the two things that
// actually broke the feature for its first real user:
//
//   1. Chrome 142+ ships LOCAL NETWORK ACCESS. A page on a public origin may
//      not reach `http://127.0.0.1` until the user grants permission. The
//      rejected fetch is a plain `TypeError: Failed to fetch` in about a
//      millisecond and NOTHING reaches the bridge — which the app reported as
//      "Nothing answered … Start the bridge", to someone whose bridge was
//      running the whole time.
//   2. `https://review123.dev` answers `308 → https://www.review123.dev`, so
//      the origin real browsers send is `www`, which the bridge's allowlist
//      did not carry. Its 403 has no CORS headers by design, so that ALSO
//      surfaced as an unexplained `TypeError: Failed to fetch`.
//
// WHAT THESE TESTS COVER, AND WHAT THEY DO NOT — read this before trusting
// them, because an honest partial test beats a green one that proves nothing:
//
//   • `startRealBridge` spawns the compiled bridge (tsc, once per run) and
//     reads its port and token out of its own banner. No stubs of any kind.
//   • The LOOPBACK tests load the app from the e2e origin (http://localhost:…)
//     and make a genuine cross-origin call to the bridge on another port. That
//     is a real CORS preflight against the real allowlist. It does NOT
//     exercise Local Network Access: both ends are loopback, which Chrome does
//     not gate.
//   • The PUBLIC-ORIGIN tests put the page on `https://www.review123.dev` by
//     fulfilling it through `page.route`, which is the only way to hold that
//     origin with no internet. Chrome applies the Local Network Access gate to
//     an intercepted page exactly as it does to a real one (verified against
//     Chromium 148 and Chrome 154), so those tests DO cover it and DO cover
//     the Origin allowlist. They do NOT cover the CORS preflight: with request
//     interception on, Chrome handles CORS internally and emits no OPTIONS —
//     which is precisely why the loopback tests above exist.
//   • The Private Network Access preflight answer is asserted from Node,
//     because `Access-Control-Request-Private-Network` is a forbidden header
//     no page may set. That proves the bridge's ANSWER, not any browser's
//     behaviour — and current Chrome never asks (see bridge/src/cors.ts).
// ---------------------------------------------------------------------------

/** The origin the deployed app really has, after the apex 308-redirects. */
const APP_ORIGIN = 'https://www.review123.dev'
/** The apex people type, which must keep working for anyone who reaches it. */
const APEX_ORIGIN = 'https://review123.dev'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface RealBridge {
  port: number
  token: string
  stop: () => void
}

/** Compile the bridge once. The e2e CI job installs deps but builds nothing. */
function buildBridgeOnce(): void {
  const built = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'bridge/tsconfig.build.json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  if (built.status !== 0) {
    throw new Error(`could not compile the bridge:\n${built.stdout}\n${built.stderr}`)
  }
}

/**
 * A port nothing is using. The bridge refuses `--port 0` on purpose (a bridge
 * whose port you cannot predict is one you cannot paste into Settings), so the
 * test picks one the same way the e2e harness picks its own.
 */
function freePort(): Promise<number> {
  return new Promise((settle, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        fail(new Error('could not reserve a port'))
        return
      }
      const { port } = address
      probe.close(() => settle(port))
    })
  })
}

/**
 * Start a real bridge on a free port, serving this repo, and read the port and
 * pairing token back out of the banner it prints — the same two strings a user
 * copies off their own terminal.
 */
async function startRealBridge(): Promise<RealBridge> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'bridge', 'dist', 'cli.js'),
      '--port',
      String(await freePort()),
      '--root',
      REPO_ROOT,
      '--token-file',
      join(mkdtempSync(join(tmpdir(), 'review123-e2e-bridge-')), 'token'),
    ],
    { cwd: REPO_ROOT },
  )
  let banner = ''
  const ready = new Promise<{ port: number; token: string }>((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`bridge did not start:\n${banner}`)), 30_000)
    child.stdout.on('data', (chunk: Buffer) => {
      banner += chunk.toString()
      const port = /listen\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(banner)
      // The token is the only indented bare word on its own line in the banner.
      const token = /\n {4}([A-Za-z0-9_-]{20,})\n/.exec(banner)
      if (port !== null && token !== null) {
        clearTimeout(timer)
        settle({ port: Number(port[1]), token: token[1]! })
      }
    })
    child.on('error', fail)
    child.on('exit', (code) => fail(new Error(`bridge exited with ${code}:\n${banner}`)))
  })
  const { port, token } = await ready
  return { port, token, stop: () => child.kill('SIGKILL') }
}

/**
 * Ask the bridge for its health FROM THE PAGE, with no stub anywhere. Returns
 * whatever the browser gave the page — including the error, which is the whole
 * point of the blocked cases.
 */
function probeFromPage(page: Page, port: number, token: string) {
  return page.evaluate(
    async ({ port, token }) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000),
        })
        return { ok: true as const, status: response.status, body: await response.text() }
      } catch (err) {
        const error = err as { name?: string; message?: string }
        return { ok: false as const, name: error?.name ?? '', message: String(error?.message ?? err) }
      }
    },
    { port, token },
  )
}

/** A blank page held at `origin`, so a test can own that origin with no internet. */
async function blankPageAt(page: Page, origin: string, path: string) {
  await page.route(`${origin}${path}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' }),
  )
  await page.goto(`${origin}${path}`)
}

/** Serve the REAL built app at a public https origin, through interception. */
async function serveAppAt(page: Page, origin: string, baseURL: string) {
  await page.route(`${origin}/**`, async (route) => {
    const requested = new URL(route.request().url())
    const response = await route.fetch({ url: `${baseURL}${requested.pathname}${requested.search}` })
    await route.fulfill({ response })
  })
}

test.describe('real browser → real bridge', () => {
  let bridge: RealBridge

  test.beforeAll(async () => {
    // Compiling the bridge is the slow part, and a cold CI runner is slower
    // than any laptop. The default hook timeout is the 30s test timeout, which
    // would turn a slow `tsc` into a mystery failure rather than a slow pass.
    test.setTimeout(180_000)
    buildBridgeOnce()
    bridge = await startRealBridge()
  })

  test.afterAll(() => {
    bridge?.stop()
  })

  test('a genuine cross-origin call from the app reaches the bridge, preflight and all', async ({
    page,
  }) => {
    // NO page.route in this test, deliberately: registering one makes Chrome
    // handle CORS internally and skip the OPTIONS preflight, which is the one
    // thing this test exists to exercise.
    await page.goto('/')
    const result = await probeFromPage(page, bridge.port, bridge.token)

    expect(result.ok, `the bridge refused a real browser call: ${JSON.stringify(result)}`).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ ok: true, protocol: 1 })
  })

  test('a wrong token comes back as a READABLE 401, not as an unexplained failure', async ({
    page,
  }) => {
    await page.goto('/')
    const result = await probeFromPage(page, bridge.port, 'not-the-token')

    // The 401 carries CORS headers on purpose, so the page can tell "the token
    // is wrong" from "nothing is there" — two problems, two different fixes.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(401)
  })

  test('the bridge answers a Private Network Access preflight — and only for an allowed origin', async ({
    request,
  }) => {
    // Driven from Node: no page may set this request header.
    const allowed = await request.fetch(`http://127.0.0.1:${bridge.port}/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: APP_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    expect(allowed.status()).toBe(204)
    expect(allowed.headers()['access-control-allow-private-network']).toBe('true')
    expect(allowed.headers()['access-control-allow-origin']).toBe(APP_ORIGIN)

    const stranger = await request.fetch(`http://127.0.0.1:${bridge.port}/v1/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.test',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    expect(stranger.status()).toBe(403)
    // A rejected origin gets NOTHING — not the private-network answer, not any
    // other Access-Control-* header.
    const leaked = Object.keys(stranger.headers()).filter((h) => h.startsWith('access-control-'))
    expect(leaked).toEqual([])
  })

  test('Chrome BLOCKS a public-origin page from the bridge until local network access is granted', async ({
    page,
  }) => {
    await blankPageAt(page, APP_ORIGIN, '/blocked')

    const permission = await page.evaluate(async () => {
      try {
        return (await navigator.permissions.query({ name: 'local-network-access' } as never)).state
      } catch {
        return 'unqueryable'
      }
    })
    // The state the app's classifier keys on. If this ever stops being
    // 'prompt', the copy in bridge.svelte.ts needs revisiting.
    expect(permission).toBe('prompt')

    const result = await probeFromPage(page, bridge.port, bridge.token)

    expect(result.ok).toBe(false)
    if (result.ok) return
    // The failure the user saw: indistinguishable, from the page alone, from a
    // bridge that was never started.
    expect(result.name).toBe('TypeError')
  })

  test('with the permission granted, the WWW origin the apex redirects to is allowed', async ({
    page,
    context,
  }) => {
    await blankPageAt(page, APP_ORIGIN, '/allowed')
    await context.grantPermissions(['local-network-access'], { origin: APP_ORIGIN })

    const result = await probeFromPage(page, bridge.port, bridge.token)

    // THE REGRESSION. Before this fix the allowlist carried only the apex, so
    // this call died on a headerless 403 even with the permission granted.
    expect(result.ok, `www origin was refused: ${JSON.stringify(result)}`).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(200)
  })

  test('the apex origin keeps working for anyone who reaches it', async ({ page, context }) => {
    await blankPageAt(page, APEX_ORIGIN, '/allowed')
    await context.grantPermissions(['local-network-access'], { origin: APEX_ORIGIN })

    const result = await probeFromPage(page, bridge.port, bridge.token)
    expect(result.ok).toBe(true)
  })

  test('a foreign origin is still refused, permission or not', async ({ page, context }) => {
    await blankPageAt(page, 'https://evil.test', '/steal')
    await context.grantPermissions(['local-network-access'], { origin: 'https://evil.test' })

    const result = await probeFromPage(page, bridge.port, bridge.token)

    // Even holding the token AND the browser's permission, the origin gate
    // stops it — and it learns nothing from the bare 403.
    expect(result.ok).toBe(false)
  })

  test('THE BUG, end to end: the real app on the real origin, and what it tells the user', async ({
    page,
    context,
    baseURL,
  }) => {
    await serveAppAt(page, APP_ORIGIN, baseURL!)
    await page.goto(`${APP_ORIGIN}/settings`)
    await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible({ timeout: 15_000 })

    await page.getByLabel(/bridge port/i).fill(String(bridge.port))
    await page.getByLabel(/bridge pairing token/i).fill(bridge.token)
    await page.getByRole('button', { name: /^connect$/i }).click()

    // Permission not granted: the app must blame the BROWSER, not the bridge —
    // which is running, serving this very repo, started in beforeAll.
    const alert = page.getByRole('alert')
    await expect(alert).toContainText(/local network access/i, { timeout: 15_000 })
    await expect(alert).not.toContainText(/start the bridge in your repo/i)

    // Grant it, press Connect again, and the same click now pairs.
    await context.grantPermissions(['local-network-access'], { origin: APP_ORIGIN })
    await page.getByRole('button', { name: /^connect$/i }).click()

    await expect(page.getByTestId('bridge-status')).toContainText(/connected to/i, { timeout: 15_000 })
    // The bridge sends the repo BASENAME only, and the checkout this runs in
    // is a worktree as often as it is the repo itself.
    await expect(page.getByTestId('bridge-root')).toHaveText(basename(REPO_ROOT))
  })
})
