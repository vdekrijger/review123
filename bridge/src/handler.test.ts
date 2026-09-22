// @vitest-environment node
/**
 * handler.test.ts — the protocol's gates, exercised as plain data.
 */
import { describe, it, expect } from 'vitest'
import { handleRequest, type BridgeRequest, type HandlerContext } from './handler.js'
import { MAX_BODY_BYTES, PROTOCOL_VERSION, type HealthResponse } from './protocol.js'
import { REVIEW123_ORIGIN } from './cors.js'

const TOKEN = 'test-token-0000000000000000000000000000000'
const PORT = 7321

function ctx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    token: TOKEN,
    port: PORT,
    realRoot: '/private/tmp/checkouts/review123',
    rootName: 'review123',
    extraOrigins: [],
    capabilities: async () => ({ inference: ['claude'], files: false, search: false }),
    version: '0.1.0',
    ...overrides,
  }
}

/** A well-formed authenticated request; `overrides.headers` MERGES per-header. */
function req(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  const { headers, ...rest } = overrides
  return {
    method: 'GET',
    path: '/v1/health',
    body: null,
    ...rest,
    headers: {
      host: `127.0.0.1:${PORT}`,
      origin: REVIEW123_ORIGIN,
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
  }
}

function parse(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>
}

describe('GET /v1/health', () => {
  it('answers 200 with the v1 shape', async () => {
    const res = await handleRequest(req(), ctx())
    expect(res.status).toBe(200)
    const payload = parse(res.body) as unknown as HealthResponse
    expect(payload).toEqual({
      ok: true,
      protocol: PROTOCOL_VERSION,
      root: 'review123',
      capabilities: { inference: ['claude'], files: false, search: false },
      version: '0.1.0',
    })
  })

  it('sends the repo BASENAME only — never the absolute path', async () => {
    const res = await handleRequest(req(), ctx())
    expect(res.body).not.toContain('/private/tmp/checkouts')
    expect(parse(res.body)['root']).toBe('review123')
  })

  it('never echoes the pairing token back', async () => {
    const res = await handleRequest(req(), ctx())
    expect(res.body).not.toContain(TOKEN)
    expect(JSON.stringify(res.headers)).not.toContain(TOKEN)
  })

  it('is not cacheable and is not sniffable', async () => {
    const res = await handleRequest(req(), ctx())
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('re-probes capabilities per request so a newly installed CLI shows up', async () => {
    let installed: string[] = []
    const context = ctx({ capabilities: async () => ({ inference: installed, files: false, search: false }) })
    expect(parse((await handleRequest(req(), context)).body)['capabilities']).toEqual({
      inference: [],
      files: false,
      search: false,
    })
    installed = ['codex']
    expect(parse((await handleRequest(req(), context)).body)['capabilities']).toEqual({
      inference: ['codex'],
      files: false,
      search: false,
    })
  })
})

describe('auth gate', () => {
  it.each([
    ['no Authorization header', undefined],
    ['an empty header', ''],
    ['a bare token with no scheme', TOKEN],
    ['the wrong token', 'Bearer not-the-token'],
    ['Basic auth carrying the token', `Basic ${TOKEN}`],
  ])('rejects %s with 401 before doing any work', async (_label, authorization) => {
    const res = await handleRequest(req({ headers: { authorization: authorization as string | undefined } }), ctx())
    expect(res.status).toBe(401)
    expect(parse(res.body)['error']).toBe('unauthorized')
    expect(res.headers['WWW-Authenticate']).toMatch(/^Bearer/)
  })

  it('still sends CORS headers on a 401 so the browser can READ the failure', async () => {
    const res = await handleRequest(req({ headers: { authorization: undefined } }), ctx())
    expect(res.headers['Access-Control-Allow-Origin']).toBe(REVIEW123_ORIGIN)
  })

  it('401s the reserved routes too — auth runs before routing', async () => {
    for (const path of ['/v1/infer', '/v1/files', '/v1/search']) {
      const res = await handleRequest(
        req({ method: 'POST', path, headers: { authorization: undefined }, body: Buffer.from('{}') }),
        ctx(),
      )
      expect(res.status, path).toBe(401)
    }
  })

  it('accepts the token from a loopback dev origin', async () => {
    const res = await handleRequest(req({ headers: { origin: 'http://localhost:5173' } }), ctx())
    expect(res.status).toBe(200)
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173')
  })
})

describe('origin gate', () => {
  it('403s an origin that is not on the allowlist', async () => {
    const res = await handleRequest(req({ headers: { origin: 'https://evil.test' } }), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-origin')
  })

  it('sends NO Access-Control-Allow-* headers to a rejected origin', async () => {
    const res = await handleRequest(req({ headers: { origin: 'https://evil.test' } }), ctx())
    const cors = Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith('access-control-'))
    expect(cors).toEqual([])
  })

  it('rejects the origin BEFORE the token is even considered', async () => {
    const res = await handleRequest(
      req({ headers: { origin: 'https://evil.test', authorization: `Bearer ${TOKEN}` } }),
      ctx(),
    )
    expect(res.status).toBe(403)
  })

  it('honours an additive --allow-origin', async () => {
    const res = await handleRequest(
      req({ headers: { origin: 'https://preview.review123.dev' } }),
      ctx({ extraOrigins: ['https://preview.review123.dev'] }),
    )
    expect(res.status).toBe(200)
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://preview.review123.dev')
  })

  it('serves a non-browser caller (no Origin) with a valid token, and no CORS headers', async () => {
    const res = await handleRequest(req({ headers: { origin: undefined } }), ctx())
    expect(res.status).toBe(200)
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })
})

describe('preflight', () => {
  it('answers OPTIONS with 204 and the CORS headers, without a token', async () => {
    const res = await handleRequest(
      req({ method: 'OPTIONS', path: '/v1/files', headers: { authorization: undefined } }),
      ctx(),
    )
    expect(res.status).toBe(204)
    expect(res.body).toBe('')
    expect(res.headers['Access-Control-Allow-Origin']).toBe(REVIEW123_ORIGIN)
    expect(res.headers['Access-Control-Allow-Headers']).toMatch(/authorization/i)
    expect(res.headers['Access-Control-Allow-Methods']).toMatch(/POST/)
  })

  it('403s a preflight from a disallowed origin, with no CORS headers', async () => {
    const res = await handleRequest(
      req({ method: 'OPTIONS', headers: { origin: 'https://evil.test', authorization: undefined } }),
      ctx(),
    )
    expect(res.status).toBe(403)
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })
})

describe('host gate (DNS rebinding)', () => {
  it('403s a request that arrived under a rebound hostname', async () => {
    const res = await handleRequest(req({ headers: { host: 'evil.test:7321' } }), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-host')
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('403s even with a valid token and an allowed origin', async () => {
    const res = await handleRequest(
      req({ headers: { host: 'evil.test:7321', origin: REVIEW123_ORIGIN, authorization: `Bearer ${TOKEN}` } }),
      ctx(),
    )
    expect(res.status).toBe(403)
  })
})

describe('reserved routes', () => {
  it.each(['/v1/infer', '/v1/files', '/v1/search'])('%s answers 501 not-implemented', async (path) => {
    const res = await handleRequest(req({ method: 'POST', path, body: Buffer.from('{}') }), ctx())
    expect(res.status).toBe(501)
    expect(parse(res.body)).toEqual({
      ok: false,
      error: 'not-implemented',
      message: expect.stringContaining(path),
    })
  })

  it('405s a reserved route reached with the wrong method', async () => {
    const res = await handleRequest(req({ method: 'GET', path: '/v1/files' }), ctx())
    expect(res.status).toBe(405)
    expect(res.headers['Allow']).toBe('POST, OPTIONS')
  })
})

describe('unknown routes and caps', () => {
  it('404s an unknown path', async () => {
    const res = await handleRequest(req({ path: '/v1/exec' }), ctx())
    expect(res.status).toBe(404)
    expect(parse(res.body)['error']).toBe('not-found')
  })

  it('404s an unversioned path — the version is part of the contract', async () => {
    expect((await handleRequest(req({ path: '/health' }), ctx())).status).toBe(404)
  })

  it('413s a body over the cap', async () => {
    const res = await handleRequest(
      req({ method: 'POST', path: '/v1/files', body: Buffer.alloc(MAX_BODY_BYTES + 1) }),
      ctx(),
    )
    expect(res.status).toBe(413)
    expect(parse(res.body)['error']).toBe('payload-too-large')
  })

  it('accepts a body right at the cap', async () => {
    const res = await handleRequest(
      req({ method: 'POST', path: '/v1/files', body: Buffer.alloc(MAX_BODY_BYTES) }),
      ctx(),
    )
    expect(res.status).toBe(501)
  })
})
