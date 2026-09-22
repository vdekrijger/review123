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
const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678'

function ctx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    token: TOKEN,
    port: PORT,
    realRoot: '/private/tmp/checkouts/review123',
    rootName: 'review123',
    extraOrigins: [],
    capabilities: async () => ({ inference: ['claude'], infer: true, files: true, search: true }),
    version: '0.1.0',
    // Default stubs: the handler's own tests never spawn a CLI, open a file or
    // walk a tree. infer/files/search.test.ts own those mechanics; this file
    // owns the protocol gates.
    infer: async () => ({ ok: true as const, text: 'stub answer', truncated: false, durationMs: 3 }),
    files: async () => ({ ok: true as const, files: [], missing: [], skipped: [] }),
    search: async () => ({ ok: true as const, matches: [], truncated: false }),
    repoState: async () => ({ head: HEAD_SHA, branch: 'main', dirty: false }),
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
      capabilities: { inference: ['claude'], infer: true, files: true, search: true },
      git: { head: HEAD_SHA, branch: 'main', dirty: false },
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
    const context = ctx({ capabilities: async () => ({ inference: installed, infer: true, files: true, search: true }) })
    expect(parse((await handleRequest(req(), context)).body)['capabilities']).toEqual({
      inference: [],
      infer: true,
      files: true,
      search: true,
    })
    installed = ['codex']
    expect(parse((await handleRequest(req(), context)).body)['capabilities']).toEqual({
      inference: ['codex'],
      infer: true,
      files: true,
      search: true,
    })
  })
})

// ---------------------------------------------------------------------------
// The repo state — the field the whole grounding feature turns on. Every case
// is exercised here as DATA, so the handler's promise ("report it, never guess
// it") is pinned without needing four real checkouts. gitState.test.ts owns
// the git mechanics that produce these shapes.
// ---------------------------------------------------------------------------

