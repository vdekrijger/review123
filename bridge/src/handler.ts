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
 *   6. Route.                                    200 / 4xx / 404.
 *
 * Every gate above still applies to `/v1/infer`, `/v1/files`, `/v1/search` and
 * `/v1/fix`: no origin outside the allowlist, no request without the pairing
 * token, and no rebound hostname ever reaches the code that spawns a process,
 * opens a file, or creates a worktree.
 *
 * `/v1/fix` adds a SEVENTH gate of its own, inside the route: `--allow-write`.
 * It is checked before the body is even parsed, so a read-only bridge refuses
 * without touching a line of the fix machinery.
 *
 * `/v1/checkout` and `/v1/restore` add their OWN seventh gate, a DIFFERENT
 * one: `--allow-checkout`. The two are never read for each other. A bridge
 * started with `--allow-write` alone refuses a checkout, and a bridge started
 * with `--allow-checkout` alone refuses a fix — because writing in an isolated
 * scratch worktree and moving the user's own branch are different risks, and
 * consenting to one is not consenting to the other.
 *
 * `/v1/stack` is gated by 1-5 like everything else but has NO seventh gate: it
 * only reads, and the client needs its answer (including the flag's value) to
 * explain why an action is unavailable.
 */

import { readAppState } from './appUrl.js'
import { extractBearer, tokenMatches } from './auth.js'
import {
  CheckoutError,
  parseCheckoutRequest,
  parseRestoreRequest,
  readDirtyState,
  readPriorState,
  readTreeState,
  runCheckout,
  runRestore,
  statusForCheckoutError,
  type CheckoutResult,
  type RestoreResult,
} from './checkout.js'
import { corsHeaders, isAllowedHost, isAllowedOrigin } from './cors.js'
import {
  parseFilesRequest,
  readFiles,
  statusForFilesError,
  type FilesOutcome,
} from './files.js'
import { parseFixRequest, runFixLoop, statusForFixError, type FixOutcome } from './fix.js'
import { readGitState } from './gitState.js'
import {
  parseInferRequest,
  runInference,
  statusForInferError,
  type InferOutcome,
} from './infer.js'
import { parseSearchRequest, runSearch } from './search.js'
import { runStreamInference, type StreamEmit } from './inferStream.js'
import {
  encodeStreamEvent,
  INFER_STREAM_CONTENT_TYPE,
  INFER_STREAM_PATH,
  MAX_BODY_BYTES,
  PROTOCOL_VERSION,
  type BridgeCapabilities,
  type BridgeErrorCode,
  type CheckoutRequest,
  type ErrorResponse,
  type FilesRequest,
  type FixRequest,
  type FixResponse,
  type GitState,
  type HealthResponse,
  type InferRequest,
  type InferResponse,
  type RestoreRequest,
  type SearchRequest,
  type SearchResponse,
  type StackApp,
  type StackActionResponse,
  type StackResponse,
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
  /**
   * `--allow-write`. THE authorisation for `/v1/fix`, and the only one.
   *
   * It is a property of the PROCESS, set from argv at startup. Nothing a
   * request carries can change it, so a web origin can neither turn writing on
   * nor discover a way to ask for it — the only way is for the person at the
   * terminal to restart the bridge with the flag.
   */
  allowWrite: boolean
  /**
   * `--allow-checkout`. THE authorisation for `/v1/checkout` and `/v1/restore`,
   * and the only one.
   *
   * A SEPARATE PROPERTY FROM `allowWrite`, which is the entire point. The fix
   * loop's grant lets an agent write inside an isolated scratch worktree and
   * promises the user's checkout is never touched. This grant moves the user's
   * checkout. Reading one from the other would hand every person who wanted
   * agent fixes a branch-switching capability they never asked for, so the
   * handler never falls back from one to the other.
   */
  allowCheckout: boolean
  /** Re-probed per health request so plugging in a CLI does not need a restart. */
  capabilities: () => Promise<BridgeCapabilities>
  version: string
  /**
   * Runs `/v1/infer`. Injected so the handler's tests can exercise every
   * protocol rule without spawning a real CLI (and without a machine needing
   * one installed to run the suite).
   */
  infer: (req: InferRequest, availableClis: readonly string[]) => Promise<InferOutcome>
  /**
   * Runs `/v1/infer/stream`. Injected for the same reason `infer` is, with one
   * addition that only streaming has: `signal`, which fires when the BROWSER
   * disconnected and must reach the child process.
   *
   * It resolves when the run is over — after the child has been reaped, never
   * before — so the HTTP layer can end the response knowing nothing is still
   * spending the user's subscription.
   */
  inferStream: (
    req: InferRequest,
    availableClis: readonly string[],
    emit: StreamEmit,
    signal: AbortSignal,
  ) => Promise<void>
  /** Runs `/v1/files`. Injected for the same reason `infer` is. */
  files: (req: FilesRequest) => Promise<FilesOutcome>
  /** Runs `/v1/search`. Injected for the same reason `infer` is. */
  search: (req: SearchRequest) => Promise<SearchResponse>
  /**
   * Runs `/v1/fix`. Injected so the handler's tests can exercise every
   * protocol rule — above all the `--allow-write` gate — without a real
   * worktree, a real agent, or a real commit.
   */
  fix: (req: FixRequest, availableClis: readonly string[]) => Promise<FixOutcome>
  /**
   * The working tree's repo state for `/v1/health`, or null when it cannot be
   * established. Injected so the handler's tests can exercise every state
   * (clean, dirty, detached, no repo) as data, with no real checkout.
   */
  repoState: () => Promise<GitState | null>
  /**
   * The `/v1/stack` probe: tree state, dirty paths, the recorded prior state,
   * and whether the dev server answers. Injected so the handler's tests can
   * exercise every combination as data, with no real checkout and no socket.
   */
  stack: () => Promise<Omit<StackResponse, 'ok' | 'checkoutEnabled'>>
  /** Runs `/v1/checkout`. Injected for the same reason `fix` is. */
  checkout: (req: CheckoutRequest & {
    remote: string
    stashDirty: boolean
    acknowledgeUntrusted: boolean
  }) => Promise<CheckoutResult>
  /** Runs `/v1/restore`. Injected for the same reason `fix` is. */
  restore: (req: Required<RestoreRequest>) => Promise<RestoreResult>
  /** The dev-server probe, re-run after a checkout so the answer is current. */
  appState: () => Promise<StackApp>
}

/** The real worker, used unless a test injects its own. */
export function defaultInfer(realRoot: string) {
  return (req: InferRequest, availableClis: readonly string[]): Promise<InferOutcome> =>
    runInference(req, { realRoot, availableClis })
}

/** The real `/v1/infer/stream` worker, used unless a test injects its own. */
export function defaultInferStream(realRoot: string) {
  return (
    req: InferRequest,
    availableClis: readonly string[],
    emit: StreamEmit,
    signal: AbortSignal,
  ): Promise<void> => runStreamInference(req, { realRoot, availableClis, emit, signal })
}

/** The real `/v1/files` worker, used unless a test injects its own. */
export function defaultFiles(realRoot: string) {
  return (req: FilesRequest): Promise<FilesOutcome> => readFiles(realRoot, req)
}

/** The real `/v1/search` worker, used unless a test injects its own. */
export function defaultSearch(realRoot: string, hasRipgrep: () => Promise<boolean>) {
  return (req: SearchRequest): Promise<SearchResponse> => runSearch(realRoot, req, { hasRipgrep })
}

/** The real repo-state probe, used unless a test injects its own. */
export function defaultRepoState(realRoot: string) {
  return (): Promise<GitState | null> => readGitState(realRoot)
}

/** The real dev-server probe. `appUrl` is the `--app-url` flag, or null. */
export function defaultAppState(realRoot: string, appUrl: string | null) {
  return (): Promise<StackApp> => readAppState(realRoot, appUrl)
}

/**
 * The real `/v1/stack` probe.
 *
 * Note what it is NOT gated on: `/v1/stack` answers whether or not
 * `--allow-checkout` was given, and reports the flag in `checkoutEnabled`. A
 * read-only bridge that 403'd here would leave the UI unable to explain WHY
 * the button is unavailable — the named-reason discipline this repo follows
 * requires the client to be able to tell "no flag" from "no bridge".
 */
export function defaultStack(realRoot: string, appUrl: string | null) {
  return async (): Promise<Omit<StackResponse, 'ok' | 'checkoutEnabled'>> => {
    const git = await readTreeState(realRoot)
    const dirty = await readDirtyState(realRoot)
    return {
      git,
      dirtyPaths: dirty.paths,
      dirtyCount: dirty.count,
      prior: await readPriorState(realRoot),
      app: await readAppState(realRoot, appUrl),
    }
  }
}

/** The real `/v1/checkout` worker, used unless a test injects its own. */
export function defaultCheckout(realRoot: string) {
  return (
    req: CheckoutRequest & { remote: string; stashDirty: boolean; acknowledgeUntrusted: boolean },
  ): Promise<CheckoutResult> => runCheckout(realRoot, req)
}

/** The real `/v1/restore` worker, used unless a test injects its own. */
export function defaultRestore(realRoot: string) {
  return (req: Required<RestoreRequest>): Promise<RestoreResult> => runRestore(realRoot, req)
}

/**
 * The real `/v1/fix` worker. Note what it closes over: the repo root and the
 * TERMINAL's test-command settings. Nothing from a request reaches the
 * subprocess layer except a validated sha and the findings' text.
 */
export function defaultFix(realRoot: string, testCommand: readonly string[], noTests: boolean) {
  return (req: FixRequest, availableClis: readonly string[]): Promise<FixOutcome> =>
    runFixLoop(req, { realRoot, availableClis, testCommand, noTests })
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

/**
 * A checkout/restore refusal, rendered with its evidence.
 *
 * `tree-dirty` carries the paths a stash would take, because a refusal that
 * says only "your tree is dirty" makes the user take the bridge's word for
 * what is about to move. Every other kind carries the message alone.
 */
function failCheckout(err: CheckoutError, cors: Record<string, string>): BridgeResponse {
  const payload: ErrorResponse = {
    ok: false,
    error: err.kind === 'no-repo-state' ? 'checkout-failed' : err.kind,
    message: err.message,
    ...(err.kind === 'tree-dirty'
      ? { dirtyPaths: err.dirtyPaths, dirtyCount: err.dirtyCount }
      : {}),
  }
  return json(statusForCheckoutError(err.kind), payload, cors)
}

/**
 * Every POST route in protocol v1. Used for the 405 check, so a GET to a real
 * route is told the METHOD is wrong rather than that the route is missing.
 *
 * There is no longer a RESERVED set: every v1 route is implemented below. The
 * `not-implemented` error CODE stays in the contract (codes are additive within
 * v1, and clients still recognise it) — it is simply no longer produced by any
 * route.
 *
 * `/v1/fix` is listed here even on a bridge started WITHOUT `--allow-write`.
 * That is deliberate: it exists and is understood, it is simply not authorised,
 * so it answers `403 write-disabled` — a fact the user can act on — rather than
 * a 404 that would read as "update your bridge".
 */
const POST_ROUTES = new Set([
  '/v1/infer',
  // Listed so a GET is told the METHOD is wrong rather than that the route is
  // missing. The POST itself never reaches handleRequest: server.ts hands it
  // to handleStreamRequest, which cannot return a single BridgeResponse.
  INFER_STREAM_PATH,
  '/v1/files',
  '/v1/search',
  '/v1/fix',
  // Listed even without `--allow-checkout`, for the same reason `/v1/fix` is
  // listed without `--allow-write`: the route exists and is understood, it is
  // simply not authorised. `403 checkout-disabled` is a fact the user can act
  // on; a 404 would read as "update your bridge".
  '/v1/checkout',
  '/v1/restore',
])

/** Parse a request body as JSON, or null. Never throws. */
function parseJsonBody(body: Buffer | null): unknown {
  if (body === null || body.byteLength === 0) return null
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * The outcome of gates 1-5: either a response that ENDS the request, or the
 * CORS headers every later answer has to carry.
 */
export type GateOutcome =
  | { kind: 'halt'; response: BridgeResponse }
  | { kind: 'pass'; cors: Record<string, string> }

/**
 * GATES 1-5, as ONE function, so every route surface runs the SAME ladder.
 *
 * It exists because `/v1/infer/stream` cannot be a `BridgeResponse`-returning
 * route — it writes its body incrementally — and a streaming route that
 * re-implemented "is this host allowed, is this origin allowed, is the token
 * right" would be a second copy of the security model, drifting from this one
 * the first time either changed. There is one copy, and it is here.
 *
 * See the file header for what each gate is for and why the order is what it
 * is. Route-SPECIFIC gates (`--allow-write`, `--allow-checkout`) are NOT here:
 * they belong to their routes.
 */
export function checkGates(req: BridgeRequest, ctx: HandlerContext): GateOutcome {
  // ---- 1. Host: refuse a rebound hostname pointed at our loopback socket ----
  if (!isAllowedHost(req.headers.host, ctx.port)) {
    return { kind: 'halt', response: fail(403, 'forbidden-host', 'The bridge only answers on 127.0.0.1.') }
  }

  // ---- 2. Origin: exact allowlist, no headers leak to a stranger ----
  const origin = req.headers.origin
  const originAllowed = isAllowedOrigin(origin, ctx.extraOrigins)
  if (origin !== undefined && !originAllowed) {
    // No Access-Control-Allow-* headers: the browser will block the read even
    // if this body somehow became interesting.
    return {
      kind: 'halt',
      response: fail(403, 'forbidden-origin', 'This origin is not allowed to use the bridge.'),
    }
  }
  // A request with NO Origin is not browser-borne (curl, a health check). The
  // bearer token still gates it, and it gets no CORS headers because it needs
  // none.
  const cors = origin !== undefined && originAllowed ? corsHeaders(origin) : {}

  // ---- 3. Preflight: answer before auth (no Authorization is sent on one) ----
  if (req.method === 'OPTIONS') {
    return {
      kind: 'halt',
      response: { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' }, body: '' },
    }
  }

  // ---- 4. Auth ----
  if (!tokenMatches(extractBearer(req.headers.authorization), ctx.token)) {
    return {
      kind: 'halt',
      response: fail(401, 'unauthorized', 'A valid pairing token is required.', {
        ...cors,
        'WWW-Authenticate': 'Bearer realm="review123-bridge"',
      }),
    }
  }

  // ---- 5. Body cap ----
  if (req.body !== null && req.body.byteLength > MAX_BODY_BYTES) {
    return {
      kind: 'halt',
      response: fail(413, 'payload-too-large', `Request bodies are capped at ${MAX_BODY_BYTES} bytes.`, cors),
    }
  }

  return { kind: 'pass', cors }
}

export async function handleRequest(
  req: BridgeRequest,
  ctx: HandlerContext,
): Promise<BridgeResponse> {
  const gate = checkGates(req, ctx)
  if (gate.kind === 'halt') return gate.response
  const { cors } = gate

  // ---- 6. Routes ----
  if (req.method === 'GET' && req.path === '/v1/health') {
    const payload: HealthResponse = {
      ok: true,
      protocol: PROTOCOL_VERSION,
      // Basename only — never the absolute path (see protocol.ts).
      root: ctx.rootName,
      capabilities: await ctx.capabilities(),
      // The field local grounding turns on. Null is a normal answer (not a
      // repo, no commits, no git) and the client must read it as "no match
      // provable" — never as an error, and never as permission to guess.
      git: await ctx.repoState(),
      version: ctx.version,
    }
    return json(200, payload, cors)
  }

  if (req.method === 'GET' && req.path === '/v1/stack') {
    // NOT gated on --allow-checkout. The client needs to know the state of the
    // tree and the flag in order to EXPLAIN why an action is unavailable; a
    // 403 here would leave it with a bare disabled button and no reason.
    const state = await ctx.stack()
    const payload: StackResponse = { ok: true, ...state, checkoutEnabled: ctx.allowCheckout }
    return json(200, payload, cors)
  }

  if (POST_ROUTES.has(req.path)) {
    if (req.method !== 'POST') {
      return fail(405, 'method-not-allowed', `${req.path} accepts POST.`, { ...cors, Allow: 'POST, OPTIONS' })
    }
  }

  if (req.method === 'POST' && (req.path === '/v1/checkout' || req.path === '/v1/restore')) {
    // ---- THE CHECKOUT GATE ----
    // First, before parsing and long before any git command can run. It reads
    // `allowCheckout` and NOTHING ELSE: a bridge started with --allow-write but
    // not --allow-checkout refuses here, because the two grants authorise
    // different things and one must never stand in for the other.
    if (!ctx.allowCheckout) {
      return fail(
        403,
        'checkout-disabled',
        'This bridge may not change your working tree. Restart it with --allow-checkout to let review123 check a pull request out here. (--allow-write does not enable this: it grants the fix loop, which only ever writes in an isolated worktree.)',
        cors,
      )
    }

    if (req.path === '/v1/restore') {
      const parsed = parseRestoreRequest(parseJsonBody(req.body))
      if ('error' in parsed) return fail(400, 'bad-request', parsed.error, cors)
      let outcome: RestoreResult
      try {
        outcome = await ctx.restore(parsed)
      } catch (err) {
        if (err instanceof CheckoutError) return failCheckout(err, cors)
        throw err
      }
      const payload: StackActionResponse = {
        ok: true,
        git: outcome.git,
        // A completed restore consumes the record: there is no longer a prior
        // state, and reporting a stale one would offer a second "Restore".
        prior: null,
        stash: outcome.stash,
        app: await ctx.appState(),
      }
      return json(200, payload, cors)
    }

    const parsed = parseCheckoutRequest(parseJsonBody(req.body))
    if ('error' in parsed) return fail(400, 'bad-request', parsed.error, cors)
    let outcome: CheckoutResult
    try {
      outcome = await ctx.checkout(parsed)
    } catch (err) {
      if (err instanceof CheckoutError) return failCheckout(err, cors)
      throw err
    }
    const payload: StackActionResponse = {
      ok: true,
      git: outcome.git,
      prior: outcome.prior,
      stash: outcome.stash,
      // Re-probed AFTER the checkout: a dev server that was up a moment ago may
      // be mid-reload, and the honest answer is the one measured now.
      app: await ctx.appState(),
    }
    return json(200, payload, cors)
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

  if (req.method === 'POST' && req.path === '/v1/files') {
    const parsed = parseFilesRequest(parseJsonBody(req.body))
    if ('error' in parsed) return fail(400, 'bad-request', parsed.error, cors)

    // Confinement lives in the worker (it needs the filesystem), so this is
    // where a path escape becomes a 403. One bad path fails the WHOLE request:
    // a caller must never be able to mistake "refused" for "missing".
    const outcome = await ctx.files(parsed)
    if (outcome.ok !== true) {
      return fail(statusForFilesError(outcome.code), outcome.code, outcome.message, cors)
    }
    return json(200, outcome, cors)
  }

  if (req.method === 'POST' && req.path === '/v1/fix') {
    // ---- THE WRITE GATE ----
    // First, before parsing and long before anything can create a directory or
    // spawn an agent. A bridge without --allow-write never reaches a single
    // line of fix.ts, whatever the body says.
    if (!ctx.allowWrite) {
      return fail(
        403,
        'write-disabled',
        'This bridge is read-only. Restart it with --allow-write to let review123 hand findings to your local coding agent.',
        cors,
      )
    }

    const parsed = parseFixRequest(parseJsonBody(req.body))
    if ('error' in parsed) return fail(400, 'bad-request', parsed.error, cors)

    // Same re-probe as /v1/infer: installing a CLI must not need a restart, and
    // "you do not have that CLI" is answered before any worktree is created.
    const { inference } = await ctx.capabilities()
    if (!inference.includes(parsed.cli)) {
      return fail(
        503,
        'cli-unavailable',
        `The ${parsed.cli} CLI is not on this machine's PATH. Install it, then restart the bridge.`,
        cors,
      )
    }

    const outcome = await ctx.fix(parsed, inference)
    if (!outcome.ok) {
      return fail(statusForFixError(outcome.code), outcome.code, outcome.message, cors)
    }

    const payload: FixResponse = {
      ok: true,
      cli: parsed.cli,
      baseSha: outcome.baseSha,
      branch: outcome.branch,
      changes: outcome.changes,
      skipped: outcome.skipped,
      rounds: outcome.rounds,
      stopReason: outcome.stopReason,
      tests: outcome.tests,
      durationMs: outcome.durationMs,
    }
    return json(200, payload, cors)
  }

  if (req.method === 'POST' && req.path === '/v1/search') {
    const parsed = parseSearchRequest(parseJsonBody(req.body))
    if ('error' in parsed) return fail(400, 'bad-request', parsed.error, cors)

    // Search names no paths, so there is no confinement step: both backends are
    // rooted at the repo and neither follows a symlink out of it.
    return json(200, await ctx.search(parsed), cors)
  }

  return fail(404, 'not-found', `No route ${req.method} ${req.path} in protocol v${PROTOCOL_VERSION}.`, cors)
}

// ===========================================================================
// `POST /v1/infer/stream` — the ONE route that answers incrementally.
// ===========================================================================

/**
 * Where a streamed response goes.
 *
 * Deliberately NOT a `ServerResponse`: the whole protocol stays testable over
 * plain data, exactly as `handleRequest` is. `server.ts` supplies the socket
 * version; the tests supply an array.
 */
export interface StreamSink {
  /** Called exactly once, before any body byte. */
  head: (status: number, headers: Record<string, string>) => void
  write: (chunk: string) => void
  end: () => void
  /**
   * Fires when the CLIENT went away — the fetch was aborted, the tab closed,
   * the socket died. It is the whole reason this route exists in this shape:
   * it is forwarded to the worker, which forwards it to the child process.
   */
  signal: AbortSignal
}

/**
 * `POST /v1/infer/stream`.
 *
 * SAME GATES, ONE COPY. Host, Origin, preflight, auth and the body cap all run
 * through `checkGates` — the identical ladder `/v1/infer` runs. A rebound
 * hostname, a foreign origin and a missing token are refused here exactly as
 * they are there, and they are refused with an ordinary JSON body, because
 * nothing has been committed to the wire yet.
 *
 * THE STATUS LINE IS THE PIVOT. Everything decidable BEFORE the CLI starts — a
 * malformed body, an uninstalled CLI — is an HTTP status, so a client sees an
 * ordinary error. Everything after it is an NDJSON `error` event under a 200,
 * because the status line is already spent. That is the one real cost of
 * streaming, and it is why `InferStreamError` carries exactly the same
 * BridgeErrorCode the status would have.
 */
export async function handleStreamRequest(
  req: BridgeRequest,
  ctx: HandlerContext,
  sink: StreamSink,
): Promise<void> {
  const gate = checkGates(req, ctx)
  if (gate.kind === 'halt') {
    sink.head(gate.response.status, gate.response.headers)
    if (gate.response.body !== '') sink.write(gate.response.body)
    sink.end()
    return
  }
  const { cors } = gate

  const sendJson = (response: BridgeResponse): void => {
    sink.head(response.status, response.headers)
    sink.write(response.body)
    sink.end()
  }

  if (req.method !== 'POST') {
    sendJson(
      fail(405, 'method-not-allowed', `${INFER_STREAM_PATH} accepts POST.`, {
        ...cors,
        Allow: 'POST, OPTIONS',
      }),
    )
    return
  }

  const parsed = parseInferRequest(parseJsonBody(req.body))
  if ('error' in parsed) {
    sendJson(fail(400, 'bad-request', parsed.error, cors))
    return
  }

  // Re-probed per call exactly as `/v1/infer` does, so installing a CLI does
  // not need a bridge restart — and so "you do not have that CLI" is still a
  // real 503 rather than a 200 with an error event buried in it.
  const { inference } = await ctx.capabilities()
  if (!inference.includes(parsed.cli)) {
    sendJson(
      fail(
        503,
        'cli-unavailable',
        `The ${parsed.cli} CLI is not on this machine's PATH. Install it, then restart the bridge.`,
        cors,
      ),
    )
    return
  }

  sink.head(200, {
    'Content-Type': INFER_STREAM_CONTENT_TYPE,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Nothing sits in front of a loopback bridge today, but a proxy that
    // buffers the whole body would make this route silently not a stream.
    'X-Accel-Buffering': 'no',
    ...cors,
  })

  // A closed socket must never turn a delta into a crash — and must never stop
  // us awaiting the worker, because that await is what reaps the child.
  let open = true
  const emit: StreamEmit = (event) => {
    if (!open || sink.signal.aborted) return
    try {
      sink.write(encodeStreamEvent(event))
    } catch {
      open = false
    }
  }

  await ctx.inferStream(parsed, inference, emit, sink.signal)
  sink.end()
}
