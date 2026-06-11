/**
 * Tests for api/oauth/exchange.ts — pure handler logic + default export origin guard.
 * EC-02l: also asserts no console.* calls appear in the source.
 */
import { describe, it, expect, vi } from 'vitest'
import { exchangeHandler } from '../../../api/oauth/exchange'
import handler from '../../../api/oauth/exchange'

const VALID_ENV = {
  GITHUB_OAUTH_CLIENT_ID: 'test_client_id',
  GITHUB_OAUTH_CLIENT_SECRET: 'test_client_secret',
}

function makeFetch(responseBody: Record<string, unknown>, status = 200): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    }) as unknown as Response
}

describe('exchangeHandler', () => {
  it('returns 400 {error:missing-code} when body is null', async () => {
    const result = await exchangeHandler(null, VALID_ENV, makeFetch({}))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'missing-code' })
  })

  it('returns 400 {error:missing-code} when code is missing from body', async () => {
    const result = await exchangeHandler({ foo: 'bar' }, VALID_ENV, makeFetch({}))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'missing-code' })
  })

  it('returns 400 {error:missing-code} when code is not a string', async () => {
    const result = await exchangeHandler({ code: 42 }, VALID_ENV, makeFetch({}))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'missing-code' })
  })

  it('returns 400 {error:missing-code} when code is empty string', async () => {
    const result = await exchangeHandler({ code: '' }, VALID_ENV, makeFetch({}))
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'missing-code' })
  })

  it('passes through GitHub error body with 400', async () => {
    const result = await exchangeHandler(
      { code: 'abc123' },
      VALID_ENV,
      makeFetch({ error: 'bad_verification_code', error_description: 'The code passed is incorrect.' }),
    )
    expect(result.status).toBe(400)
    expect(result.body).toEqual({ error: 'bad_verification_code' })
  })

  it('returns 200 with ONLY access_token and scope on success', async () => {
    const result = await exchangeHandler(
      { code: 'valid_code', code_verifier: 'verifier_value' },
      VALID_ENV,
      makeFetch({
        access_token: 'gho_abc123',
        scope: 'public_repo',
        token_type: 'bearer',
        // extra fields that must NOT be echoed
      }),
    )
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ access_token: 'gho_abc123', scope: 'public_repo' })
    // Ensure no extra keys (token_type, etc.)
    expect(Object.keys(result.body)).toHaveLength(2)
  })

  it('returns 500 {error:oauth-not-configured} when CLIENT_ID is missing', async () => {
    const result = await exchangeHandler({ code: 'abc' }, { GITHUB_OAUTH_CLIENT_SECRET: 'secret' }, makeFetch({}))
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'oauth-not-configured' })
  })

  it('returns 500 {error:oauth-not-configured} when CLIENT_SECRET is missing', async () => {
    const result = await exchangeHandler({ code: 'abc' }, { GITHUB_OAUTH_CLIENT_ID: 'id' }, makeFetch({}))
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'oauth-not-configured' })
  })

  it('returns 500 {error:oauth-not-configured} when env is empty', async () => {
    const result = await exchangeHandler({ code: 'abc' }, {}, makeFetch({}))
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'oauth-not-configured' })
  })

  it('EC-02l: api/oauth/exchange.ts contains no console.* calls (from exchangeHandler describe)', async () => {
    // Use dynamic import to read the raw source as text for the no-logging proof
    const fileUrl = new URL('../../../api/oauth/exchange.ts', import.meta.url)
    const source = await fetch(fileUrl.href).then((r) => r.text()).catch(async () => {
      // Fallback: read via Vite's ?raw import (works in vitest)
      const mod = await import('../../../api/oauth/exchange.ts?raw')
      return mod.default as string
    })
    // Must not contain any console. usage
    expect(source).not.toMatch(/\bconsole\s*\./)
  })
})

// ---- Default export: origin guard tests ----

/**
 * Build minimal req/res fakes for testing the default export handler.
 * res.status(n).json(body) records the response for assertion.
 */
function makeRes() {
  const recorded: { status: number; body: unknown } = { status: 0, body: null }
  const res = {
    status(code: number) {
      recorded.status = code
      return {
        json(body: unknown) {
          recorded.body = body
        },
      }
    },
    _recorded: recorded,
  }
  return res
}

describe('handler (default export) — origin guard', () => {
  it('returns 403 when Origin header is missing (fail-closed)', async () => {
    const req = { headers: { host: 'app.example.com' }, body: {} }
    const res = makeRes()
    await handler(req, res)
    expect(res._recorded.status).toBe(403)
    expect(res._recorded.body).toEqual({ error: 'forbidden' })
  })

  it('returns 403 when Origin is a foreign host', async () => {
    const req = { headers: { host: 'app.example.com', origin: 'https://evil.com' }, body: {} }
    const res = makeRes()
    await handler(req, res)
    expect(res._recorded.status).toBe(403)
    expect(res._recorded.body).toEqual({ error: 'forbidden' })
  })

  it('returns 403 when Origin is malformed', async () => {
    const req = { headers: { host: 'app.example.com', origin: 'not-a-url' }, body: {} }
    const res = makeRes()
    await handler(req, res)
    expect(res._recorded.status).toBe(403)
    expect(res._recorded.body).toEqual({ error: 'forbidden' })
  })

  it('compares against x-forwarded-host when present (Vercel proxy)', async () => {
    // Origin matches x-forwarded-host, not host — should pass the guard and reach exchangeHandler
    // exchangeHandler will 500 (no env vars) which proves the guard was passed
    const req = {
      headers: {
        host: 'internal-host.vercel-internal',
        'x-forwarded-host': 'app.example.com',
        origin: 'https://app.example.com',
      },
      body: { code: 'abc' },
    }
    const res = makeRes()
    // Stub fetch so exchangeHandler doesn't make real network calls
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'gho_test', scope: 'public_repo' }),
    }))
    await handler(req, res)
    vi.unstubAllGlobals()
    // 403 would mean origin guard blocked it; any non-403 means guard passed
    expect(res._recorded.status).not.toBe(403)
  })

  it('returns 403 when origin host does not match x-forwarded-host', async () => {
    const req = {
      headers: {
        host: 'app.example.com',
        'x-forwarded-host': 'other.example.com',
        origin: 'https://app.example.com',
      },
      body: {},
    }
    const res = makeRes()
    await handler(req, res)
    expect(res._recorded.status).toBe(403)
    expect(res._recorded.body).toEqual({ error: 'forbidden' })
  })
})
