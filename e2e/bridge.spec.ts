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
 * The bridge is a process on 127.0.0.1 that no CI runner has, so it is stubbed
 * at the `window.fetch` seam via addInitScript. That is deliberate over
 * `page.route`: the real calls are cross-origin with an Authorization header
 * and a JSON content type, so they would drag CORS preflights into the test and
 * make the assertions depend on Playwright's preflight handling.
 */
import { test, expect, type Page } from '@playwright/test'

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
  opts: { health: Record<string, unknown>; answers: Record<string, string>; down?: boolean },
) {
  await page.addInitScript(
    ({ health, answers, down }) => {
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

        if (url.includes('/v1/infer')) {
          const sent = (body ?? '').toLowerCase()
          const match = Object.keys(answers).find((needle) => sent.includes(needle.toLowerCase()))
          const text = match ? answers[match]! : answers['default'] ?? ''
          return Promise.resolve(
            json({ ok: true, cli: 'claude', text, truncated: false, durationMs: 12 }),
          )
        }
        return Promise.resolve(json({ ok: false, error: 'not-found', message: 'no' }, 404))
      }
    },
    { health: opts.health, answers: opts.answers, down: opts.down === true },
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
    capabilities: { inference: ['claude', 'codex'], infer: true, files: true, search: true },
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
