// @vitest-environment node
/**
 * handler.test.ts — the protocol's gates, exercised as plain data.
 */
import { describe, it, expect } from 'vitest'
import { CheckoutError } from './checkout.js'
import { PushError } from './push.js'
import {
  handleRequest,
  handleStreamRequest,
  type BridgeRequest,
  type HandlerContext,
  type StreamSink,
} from './handler.js'
import { COMMITS_PATH, MAX_BODY_BYTES, PROTOCOL_VERSION, type HealthResponse } from './protocol.js'
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
    // AND SEPARATELY AGAIN, for the grant whose effects other people can see:
    // a test that does not say `allowPush: true` is asserting the behaviour of
    // a bridge that may not write to a remote. That is almost all of them, and
    // it is the default a mistake should fall back to.
    allowPush: false,
    capabilities: async () => ({
      inference: ['claude'],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      commits: true,
      fix: false,
      checkout: false,
      push: false,
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
    ciFix: async () => ({
      ok: true as const,
      reproduction: 'reproduced' as const,
      baseline: { status: 'failed' as const, command: 'pnpm test', durationMs: 20, output: 'stub red' },
      baseSha: HEAD_SHA,
      branch: 'review123/fix/1234567890ab',
      changes: [],
      skipped: [],
      rounds: 1,
      stopReason: 'all-addressed' as const,
      tests: null,
      headCommit: null,
      durationMs: 5,
    }),
    // A stub that RESOLVES. Every push refusal in this file is asserted by
    // making the gate refuse, or by throwing a PushError from an override —
    // never by letting a real git command run, which is what keeps a test run
    // structurally incapable of pushing anything anywhere.
    push: async (req) => ({
      ok: true as const,
      remote: req.remote,
      branch: req.branch,
      before: req.expectedRemoteSha,
      after: req.sha,
      commits: 1,
      durationMs: 7,
    }),
    repoState: async () => ({ head: HEAD_SHA, branch: 'main', dirty: false }),
    // The containment probe. The default repo "has" only its own HEAD, which
    // is the pre-#293 world the equality test assumed — so a test that wants a
    // commit the checkout is NOT sitting on has to say so, and says it as data.
    commits: async (shas) => shas.filter((sha) => sha === HEAD_SHA),
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
        commits: true,
        fix: false,
        checkout: false,
        push: false,
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
    const context = ctx({ capabilities: async () => ({ inference: installed, infer: true, inferStream: true, inferAgentic: true, files: true, search: true, commits: true, fix: false, checkout: false, push: false }) })
    expect(parse((await handleRequest(req(), context)).body)['capabilities']).toEqual({
      inference: [],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      commits: true,
      fix: false,
      checkout: false,
      push: false,
    })
    installed = ['codex']
    expect(parse((await handleRequest(req(), context)).body)['capabilities']).toEqual({
      inference: ['codex'],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      commits: true,
      fix: false,
      checkout: false,
      push: false,
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
      capabilities: async () => ({ inference: [], infer: true, inferStream: true, inferAgentic: true, files: false, search: false, commits: true, fix: false, checkout: false, push: false }),
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

describe('POST /v1/commits — the containment probe', () => {
  const OTHER_SHA = 'b'.repeat(40)

  it('answers which of the requested commits this repository has', async () => {
    const res = await handleRequest(
      req({
        method: 'POST',
        path: COMMITS_PATH,
        body: Buffer.from(JSON.stringify({ shas: [HEAD_SHA, OTHER_SHA] })),
      }),
      ctx({ commits: async (shas) => shas.filter((s) => s === OTHER_SHA) }),
    )
    expect(res.status).toBe(200)
    expect(parse(res.body)).toEqual({ ok: true, present: [OTHER_SHA] })
  })

  it('ANSWERS ON A READ-ONLY BRIDGE — it is a read, and it gets no write gate', async () => {
    // The whole point: a client asks this BEFORE it offers the fix button, and
    // a bridge without --allow-write must still be able to say "yes, that
    // commit is here" so the refusal it does show names the right reason.
    const res = await handleRequest(
      req({
        method: 'POST',
        path: COMMITS_PATH,
        body: Buffer.from(JSON.stringify({ shas: [OTHER_SHA] })),
      }),
      ctx({ allowWrite: false, commits: async (shas) => [...shas] }),
    )
    expect(res.status).toBe(200)
    expect(parse(res.body)['present']).toEqual([OTHER_SHA])
  })

  it('a commit the repository has never seen comes back absent, not as an error', async () => {
    const res = await handleRequest(
      req({
        method: 'POST',
        path: COMMITS_PATH,
        body: Buffer.from(JSON.stringify({ shas: [OTHER_SHA] })),
      }),
      ctx({ commits: async () => [] }),
    )
    expect(res.status).toBe(200)
    expect(parse(res.body)).toEqual({ ok: true, present: [] })
  })

  it('400s a malformed body before the probe is ever called', async () => {
    let called = false
    const res = await handleRequest(
      req({ method: 'POST', path: COMMITS_PATH, body: Buffer.from(JSON.stringify({ shas: ['abc'] })) }),
      ctx({
        commits: async () => {
          called = true
          return []
        },
      }),
    )
    expect(res.status).toBe(400)
    expect(parse(res.body)['error']).toBe('bad-request')
    expect(called).toBe(false)
  })

  it('405s the route reached with the wrong method', async () => {
    const res = await handleRequest(req({ method: 'GET', path: COMMITS_PATH }), ctx())
    expect(res.status).toBe(405)
    expect(res.headers['Allow']).toBe('POST, OPTIONS')
  })

  it('still needs the pairing token, like every other route', async () => {
    const res = await handleRequest(
      req({
        method: 'POST',
        path: COMMITS_PATH,
        body: Buffer.from(JSON.stringify({ shas: [OTHER_SHA] })),
        headers: { authorization: 'Bearer wrong' },
      }),
      ctx(),
    )
    expect(res.status).toBe(401)
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
      ctx({ ...write, capabilities: async () => ({ inference: ['claude'], infer: true, inferStream: true, inferAgentic: true, files: true, search: true, commits: true, fix: true, checkout: false, push: false }) }),
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
          commits: true,
          fix: false,
          checkout: false,
          push: false,
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

// ---------------------------------------------------------------------------
// POST /v1/push — the one route that leaves the machine, and its own gate.
// ---------------------------------------------------------------------------

const PUSH_BODY = {
  remote: 'origin',
  branch: 'feat/thing',
  expectedRemoteSha: HEAD_SHA,
  sha: PR_SHA,
}

function pushReq(body: unknown = PUSH_BODY, overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return req({
    method: 'POST',
    path: '/v1/push',
    body: Buffer.from(JSON.stringify(body)),
    ...overrides,
  })
}

describe('POST /v1/push — the --allow-push gate', () => {
  it('REFUSES with 403 push-disabled on a bridge started without --allow-push', async () => {
    const res = await handleRequest(pushReq(), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('push-disabled')
    expect(parse(res.body)['message']).toContain('--allow-push')
  })

  // THE RULE THIS ROUTE EXISTS TO ENFORCE. The two local grants authorise
  // things their owner can undo. This one does not, so neither of them — nor
  // both together — may stand in for it.
  it('is NOT enabled by --allow-write', async () => {
    expect((await handleRequest(pushReq(), ctx({ allowWrite: true }))).status).toBe(403)
  })

  it('is NOT enabled by --allow-checkout', async () => {
    expect((await handleRequest(pushReq(), ctx({ allowCheckout: true }))).status).toBe(403)
  })

  it('is NOT enabled by BOTH of them together', async () => {
    const res = await handleRequest(pushReq(), ctx({ allowWrite: true, allowCheckout: true }))
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('push-disabled')
  })

  it('refuses BEFORE the worker runs — an ungranted bridge never reaches git', async () => {
    let ran = false
    const res = await handleRequest(
      pushReq(),
      ctx({
        push: async () => {
          ran = true
          throw new Error('must never be reached')
        },
      }),
    )
    expect(res.status).toBe(403)
    expect(ran).toBe(false)
  })

  it('refuses a MALFORMED body with 403 too — the gate is before parsing', async () => {
    const res = await handleRequest(pushReq({ nonsense: true }), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('push-disabled')
  })

  it('nothing in the REQUEST can turn pushing on', async () => {
    for (const forged of [
      { ...PUSH_BODY, allowPush: true },
      { ...PUSH_BODY, capabilities: { push: true } },
      { ...PUSH_BODY, force: true },
    ]) {
      expect((await handleRequest(pushReq(forged), ctx())).status).toBe(403)
    }
  })

  it('answers 200 once the bridge WAS started with the flag, echoing the exact move', async () => {
    const res = await handleRequest(pushReq(), ctx({ allowPush: true }))
    expect(res.status).toBe(200)
    const payload = parse(res.body)
    expect(payload).toMatchObject({
      ok: true,
      remote: 'origin',
      branch: 'feat/thing',
      before: HEAD_SHA,
      after: PR_SHA,
    })
  })
})

describe('POST /v1/push — the other gates still apply', () => {
  const allow = { allowPush: true }

  it('still requires the pairing token', async () => {
    const res = await handleRequest(pushReq(PUSH_BODY, { headers: { authorization: undefined } }), ctx(allow))
    expect(res.status).toBe(401)
  })

  it('still refuses an origin outside the allowlist', async () => {
    const res = await handleRequest(pushReq(PUSH_BODY, { headers: { origin: 'https://evil.test' } }), ctx(allow))
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-origin')
  })

  it('still refuses a rebound Host', async () => {
    const res = await handleRequest(pushReq(PUSH_BODY, { headers: { host: 'evil.test' } }), ctx(allow))
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('forbidden-host')
  })

  it('answers 405 to a GET, so the route is never reported as missing', async () => {
    const res = await handleRequest(req({ method: 'GET', path: '/v1/push' }), ctx(allow))
    expect(res.status).toBe(405)
  })

  it('validates the body, and says which field is wrong', async () => {
    const res = await handleRequest(pushReq({ ...PUSH_BODY, branch: 'refs/heads/x' }), ctx(allow))
    expect(res.status).toBe(400)
    expect(parse(res.body)['message']).toContain('plain branch name')
  })
})

describe('POST /v1/push — every refusal keeps its own status and sentence', () => {
  const allow = { allowPush: true }

  it.each([
    ['protected-branch', 403],
    ['branch-missing', 404],
    ['commit-unknown', 404],
    ['remote-unknown', 404],
    ['remote-moved', 409],
    ['not-fast-forward', 409],
    ['nothing-to-push', 409],
    ['default-branch-unknown', 409],
    ['remote-unreachable', 502],
    ['push-rejected', 502],
    ['push-failed', 500],
  ] as const)('renders %s as HTTP %i with the worker’s own words', async (kind, status) => {
    const res = await handleRequest(
      pushReq(PUSH_BODY, {}),
      ctx({
        ...allow,
        push: async () => {
          throw new PushError(kind, `a sentence about ${kind}`)
        },
      }),
    )
    expect(res.status).toBe(status)
    expect(parse(res.body)['error']).toBe(kind)
    expect(parse(res.body)['message']).toBe(`a sentence about ${kind}`)
  })

  it('carries the dirty paths on tree-dirty, so the user sees what is in the way', async () => {
    const res = await handleRequest(
      pushReq(PUSH_BODY, {}),
      ctx({
        ...allow,
        push: async () => {
          throw new PushError('tree-dirty', 'uncommitted changes', {
            dirty: true,
            paths: ['src/wip.ts'],
            count: 1,
          })
        },
      }),
    )
    expect(res.status).toBe(409)
    expect(parse(res.body)['dirtyPaths']).toEqual(['src/wip.ts'])
    expect(parse(res.body)['dirtyCount']).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// POST /v1/ci-fix — writes in a worktree, pushes nothing.
// ---------------------------------------------------------------------------

const CI_FIX_BODY = {
  cli: 'claude',
  headSha: HEAD_SHA,
  failures: [{ id: 'job-1', name: 'test (ubuntu-latest)', log: 'FAIL src/a.test.ts' }],
}

function ciFixReq(body: unknown = CI_FIX_BODY, overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return req({
    method: 'POST',
    path: '/v1/ci-fix',
    body: Buffer.from(JSON.stringify(body)),
    ...overrides,
  })
}

describe('POST /v1/ci-fix', () => {
  it('is gated on --allow-write, because that is what it actually does', async () => {
    const res = await handleRequest(ciFixReq(), ctx())
    expect(res.status).toBe(403)
    expect(parse(res.body)['error']).toBe('write-disabled')
  })

  // It commits in a scratch worktree and stops. Pushing what it made is a
  // separate request with a separate grant, so requiring --allow-push here
  // would describe the route as doing something it does not do.
  it('does NOT require --allow-push — it never reaches a remote', async () => {
    const res = await handleRequest(ciFixReq(), ctx({ allowWrite: true }))
    expect(res.status).toBe(200)
  })

  it('reports the reproduction verdict and the sha a push could carry', async () => {
    const res = await handleRequest(ciFixReq(), ctx({ allowWrite: true }))
    const payload = parse(res.body)
    expect(payload['reproduction']).toBe('reproduced')
    expect(payload).toHaveProperty('baseline')
    expect(payload).toHaveProperty('headCommit')
  })

  it('reports a run that never started an agent, with nothing to push', async () => {
    const res = await handleRequest(
      ciFixReq(),
      ctx({
        allowWrite: true,
        ciFix: async () => ({
          ok: true as const,
          reproduction: 'not-reproduced' as const,
          baseline: { status: 'passed' as const, command: 'pnpm test', durationMs: 9, output: '' },
          baseSha: HEAD_SHA,
          branch: 'review123/fix/1234567890ab',
          changes: [],
          skipped: [],
          rounds: 0,
          stopReason: 'all-addressed' as const,
          tests: null,
          headCommit: null,
          durationMs: 9,
        }),
      }),
    )
    const payload = parse(res.body)
    expect(payload['reproduction']).toBe('not-reproduced')
    expect(payload['changes']).toEqual([])
    expect(payload['headCommit']).toBeNull()
  })

  it('validates the body, and says which field is wrong', async () => {
    const res = await handleRequest(ciFixReq({ ...CI_FIX_BODY, failures: [] }), ctx({ allowWrite: true }))
    expect(res.status).toBe(400)
    expect(parse(res.body)['message']).toContain('non-empty array')
  })

  it('refuses a CLI that is not installed, with 503', async () => {
    const res = await handleRequest(ciFixReq({ ...CI_FIX_BODY, cli: 'codex' }), ctx({ allowWrite: true }))
    expect(res.status).toBe(503)
    expect(parse(res.body)['error']).toBe('cli-unavailable')
  })

  it('answers 405 to a GET, so the route is never reported as missing', async () => {
    const res = await handleRequest(req({ method: 'GET', path: '/v1/ci-fix' }), ctx({ allowWrite: true }))
    expect(res.status).toBe(405)
  })
})