describe('GET /v1/health — repo state', () => {
  it('reports a clean checkout on a branch', async () => {
    const res = await handleRequest(req(), ctx())
    expect(parse(res.body)['git']).toEqual({ head: HEAD_SHA, branch: 'main', dirty: false })
  })

  it('reports a DIRTY checkout as dirty — never smooths it over', async () => {
    const context = ctx({ repoState: async () => ({ head: HEAD_SHA, branch: 'main', dirty: true }) })
    expect(parse((await handleRequest(req(), context)).body)['git']).toEqual({
      head: HEAD_SHA,
      branch: 'main',
      dirty: true,
    })
  })

  it('reports a detached HEAD as a null branch, with the sha still present', async () => {
    const context = ctx({ repoState: async () => ({ head: HEAD_SHA, branch: null, dirty: false }) })
    expect(parse((await handleRequest(req(), context)).body)['git']).toEqual({
      head: HEAD_SHA,
      branch: null,
      dirty: false,
    })
  })

  it('reports NULL when the root is not a repo — not a fabricated sha, not an error', async () => {
    const context = ctx({ repoState: async () => null })
    const res = await handleRequest(req(), context)
    expect(res.status).toBe(200)
    expect(parse(res.body)['git']).toBeNull()
  })

  it('re-reads the repo state per request, so switching branches needs no restart', async () => {
    let head = HEAD_SHA
    const context = ctx({ repoState: async () => ({ head, branch: 'main', dirty: false }) })
    expect((parse((await handleRequest(req(), context)).body)['git'] as { head: string }).head).toBe(HEAD_SHA)
    head = 'f'.repeat(40)
    expect((parse((await handleRequest(req(), context)).body)['git'] as { head: string }).head).toBe('f'.repeat(40))
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

describe('POST /v1/infer', () => {
  function inferReq(body: unknown, overrides: Partial<BridgeRequest> = {}): BridgeRequest {
    return req({ method: 'POST', path: '/v1/infer', body: Buffer.from(JSON.stringify(body)), ...overrides })
  }

  it('answers 200 with the InferResponse shape', async () => {
    const res = await handleRequest(inferReq({ cli: 'claude', prompt: 'hi' }), ctx())
    expect(res.status).toBe(200)
    expect(parse(res.body)).toEqual({
      ok: true,
      cli: 'claude',
      text: 'stub answer',
      truncated: false,
      durationMs: 3,
    })
  })

  it('includes usage ONLY when the CLI reported it', async () => {
    const withUsage = ctx({
      infer: async () => ({
        ok: true as const, text: 'a', truncated: false, durationMs: 1,
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
    })
    expect(parse((await handleRequest(inferReq({ cli: 'claude', prompt: 'hi' }), withUsage)).body)).toHaveProperty(
      'usage',
      { inputTokens: 10, outputTokens: 2 },
    )
    // The default stub reports none, so the field is ABSENT rather than zeroed.
    expect(parse((await handleRequest(inferReq({ cli: 'claude', prompt: 'hi' }), ctx())).body)).not.toHaveProperty('usage')
  })

  it('405s a GET', async () => {
    const res = await handleRequest(req({ method: 'GET', path: '/v1/infer' }), ctx())
    expect(res.status).toBe(405)
    expect(res.headers['Allow']).toBe('POST, OPTIONS')
  })

  it.each([
    ['a body that is not JSON at all', Buffer.from('not json')],
    ['an empty body', null],
  ])('400s %s', async (_label, body) => {
    const res = await handleRequest(req({ method: 'POST', path: '/v1/infer', body }), ctx())
    expect(res.status).toBe(400)
    expect(parse(res.body)['error']).toBe('bad-request')
  })

  it('400s a cli id that is not in the hard-coded set', async () => {
    const res = await handleRequest(inferReq({ cli: '/bin/sh', prompt: 'hi' }), ctx())
    expect(res.status).toBe(400)
  })

  it('503s a KNOWN cli that is not installed — checked before the worker runs', async () => {
    let spawnedAnyway = false
    const context = ctx({
      capabilities: async () => ({ inference: [], infer: true, files: false, search: false }),
      infer: async () => {
        spawnedAnyway = true
        return { ok: true as const, text: '', truncated: false, durationMs: 0 }
      },
    })
    const res = await handleRequest(inferReq({ cli: 'claude', prompt: 'hi' }), context)
    expect(res.status).toBe(503)
    expect(parse(res.body)['error']).toBe('cli-unavailable')
    expect(spawnedAnyway).toBe(false)
  })

  it.each([
    ['timeout', 504],
    ['cli-failed', 502],
    ['forbidden-path', 403],
  ] as const)('maps a %s failure onto HTTP %i', async (code, status) => {
    const context = ctx({ infer: async () => ({ ok: false as const, code, message: 'nope' }) })
    const res = await handleRequest(inferReq({ cli: 'claude', prompt: 'hi' }), context)
    expect(res.status).toBe(status)
    expect(parse(res.body)['error']).toBe(code)
  })

  it('still carries CORS headers on an infer failure so the browser can READ it', async () => {
    const context = ctx({ infer: async () => ({ ok: false as const, code: 'cli-failed' as const, message: 'nope' }) })
    const res = await handleRequest(inferReq({ cli: 'claude', prompt: 'hi' }), context)
    expect(res.headers['Access-Control-Allow-Origin']).toBe(REVIEW123_ORIGIN)
  })

  it('403s a rebound Host BEFORE the worker is ever consulted', async () => {
    let reached = false
    const context = ctx({
      infer: async () => {
        reached = true
        return { ok: true as const, text: '', truncated: false, durationMs: 0 }
      },
    })
    const res = await handleRequest(
      inferReq({ cli: 'claude', prompt: 'hi' }, { headers: { host: 'evil.test:7321' } }),
      context,
    )
    expect(res.status).toBe(403)
    expect(reached).toBe(false)
  })

  it('403s a disallowed Origin BEFORE the worker is ever consulted', async () => {
    let reached = false
    const context = ctx({
      infer: async () => {
        reached = true
        return { ok: true as const, text: '', truncated: false, durationMs: 0 }
      },
    })
    const res = await handleRequest(
      inferReq({ cli: 'claude', prompt: 'hi' }, { headers: { origin: 'https://evil.test' } }),
      context,
    )
    expect(res.status).toBe(403)
    expect(reached).toBe(false)
  })

  it('401s without a token BEFORE the worker is ever consulted', async () => {
    let reached = false
    const context = ctx({
      infer: async () => {
        reached = true
        return { ok: true as const, text: '', truncated: false, durationMs: 0 }
      },
    })
    const res = await handleRequest(
      inferReq({ cli: 'claude', prompt: 'hi' }, { headers: { authorization: undefined } }),
      context,
    )
    expect(res.status).toBe(401)
    expect(reached).toBe(false)
  })

  it('413s an over-cap body BEFORE the worker is ever consulted', async () => {
    let reached = false
    const context = ctx({
      infer: async () => {
        reached = true
        return { ok: true as const, text: '', truncated: false, durationMs: 0 }
      },
    })
    const res = await handleRequest(
      req({ method: 'POST', path: '/v1/infer', body: Buffer.alloc(MAX_BODY_BYTES + 1) }),
      context,
    )
    expect(res.status).toBe(413)
    expect(reached).toBe(false)
  })
})

describe('POST /v1/files', () => {
  it('returns the worker’s answer verbatim, including the empty-but-present arrays', async () => {
    const res = await handleRequest(
      req({ method: 'POST', path: '/v1/files', body: Buffer.from(JSON.stringify({ paths: ['a.ts'] })) }),
      ctx({
        files: async () => ({
          ok: true as const,
          files: [{ path: 'a.ts', bytes: 3, truncated: false, content: 'abc', encoding: 'utf-8' as const }],
          missing: ['b.ts'],
          skipped: [{ path: 'logo.png', reason: 'binary' as const }],
        }),
      }),
    )
    expect(res.status).toBe(200)
    expect(parse(res.body)).toEqual({
      ok: true,
      files: [{ path: 'a.ts', bytes: 3, truncated: false, content: 'abc', encoding: 'utf-8' }],
      missing: ['b.ts'],
      skipped: [{ path: 'logo.png', reason: 'binary' }],
    })
  })

  it('400s a body with no paths, before the worker is ever called', async () => {
    let called = false
    const res = await handleRequest(
      req({ method: 'POST', path: '/v1/files', body: Buffer.from('{}') }),
      ctx({
        files: async () => {
          called = true
          return { ok: true as const, files: [], missing: [], skipped: [] }
        },
      }),
    )
    expect(res.status).toBe(400)
    expect(parse(res.body)['error']).toBe('bad-request')
    expect(called).toBe(false)
  })

  it('403s a confinement refusal — the whole request, not a dropped path', async () => {
    const res = await handleRequest(
      req({
        method: 'POST',
        path: '/v1/files',
        body: Buffer.from(JSON.stringify({ paths: ['../../etc/passwd'] })),
      }),
      ctx({
        files: async () => ({
          ok: false as const,
          code: 'forbidden-path' as const,
          message: 'Path is outside the repo: ../../etc/passwd',
        }),
      }),
    )
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-path')
  })

  it('405s /v1/files reached with the wrong method', async () => {
    const res = await handleRequest(req({ method: 'GET', path: '/v1/files' }), ctx())
    expect(res.status).toBe(405)
    expect(res.headers['Allow']).toBe('POST, OPTIONS')
  })
})

describe('POST /v1/search', () => {
  it('returns the worker’s matches and its truncation flag', async () => {
    const res = await handleRequest(
      req({ method: 'POST', path: '/v1/search', body: Buffer.from(JSON.stringify({ query: 'foo' })) }),
      ctx({
        search: async () => ({
          ok: true as const,
          matches: [{ path: 'src/a.ts', line: 3, column: 5, preview: 'const foo = 1' }],
          truncated: true,
        }),
      }),
    )
    expect(res.status).toBe(200)
    expect(parse(res.body)).toEqual({
      ok: true,
      matches: [{ path: 'src/a.ts', line: 3, column: 5, preview: 'const foo = 1' }],
      truncated: true,
    })
  })

  it('400s an empty query, before the worker is ever called', async () => {
    let called = false
    const res = await handleRequest(
      req({ method: 'POST', path: '/v1/search', body: Buffer.from(JSON.stringify({ query: '' })) }),
      ctx({
        search: async () => {
          called = true
          return { ok: true as const, matches: [], truncated: false }
        },
      }),
    )
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  it('405s /v1/search reached with the wrong method', async () => {
    const res = await handleRequest(req({ method: 'GET', path: '/v1/search' }), ctx())
    expect(res.status).toBe(405)
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

  it('accepts a body right at the cap — it gets past the cap gate and is judged on content', async () => {
    const res = await handleRequest(
      req({ method: 'POST', path: '/v1/files', body: Buffer.alloc(MAX_BODY_BYTES) }),
      ctx(),
    )
    // A buffer of NULs is not JSON, so the route rejects it as a bad request
    // rather than as payload-too-large. That distinction is the assertion.
    expect(res.status).toBe(400)
    expect(parse(res.body)['error']).toBe('bad-request')
  })
})
