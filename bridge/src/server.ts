/**
 * server.ts — the socket shell around handler.ts.
 *
 * Deliberately thin: it binds, reads a capped body, and serialises whatever the
 * pure handler decided. The only policy it owns is the one that cannot live in
 * a pure function — the LISTEN ADDRESS.
 *
 * LOOPBACK ONLY. `listen({ host: '127.0.0.1' })`, never `0.0.0.0` and never the
 * default (which binds every interface). On a laptop on a café network, the
 * difference is whether the room can read the user's repo.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { detectCapabilities, defaultCapabilityDeps, type CapabilityDeps } from './capabilities.js'
import { handleRequest, type BridgeRequest, type HandlerContext } from './handler.js'
import { MAX_BODY_BYTES, REQUEST_TIMEOUT_MS } from './protocol.js'

/** The address the bridge binds. Not configurable — see the header comment. */
export const LOOPBACK_HOST = '127.0.0.1'

export interface BridgeServerOptions {
  token: string
  port: number
  realRoot: string
  extraOrigins?: string[]
  version: string
  capabilityDeps?: CapabilityDeps
}

/** Build the handler context (also used directly by tests). */
export function createContext(opts: BridgeServerOptions): HandlerContext {
  const deps = opts.capabilityDeps ?? defaultCapabilityDeps()
  return {
    token: opts.token,
    port: opts.port,
    realRoot: opts.realRoot,
    rootName: basename(opts.realRoot),
    extraOrigins: opts.extraOrigins ?? [],
    capabilities: () => detectCapabilities(deps),
    version: opts.version,
  }
}

/**
 * Read a request body, refusing anything over the cap.
 *
 * The cap is enforced WHILE streaming, not after: buffering an unbounded body
 * and then measuring it is how a local server gets OOM-killed by a single
 * request.
 */
function readBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        settled = true
        req.pause()
        resolve('too-large')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req)
  const bridgeReq: BridgeRequest = {
    method: req.method ?? 'GET',
    // `req.url` is origin-form ("/v1/health?x=1"); only the pathname routes.
    path: new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`).pathname,
    headers: {
      host: req.headers.host,
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      authorization: req.headers.authorization,
    },
    // 'too-large' is handed to the handler as an over-cap buffer stand-in so
    // the 413 answer stays in the one place that formats responses.
    body: body === 'too-large' ? Buffer.alloc(MAX_BODY_BYTES + 1) : body,
  }
  const result = await handleRequest(bridgeReq, ctx)
  res.writeHead(result.status, result.headers)
  res.end(result.body)
}

/**
 * A bound-together server and its handler context. The context is handed back
 * because `listenLoopback` has to write the ACTUAL port into it: with
 * `--port 0` (tests) the OS picks the port, and the Host guard compares
 * against it.
 */
export interface BridgeServer {
  server: Server
  ctx: HandlerContext
}

export function createBridgeServer(opts: BridgeServerOptions): BridgeServer {
  const ctx = createContext(opts)
  const server = createServer((req, res) => {
    respond(req, res, ctx).catch(() => {
      // Never leak an internal error message (paths, stack frames) to a web
      // origin; the pure handler produces every message a caller should see.
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'bad-request', message: 'The bridge could not handle that request.' }))
    })
  })
  // Slow-loris and hung-request budgets. Node's defaults are generous for a
  // public server and far too generous for one on a laptop.
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = Math.min(REQUEST_TIMEOUT_MS, 10_000)
  server.keepAliveTimeout = 5_000
  return { server, ctx }
}

/**
 * Bind to loopback and resolve with the port actually bound, after recording it
 * on the context so the Host guard compares against the real port.
 */
export function listenLoopback(bridge: BridgeServer, port: number): Promise<number> {
  const { server } = bridge
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: LOOPBACK_HOST, port }, () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('bridge server did not bind a TCP port'))
        return
      }
      bridge.ctx.port = address.port
      resolve(address.port)
    })
  })
}
