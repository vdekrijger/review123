// @vitest-environment node
/**
 * server.test.ts — the socket shell, against a REAL listening server.
 *
 * The one property that cannot be tested through the pure handler is the bind
 * address, and it is the most consequential setting in the package: a bridge on
 * 0.0.0.0 hands the whole LAN a read view of the user's repo. So this suite
 * starts an actual server and inspects what it bound.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOOPBACK_HOST, createBridgeServer, listenLoopback, type BridgeServer } from './server.js'
import { MAX_BODY_BYTES, PROTOCOL_VERSION } from './protocol.js'
import { REVIEW123_ORIGIN } from './cors.js'

const TOKEN = 'server-test-token-000000000000000000000000'

let bridge: BridgeServer
let server: Server
let port: number
let root: string
/** Flipped per-test so /v1/health and /v1/infer see the same detected list. */
let claudeInstalled = false

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-server-')))
  bridge = createBridgeServer({
    token: TOKEN,
    // 0 asks the OS for a free port so parallel suites never collide. The CLI
    // refuses --port 0; only tests use it.
    port: 0,
    realRoot: root,
    version: '0.1.0',
    // A non-empty PATH so the detector actually consults `isExecutable`
    // (empty PATH entries are skipped — see capabilities.ts).
    capabilityDeps: { env: { PATH: '/bin' }, isExecutable: async () => claudeInstalled },
    // No CLI is spawned over HTTP: the socket shell's job is to carry the
    // handler's answer, and infer.test.ts owns the subprocess behaviour.
    infer: async (req) =>
      req.prompt === 'boom'
        ? { ok: false as const, code: 'cli-failed' as const, message: 'The claude CLI exited with code 1.' }
        : { ok: true as const, text: `echo:${req.prompt}`, truncated: false, durationMs: 7 },
  })
  server = bridge.server
  port = await listenLoopback(bridge, 0)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Fetch the bridge with the Host header a real loopback client would send. */
function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://${LOOPBACK_HOST}:${port}${path}`, init)
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra }
}

describe('bind address', () => {
  it('listens on 127.0.0.1 — never 0.0.0.0 or ::', () => {
    const address = server.address()
    expect(address).not.toBeNull()
    expect(typeof address).not.toBe('string')
    expect((address as { address: string }).address).toBe('127.0.0.1')
  })

  it('exposes loopback as a constant, with no way to override it', () => {
    expect(LOOPBACK_HOST).toBe('127.0.0.1')
  })
})

describe('GET /v1/health over HTTP', () => {
  it('answers 200 with the health document', async () => {
    const res = await call('/v1/health', { headers: auth({ Origin: REVIEW123_ORIGIN }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('access-control-allow-origin')).toBe(REVIEW123_ORIGIN)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['protocol']).toBe(PROTOCOL_VERSION)
    expect(body['root']).toBe(root.split('/').pop())
    expect(body['capabilities']).toEqual({ inference: [], infer: true, files: false, search: false })
  })

  it('ignores a query string when routing', async () => {
    const res = await call('/v1/health?cachebust=1', { headers: auth() })
    expect(res.status).toBe(200)
  })

  it('401s without a token', async () => {
    const res = await call('/v1/health')
    expect(res.status).toBe(401)
    expect((await res.json() as Record<string, unknown>)['error']).toBe('unauthorized')
  })

  it('403s a disallowed Origin', async () => {
    const res = await call('/v1/health', { headers: auth({ Origin: 'https://evil.test' }) })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('preflight over HTTP', () => {
  it('answers OPTIONS with 204 and no body', async () => {
    const res = await call('/v1/files', {
      method: 'OPTIONS',
      headers: {
        Origin: REVIEW123_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(REVIEW123_ORIGIN)
    expect(await res.text()).toBe('')
  })
})

describe('POST /v1/infer over HTTP', () => {
  it('405s a GET — the route is POST-only', async () => {
    const res = await call('/v1/infer', { headers: auth() })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST, OPTIONS')
  })

  it('401s without the pairing token — auth runs before anything is spawned', async () => {
    const res = await call('/v1/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli: 'claude', prompt: 'hello' }),
    })
    expect(res.status).toBe(401)
  })

  it('403s a disallowed Origin with no CORS headers at all', async () => {
    const res = await call('/v1/infer', {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json', Origin: 'https://evil.test' }),
      body: JSON.stringify({ cli: 'claude', prompt: 'hello' }),
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('400s a body that names no known CLI', async () => {
    const res = await call('/v1/infer', {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ cli: 'rm -rf /', prompt: 'hello' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as Record<string, unknown>)['error']).toBe('bad-request')
  })

  it('503s when the named CLI is not on PATH', async () => {
    claudeInstalled = false
    const res = await call('/v1/infer', {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ cli: 'claude', prompt: 'hello' }),
    })
    expect(res.status).toBe(503)
    expect((await res.json() as Record<string, unknown>)['error']).toBe('cli-unavailable')
  })

  it('answers 200 with the InferResponse shape when the CLI succeeds', async () => {
    claudeInstalled = true
    try {
      const res = await call('/v1/infer', {
        method: 'POST',
        headers: auth({ 'Content-Type': 'application/json', Origin: REVIEW123_ORIGIN }),
        body: JSON.stringify({ cli: 'claude', prompt: 'hello' }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe(REVIEW123_ORIGIN)
      expect(await res.json()).toEqual({
        ok: true,
        cli: 'claude',
        text: 'echo:hello',
        truncated: false,
        durationMs: 7,
      })
    } finally {
      claudeInstalled = false
    }
  })

  it('502s a CLI failure with the honest cli-failed code', async () => {
    claudeInstalled = true
    try {
      const res = await call('/v1/infer', {
        method: 'POST',
        headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ cli: 'claude', prompt: 'boom' }),
      })
      expect(res.status).toBe(502)
      expect((await res.json() as Record<string, unknown>)['error']).toBe('cli-failed')
    } finally {
      claudeInstalled = false
    }
  })
})

describe('reserved routes over HTTP', () => {
  it.each(['/v1/files', '/v1/search'])('%s answers 501', async (path) => {
    const res = await call(path, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: '{}',
    })
    expect(res.status).toBe(501)
    expect((await res.json() as Record<string, unknown>)['error']).toBe('not-implemented')
  })
})

describe('caps', () => {
  it('413s a body over the cap instead of buffering it', async () => {
    const res = await call('/v1/files', {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: 'x'.repeat(MAX_BODY_BYTES + 1024),
    })
    expect(res.status).toBe(413)
  })

  it('sets a request timeout so a half-open request cannot pin the process', () => {
    expect(server.requestTimeout).toBeGreaterThan(0)
    expect(server.headersTimeout).toBeGreaterThan(0)
  })
})

describe('unknown routes', () => {
  it('404s anything outside the contract', async () => {
    const res = await call('/v1/exec', { method: 'POST', headers: auth(), body: '{}' })
    expect(res.status).toBe(404)
  })
})
