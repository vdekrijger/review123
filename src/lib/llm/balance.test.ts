/**
 * balance.test.ts — capability gate + DeepSeek balance parsing + graceful
 * failure for the "credits remaining" readout.
 *
 * fetchProviderBalance must NEVER throw: every failure mode (unsupported
 * provider, missing key, network error, HTTP error, garbage JSON,
 * is_available:false) resolves to null so a missing balance can't break
 * Settings. Non-supported providers must not even hit the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  providerSupportsBalance,
  fetchProviderBalance,
  formatBalance,
} from './balance'

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const DEEPSEEK_OK = {
  is_available: true,
  balance_infos: [
    {
      currency: 'USD',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('providerSupportsBalance — capability gate', () => {
  it('is true only for deepseek', () => {
    expect(providerSupportsBalance('deepseek')).toBe(true)
    expect(providerSupportsBalance('openai')).toBe(false)
    expect(providerSupportsBalance('anthropic')).toBe(false)
    expect(providerSupportsBalance('gemini')).toBe(false)
  })
})

describe('fetchProviderBalance — DeepSeek happy path', () => {
  it('parses the USD entry and Number-coerces the string amounts', async () => {
    const f = vi.fn().mockResolvedValue(makeJsonResponse(DEEPSEEK_OK))
    vi.stubGlobal('fetch', f)

    const balance = await fetchProviderBalance('deepseek', 'sk-test')
    expect(balance).toEqual({
      currency: 'USD',
      total: 110,
      granted: 10,
      toppedUp: 100,
    })
    // Called the direct DeepSeek endpoint with a Bearer key (no proxy).
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/user/balance')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' })
  })

  it('prefers the USD entry among multiple currencies', async () => {
    const body = {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '700.00' },
        { currency: 'USD', total_balance: '110.00' },
      ],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    const balance = await fetchProviderBalance('deepseek', 'sk-test')
    expect(balance).toMatchObject({ currency: 'USD', total: 110 })
  })

  it('falls back to the first entry when there is no USD entry', async () => {
    const body = {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '700.00' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    const balance = await fetchProviderBalance('deepseek', 'sk-test')
    expect(balance).toMatchObject({ currency: 'CNY', total: 700 })
  })

  it('omits granted/toppedUp when the provider does not report them', async () => {
    const body = {
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '5.00' }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    const balance = await fetchProviderBalance('deepseek', 'sk-test')
    expect(balance).toEqual({ currency: 'USD', total: 5 })
  })
})

describe('fetchProviderBalance — null / graceful cases', () => {
  it('returns null and does NOT fetch for a non-deepseek provider', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await fetchProviderBalance('openai', 'sk-test')).toBeNull()
    expect(await fetchProviderBalance('anthropic', 'sk-test')).toBeNull()
    expect(await fetchProviderBalance('gemini', 'sk-test')).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('returns null without fetching when the key is missing or blank', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect(await fetchProviderBalance('deepseek', '')).toBeNull()
    expect(await fetchProviderBalance('deepseek', '   ')).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('returns null when is_available is false', async () => {
    const body = { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    expect(await fetchProviderBalance('deepseek', 'sk-test')).toBeNull()
  })

  it('returns null on an HTTP error (e.g. 401) — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({}, 401)))
    await expect(fetchProviderBalance('deepseek', 'sk-test')).resolves.toBeNull()
  })

  it('returns null on a network/CORS error — never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(fetchProviderBalance('deepseek', 'sk-test')).resolves.toBeNull()
  })

  it('returns null on garbage / non-JSON body — never throws', async () => {
    const garbage = new Response('<html>not json</html>', { status: 200 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(garbage))
    await expect(fetchProviderBalance('deepseek', 'sk-test')).resolves.toBeNull()
  })

  it('returns null when balance_infos is empty or missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({ is_available: true, balance_infos: [] })))
    expect(await fetchProviderBalance('deepseek', 'sk-test')).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse({ is_available: true })))
    expect(await fetchProviderBalance('deepseek', 'sk-test')).toBeNull()
  })

  it('returns null when the total amount is unparseable', async () => {
    const body = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: 'n/a' }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(body)))
    expect(await fetchProviderBalance('deepseek', 'sk-test')).toBeNull()
  })
})

describe('formatBalance', () => {
  it('formats USD with a leading $ and two decimals', () => {
    expect(formatBalance({ currency: 'USD', total: 110 })).toBe('$110.00')
    expect(formatBalance({ currency: 'USD', total: 5.5 })).toBe('$5.50')
  })

  it('formats non-USD currencies with a trailing code', () => {
    expect(formatBalance({ currency: 'CNY', total: 700 })).toBe('700.00 CNY')
  })
})
