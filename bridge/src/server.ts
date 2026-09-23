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
import { PRIVATE_NETWORK_REQUEST_HEADER } from './cors.js'
import {
  defaultAppState,
  defaultCheckout,
  defaultFiles,
  defaultFix,
  defaultInfer,
  defaultInferStream,
  defaultRepoState,
  defaultRestore,
  defaultSearch,
  defaultStack,
  handleRequest,
  handleStreamRequest,
  type BridgeRequest,
  type HandlerContext,
  type StreamSink,
} from './handler.js'
import { INFER_STREAM_PATH, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS } from './protocol.js'
import { ripgrepProbe } from './search.js'

/** The address the bridge binds. Not configurable — see the header comment. */
export const LOOPBACK_HOST = '127.0.0.1'

export interface BridgeServerOptions {
  token: string
  port: number
  realRoot: string
  extraOrigins?: string[]
  version: string
  capabilityDeps?: CapabilityDeps
  /**
   * `--allow-write`. Defaults to FALSE: a server constructed without saying
   * otherwise is read-only, which is the behaviour every existing caller and
   * every existing test already expects.
   */
  allowWrite?: boolean
  /** `--test-command`, already argv. Empty → the fix loop detects one. */
  testCommand?: string[]
  /** `--no-tests`. */
  noTests?: boolean
  /**
   * `--allow-checkout`. Defaults to FALSE, and is read SEPARATELY from
   * `allowWrite`: a server constructed with write access alone may not move
   * the user's working tree, which is the whole reason the flag exists.
   */
  allowCheckout?: boolean
  /** `--app-url`, already validated to a loopback origin. Null → detect. */
  appUrl?: string | null
  /** Overrides the real `/v1/infer` worker. Tests only — see handler.ts. */
  infer?: HandlerContext['infer']
  /** Overrides the real `/v1/infer/stream` worker. Tests only. */
  inferStream?: HandlerContext['inferStream']
  /** Overrides the real `/v1/files` worker. Tests only. */
  files?: HandlerContext['files']
  /** Overrides the real `/v1/search` worker. Tests only. */
  search?: HandlerContext['search']
  /** Overrides the real `/v1/fix` worker. Tests only. */
  fix?: HandlerContext['fix']
  /** Overrides the real repo-state probe. Tests only. */
  repoState?: HandlerContext['repoState']
  /** Overrides the real `/v1/stack` probe. Tests only. */
  stack?: HandlerContext['stack']
  /** Overrides the real `/v1/checkout` worker. Tests only. */
  checkout?: HandlerContext['checkout']
  /** Overrides the real `/v1/restore` worker. Tests only. */
  restore?: HandlerContext['restore']
  /** Overrides the real dev-server probe. Tests only. */
  appState?: HandlerContext['appState']
}

