// @vitest-environment node
/**
 * handler.test.ts — the protocol's gates, exercised as plain data.
 */
import { describe, it, expect } from 'vitest'
import { CheckoutError } from './checkout.js'
import {
  handleRequest,
  handleStreamRequest,
  type BridgeRequest,
  type HandlerContext,
  type StreamSink,
} from './handler.js'
import { MAX_BODY_BYTES, PROTOCOL_VERSION, type HealthResponse } from './protocol.js'
import { REVIEW123_ORIGIN, REVIEW123_WWW_ORIGIN } from './cors.js'

const TOKEN = 'test-token-0000000000000000000000000000000'
const PORT = 7321
const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678'
/** The commit a checked-out PR ref resolves to, in the stack-route fixtures. */
const PR_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

/** A detected, reachable dev server — the happy default for the stack routes. */
const STUB_APP = {
  url: 'http://localhost:8010',
  source: 'posthog' as const,
  reachable: true,
  detail: 'This is a PostHog checkout, whose dev stack is fronted at port 8010.',
}

function ctx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    token: TOKEN,
    port: PORT,
    realRoot: '/private/tmp/checkouts/review123',
    rootName: 'review123',
    extraOrigins: [],
    // READ-ONLY BY DEFAULT. Every test in this file that does not explicitly
    // pass `allowWrite: true` is asserting the behaviour of a bridge the user
    // started without the flag — which is the overwhelming majority of them.
    allowWrite: false,
    // READ-ONLY ABOUT THE WORKING TREE BY DEFAULT, for the same reason and as a
    // SEPARATE default: a test that does not say `allowCheckout: true` is
    // asserting the behaviour of a bridge the user started without that flag.
    allowCheckout: false,
    capabilities: async () => ({
      inference: ['claude'],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      fix: false,
      checkout: false,
    }),
    version: '0.1.0',
    // Default stubs: the handler's own tests never spawn a CLI, open a file or
    // walk a tree. infer/files/search.test.ts own those mechanics; this file
    // owns the protocol gates.
    infer: async () => ({ ok: true as const, text: 'stub answer', truncated: false, durationMs: 3 }),
    inferStream: async (_req, _clis, emit) => {
      emit({ type: 'start', cli: 'claude', streaming: true })
      emit({ type: 'delta', text: 'stub answer' })
      emit({ type: 'done', text: 'stub answer', truncated: false, durationMs: 3 })
    },
    files: async () => ({ ok: true as const, files: [], missing: [], skipped: [] }),
    search: async () => ({ ok: true as const, matches: [], truncated: false }),
    fix: async () => ({
      ok: true as const,
      baseSha: HEAD_SHA,
      branch: 'review123/fix/1234567890ab',
      changes: [],
      skipped: [],
      rounds: 1,
      stopReason: 'all-addressed' as const,
      tests: null,
      durationMs: 5,
    }),
    repoState: async () => ({ head: HEAD_SHA, branch: 'main', dirty: false }),
    // Default stubs for the run-this-PR family. Like their siblings above, the
    // handler's own tests never run a git command; checkout.test.ts owns those
    // mechanics and this file owns the protocol gates.
    stack: async () => ({
      git: { head: HEAD_SHA, branch: 'main', dirty: false },
      dirtyPaths: [],
      dirtyCount: 0,
      prior: null,
      app: STUB_APP,
    }),
    checkout: async () => ({
      git: { head: PR_SHA, branch: null, dirty: false },
      prior: {
        branch: 'main',
        head: HEAD_SHA,
        recordedAt: '2026-01-01T00:00:00.000Z',
        checkedOutRef: 'refs/pull/42/head',
        checkedOutSha: PR_SHA,
        stashRef: null,
      },
      stash: null,
    }),
    restore: async () => ({ git: { head: HEAD_SHA, branch: 'main', dirty: false }, stash: null }),
    appState: async () => STUB_APP,
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
      capabilities: {
        inference: ['claude'],
        infer: true,
        inferStream: true,
        inferAgentic: true,
        files: true,
        search: true,
        fix: false,
        checkout: false,
      },
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
    const context = ctx({ capabilities: async () => ({ inference: installed, infer: true, inferStream: true, inferAgentic: true, files: true, search: true, fix: false, checkout: false }) })
    expect(parse((await handleRequest(req(), context)).body)['capabilities']).toEqual({
      inference: [],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      fix: false,
      checkout: false,
    })
    installed = ['codex']
    expect(parse((await handleRequest(req(), context)).body)['capabilities']).toEqual({
      inference: ['codex'],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      fix: false,
      checkout: false,
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

  it('401s the grounding routes too — auth runs before routing', async () => {
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

  it('answers the private-network preflight for an ALLOWED origin', async () => {
    const res = await handleRequest(
      req({
        method: 'OPTIONS',
        headers: { authorization: undefined, requestPrivateNetwork: 'true' },
      }),
      ctx(),
    )
    expect(res.status).toBe(204)
    expect(res.headers['Access-Control-Allow-Private-Network']).toBe('true')
  })

  it('answers it for the www origin the apex redirects to', async () => {
    const res = await handleRequest(
      req({
        method: 'OPTIONS',
        headers: {
          origin: REVIEW123_WWW_ORIGIN,
          authorization: undefined,
          requestPrivateNetwork: 'true',
        },
      }),
      ctx(),
    )
    expect(res.status).toBe(204)
    expect(res.headers['Access-Control-Allow-Origin']).toBe(REVIEW123_WWW_ORIGIN)
    expect(res.headers['Access-Control-Allow-Private-Network']).toBe('true')
  })

  /**
   * The rule that keeps the new header from widening anything: it rides on the
   * origin allowlist, so a stranger asking for private-network access still
   * gets a bare 403 with no `Access-Control-*` header of ANY kind.
   */
  it('NEVER sends the private-network answer to a rejected origin', async () => {
    const res = await handleRequest(
      req({
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.test',
          authorization: undefined,
          requestPrivateNetwork: 'true',
        },
      }),
      ctx(),
    )
    expect(res.status).toBe(403)
    const cors = Object.keys(res.headers).filter((h) => h.toLowerCase().startsWith('access-control-'))
    expect(cors).toEqual([])
  })

  it('never sends it to an Origin-less preflight either', async () => {
    const res = await handleRequest(
      req({
        method: 'OPTIONS',
        headers: { origin: undefined, authorization: undefined, requestPrivateNetwork: 'true' },
      }),
      ctx(),
    )
    expect(res.status).toBe(204)
    expect(res.headers['Access-Control-Allow-Private-Network']).toBeUndefined()
  })

  it('sends it only when the preflight asked', async () => {
    const res = await handleRequest(
      req({ method: 'OPTIONS', headers: { authorization: undefined } }),
      ctx(),
    )
    expect(res.status).toBe(204)
    expect(res.headers['Access-Control-Allow-Private-Network']).toBeUndefined()
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

  it('forwards the agentic flag to the worker instead of deciding for it', async () => {
    let seen: unknown
    const spy = ctx({
      infer: async (request) => {
        seen = request.agentic
        return { ok: true as const, text: 'a', truncated: false, durationMs: 1 }
      },
    })
    await handleRequest(inferReq({ cli: 'claude', prompt: 'hi', agentic: true }), spy)
    expect(seen).toBe(true)
    await handleRequest(inferReq({ cli: 'claude', prompt: 'hi' }), spy)
    expect(seen).toBeUndefined()
  })

  it('includes the agentic report ONLY when the worker produced one', async () => {
    // Its ABSENCE is the signal a client reads as "this was a plain
    // completion" — the same thing an older bridge sends for an agentic
    // request it does not understand. So it must never be synthesized here.
    const withReport = ctx({
      infer: async () => ({
        ok: true as const, text: 'a', truncated: false, durationMs: 1,
        agentic: { tools: ['Read', 'Glob', 'Grep'], toolCallsAtLeast: 2, denied: 0 },
      }),
    })
    expect(
      parse((await handleRequest(inferReq({ cli: 'claude', prompt: 'hi', agentic: true }), withReport)).body),
    ).toHaveProperty('agentic', { tools: ['Read', 'Glob', 'Grep'], toolCallsAtLeast: 2, denied: 0 })
    expect(
      parse((await handleRequest(inferReq({ cli: 'claude', prompt: 'hi' }), ctx())).body),
    ).not.toHaveProperty('agentic')
  })

  it('400s a non-boolean agentic rather than reading it as truthy', async () => {
    const res = await handleRequest(inferReq({ cli: 'claude', prompt: 'hi', agentic: 'yes' }), ctx())
    expect(res.status).toBe(400)
    expect(parse(res.body)['error']).toBe('bad-request')
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
      capabilities: async () => ({ inference: [], infer: true, inferStream: true, inferAgentic: true, files: false, search: false, fix: false, checkout: false }),
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

// ---------------------------------------------------------------------------
// POST /v1/fix — the one route that writes, and the gate in front of it.
// ---------------------------------------------------------------------------

const FIX_BODY = {
  cli: 'claude',
  headSha: HEAD_SHA,
  findings: [
    { id: 'f1', path: 'src/a.ts', line: 3, severity: 'high', body: 'unescaped input', suggestedFix: 'escape it' },
  ],
}

function fixReq(body: unknown = FIX_BODY, overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return req({
    method: 'POST',
    path: '/v1/fix',
    body: Buffer.from(JSON.stringify(body)),
    ...overrides,
  })
}

describe('POST /v1/fix — the --allow-write gate', () => {
  // THE RULE: writing is granted at the terminal. A web origin cannot turn it
  // on, and cannot get past this without it.
  it('REFUSES with 403 write-disabled on a bridge started without --allow-write', async () => {
    const res = await handleRequest(fixReq(), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('write-disabled')
    expect(parse(res.body)['message']).toContain('--allow-write')
  })

  it('refuses BEFORE the worker runs — a read-only bridge never reaches the fix machinery', async () => {
    let ran = false
    const res = await handleRequest(
      fixReq(),
      ctx({
        fix: async () => {
          ran = true
          throw new Error('must never be reached')
        },
      }),
    )
    expect(res.status).toBe(403)
    expect(ran).toBe(false)
  })

  it('refuses a MALFORMED body with 403 too — the gate is before parsing', async () => {
    const res = await handleRequest(fixReq({ nonsense: true }), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('write-disabled')
  })

  it('nothing in the REQUEST can turn writing on', async () => {
    for (const forged of [
      { ...FIX_BODY, allowWrite: true },
      { ...FIX_BODY, capabilities: { fix: true } },
      { ...FIX_BODY, write: 'yes' },
    ]) {
      expect((await handleRequest(fixReq(forged), ctx())).status).toBe(403)
    }
  })

  it('answers 200 once the bridge WAS started with the flag', async () => {
    const res = await handleRequest(fixReq(), ctx({ allowWrite: true }))
    expect(res.status).toBe(200)
    const payload = parse(res.body)
    expect(payload['ok']).toBe(true)
    expect(payload['branch']).toBe('review123/fix/1234567890ab')
    expect(payload['stopReason']).toBe('all-addressed')
    expect(payload['cli']).toBe('claude')
  })
})

describe('POST /v1/fix — the other gates still apply', () => {
  const write = { allowWrite: true }

  it('still requires the pairing token', async () => {
    const res = await handleRequest(fixReq(FIX_BODY, { headers: { authorization: undefined } }), ctx(write))
    expect(res.status).toBe(401)
  })

  it('still refuses an origin outside the allowlist', async () => {
    const res = await handleRequest(
      fixReq(FIX_BODY, { headers: { origin: 'https://evil.test' } }),
      ctx(write),
    )
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-origin')
  })

  it('still refuses a rebound Host', async () => {
    const res = await handleRequest(fixReq(FIX_BODY, { headers: { host: 'evil.test' } }), ctx(write))
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-host')
  })

  it('answers 405 to a GET, so the route is never reported as missing', async () => {
    const res = await handleRequest(req({ method: 'GET', path: '/v1/fix' }), ctx(write))
    expect(res.status).toBe(405)
    expect(res.headers['Allow']).toBe('POST, OPTIONS')
  })

  it('validates the body, and says which field is wrong', async () => {
    const res = await handleRequest(
      fixReq({ ...FIX_BODY, findings: [{ ...FIX_BODY.findings[0], suggestedFix: '' }] }),
      ctx(write),
    )
    expect(res.status).toBe(400)
    expect(parse(res.body)['message']).toContain('suggestedFix is required')
  })

  it('refuses a CLI that is not installed, with 503 rather than a confusing 501', async () => {
    const res = await handleRequest(
      fixReq({ ...FIX_BODY, cli: 'codex' }),
      ctx({ ...write, capabilities: async () => ({ inference: ['claude'], infer: true, inferStream: true, inferAgentic: true, files: true, search: true, fix: true, checkout: false }) }),
    )
    expect(res.status).toBe(503)
    expect(parse(res.body)['error']).toBe('cli-unavailable')
  })

  it('maps the worker’s failures onto their own statuses', async () => {
    const cases = [
      ['head-unknown', 409],
      ['worktree-failed', 500],
      ['timeout', 504],
    ] as const
    for (const [code, status] of cases) {
      const res = await handleRequest(
        fixReq(),
        ctx({ ...write, fix: async () => ({ ok: false as const, code, message: 'nope' }) }),
      )
      expect(res.status).toBe(status)
      expect(parse(res.body)['error']).toBe(code)
    }
  })
})

// ---------------------------------------------------------------------------
// GET /v1/stack and the checkout family — the routes that move the USER'S OWN
// working tree, and the SECOND, SEPARATE gate in front of them.
// ---------------------------------------------------------------------------

const CHECKOUT_BODY = { ref: 'refs/pull/42/head', acknowledgeUntrusted: true }

function checkoutReq(body: unknown = CHECKOUT_BODY, overrides: Partial<BridgeRequest> = {}) {
  return req({
    method: 'POST',
    path: '/v1/checkout',
    body: Buffer.from(JSON.stringify(body)),
    ...overrides,
  })
}

function restoreReq(body: unknown = {}, overrides: Partial<BridgeRequest> = {}) {
  return req({
    method: 'POST',
    path: '/v1/restore',
    body: Buffer.from(JSON.stringify(body)),
    ...overrides,
  })
}

describe('GET /v1/stack', () => {
  it('answers 200 with the tree, the dirty paths, the prior state and the app', async () => {
    const res = await handleRequest(req({ path: '/v1/stack' }), ctx())
    expect(res.status).toBe(200)
    expect(parse(res.body)).toEqual({
      ok: true,
      git: { head: HEAD_SHA, branch: 'main', dirty: false },
      dirtyPaths: [],
      dirtyCount: 0,
      prior: null,
      app: STUB_APP,
      checkoutEnabled: false,
    })
  })

  // NOT gated on --allow-checkout. The client needs this answer — including
  // the flag's value — to EXPLAIN why the action is unavailable. A 403 here
  // would leave it with a bare disabled button and no reason, which is exactly
  // the failure mode the named-reason discipline exists to prevent.
  it('answers on a bridge WITHOUT --allow-checkout, reporting the flag as false', async () => {
    const res = await handleRequest(req({ path: '/v1/stack' }), ctx())
    expect(res.status).toBe(200)
    expect(parse(res.body)['checkoutEnabled']).toBe(false)
  })

  it('reports checkoutEnabled true when the bridge WAS started with the flag', async () => {
    const res = await handleRequest(req({ path: '/v1/stack' }), ctx({ allowCheckout: true }))
    expect(parse(res.body)['checkoutEnabled']).toBe(true)
  })

  it('reports an undetectable dev server honestly, rather than guessing one', async () => {
    const unknownApp = {
      url: null,
      source: 'unknown' as const,
      reachable: false,
      detail: 'The "dev" script names no port, so the bridge will not guess one.',
    }
    const res = await handleRequest(
      req({ path: '/v1/stack' }),
      ctx({
        stack: async () => ({
          git: { head: HEAD_SHA, branch: 'main', dirty: false },
          dirtyPaths: [],
          dirtyCount: 0,
          prior: null,
          app: unknownApp,
        }),
      }),
    )
    expect(parse(res.body)['app']).toEqual(unknownApp)
  })

  it('carries the dirty paths, so a stash prompt can name what it would move', async () => {
    const res = await handleRequest(
      req({ path: '/v1/stack' }),
      ctx({
        stack: async () => ({
          git: { head: HEAD_SHA, branch: 'main', dirty: true },
          dirtyPaths: ['src/a.ts', 'notes.txt'],
          dirtyCount: 2,
          prior: null,
          app: STUB_APP,
        }),
      }),
    )
    expect(parse(res.body)['dirtyPaths']).toEqual(['src/a.ts', 'notes.txt'])
    expect(parse(res.body)['dirtyCount']).toBe(2)
  })

  it('still requires the pairing token, the origin and the Host', async () => {
    expect(
      (await handleRequest(req({ path: '/v1/stack', headers: { authorization: undefined } }), ctx()))
        .status,
    ).toBe(401)
    expect(
      (await handleRequest(req({ path: '/v1/stack', headers: { origin: 'https://evil.test' } }), ctx()))
        .status,
    ).toBe(403)
    expect(
      (await handleRequest(req({ path: '/v1/stack', headers: { host: 'evil.test' } }), ctx())).status,
    ).toBe(403)
  })
})

describe('POST /v1/checkout — the --allow-checkout gate', () => {
  it('REFUSES with 403 checkout-disabled without the flag', async () => {
    const res = await handleRequest(checkoutReq(), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('checkout-disabled')
    expect(parse(res.body)['message']).toContain('--allow-checkout')
  })

  // THE HEADLINE RULE OF THIS WHOLE FEATURE. Someone who turned on agent fixes
  // must NOT discover they also handed the browser their branch.
  it('--allow-write alone does NOT open it', async () => {
    const res = await handleRequest(checkoutReq(), ctx({ allowWrite: true }))
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('checkout-disabled')
  })

  it('and the refusal SAYS that --allow-write is not the flag they want', async () => {
    const res = await handleRequest(checkoutReq(), ctx({ allowWrite: true }))
    expect(parse(res.body)['message']).toContain('--allow-write does not enable this')
  })

  // The mirror image, so neither grant can be read off the other.
  it('--allow-checkout alone does NOT open /v1/fix', async () => {
    const res = await handleRequest(fixReq(), ctx({ allowCheckout: true }))
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('write-disabled')
  })

  it('refuses BEFORE the worker runs — a read-only bridge never reaches a git command', async () => {
    let ran = false
    const res = await handleRequest(
      checkoutReq(),
      ctx({
        checkout: async () => {
          ran = true
          throw new Error('must never be reached')
        },
      }),
    )
    expect(res.status).toBe(403)
    expect(ran).toBe(false)
  })

  it('refuses a MALFORMED body with 403 too — the gate is before parsing', async () => {
    const res = await handleRequest(checkoutReq({ nonsense: true }), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('checkout-disabled')
  })

  it('nothing in the REQUEST can turn it on', async () => {
    for (const forged of [
      { ...CHECKOUT_BODY, allowCheckout: true },
      { ...CHECKOUT_BODY, capabilities: { checkout: true } },
      // Including the adjacent grant, spelled every way a caller might hope.
      { ...CHECKOUT_BODY, allowWrite: true },
      { ...CHECKOUT_BODY, checkout: 'yes' },
    ]) {
      expect((await handleRequest(checkoutReq(forged), ctx())).status).toBe(403)
    }
  })

  it('/v1/restore is behind the SAME gate', async () => {
    const res = await handleRequest(restoreReq(), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('checkout-disabled')
    expect((await handleRequest(restoreReq(), ctx({ allowWrite: true }))).status).toBe(403)
  })

  it('answers 200 once the bridge WAS started with the flag', async () => {
    const res = await handleRequest(checkoutReq(), ctx({ allowCheckout: true }))
    expect(res.status).toBe(200)
    const payload = parse(res.body)
    expect(payload['ok']).toBe(true)
    expect(payload['git']).toEqual({ head: PR_SHA, branch: null, dirty: false })
    expect(payload['prior']).toMatchObject({ branch: 'main', checkedOutRef: 'refs/pull/42/head' })
    expect(payload['app']).toEqual(STUB_APP)
  })
})

describe('POST /v1/checkout — refusals from the worker', () => {
  const allow = { allowCheckout: true }

  it('renders a tree-dirty refusal WITH the paths, so the UI can name them', async () => {
    const res = await handleRequest(
      checkoutReq(),
      ctx({
        ...allow,
        checkout: async () => {
          throw new CheckoutError('tree-dirty', 'You have 2 uncommitted changes.', {
            dirty: true,
            paths: ['src/a.ts', 'notes.txt'],
            count: 2,
          })
        },
      }),
    )
    expect(res.status).toBe(409)
    const payload = parse(res.body)
    expect(payload['error']).toBe('tree-dirty')
    expect(payload['dirtyPaths']).toEqual(['src/a.ts', 'notes.txt'])
    expect(payload['dirtyCount']).toBe(2)
  })

  it('maps each worker refusal onto its own code and status', async () => {
    const cases = [
      ['untrusted-unacknowledged', 403],
      ['ref-unknown', 404],
      ['prior-gone', 409],
      ['moved-since', 409],
      ['checkout-failed', 500],
    ] as const
    for (const [kind, status] of cases) {
      const res = await handleRequest(
        checkoutReq(),
        ctx({
          ...allow,
          checkout: async () => {
            throw new CheckoutError(kind, 'nope')
          },
        }),
      )
      expect(res.status).toBe(status)
      expect(parse(res.body)['error']).toBe(kind)
    }
  })

  it('does not attach dirtyPaths to refusals that are not about a dirty tree', async () => {
    const res = await handleRequest(
      checkoutReq(),
      ctx({
        ...allow,
        checkout: async () => {
          throw new CheckoutError('ref-unknown', 'no such ref')
        },
      }),
    )
    expect(parse(res.body)).not.toHaveProperty('dirtyPaths')
  })

  it('validates the ref, and says why a flag-shaped one is refused', async () => {
    const res = await handleRequest(
      checkoutReq({ ref: '--upload-pack=evil', acknowledgeUntrusted: true }),
      ctx(allow),
    )
    expect(res.status).toBe(400)
    expect(parse(res.body)['message']).toContain('refs/pull/42/head')
  })

  it('reports a restore with nothing recorded as 404 no-prior-state', async () => {
    const res = await handleRequest(
      restoreReq(),
      ctx({
        ...allow,
        restore: async () => {
          throw new CheckoutError('no-prior-state', 'nothing recorded')
        },
      }),
    )
    expect(res.status).toBe(404)
    expect(parse(res.body)['error']).toBe('no-prior-state')
  })

  it('a completed restore reports NO prior state, so no second Restore is offered', async () => {
    const res = await handleRequest(restoreReq(), ctx(allow))
    expect(res.status).toBe(200)
    expect(parse(res.body)['prior']).toBeNull()
    expect(parse(res.body)['git']).toEqual({ head: HEAD_SHA, branch: 'main', dirty: false })
  })
})

describe('the checkout family — the other gates still apply', () => {
  const allow = { allowCheckout: true }

  it('still requires the pairing token', async () => {
    const res = await handleRequest(
      checkoutReq(CHECKOUT_BODY, { headers: { authorization: undefined } }),
      ctx(allow),
    )
    expect(res.status).toBe(401)
  })

  it('still refuses an origin outside the allowlist', async () => {
    const res = await handleRequest(
      checkoutReq(CHECKOUT_BODY, { headers: { origin: 'https://evil.test' } }),
      ctx(allow),
    )
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-origin')
  })

  it('still refuses a rebound Host', async () => {
    const res = await handleRequest(
      checkoutReq(CHECKOUT_BODY, { headers: { host: 'evil.test' } }),
      ctx(allow),
    )
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-host')
  })

  it('answers 405 to a GET on either route, so neither reads as missing', async () => {
    for (const path of ['/v1/checkout', '/v1/restore']) {
      const res = await handleRequest(req({ method: 'GET', path }), ctx(allow))
      expect(res.status).toBe(405)
      expect(res.headers['Allow']).toBe('POST, OPTIONS')
    }
  })

  it('answers the CORS preflight without auth, like every other route', async () => {
    const res = await handleRequest(
      req({ method: 'OPTIONS', path: '/v1/checkout', headers: { authorization: undefined } }),
      ctx(allow),
    )
    expect(res.status).toBe(204)
  })
})

// ===========================================================================
// POST /v1/infer/stream — the gates, and the pivot at the status line.
//
// The route answers incrementally, so it does not return a BridgeResponse and
// is exercised through a StreamSink that collects what it wrote. What it has
// to prove here is that it runs the SAME ladder /v1/infer runs — a rebound
// host, a foreign origin, a missing token refused identically — and that
// anything decidable BEFORE the CLI starts is still a real HTTP status rather
// than a 200 with the failure buried inside it.
// ===========================================================================

interface CapturedStream {
  readonly status: number
  readonly headers: Record<string, string>
  readonly chunks: string[]
  readonly ended: boolean
  readonly sink: StreamSink
}

function capture(signal: AbortSignal = new AbortController().signal): CapturedStream {
  const state = { status: 0, headers: {} as Record<string, string>, chunks: [] as string[], ended: false }
  const sink: StreamSink = {
    head: (status, headers) => {
      state.status = status
      state.headers = headers
    },
    write: (chunk) => {
      state.chunks.push(chunk)
    },
    end: () => {
      state.ended = true
    },
    signal,
  }
  return {
    get status() {
      return state.status
    },
    get headers() {
      return state.headers
    },
    get chunks() {
      return state.chunks
    },
    get ended() {
      return state.ended
    },
    sink,
  }
}

/** Every NDJSON event the sink received, parsed. */
function events(c: CapturedStream): Record<string, unknown>[] {
  return c.chunks
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function streamReq(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return req({
    method: 'POST',
    path: '/v1/infer/stream',
    body: Buffer.from(JSON.stringify({ cli: 'claude', prompt: 'hi' })),
    ...overrides,
  })
}

describe('POST /v1/infer/stream — the SAME gates as every other route', () => {
  it('refuses a rebound Host with 403 and NO CORS headers', async () => {
    const c = capture()
    await handleStreamRequest(streamReq({ headers: { host: 'evil.example.com' } }), ctx(), c.sink)
    expect(c.status).toBe(403)
    expect(parse(c.chunks.join(''))['error']).toBe('forbidden-host')
    expect(c.headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(c.ended).toBe(true)
  })

  it('refuses a foreign Origin with 403 and NO CORS headers', async () => {
    const c = capture()
    await handleStreamRequest(streamReq({ headers: { origin: 'https://evil.example.com' } }), ctx(), c.sink)
    expect(c.status).toBe(403)
    expect(parse(c.chunks.join(''))['error']).toBe('forbidden-origin')
    expect(c.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('refuses a missing or wrong token with 401 — with CORS, so the browser can READ it', async () => {
    for (const authorization of [undefined, 'Bearer wrong-token']) {
      const c = capture()
      await handleStreamRequest(streamReq({ headers: { authorization } }), ctx(), c.sink)
      expect(c.status).toBe(401)
      expect(parse(c.chunks.join(''))['error']).toBe('unauthorized')
      expect(c.headers['Access-Control-Allow-Origin']).toBe(REVIEW123_ORIGIN)
    }
  })

  it('refuses an over-cap body with 413, before the CLI is even named', async () => {
    const c = capture()
    await handleStreamRequest(streamReq({ body: Buffer.alloc(MAX_BODY_BYTES + 1) }), ctx(), c.sink)
    expect(c.status).toBe(413)
    expect(parse(c.chunks.join(''))['error']).toBe('payload-too-large')
  })

  it('answers the CORS preflight without auth, like every other route', async () => {
    const c = capture()
    await handleStreamRequest(
      streamReq({ method: 'OPTIONS', headers: { authorization: undefined } }),
      ctx(),
      c.sink,
    )
    expect(c.status).toBe(204)
    expect(c.headers['Access-Control-Allow-Origin']).toBe(REVIEW123_ORIGIN)
  })

  it('answers 405 to a GET, so the route never reads as missing', async () => {
    // Through handleRequest, because that is where a non-POST actually lands.
    const res = await handleRequest(req({ method: 'GET', path: '/v1/infer/stream' }), ctx())
    expect(res.status).toBe(405)
    expect(res.headers['Allow']).toBe('POST, OPTIONS')
  })
})

describe('POST /v1/infer/stream — what is decided BEFORE the status line', () => {
  it('a malformed body is a real 400, not a 200 with an error inside it', async () => {
    const c = capture()
    await handleStreamRequest(streamReq({ body: Buffer.from('{"cli":"nope"}') }), ctx(), c.sink)
    expect(c.status).toBe(400)
    expect(parse(c.chunks.join(''))['error']).toBe('bad-request')
  })

  it('an uninstalled CLI is a real 503, re-probed per call', async () => {
    const c = capture()
    await handleStreamRequest(
      streamReq(),
      ctx({
        capabilities: async () => ({
          inference: ['codex'],
          infer: true,
          inferStream: true,
          inferAgentic: true,
          files: true,
          search: true,
          fix: false,
          checkout: false,
        }),
      }),
      c.sink,
    )
    expect(c.status).toBe(503)
    expect(parse(c.chunks.join(''))['error']).toBe('cli-unavailable')
  })
})

describe('POST /v1/infer/stream — the NDJSON framing', () => {
  it('commits 200 application/x-ndjson and writes one JSON document per line', async () => {
    const c = capture()
    await handleStreamRequest(streamReq(), ctx(), c.sink)
    expect(c.status).toBe(200)
    expect(c.headers['Content-Type']).toBe('application/x-ndjson')
    expect(c.headers['Cache-Control']).toBe('no-store')
    expect(c.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(c.headers['Access-Control-Allow-Origin']).toBe(REVIEW123_ORIGIN)
    for (const chunk of c.chunks) {
      expect(chunk.endsWith('\n')).toBe(true)
      expect(() => JSON.parse(chunk.trimEnd())).not.toThrow()
    }
    expect(events(c).map((e) => e['type'])).toEqual(['start', 'delta', 'done'])
    expect(c.ended).toBe(true)
  })

  it('writes each event as its OWN write, so a reader sees them as they happen', async () => {
    const c = capture()
    await handleStreamRequest(
      streamReq(),
      ctx({
        inferStream: async (_req, _clis, emit) => {
          emit({ type: 'start', cli: 'claude', streaming: true })
          emit({ type: 'delta', text: 'a' })
          emit({ type: 'delta', text: 'b' })
          emit({ type: 'done', text: 'ab', truncated: false, durationMs: 1 })
        },
      }),
      c.sink,
    )
    // Four events, four writes — never one buffered blob at the end.
    expect(c.chunks).toHaveLength(4)
  })

  it('hands the worker the detected CLI list and the parsed request', async () => {
    let seen: { cli: string; prompt: string } | null = null
    let clis: readonly string[] = []
    const c = capture()
    await handleStreamRequest(
      streamReq({ body: Buffer.from(JSON.stringify({ cli: 'claude', prompt: 'review this' })) }),
      ctx({
        inferStream: async (request, available, emit) => {
          seen = { cli: request.cli, prompt: request.prompt }
          clis = available
          emit({ type: 'done', text: '', truncated: false, durationMs: 0 })
        },
      }),
      c.sink,
    )
    expect(seen).toEqual({ cli: 'claude', prompt: 'review this' })
    expect(clis).toEqual(['claude'])
  })
})

describe('POST /v1/infer/stream — a client that went away', () => {
  it('forwards the disconnect signal to the worker', async () => {
    const controller = new AbortController()
    const c = capture(controller.signal)
    let received: AbortSignal | null = null
    await handleStreamRequest(
      streamReq(),
      ctx({
        inferStream: async (_req, _clis, _emit, signal) => {
          received = signal
        },
      }),
      c.sink,
    )
    expect(received).toBe(controller.signal)
  })

  it('stops writing once the client is gone, instead of filling a dead socket', async () => {
    const controller = new AbortController()
    const c = capture(controller.signal)
    await handleStreamRequest(
      streamReq(),
      ctx({
        inferStream: async (_req, _clis, emit) => {
          emit({ type: 'start', cli: 'claude', streaming: true })
          emit({ type: 'delta', text: 'before' })
          controller.abort()
          emit({ type: 'delta', text: 'after' })
          emit({ type: 'done', text: 'x', truncated: false, durationMs: 1 })
        },
      }),
      c.sink,
    )
    expect(events(c).map((e) => e['type'])).toEqual(['start', 'delta'])
    expect(c.chunks.join('')).not.toContain('after')
  })

  it('awaits the worker even after the client is gone — that await is what reaps the child', async () => {
    const controller = new AbortController()
    controller.abort()
    const c = capture(controller.signal)
    let finished = false
    await handleStreamRequest(
      streamReq(),
      ctx({
        inferStream: async () => {
          await new Promise((r) => setTimeout(r, 20))
          finished = true
        },
      }),
      c.sink,
    )
    expect(finished).toBe(true)
    expect(c.ended).toBe(true)
  })
})
