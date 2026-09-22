/**
 * handler.ts — the whole protocol as ONE pure function.
 *
 * Same shape as the repo's serverless handlers (`api/oauth/exchange.ts`): all
 * the logic lives in a function over plain data, so every security rule can be
 * tested without HTTP plumbing, and `server.ts` stays a thin socket shell.
 *
 * GATE ORDER (each gate runs before any work the next one would do):
 *   1. Host        — DNS-rebinding guard.        403, no CORS headers.
 *   2. Origin      — exact allowlist.            403, no CORS headers.
 *   3. Preflight   — OPTIONS short-circuit.      204, CORS headers, NO auth
 *                    (browsers never send Authorization on a preflight).
 *   4. Auth        — bearer token.               401, CORS headers if the
 *                    origin was allowed, so the browser can READ the 401.
 *   5. Body cap.                                 413.
 *   6. Route.                                    200 / 501 / 404.
 *
 * Every gate above still applies to `/v1/infer`: no origin outside the
 * allowlist, no request without the pairing token, and no rebound hostname ever
 * reaches the code that spawns a process.
 */

import { extractBearer, tokenMatches } from './auth.js'
import { corsHeaders, isAllowedHost, isAllowedOrigin } from './cors.js'
import {
  parseInferRequest,
  runInference,
  statusForInferError,
  type InferOutcome,
} from './infer.js'
import {
  MAX_BODY_BYTES,
  PROTOCOL_VERSION,
  type BridgeCapabilities,
  type BridgeErrorCode,
  type ErrorResponse,
  type HealthResponse,
  type InferRequest,
  type InferResponse,
} from './protocol.js'

/** The subset of an incoming HTTP request the protocol actually looks at. */
export interface BridgeRequest {
  method: string
  /** URL pathname only — query and hash are irrelevant to every v1 route. */
  path: string
  headers: {
    host?: string | undefined
    origin?: string | undefined
    authorization?: string | undefined
  }
  body: Buffer | null
}

export interface BridgeResponse {
  status: number
  headers: Record<string, string>
  /** Always a JSON document, or '' for 204. */
  body: string
}

export interface HandlerContext {
  /** The pairing token this process minted (or read from --token-file). */
  token: string
  /** The port we bound — the Host guard compares against it. */
  port: number
  /** Fully resolved, symlink-free repo root. */
  realRoot: string
  /** Repo directory basename — the ONLY part of the path we ever send. */
  rootName: string
  /** Additive `--allow-origin` values, matched exactly. */
  extraOrigins: string[]
  /** Re-probed per health request so plugging in a CLI does not need a restart. */
  capabilities: () => Promise<BridgeCapabilities>
  version: string
  /**
   * Runs `/v1/infer`. Injected so the handler's tests can exercise every
   * protocol rule without spawning a real CLI (and without a machine needing
   * one installed to run the suite).
   */
  infer: (req: InferRequest, availableClis: readonly string[]) => Promise<InferOutcome>
}

/** The real worker, used unless a test injects its own. */
export function defaultInfer(realRoot: string) {
  return (req: InferRequest, availableClis: readonly string[]): Promise<InferOutcome> =>
    runInference(req, { realRoot, availableClis })
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // A bridge response is never a cacheable document, and the 401/403 bodies
  // must not be replayed from a disk cache after the token rotates.
  'Cache-Control': 'no-store',
  // Defence in depth: nothing here is ever meant to be sniffed or framed.
  'X-Content-Type-Options': 'nosniff',
}

function json(status: number, payload: unknown, extra: Record<string, string> = {}): BridgeResponse {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(payload) }
}

function fail(
  status: number,
  error: BridgeErrorCode,
  message: string,
  extra: Record<string, string> = {},
): BridgeResponse {
  const payload: ErrorResponse = { ok: false, error, message }
  return json(status, payload, extra)
}

/** Routes that exist in the contract but answer 501 until their PR lands. */
const RESERVED_ROUTES = new Set(['/v1/files', '/v1/search'])

/** POST routes that are actually implemented. Used for the 405 check. */
const POST_ROUTES = new Set(['/v1/infer'])