/** Build the handler context (also used directly by tests). */
export function createContext(opts: BridgeServerOptions): HandlerContext {
  const deps = opts.capabilityDeps ?? defaultCapabilityDeps()
  const allowWrite = opts.allowWrite === true
  const testCommand = opts.testCommand ?? []
  const noTests = opts.noTests === true
  const allowCheckout = opts.allowCheckout === true
  const appUrl = opts.appUrl ?? null
  return {
    token: opts.token,
    port: opts.port,
    realRoot: opts.realRoot,
    rootName: basename(opts.realRoot),
    extraOrigins: opts.extraOrigins ?? [],
    allowWrite,
    allowCheckout,
    // `capabilities.fix` is the --allow-write flag itself and
    // `capabilities.checkout` is --allow-checkout, re-read per health request
    // like the CLI detection beside them. Each can only be true for a process
    // the user started with THAT flag — they are passed separately here so one
    // can never stand in for the other.
    capabilities: () => detectCapabilities(deps, allowWrite, allowCheckout),
    version: opts.version,
    infer: opts.infer ?? defaultInfer(opts.realRoot),
    inferStream: opts.inferStream ?? defaultInferStream(opts.realRoot),
    fix: opts.fix ?? defaultFix(opts.realRoot, testCommand, noTests),
    files: opts.files ?? defaultFiles(opts.realRoot),
    // The ripgrep probe is re-run per search, exactly as capability detection
    // is re-run per health request, so installing `rg` does not need a bridge
    // restart to take effect.
    search: opts.search ?? defaultSearch(opts.realRoot, ripgrepProbe(deps)),
    repoState: opts.repoState ?? defaultRepoState(opts.realRoot),
    stack: opts.stack ?? defaultStack(opts.realRoot, appUrl),
    checkout: opts.checkout ?? defaultCheckout(opts.realRoot),
    restore: opts.restore ?? defaultRestore(opts.realRoot),
    appState: opts.appState ?? defaultAppState(opts.realRoot, appUrl),
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

/**
 * An AbortSignal that fires when the CLIENT went away.
 *
 * THE ONE MECHANISM BOTH ROUTES USE. Without it, a browser cancelling an
 * inference only closed the socket: `claude -p` kept running on the user's
 * machine, on their subscription, producing an answer nobody would ever read,
 * until it finished or burned the whole per-call budget (which the standing
 * rules caller sets to 300 s). Closing a connection has to mean stopping the
 * work, and this is the wire that makes it mean that.
 *
 * TWO listeners, and deliberately NOT a third:
 *   - `req` 'aborted' — the prompt, explicit signal for a cancelled fetch.
 *   - `res` 'close' with `!res.writableEnded` — the connection died before we
 *     finished answering. The guard is what distinguishes it from the ordinary
 *     close that follows every completed response.
 *   - `req` 'close' is NOT used: on a fully-received request it fires as part
 *     of normal completion, and a spurious abort would kill a live CLI — a
 *     strictly worse failure than missing one cancellation.
 */
function clientDisconnectSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  const gone = (): void => controller.abort()
  req.on('aborted', gone)
  res.on('close', () => {
    if (!res.writableEnded) gone()
  })
  return controller.signal
}

/**
 * One header as a plain string. Node types every header as
 * `string | string[] | undefined`; a repeated header is not something any
 * browser sends on a preflight, and the handler only ever compares the value
 * to an exact string, so an array is simply not a value it recognises.
 */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  return typeof raw === 'string' ? raw : undefined
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const signal = clientDisconnectSignal(req, res)
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req)
  const bridgeReq: BridgeRequest = {
    method: req.method ?? 'GET',
    // `req.url` is origin-form ("/v1/health?x=1"); only the pathname routes.
    path: new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`).pathname,
    headers: {
      host: req.headers.host,
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      authorization: req.headers.authorization,
      requestPrivateNetwork: headerValue(req, PRIVATE_NETWORK_REQUEST_HEADER),
    },
    // 'too-large' is handed to the handler as an over-cap buffer stand-in so
    // the 413 answer stays in the one place that formats responses.
    body: body === 'too-large' ? Buffer.alloc(MAX_BODY_BYTES + 1) : body,
    signal,
  }

  // The ONE route that cannot be a single BridgeResponse: it writes its body
  // as the CLI produces it. Everything else — including an OPTIONS preflight
  // or a GET to this path — goes through the ordinary handler.
  if (bridgeReq.method === 'POST' && bridgeReq.path === INFER_STREAM_PATH) {
    await respondStreaming(res, ctx, bridgeReq)
    return
  }

  const result = await handleRequest(bridgeReq, ctx)
  // The client may have hung up while the CLI was running. Writing into a dead
  // socket is not an error worth reporting — it is the normal end of a
  // cancelled request, and the child has already been killed.
  if (res.writableEnded || res.destroyed) return
  res.writeHead(result.status, result.headers)
  res.end(result.body)
}

/**
 * The socket half of `/v1/infer/stream`.
 *
 * It adds one thing to what `respond` already does: writing the body in
 * pieces, unbuffered. `flushHeaders()` and Node's per-write flush matter here
 * — a response that arrives in one lump at the end is exactly the behaviour
 * this route exists to remove.
 *
 * The disconnect signal is the SAME one every route gets, built once in
 * `respond` by `clientDisconnectSignal`, so the chain from "the user
 * cancelled" to "the CLI stopped spending their subscription" is one chain,
 * not two.
 */
async function respondStreaming(
  res: ServerResponse,
  ctx: HandlerContext,
  bridgeReq: BridgeRequest,
): Promise<void> {
  const sink: StreamSink = {
    head: (status, headers) => {
      res.writeHead(status, headers)
      res.flushHeaders()
    },
    write: (chunk) => {
      if (res.writableEnded || res.destroyed) return
      res.write(chunk)
    },
    end: () => {
      if (!res.writableEnded) res.end()
    },
    signal: bridgeReq.signal ?? new AbortController().signal,
  }

  try {
    await handleStreamRequest(bridgeReq, ctx, sink)
  } finally {
    sink.end()
  }
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
