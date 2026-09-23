// @vitest-environment node
/**
 * server.test.ts — the socket shell, against a REAL listening server.
 *
 * The one property that cannot be tested through the pure handler is the bind
 * address, and it is the most consequential setting in the package: a bridge on
 * 0.0.0.0 hands the whole LAN a read view of the user's repo. So this suite
 * starts an actual server and inspects what it bound.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LOOPBACK_HOST, createBridgeServer, listenLoopback, type BridgeServer } from './server.js'
import { MAX_BODY_BYTES, PROTOCOL_VERSION } from './protocol.js'
import { REVIEW123_ORIGIN, REVIEW123_WWW_ORIGIN } from './cors.js'
import { runStreamProcess } from './inferStream.js'
import { runProcess } from './infer.js'

const TOKEN = 'server-test-token-000000000000000000000000'

let bridge: BridgeServer
let server: Server
let port: number
let root: string
/** Flipped per-test so /v1/health and /v1/infer see the same detected list. */
let claudeInstalled = false

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-server-')))
  // One real file inside the served root, and one OUTSIDE it that the
  // confinement test tries (and must fail) to reach through `..`.
  await writeFile(join(root, 'hello.txt'), 'hello bridge')
  await writeFile(join(dirname(root), 'outside.txt'), 'secret')
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
    // A temp dir is not a checkout, so the real probe would answer null on
    // every health call (and spawn three `git` processes to say so). A fixed
    // state instead proves the field actually crosses the socket.
    repoState: async () => ({ head: 'a'.repeat(40), branch: 'main', dirty: false }),
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
    // `fix: false` because this server was built without `allowWrite`, and
    // `checkout: false` because it was built without `allowCheckout` — the
    // health document reports each flag, never a hard-coded readiness boolean.
    expect(body['capabilities']).toEqual({
      inference: [],
      infer: true,
      inferStream: true,
      inferAgentic: true,
      files: true,
      search: true,
      fix: false,
      checkout: false,
    })
    expect(body['git']).toEqual({ head: 'a'.repeat(40), branch: 'main', dirty: false })
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

  /**
   * The SOCKET half of the private-network answer. handler.test.ts proves the
   * rule over plain data; this proves `server.ts` actually reads the header
   * off the wire and writes the answer back onto it — the wiring a pure test
   * cannot see.
   */
  it('answers a private-network preflight from an allowed origin', async () => {
    const res = await call('/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: REVIEW123_WWW_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-private-network')).toBe('true')
    expect(res.headers.get('access-control-allow-origin')).toBe(REVIEW123_WWW_ORIGIN)
  })

  it('gives a rejected origin a bare 403 even when it asks for private-network access', async () => {
    const res = await call('/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.test',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-private-network')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('sends no private-network answer when the preflight did not ask', async () => {
    const res = await call('/v1/health', {
      method: 'OPTIONS',
      headers: { Origin: REVIEW123_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-private-network')).toBeNull()
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

describe('grounding routes over HTTP', () => {
  it('reads a real file out of the served root, and reports a missing one as missing', async () => {
    const res = await call('/v1/files', {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ paths: ['hello.txt', 'gone.txt'] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['files']).toEqual([
      { path: 'hello.txt', bytes: 12, truncated: false, content: 'hello bridge', encoding: 'utf-8' },
    ])
    expect(body['missing']).toEqual(['gone.txt'])
    expect(body['skipped']).toEqual([])
  })

  it('403s a path that escapes the served root — over the wire, not just in the worker', async () => {
    const res = await call('/v1/files', {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ paths: ['../outside.txt'] }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['error']).toBe('forbidden-path')
    expect(res.body === null ? '' : JSON.stringify(body)).not.toContain('secret')
  })

  it('searches the served root and finds the file it just read', async () => {
    const res = await call('/v1/search', {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query: 'hello bridge' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { matches: { path: string; line: number }[] }
    expect(body.matches.map((m) => m.path)).toContain('hello.txt')
  })

  it('400s a search with no query', async () => {
    const res = await call('/v1/search', {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: '{}',
    })
    expect(res.status).toBe(400)
    expect((await res.json() as Record<string, unknown>)['error']).toBe('bad-request')
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

// ===========================================================================
// POST /v1/infer/stream, OVER A REAL SOCKET.
//
// Everything below needs an actual TCP connection, because the properties are
// about the connection: that bytes reach the reader BEFORE the run is over,
// and that a reader hanging up kills the CLI. A pure-data sink can prove the
// event shapes (handler.test.ts does) but not either of these.
//
// The child is `node`, not `claude`: CI has no CLI installed, and what is
// being proved is the plumbing between a browser's abort and a dead pid —
// which is identical whichever binary is on the other end.
// ===========================================================================

describe('POST /v1/infer/stream over HTTP', () => {
  let streamBridge: BridgeServer
  let streamPort: number
  /** The pid of the last child the stream worker spawned. */
  let lastPid: number | undefined
  /** Resolves once that child has been spawned, so a test can race it. */
  let spawned: Promise<void>
  let markSpawned: () => void

  beforeAll(async () => {
    streamBridge = createBridgeServer({
      token: TOKEN,
      port: 0,
      realRoot: root,
      version: '0.1.0',
      capabilityDeps: { env: { PATH: '/bin' }, isExecutable: async () => true },
      // A real subprocess, driven through the real streaming runner, with the
      // real disconnect signal the socket shell built.
      inferStream: async (_req, _clis, emit, signal) => {
        emit({ type: 'start', cli: 'claude', streaming: true })
        const result = await runStreamProcess({
          bin: process.execPath,
          // Emits a line every 60ms forever. Only a kill ends it.
          args: ['-e', `let i=0;setInterval(()=>process.stdout.write('chunk'+(++i)+'\\n'),60)`],
          stdin: '',
          cwd: root,
          timeoutMs: 20_000,
          signal,
          onLine: (line) => {
            emit({ type: 'delta', text: line })
            return true
          },
        })
        lastPid = result.pid
        markSpawned()
        if (result.aborted) return
        emit({ type: 'done', text: '', truncated: result.truncated, durationMs: 1 })
      },
    })
    streamPort = await listenLoopback(streamBridge, 0)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => streamBridge.server.close(() => resolve()))
  })

  beforeEach(() => {
    lastPid = undefined
    spawned = new Promise<void>((resolve) => {
      markSpawned = resolve
    })
  })

  function streamCall(init: RequestInit = {}): Promise<Response> {
    return fetch(`http://${LOOPBACK_HOST}:${streamPort}/v1/infer/stream`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli: 'claude', prompt: 'hi' }),
      ...init,
    })
  }

  it('DELIVERS DELTAS AS THEY HAPPEN — not one blob when the run ends', async () => {
    const controller = new AbortController()
    const res = await streamCall({ signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    const started = Date.now()
    const arrivals: number[] = []
    let buffer = ''
    const lines: string[] = []

    // Read until three deltas have arrived. The child never stops on its own,
    // so reaching this at all proves bytes were flushed mid-run.
    while (lines.length < 4) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
        arrivals.push(Date.now() - started)
      }
    }
    controller.abort()
    await spawned

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed[0]).toEqual({ type: 'start', cli: 'claude', streaming: true })
    expect(parsed.slice(1).map((e) => e['type'])).toEqual(['delta', 'delta', 'delta'])
    // The first delta landed well before the third: it was streamed, not
    // buffered and released together.
    expect(arrivals[1]!).toBeLessThan(arrivals[3]! - 40)
  }, 20_000)

  it('A CLIENT ABORT KILLS THE CHILD — no orphan left spending the subscription', async () => {
    const controller = new AbortController()
    const res = await streamCall({ signal: controller.signal })
    const reader = res.body!.getReader()
    // Wait until the child is definitely running and writing.
    await reader.read()
    await reader.read()

    controller.abort()

    // The worker resolves only after runStreamProcess saw 'close', i.e. after
    // the child was reaped — so awaiting it is awaiting the reap.
    await spawned
    expect(typeof lastPid).toBe('number')
    let alive = true
    try {
      process.kill(lastPid!, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }, 20_000)

  it('still enforces auth, Origin and Host on the streaming route', async () => {
    const base = `http://${LOOPBACK_HOST}:${streamPort}/v1/infer/stream`
    const body = JSON.stringify({ cli: 'claude', prompt: 'hi' })

    const noToken = await fetch(base, { method: 'POST', body })
    expect(noToken.status).toBe(401)

    const badOrigin = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example.com' },
      body,
    })
    expect(badOrigin.status).toBe(403)
    expect((await badOrigin.json() as Record<string, unknown>)['error']).toBe('forbidden-origin')

    const goodOrigin = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: REVIEW123_ORIGIN, 'Content-Type': 'application/json' },
      body,
    })
    expect(goodOrigin.status).toBe(200)
    expect(goodOrigin.headers.get('access-control-allow-origin')).toBe(REVIEW123_ORIGIN)
    await goodOrigin.body!.cancel()
  }, 20_000)

  it('405s a GET on the streaming route rather than 404ing it', async () => {
    const res = await fetch(`http://${LOOPBACK_HOST}:${streamPort}/v1/infer/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST, OPTIONS')
  })
})

// ===========================================================================
// THE SAME DISCONNECT MECHANISM, on the NON-streaming route.
//
// Before this, cancelling a bridge inference only closed the socket: `claude
// -p` kept running on the user's machine, on their subscription, producing an
// answer nobody would ever read, until it finished or burned the whole
// per-call budget. One AbortSignal now serves both routes, and this is the
// half that proves the OLD route got it too.
// ===========================================================================

describe('POST /v1/infer over HTTP — a client that hangs up', () => {
  let abortBridge: BridgeServer
  let abortPort: number
  let lastPid: number | undefined
  let finished: Promise<void>
  let markFinished: () => void

  beforeAll(async () => {
    abortBridge = createBridgeServer({
      token: TOKEN,
      port: 0,
      realRoot: root,
      version: '0.1.0',
      capabilityDeps: { env: { PATH: '/bin' }, isExecutable: async () => true },
      // The REAL one-shot runner against a real child, so the signal is
      // exercised end to end: socket → BridgeRequest.signal → runInference →
      // runProcess → SIGTERM.
      infer: async (_req, _clis, signal) => {
        const result = await runProcess({
          bin: process.execPath,
          // Would run forever. Only a kill ends it.
          args: ['-e', `process.stdout.write('x');setInterval(()=>{},1000)`],
          stdin: '',
          cwd: root,
          timeoutMs: 20_000,
          ...(signal ? { signal } : {}),
        })
        lastPid = result.pid
        markFinished()
        return { ok: true as const, text: 'ignored', truncated: false, durationMs: 1 }
      },
    })
    abortPort = await listenLoopback(abortBridge, 0)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => abortBridge.server.close(() => resolve()))
  })

  beforeEach(() => {
    lastPid = undefined
    finished = new Promise<void>((resolve) => {
      markFinished = resolve
    })
  })

  it('KILLS THE CLI when the browser aborts — not just closes the socket', async () => {
    const controller = new AbortController()
    const inFlight = fetch(`http://${LOOPBACK_HOST}:${abortPort}/v1/infer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cli: 'claude', prompt: 'hello' }),
      signal: controller.signal,
    })
    // Let the child actually start before pulling the rug.
    await new Promise((r) => setTimeout(r, 150))
    controller.abort()
    await expect(inFlight).rejects.toThrow()

    // runProcess resolves on 'close', i.e. after the child was reaped.
    await finished
    expect(typeof lastPid).toBe('number')
    let alive = true
    try {
      process.kill(lastPid!, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }, 20_000)
})
