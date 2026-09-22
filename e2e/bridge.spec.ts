/**
 * e2e/bridge.spec.ts — the Local bridge settings section, end to end.
 *
 * The bridge is a process on 127.0.0.1 that no CI runner has, so the health
 * endpoint is stubbed at the `window.fetch` seam via addInitScript. That is
 * deliberate over `page.route`: the real call is cross-origin with an
 * Authorization header, so it would drag a CORS preflight into the test and
 * make the assertions about the UI depend on Playwright's preflight handling.
 * What this spec is actually for is the three user-visible states — absent,
 * present, and paired — plus the guarantee that an unpaired app touches the
 * loopback address not once.
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

function healthBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    protocol: 1,
    root: 'review123',
    capabilities: { inference: ['claude', 'codex'], files: false, search: false },
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
  // Honest about the foundation: nothing is routed through it yet.
  await expect(page.getByTestId('bridge-section')).toContainText(/not wired up yet/i)
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