/** Parse a request body as JSON, or null. Never throws. */
function parseJsonBody(body: Buffer | null): unknown {
  if (body === null || body.byteLength === 0) return null
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
}

export async function handleRequest(
  req: BridgeRequest,
  ctx: HandlerContext,
): Promise<BridgeResponse> {
  // ---- 1. Host: refuse a rebound hostname pointed at our loopback socket ----
  if (!isAllowedHost(req.headers.host, ctx.port)) {
    return fail(403, 'forbidden-host', 'The bridge only answers on 127.0.0.1.')
  }

  // ---- 2. Origin: exact allowlist, no headers leak to a stranger ----
  const origin = req.headers.origin
  const originAllowed = isAllowedOrigin(origin, ctx.extraOrigins)
  if (origin !== undefined && !originAllowed) {
    // No Access-Control-Allow-* headers: the browser will block the read even
    // if this body somehow became interesting.
    return fail(403, 'forbidden-origin', 'This origin is not allowed to use the bridge.')
  }
  // A request with NO Origin is not browser-borne (curl, a health check). The
  // bearer token still gates it, and it gets no CORS headers because it needs
  // none.
  const cors = origin !== undefined && originAllowed ? corsHeaders(origin) : {}

  // ---- 3. Preflight: answer before auth (no Authorization is sent on one) ----
  if (req.method === 'OPTIONS') {
    return { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' }, body: '' }
  }

  // ---- 4. Auth ----
  if (!tokenMatches(extractBearer(req.headers.authorization), ctx.token)) {
    return fail(401, 'unauthorized', 'A valid pairing token is required.', {
      ...cors,
      'WWW-Authenticate': 'Bearer realm="review123-bridge"',
    })
  }

  // ---- 5. Body cap ----
  if (req.body !== null && req.body.byteLength > MAX_BODY_BYTES) {
    return fail(413, 'payload-too-large', `Request bodies are capped at ${MAX_BODY_BYTES} bytes.`, cors)
  }

  // ---- 6. Routes ----
  if (req.method === 'GET' && req.path === '/v1/health') {
    const payload: HealthResponse = {
      ok: true,
      protocol: PROTOCOL_VERSION,
      // Basename only — never the absolute path (see protocol.ts).
      root: ctx.rootName,
      capabilities: await ctx.capabilities(),
      version: ctx.version,
    }
    return json(200, payload, cors)
  }

  if (POST_ROUTES.has(req.path) || RESERVED_ROUTES.has(req.path)) {
    if (req.method !== 'POST') {
      return fail(405, 'method-not-allowed', `${req.path} accepts POST.`, { ...cors, Allow: 'POST, OPTIONS' })
    }
  }

  if (req.method === 'POST' && req.path === '/v1/infer') {
    const parsed = parseInferRequest(parseJsonBody(req.body))
    if ('error' in parsed) return fail(400, 'bad-request', parsed.error, cors)

    // The detected-CLI list is re-probed per call, exactly as /v1/health does,
    // so installing a CLI does not require a bridge restart. The gate lives
    // HERE, before the worker, so "you do not have that CLI" is answered
    // without touching any process-spawning code at all. runInference repeats
    // the check as defence in depth for callers that reach it directly.
    const { inference } = await ctx.capabilities()
    if (!inference.includes(parsed.cli)) {
      return fail(
        503,
        'cli-unavailable',
        `The ${parsed.cli} CLI is not on this machine's PATH. Install it, then restart the bridge.`,
        cors,
      )
    }

    const outcome = await ctx.infer(parsed, inference)
    if (!outcome.ok) {
      return fail(statusForInferError(outcome.code), outcome.code, outcome.message, cors)
    }

    const payload: InferResponse = {
      ok: true,
      cli: parsed.cli,
      text: outcome.text,
      truncated: outcome.truncated,
      durationMs: outcome.durationMs,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    }
    return json(200, payload, cors)
  }

  if (RESERVED_ROUTES.has(req.path)) {
    return fail(
      501,
      'not-implemented',
      `${req.path} is reserved by protocol v${PROTOCOL_VERSION} and is not implemented yet.`,
      cors,
    )
  }

  return fail(404, 'not-found', `No route ${req.method} ${req.path} in protocol v${PROTOCOL_VERSION}.`, cors)
}
