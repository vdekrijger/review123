/**
 * bridge/protocol.ts — the browser's view of the local-bridge wire contract.
 *
 * MIRROR of `bridge/src/protocol.ts`. The two are deliberately duplicated: the
 * SPA must not take a build-time dependency on a Node workspace package (it
 * would drag `node:` types and a second tsconfig into the app bundle graph for
 * three interfaces). Change BOTH files together; `bridge/README.md` documents
 * the canonical contract.
 *
 * IMPLEMENTED in v1: GET /v1/health, POST /v1/infer, POST /v1/infer/stream,
 * POST /v1/files, POST /v1/search, POST /v1/fix. Nothing answers 501 any more.
 */

/** Wire protocol revision this build speaks. A bridge on another major is refused. */
export const PROTOCOL_VERSION = 1

/** The port the bridge binds unless started with --port. */
export const DEFAULT_BRIDGE_PORT = 7321

/**
 * Capability flags from `/v1/health`.
 *
 * TWO DIFFERENT KINDS OF ENTRY, on purpose:
 *
 * - `inference` — DETECTION. Which CLIs exist on the user's PATH.
 * - `infer` / `files` / `search` — route-READINESS booleans, one per route and
 *   named after it. Each flips in the same commit that implements its route.
 *   All three are true as of the grounding PR — v1 is complete.
 *
 * Running inference needs BOTH: `infer === true` (the bridge understands the
 * route) AND a CLI listed in `inference` (something to run). `bridgeAvailable`
 * answers the readiness half; `bridgeInferenceClis` answers the detection half.
 * See bridge/README.md.
 */
export interface BridgeCapabilities {
  inference: string[]
  infer: boolean
  /**
   * `POST /v1/infer/stream` — a route-readiness boolean exactly like `infer`,
   * flipped in the same commit that implemented the route.
   *
   * It says the bridge UNDERSTANDS the route, not that every CLI types out:
   * `claude` streams, `codex` cannot, and the route says which per call in its
   * `start` event. The Local bridge settings section reports this so a user
   * who wonders why their panels appear all at once can see the answer.
   *
   * A bridge predating the route omits the flag; an absent flag reads as
   * false, and the transport falls back to `/v1/infer`.
   */
  inferStream: boolean
  /**
   * `InferRequest.agentic` — whether this bridge understands the flag that runs
   * the CLI with its own READ-ONLY tools (file reading and search, never write,
   * never shell, never network). A route-readiness boolean like `infer`.
   *
   * THE BROWSER MUST CHECK IT BEFORE PROMISING DEEP REVIEW. `agentic` is an
   * additive request field, so a bridge predating it does not fail — it ignores
   * the flag, runs the ordinary tool-less completion and answers 200. The text
   * that comes back is a fine single-pass answer, and presenting it as a review
   * grounded in the user's working tree would be a lie the user cannot detect.
   * So this gates the offer, exactly as `files`/`search` gate local grounding.
   *
   * Absent reads as false — an older bridge, not a malformed one.
   */
  inferAgentic: boolean
  files: boolean
  search: boolean
  /**
   * `/v1/fix` — the ONE route that writes. NOT a release-readiness flag like
   * its three siblings: it reports whether the bridge PROCESS was started with
   * `--allow-write`, which is the entire authorisation model for writing.
   *
   * The browser can read it and must never try to change it. There is no
   * request field, header or setting in this app that can turn it on — only
   * the person at the terminal, by restarting the bridge with the flag. A
   * bridge predating the fix release sends no such field, and an absent flag
   * reads as `false`.
   */
  fix: boolean
  /**
   * `/v1/checkout` and `/v1/restore` — the routes that move the USER'S OWN
   * working tree, so their dev server serves the pull request. Reports the
   * bridge's `--allow-checkout` flag.
   *
   * A SEPARATE GRANT FROM `fix`, and the browser must treat it as one. The fix
   * loop writes only inside an isolated scratch worktree; this switches the
   * branch under a running dev stack. Someone who started their bridge with
   * `--allow-write` has NOT consented to this, so no code here may fall back
   * from one flag to the other. Absent or non-boolean reads as `false`.
   */
  checkout: boolean
  /**
   * `/v1/push` — the ONE route that writes to a REMOTE. Reports the bridge's
   * `--allow-push` flag, and nothing else.
   *
   * A THIRD GRANT, and the browser must treat it as one. `fix` authorises
   * writing in a throwaway worktree and `checkout` authorises moving a branch
   * that was recorded first; both are local and both can be undone by the
   * person who granted them. This one cannot be undone by anyone. So no code
   * here may fall back from either of the other two to this, and anything other
   * than a literal `true` reads as false — for a capability that writes where
   * other people can see it, "unknown" must never render as the permissive
   * answer.
   */
  push: boolean
}

/** The CLIs the bridge knows how to drive. Mirrors bridge/src/capabilities.ts. */
export const BRIDGE_CLIS = ['claude', 'codex'] as const

export type BridgeCli = (typeof BRIDGE_CLIS)[number]

/** `POST /v1/infer` request. See bridge/src/protocol.ts for the invariants. */
/**
 * Characters a `InferRequest.model` id may contain — kept byte-identical to
 * bridge/src/protocol.ts (#236: the two copies change in the same commit).
 * The bridge re-validates on arrival; this copy is so the UI can refuse a bad
 * id where the user typed it instead of after a round trip.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/** Length ceiling for a model id. */
export const MODEL_ID_MAX_LEN = 100

/** Whether `value` is a model id the bridge will accept. */
export function isValidModelId(value: string): boolean {
  return value.length > 0 && value.length <= MODEL_ID_MAX_LEN && MODEL_ID_PATTERN.test(value)
}

export interface InferRequest {
  cli: BridgeCli
  prompt: string
  /**
   * Which MODEL the CLI should run (`--model <id>`). Absent → no flag, so the
   * CLI keeps using whatever the user configured. See bridge/src/protocol.ts.
   */
  model?: string
  system?: string
  files?: string[]
  maxOutputTokens?: number
  timeoutMs?: number
  /**
   * Run the CLI WITH its own read-only tools, so it investigates the served
   * working tree instead of answering from the prompt alone. See
   * bridge/src/protocol.ts for the full contract; the short version is that the
   * ordinary call passes `--tools ""` — WE strip the CLI's tools — and this
   * flag stops doing that, granting file reading and search and nothing else.
   *
   * Only send it when `capabilities.inferAgentic` is true: an older bridge
   * ignores it and answers tool-less, which must never be reported as grounded.
   */
  agentic?: boolean
}

/**
 * What an `agentic: true` run actually did. MIRROR of bridge/src/protocol.ts,
 * where the reasoning lives.
 *
 * ABSENT from a response means the run was NOT agentic — the honest signal that
 * a bridge ignored the request field, or that the caller never asked.
 */
export interface InferAgentic {
  /**
   * Tool names granted. Exactly what `claude` was passed; EMPTY for `codex`,
   * whose toolset cannot be enumerated or narrowed (its sandbox restricts what
   * its shell may do, not which tools exist). Empty means "not nameable", never
   * "none".
   */
  tools: string[]
  /**
   * A LOWER BOUND on the CLI's tool calls — under-counted on purpose so it can
   * never overstate grounding. Absent when the CLI reported nothing countable;
   * 0 means it had tools and chose not to use them, which is a different and
   * useful fact.
   */
  toolCallsAtLeast?: number
  /** Tool calls the CLI's own permission layer refused. Absent when unreported. */
  denied?: number
}

/**
 * Token counts, when the CLI reports them. `claude` does; `codex` does not,
 * and then this is ABSENT — never zeroed, never guessed. Absent means UNKNOWN,
 * and the cost UI must render it as unknown rather than as free.
 */
export interface InferUsage {
  inputTokens: number
  outputTokens: number
}

export interface InferResponse {
  ok: true
  cli: string
  text: string
  truncated: boolean
  durationMs: number
  usage?: InferUsage
  /**
   * Present ONLY when the run really was agentic. Its ABSENCE is the signal
   * that the answer came from a tool-less completion — which is what an older
   * bridge returns for an `agentic: true` request — so a caller that means to
   * claim local grounding must look for this, not assume it.
   */
  agentic?: InferAgentic
}

/**
 * Machine-readable failure codes. ADDITIVE within protocol v1 — an unknown
 * code must fall back on `message`, never crash. `parseBridgeError` does.
 */
export type BridgeErrorCode =
  | 'bad-request'
  | 'unauthorized'
  | 'forbidden-origin'
  | 'forbidden-host'
  | 'forbidden-path'
  | 'not-found'
  | 'method-not-allowed'
  | 'not-implemented'
  | 'payload-too-large'
  | 'timeout'
  | 'cli-unavailable'
  | 'cli-failed'
  /** `/v1/fix` on a bridge started without `--allow-write`. */
  | 'write-disabled'
  /** The bridge could not create its scratch worktree. Nothing ran. */
  | 'worktree-failed'
  /** The PR's head commit is not in the local object store. */
  | 'head-unknown'
  /** `/v1/checkout` or `/v1/restore` without `--allow-checkout`. */
  | 'checkout-disabled'
  /** The working tree has uncommitted changes; the body carries `dirtyPaths`. */
  | 'tree-dirty'
  /** The remote does not have that ref. */
  | 'ref-unknown'
  /** git itself refused the checkout. Nothing was forced or discarded. */
  | 'checkout-failed'
  /** `/v1/restore` with nothing recorded for this repo. */
  | 'no-prior-state'
  /** The recorded branch was deleted; restoring detached needs `detachToSha`. */
  | 'prior-gone'
  /** HEAD moved since the checkout; restoring needs `acknowledgeMoved`. */
  | 'moved-since'
  /** A checkout was sent without `acknowledgeUntrusted`. */
  | 'untrusted-unacknowledged'
  /** `/v1/push` on a bridge started without `--allow-push`. */
  | 'push-disabled'
  /** The branch is the remote's default, or a name the bridge never pushes to. */
  | 'protected-branch'
  /** The remote's default branch could not be established. Fail closed. */
  | 'default-branch-unknown'
  /** No remote by that name is configured in the user's checkout. */
  | 'remote-unknown'
  /** The remote has no such branch, and this route never creates one. */
  | 'branch-missing'
  /** The commit to push is not in the user's local object store. */
  | 'commit-unknown'
  /** The remote branch is not where the request said it was. It moved. */
  | 'remote-moved'
  /** The push would not be a fast-forward. There is no force to fall back on. */
  | 'not-fast-forward'
  /** The remote branch is already at that commit. */
  | 'nothing-to-push'
  /** `git ls-remote` could not reach or read the remote. */
  | 'remote-unreachable'
  /** The remote itself refused — a protection rule, a hook, or permissions. */
  | 'push-rejected'
  /** The push could not be attempted at all. */
  | 'push-failed'

/** A parsed non-2xx bridge body. `code` is null when it was not one we know. */
export interface BridgeErrorBody {
  code: BridgeErrorCode | null
  message: string
  /**
   * On `tree-dirty` only: the repo-relative paths a stash would move.
   *
   * Carried so a stash confirmation can name EXACTLY what it is about to
   * touch. A prompt that says "you have uncommitted changes, stash them?"
   * without listing them asks the user to trust a claim they cannot check —
   * which is the one thing a destructive-looking action must never do.
   */
  dirtyPaths: string[]
  /** On `tree-dirty` only: the true total, which may exceed `dirtyPaths`. */
  dirtyCount: number
}

const KNOWN_ERROR_CODES: readonly string[] = [
  'bad-request', 'unauthorized', 'forbidden-origin', 'forbidden-host', 'forbidden-path',
  'not-found', 'method-not-allowed', 'not-implemented', 'payload-too-large', 'timeout',
  'cli-unavailable', 'cli-failed', 'write-disabled', 'worktree-failed', 'head-unknown',
  'checkout-disabled', 'tree-dirty', 'ref-unknown', 'checkout-failed', 'no-prior-state',
  'prior-gone', 'moved-since', 'untrusted-unacknowledged',
  // The push family. Each one is a DIFFERENT sentence in the UI, so each has to
  // survive parsing as itself — a code that fell through to null would collapse
  // eleven distinct refusals into one unhelpful "HTTP 409".
  'push-disabled', 'protected-branch', 'default-branch-unknown', 'remote-unknown',
  'branch-missing', 'commit-unknown', 'remote-moved', 'not-fast-forward',
  'nothing-to-push', 'remote-unreachable', 'push-rejected', 'push-failed',
]

/**
 * Narrow an untrusted error body. Like parseHealth, the bridge is a local
 * process the user started, but the payload still crosses into rendered UI —
 * so `message` is length-capped and stripped of control characters.
 */
export function parseBridgeError(value: unknown): BridgeErrorBody {
  const empty = { code: null, message: '', dirtyPaths: [], dirtyCount: 0 }
  if (typeof value !== 'object' || value === null) return empty
  const raw = value as Record<string, unknown>
  const code = raw['error']
  const message = raw['message']
  const paths = raw['dirtyPaths']
  const count = raw['dirtyCount']
  const dirtyPaths = Array.isArray(paths)
    ? paths.filter((p): p is string => typeof p === 'string').map((p) => sanitizeLabel(p, 300))
    : []
  return {
    code: typeof code === 'string' && KNOWN_ERROR_CODES.includes(code) ? (code as BridgeErrorCode) : null,
    message: typeof message === 'string' ? sanitizeLabel(message, 300) : '',
    dirtyPaths,
    // A count we cannot read falls back to what we CAN see, never to zero: a
    // "0 files" stash prompt beside a non-empty list would be nonsense.
    dirtyCount: typeof count === 'number' && Number.isFinite(count) ? count : dirtyPaths.length,
  }
}

/**
 * Narrow an untrusted `/v1/infer` body. `text` is NOT sanitized: it is model
 * output headed for the JSON-extraction ladder and the markdown renderer, both
 * of which already treat it as untrusted. Stripping control characters here
 * would corrupt legitimate answers.
 */
export function parseInferResponse(value: unknown): InferResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  if (typeof raw['cli'] !== 'string') return null
  if (typeof raw['text'] !== 'string') return null
  if (typeof raw['truncated'] !== 'boolean') return null
  if (typeof raw['durationMs'] !== 'number') return null

  const parsed: InferResponse = {
    ok: true,
    cli: sanitizeLabel(raw['cli'], 40),
    text: raw['text'],
    truncated: raw['truncated'],
    durationMs: raw['durationMs'],
  }

  // Usage is optional and must be ALL-OR-NOTHING: a half-reported pair would
  // be a fabricated number in the cost UI.
  const usage = raw['usage']
  if (typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>
    if (typeof u['inputTokens'] === 'number' && typeof u['outputTokens'] === 'number') {
      parsed.usage = { inputTokens: u['inputTokens'], outputTokens: u['outputTokens'] }
    }
  }

  // The agentic report is narrowed STRICTLY, because its presence is what lets
  // the app tell a user their review read their own working tree. Anything that
  // is not a well-formed report is dropped entirely rather than half-read: a
  // partial report would be indistinguishable from a tool-less run that somehow
  // grew a field, and "we could not tell" must resolve to "not grounded".
  const agentic = raw['agentic']
  if (typeof agentic === 'object' && agentic !== null) {
    const a = agentic as Record<string, unknown>
    const tools = a['tools']
    if (Array.isArray(tools) && tools.every((t) => typeof t === 'string')) {
      const report: InferAgentic = { tools: (tools as string[]).map((t) => sanitizeLabel(t, 40)) }
      // Counts are optional and must be non-negative integers. A malformed one
      // is DROPPED (leaving it absent = "unreported"), never coerced to 0 —
      // zero is a claim that the CLI used no tools, which is not what a
      // malformed number tells us.
      const calls = a['toolCallsAtLeast']
      if (typeof calls === 'number' && Number.isInteger(calls) && calls >= 0) {
        report.toolCallsAtLeast = calls
      }
      const denied = a['denied']
      if (typeof denied === 'number' && Number.isInteger(denied) && denied >= 0) {
        report.denied = denied
      }
      parsed.agentic = report
    }
  }
  return parsed
}

// ---------------------------------------------------------------------------
// `POST /v1/infer/stream` — the same work, delivered as it is produced.
// ---------------------------------------------------------------------------

/** The route. A constant so the two protocol mirrors cannot drift on a string. */
export const INFER_STREAM_PATH = '/v1/infer/stream'

/**
 * NDJSON — one JSON document per `\n`-terminated line — NOT Server-Sent
 * Events. The bridge's own protocol.ts carries the full reasoning; the short
 * version from the browser's side is that `EventSource` cannot send an
 * `Authorization` header or a POST body, so this has to be read with `fetch`
 * and a stream reader anyway — and SSE's auto-reconnect would silently re-POST
 * and spawn a SECOND CLI run on the user's subscription.
 */
export const INFER_STREAM_CONTENT_TYPE = 'application/x-ndjson'

export interface InferStreamStart {
  type: 'start'
  cli: string
  /**
   * TRUE when this CLI genuinely emits text as the model writes it. FALSE when
   * the bridge fell back to the CLI's one-shot path and the whole answer will
   * arrive as a single delta at the end (codex). The bridge never fakes
   * fragments, so this is the fact the UI may repeat to the user.
   */
  streaming: boolean
}

export interface InferStreamDelta {
  type: 'delta'
  text: string
}

export interface InferStreamDone {
  type: 'done'
  /** The CLI's own final answer, AUTHORITATIVE over the concatenated deltas. */
  text: string
  truncated: boolean
  durationMs: number
  /** Present ONLY when the CLI reported token counts. Never zero-filled. */
  usage?: InferUsage
}

export interface InferStreamError {
  type: 'error'
  /** The same BridgeErrorCode the one-shot route's HTTP status would carry. */
  code: BridgeErrorCode | null
  message: string
}

export type InferStreamEvent =
  | InferStreamStart
  | InferStreamDelta
  | InferStreamDone
  | InferStreamError

/**
 * Narrow one untrusted NDJSON line.
 *
 * Returns null for a line we cannot read — a blank line, a truncated write, or
 * an event type from a NEWER bridge. Null means SKIP, never fail: event types
 * are additive within v1 for the same reason error codes are, and a client
 * that crashed on an unknown `type` would break the moment the bridge grew a
 * progress event.
 *
 * `text` is NOT sanitized, for the same reason `InferResponse.text` is not: it
 * is model output headed for the JSON-extraction ladder and the markdown
 * renderer, both of which already treat it as untrusted, and stripping control
 * characters would corrupt legitimate answers. `cli` and `message` ARE
 * sanitized — they are rendered as labels.
 */
export function parseInferStreamEvent(line: string): InferStreamEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>

  switch (raw['type']) {
    case 'start':
      if (typeof raw['cli'] !== 'string') return null
      return {
        type: 'start',
        cli: sanitizeLabel(raw['cli'], 40),
        // Anything but a literal `true` reads as false: claiming a stream that
        // is not one is the single dishonesty this field exists to prevent.
        streaming: raw['streaming'] === true,
      }
    case 'delta':
      if (typeof raw['text'] !== 'string') return null
      return { type: 'delta', text: raw['text'] }
    case 'done': {
      if (typeof raw['text'] !== 'string') return null
      if (typeof raw['truncated'] !== 'boolean') return null
      if (typeof raw['durationMs'] !== 'number') return null
      const done: InferStreamDone = {
        type: 'done',
        text: raw['text'],
        truncated: raw['truncated'],
        durationMs: raw['durationMs'],
      }
      // ALL-OR-NOTHING, exactly as parseInferResponse does it: a half-reported
      // pair would be a fabricated number in the cost UI.
      const usage = raw['usage']
      if (typeof usage === 'object' && usage !== null) {
        const u = usage as Record<string, unknown>
        if (typeof u['inputTokens'] === 'number' && typeof u['outputTokens'] === 'number') {
          done.usage = { inputTokens: u['inputTokens'], outputTokens: u['outputTokens'] }
        }
      }
      return done
    }
    case 'error': {
      // The bridge sends `code` here — verified against a live bridge. `error`
      // is accepted as an alias because that is the field name on every OTHER
      // bridge error body (the non-2xx envelope), so it is the spelling a
      // hand-rolled proxy or a future revision is most likely to reach for.
      // Reading one field and silently dropping the other would turn a
      // classified failure into an unclassified one.
      const code = raw['code'] ?? raw['error']
      const message = raw['message']
      return {
        type: 'error',
        code: typeof code === 'string' && KNOWN_ERROR_CODES.includes(code) ? (code as BridgeErrorCode) : null,
        message: typeof message === 'string' ? sanitizeLabel(message, 300) : '',
      }
    }
    default:
      return null
  }
}

/**
 * What the bridge's working tree currently IS — the field local grounding
 * turns on. MIRROR of `GitState` in bridge/src/protocol.ts.
 *
 * The bridge serves whatever is on disk right now, which may be another
 * branch, a dirty tree, or a stale checkout. Grounding a review of PR #123 in
 * `main`'s copy of a file would be silently wrong — worse than no local
 * grounding at all — so the bridge REPORTS this and the browser decides.
 *
 * `null` (absent, or a bridge too old to send it) means "no match is
 * provable". Never read it as permission to guess.
 */
export interface BridgeGitState {
  /** Full 40-character HEAD commit sha, lowercased. */
  head: string
  /** Branch name, or null on a detached HEAD. */
  branch: string | null
  /** Any uncommitted change at all, untracked files included. */
  dirty: boolean
}

export interface BridgeHealth {
  ok: true
  protocol: number
  /** Repo directory BASENAME — the bridge never sends the absolute path. */
  root: string
  capabilities: BridgeCapabilities
  /** The served tree's state, or null when it could not be established. */
  git: BridgeGitState | null
  version: string
}

// ---------------------------------------------------------------------------
// `POST /v1/files` and `POST /v1/search` — the grounding routes.
// ---------------------------------------------------------------------------

export interface BridgeFilesRequest {
  /** Repo-relative paths. The bridge caps the list at 200. */
  paths: string[]
  /** Per-file byte ceiling; the bridge clamps it to 2 MiB. */
  maxBytes?: number
}

export interface BridgeFileEntry {
  path: string
  /** Byte length ON DISK — not of `content`, which may have been cut. */
  bytes: number
  truncated: boolean
  content: string
  encoding: 'utf-8'
}

/** Why a path that EXISTS yielded no text. See bridge/src/protocol.ts. */
export type BridgeFileSkipReason = 'binary' | 'not-a-file' | 'unreadable'

export interface BridgeFileSkip {
  path: string
  reason: BridgeFileSkipReason
}

export interface BridgeFilesResponse {
  ok: true
  files: BridgeFileEntry[]
  /** Requested but absent. NOT an error — the contract says so. */
  missing: string[]
  /** Present but unreadable as text, with the reason. Never overlaps the others. */
  skipped: BridgeFileSkip[]
}

export interface BridgeSearchRequest {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  maxResults?: number
  include?: string[]
}

export interface BridgeSearchMatch {
  path: string
  /** 1-based. */
  line: number
  /** 1-based, counted in CHARACTERS. */
  column: number
  preview: string
}

export interface BridgeSearchResponse {
  ok: true
  matches: BridgeSearchMatch[]
  /** The result set was cut — by maxResults, the scan budget, or the clock. */
  truncated: boolean
}

/**
 * Narrow an untrusted `/v1/files` body.
 *
 * `content` is NOT sanitized: it is source code headed for a prompt and for
 * the diff renderer, both of which already treat it as untrusted, and
 * stripping control characters would corrupt legitimate files. `path` IS
 * sanitized — it is rendered as a label.
 */
export function parseFilesResponse(value: unknown): BridgeFilesResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  if (!Array.isArray(raw['files'])) return null
  if (!Array.isArray(raw['missing']) || raw['missing'].some((p) => typeof p !== 'string')) return null

  const files: BridgeFileEntry[] = []
  for (const entry of raw['files']) {
    if (typeof entry !== 'object' || entry === null) return null
    const f = entry as Record<string, unknown>
    if (typeof f['path'] !== 'string') return null
    if (typeof f['bytes'] !== 'number') return null
    if (typeof f['truncated'] !== 'boolean') return null
    if (typeof f['content'] !== 'string') return null
    files.push({
      path: sanitizeLabel(f['path'], 400),
      bytes: f['bytes'],
      truncated: f['truncated'],
      content: f['content'],
      encoding: 'utf-8',
    })
  }

  // `skipped` arrived with the grounding PR and is additive: a bridge without
  // it is not malformed, it just cannot explain a gap.
  const skipped: BridgeFileSkip[] = []
  if (Array.isArray(raw['skipped'])) {
    for (const entry of raw['skipped']) {
      if (typeof entry !== 'object' || entry === null) continue
      const s = entry as Record<string, unknown>
      if (typeof s['path'] !== 'string') continue
      const reason = s['reason']
      skipped.push({
        path: sanitizeLabel(s['path'], 400),
        reason:
          reason === 'binary' || reason === 'not-a-file' || reason === 'unreadable'
            ? reason
            : 'unreadable',
      })
    }
  }

  return {
    ok: true,
    files,
    missing: (raw['missing'] as string[]).map((p) => sanitizeLabel(p, 400)),
    skipped,
  }
}

/**
 * Narrow an untrusted `/v1/search` body.
 *
 * A single malformed match DROPS OUT rather than failing the whole response:
 * a search that found 40 call sites is still useful when one of them had a
 * non-numeric line, and discarding all 40 would push the review back to the
 * rate-limited provider path for no reason.
 */
export function parseSearchResponse(value: unknown): BridgeSearchResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  if (!Array.isArray(raw['matches'])) return null
  if (typeof raw['truncated'] !== 'boolean') return null

  const matches: BridgeSearchMatch[] = []
  for (const entry of raw['matches']) {
    if (typeof entry !== 'object' || entry === null) continue
    const m = entry as Record<string, unknown>
    if (typeof m['path'] !== 'string') continue
    if (typeof m['line'] !== 'number' || !Number.isFinite(m['line'])) continue
    if (typeof m['column'] !== 'number' || !Number.isFinite(m['column'])) continue
    if (typeof m['preview'] !== 'string') continue
    matches.push({
      path: sanitizeLabel(m['path'], 400),
      line: m['line'],
      column: m['column'],
      // The preview IS rendered in tool output and prompts, so control
      // characters are stripped here the way every other label is.
      preview: sanitizeLabel(m['preview'], 400),
    })
  }
  return { ok: true, matches, truncated: raw['truncated'] }
}

/**
 * The per-route flags other modules ask `bridgeAvailable()` about.
 *
 * Deliberately excludes `inference`: that is a detection ARRAY, a different
 * question, and a boolean helper answering both would be one letter away from
 * the wrong answer at every call site. Detection has its own accessor,
 * `bridgeInferenceClis()`.
 *
 * `fix` rides along because the question a caller asks is identical — "may I
 * call this route?" — even though the bridge answers it from a flag rather
 * than from a release number.
 */
export type BridgeCapability =
  | 'infer'
  | 'inferStream'
  | 'inferAgentic'
  | 'files'
  | 'search'
  | 'fix'
  | 'checkout'
  | 'push'

/** The loopback URL for a bridge route. Always 127.0.0.1 — never `localhost`. */
export function bridgeUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

/**
 * Narrow an untrusted `/v1/health` body to BridgeHealth.
 *
 * The bridge is a local process the user started, but the response still
 * crosses a network boundary into rendered UI, so it is validated like any
 * other foreign payload: shape-checked, and `root` (which IS displayed) is
 * length-capped and stripped of control characters.
 */
export function parseHealth(value: unknown): BridgeHealth | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  if (typeof raw['protocol'] !== 'number') return null
  if (typeof raw['root'] !== 'string') return null
  if (typeof raw['version'] !== 'string') return null

  const caps = raw['capabilities']
  if (typeof caps !== 'object' || caps === null) return null
  const capsRaw = caps as Record<string, unknown>
  const inference = capsRaw['inference']
  if (!Array.isArray(inference) || inference.some((cli) => typeof cli !== 'string')) return null
  // `infer` arrived with the inference PR. A bridge predating it is on the same
  // protocol version but has no such route, so a MISSING flag reads as false —
  // not as a parse failure, which would break pairing with an older bridge.
  const inferReady = capsRaw['infer']
  if (inferReady !== undefined && typeof inferReady !== 'boolean') return null
  // `inferStream` arrived with the streaming route, additive the same way
  // `infer` was. An absent flag is an OLDER bridge, not a malformed one, and
  // reads as false — which routes the transport to the one-shot path.
  const streamReady = capsRaw['inferStream']
  if (streamReady !== undefined && typeof streamReady !== 'boolean') return null
  // `inferAgentic` is additive exactly as `infer` and `inferStream` were, and
  // an absent flag is an OLDER bridge rather than a malformed one. It reads as
  // false, which routes deep review over the bridge back to single-pass WITH a
  // note — never to a silent tool-less answer dressed up as a grounded one.
  const agenticReady = capsRaw['inferAgentic']
  if (agenticReady !== undefined && typeof agenticReady !== 'boolean') return null
  if (typeof capsRaw['files'] !== 'boolean') return null
  if (typeof capsRaw['search'] !== 'boolean') return null
  // `fix` arrived with the fix-loop release and is additive the same way
  // `infer` was. A bridge without it is not malformed — it simply cannot
  // write, which is exactly what an absent flag must mean. Anything other
  // than a literal `true` reads as false: for a WRITE capability, "unknown"
  // must never render as the permissive answer.
  const fixReady = capsRaw['fix']
  if (fixReady !== undefined && typeof fixReady !== 'boolean') return null
  // `checkout` is additive the same way, and read with the same strictness for
  // the same reason: it authorises moving the user's working tree, so anything
  // other than a literal `true` must read as false.
  const checkoutReady = capsRaw['checkout']
  if (checkoutReady !== undefined && typeof checkoutReady !== 'boolean') return null
  // `push` is additive the same way, and read with MORE care than any of them:
  // it authorises the only thing the bridge does that other people can see.
  // Absent means an older bridge that has no such route, which is exactly what
  // false must mean here.
  const pushReady = capsRaw['push']
  if (pushReady !== undefined && typeof pushReady !== 'boolean') return null

  return {
    ok: true,
    protocol: raw['protocol'],
    root: sanitizeLabel(raw['root'], 80),
    capabilities: {
      inference: (inference as string[]).map((cli) => sanitizeLabel(cli, 40)),
      infer: inferReady === true,
      inferStream: streamReady === true,
      inferAgentic: agenticReady === true,
      files: capsRaw['files'],
      search: capsRaw['search'],
      fix: fixReady === true,
      checkout: checkoutReady === true,
      push: pushReady === true,
    },
    git: parseGitState(raw['git']),
    version: sanitizeLabel(raw['version'], 40),
  }
}

/** A 40-hex commit id. Anything else is not a sha and is not trusted. */
const SHA_RE = /^[0-9a-f]{40}$/

/**
 * Narrow the health document's `git` field.
 *
 * Returns null for EVERY doubtful case: absent (an older bridge), explicitly
 * null (not a repo), malformed, or a `head` that is not a 40-hex sha. That is
 * the whole safety property — a state we cannot read is a state we cannot
 * match, and an unmatched state means the review grounds from the provider.
 *
 * `dirty` is defaulted to TRUE when it is missing or not a boolean. Unknown
 * must never render as the reassuring answer.
 */
export function parseGitState(value: unknown): BridgeGitState | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const head = raw['head']
  if (typeof head !== 'string') return null
  const sha = head.toLowerCase()
  if (!SHA_RE.test(sha)) return null

  const branch = raw['branch']
  return {
    head: sha,
    branch: typeof branch === 'string' ? sanitizeLabel(branch, 200) || null : null,
    dirty: raw['dirty'] !== false,
  }
}

// ---------------------------------------------------------------------------
// `POST /v1/fix` — the agent fix loop. MIRROR of bridge/src/protocol.ts.
// ---------------------------------------------------------------------------

/** Findings one request may carry. The bridge rejects more; so do we. */
export const MAX_FIX_FINDINGS = 10

/**
 * Wall-clock ceiling on ONE fix request, from the browser's side.
 *
 * Deliberately generous: the bridge's own total budget is 30 minutes, and a
 * fetch that gave up at 60 s would abandon work the user's subscription had
 * already paid for while the agent kept running. The extra minute is slack so
 * the bridge's own honest `budget-exhausted` answer always wins the race.
 */
export const FIX_REQUEST_TIMEOUT_MS = 31 * 60 * 1000

/**
 * Wall-clock budget for ONE agentic `/v1/infer` call, from the browser's side.
 *
 * It has to be stated explicitly, and that is the whole point of this constant.
 * The bridge transport sends `timeoutMs ?? 60_000` on EVERY call, so a caller
 * that names none does not get the bridge's agentic default — it gets 60
 * seconds, both as the browser's abort and as the budget the bridge is told to
 * honour. Sixty seconds is a fine ceiling for a single completion and far too
 * short for an agent that opens several files and turns again on what it found:
 * the review would be killed mid-investigation, having already spent the user's
 * subscription on the part it did.
 *
 * Five minutes matches the bridge's own DEFAULT_AGENTIC_INFER_TIMEOUT_MS, so
 * the two ends agree on one number instead of racing. It is still under the
 * bridge's MAX_INFER_TIMEOUT_MS ceiling, which remains the real limit.
 */
export const INFER_AGENTIC_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

/** One proposed finding sent to the agent. `suggestedFix` is REQUIRED. */
export interface BridgeFixFinding {
  id: string
  path: string
  line: number | null
  severity: 'high' | 'medium' | 'low'
  body: string
  suggestedFix: string
}

export interface BridgeFixRequest {
  cli: BridgeCli
  /** The PR's head sha — the commit the scratch worktree is created from. */
  headSha: string
  findings: BridgeFixFinding[]
  maxRounds?: number
  timeoutMs?: number
}

export type BridgeFixTestStatus = 'passed' | 'failed' | 'unrunnable' | 'timeout' | 'skipped'

export interface BridgeFixTestOutcome {
  status: BridgeFixTestStatus
  command: string
  durationMs: number
  output: string
  detail?: string
}

/** See bridge/src/protocol.ts — each value is a different thing to say. */
export type BridgeFixStopReason =
  | 'all-addressed'
  | 'round-cap'
  | 'no-progress'
  | 'repeat-diff'
  | 'budget-exhausted'

export type BridgeFixSkipReason =
  | 'refused'
  | 'no-change'
  | 'agent-failed'
  | 'timeout'
  | 'forbidden-path'
  | 'budget'

export interface BridgeFixChange {
  findingId: string
  commit: string
  subject: string
  intent: string
  files: string[]
  diff: string
  truncated: boolean
  rounds: number
  stopReason: BridgeFixStopReason
  tests: BridgeFixTestOutcome | null
}

export interface BridgeFixSkip {
  findingId: string
  reason: BridgeFixSkipReason
  detail: string
}

export interface BridgeFixResponse {
  ok: true
  cli: string
  baseSha: string
  branch: string
  changes: BridgeFixChange[]
  skipped: BridgeFixSkip[]
  rounds: number
  stopReason: BridgeFixStopReason
  tests: BridgeFixTestOutcome | null
  durationMs: number
}

const FIX_STOP_REASONS: readonly string[] = [
  'all-addressed', 'round-cap', 'no-progress', 'repeat-diff', 'budget-exhausted',
]
const FIX_SKIP_REASONS: readonly string[] = [
  'refused', 'no-change', 'agent-failed', 'timeout', 'forbidden-path', 'budget',
]
const FIX_TEST_STATUSES: readonly string[] = ['passed', 'failed', 'unrunnable', 'timeout', 'skipped']

/** A 40-hex commit id, lowercased. Anything else is not a sha. */
function asSha(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const sha = value.toLowerCase()
  return SHA_RE.test(sha) ? sha : null
}

/**
 * Narrow an untrusted `/v1/fix` test outcome.
 *
 * An unrecognised `status` becomes `unrunnable`, never `passed`: a status we
 * cannot read must not render as the reassuring answer, exactly as
 * `parseGitState` defaults `dirty` to true.
 */
function parseFixTests(value: unknown): BridgeFixTestOutcome | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const status = raw['status']
  const outcome: BridgeFixTestOutcome = {
    status: (typeof status === 'string' && FIX_TEST_STATUSES.includes(status)
      ? status
      : 'unrunnable') as BridgeFixTestStatus,
    command: typeof raw['command'] === 'string' ? sanitizeLabel(raw['command'], 200) : '',
    durationMs: typeof raw['durationMs'] === 'number' ? raw['durationMs'] : 0,
    // Test output is a multi-line report headed for a <pre>; stripping its
    // newlines the way a label is stripped would make it unreadable. The
    // bridge already removed absolute paths and control characters.
    output: typeof raw['output'] === 'string' ? raw['output'].slice(0, 8_000) : '',
  }
  if (typeof raw['detail'] === 'string') outcome.detail = sanitizeLabel(raw['detail'], 300)
  return outcome
}

/**
 * Narrow an untrusted `/v1/fix` body.
 *
 * A malformed CHANGE drops out rather than failing the whole response — five
 * good commits are still worth reviewing when a sixth arrived unreadable — but
 * a change with no commit sha is never kept: the sha is what the user acts on,
 * and a change they cannot cherry-pick is not a result, it is a lie.
 *
 * `diff` is NOT sanitized. It is a patch headed for a <pre> and the diff
 * renderer, both of which already treat it as untrusted, and stripping control
 * characters would corrupt legitimate code. `intent`, `subject` and the paths
 * ARE sanitized — they render as labels.
 */
export function parseFixResponse(value: unknown): BridgeFixResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  if (!Array.isArray(raw['changes']) || !Array.isArray(raw['skipped'])) return null
  const baseSha = asSha(raw['baseSha'])
  if (baseSha === null) return null

  const changes: BridgeFixChange[] = []
  for (const entry of raw['changes']) {
    if (typeof entry !== 'object' || entry === null) continue
    const c = entry as Record<string, unknown>
    const commit = asSha(c['commit'])
    if (commit === null) continue
    if (typeof c['findingId'] !== 'string') continue
    const stop = c['stopReason']
    changes.push({
      findingId: sanitizeLabel(c['findingId'], 200),
      commit,
      subject: typeof c['subject'] === 'string' ? sanitizeLabel(c['subject'], 200) : '',
      intent: typeof c['intent'] === 'string' ? sanitizeLabel(c['intent'], 400) : '',
      files: Array.isArray(c['files'])
        ? c['files'].filter((f): f is string => typeof f === 'string').map((f) => sanitizeLabel(f, 400))
        : [],
      diff: typeof c['diff'] === 'string' ? c['diff'] : '',
      truncated: c['truncated'] === true,
      rounds: typeof c['rounds'] === 'number' ? c['rounds'] : 1,
      stopReason: (typeof stop === 'string' && FIX_STOP_REASONS.includes(stop)
        ? stop
        : 'all-addressed') as BridgeFixStopReason,
      tests: parseFixTests(c['tests']),
    })
  }

  const skipped: BridgeFixSkip[] = []
  for (const entry of raw['skipped']) {
    if (typeof entry !== 'object' || entry === null) continue
    const s = entry as Record<string, unknown>
    if (typeof s['findingId'] !== 'string') continue
    const reason = s['reason']
    skipped.push({
      findingId: sanitizeLabel(s['findingId'], 200),
      // An unknown reason reads as `agent-failed`, the honest "something went
      // wrong here" — never as `refused`, which would credit the agent with a
      // judgment it never made.
      reason: (typeof reason === 'string' && FIX_SKIP_REASONS.includes(reason)
        ? reason
        : 'agent-failed') as BridgeFixSkipReason,
      detail: typeof s['detail'] === 'string' ? sanitizeLabel(s['detail'], 400) : '',
    })
  }

  const stop = raw['stopReason']
  return {
    ok: true,
    cli: typeof raw['cli'] === 'string' ? sanitizeLabel(raw['cli'], 40) : '',
    baseSha,
    branch: typeof raw['branch'] === 'string' ? sanitizeLabel(raw['branch'], 200) : '',
    changes,
    skipped,
    rounds: typeof raw['rounds'] === 'number' ? raw['rounds'] : 0,
    stopReason: (typeof stop === 'string' && FIX_STOP_REASONS.includes(stop)
      ? stop
      : 'all-addressed') as BridgeFixStopReason,
    tests: parseFixTests(raw['tests']),
    durationMs: typeof raw['durationMs'] === 'number' ? raw['durationMs'] : 0,
  }
}

/**
 * Strip control characters and cap the length of a string we are going to
 * render. Written as a code-point walk rather than a regex so no escape in
 * this file is itself a control character.
 */
function sanitizeLabel(value: string, maxLength: number): string {
  let out = ''
  for (const ch of value.slice(0, maxLength)) {
    const code = ch.codePointAt(0) ?? 0
    const isControl = code < 0x20 || code === 0x7f
    if (!isControl) out += ch
  }
  return out
}

// ---------------------------------------------------------------------------
// `GET /v1/stack`, `POST /v1/checkout`, `POST /v1/restore` — run this PR
// against the app the user already has running. MIRROR of bridge/src/protocol.ts.
// ---------------------------------------------------------------------------

/**
 * A checkout fetches a ref and then the user's dev server RUNS it, so the
 * request is allowed to take a while: a cold fetch of a large repo's PR ref is
 * the slow part, and failing at thirty seconds would just make the user retry
 * the same slow thing.
 */
export const CHECKOUT_REQUEST_TIMEOUT_MS = 3 * 60 * 1000

/** How the bridge worked out where the dev server is. See bridge/src/appUrl.ts. */
export type BridgeAppUrlSource = 'flag' | 'posthog' | 'package-json' | 'unknown'

export interface BridgeStackApp {
  /** Loopback URL of the dev server, or null when `source` is 'unknown'. */
  url: string | null
  source: BridgeAppUrlSource
  /** Did a TCP connect succeed just now? Always false when `url` is null. */
  reachable: boolean
  /** Why it is unknown, or how the port was read. The bridge's own sentence. */
  detail: string
}

/** The state the tree was in before a checkout moved it. */
export interface BridgeStackPrior {
  branch: string | null
  head: string
  recordedAt: string
  checkedOutRef: string
  checkedOutSha: string
  /** The stash entry created to clear the tree, as a sha. Null when none. */
  stashRef: string | null
}

/** A stash the bridge created (on checkout) or applied (on restore). */
export interface BridgeStackStash {
  action: 'created' | 'applied'
  ref: string
  /** The command the USER runs to remove the entry. The bridge never does. */
  dropCommand: string
}

export interface BridgeStackState {
  git: BridgeGitState | null
  dirtyPaths: string[]
  dirtyCount: number
  prior: BridgeStackPrior | null
  app: BridgeStackApp
  /** Mirrors `capabilities.checkout` — the `--allow-checkout` flag. */
  checkoutEnabled: boolean
}

export interface BridgeStackAction {
  git: BridgeGitState
  prior: BridgeStackPrior | null
  stash: BridgeStackStash | null
  app: BridgeStackApp
}

const APP_SOURCES: readonly string[] = ['flag', 'posthog', 'package-json', 'unknown']

/**
 * Narrow the `app` block.
 *
 * An unreadable block becomes the honest `unknown`/unreachable answer rather
 * than null, so a caller always has something to render. `reachable` is forced
 * false whenever there is no URL: an unprobed port can never be reported as
 * up, the same rule `parseGitState` applies to `dirty`.
 */
function parseStackApp(value: unknown): BridgeStackApp {
  const unknown: BridgeStackApp = { url: null, source: 'unknown', reachable: false, detail: '' }
  if (typeof value !== 'object' || value === null) return unknown
  const raw = value as Record<string, unknown>
  const source = raw['source']
  const url = raw['url']
  const safeUrl = typeof url === 'string' && url !== '' ? sanitizeLabel(url, 300) : null
  return {
    url: safeUrl,
    source: typeof source === 'string' && APP_SOURCES.includes(source)
      ? (source as BridgeAppUrlSource)
      : 'unknown',
    reachable: safeUrl !== null && raw['reachable'] === true,
    detail: typeof raw['detail'] === 'string' ? sanitizeLabel(raw['detail'], 400) : '',
  }
}

/** Cap on rendered dirty paths, mirroring the bridge's MAX_DIRTY_PATHS. */
const MAX_DIRTY_PATHS = 100

function parseDirtyPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((p): p is string => typeof p === 'string')
    .slice(0, MAX_DIRTY_PATHS)
    .map((p) => sanitizeLabel(p, 300))
}

/**
 * Narrow the recorded prior state.
 *
 * Returns null for every doubtful case, exactly like `parseGitState`: this
 * value drives a "Restore main" button, and a half-read record would offer the
 * user a way home that does not go anywhere.
 */
export function parseStackPrior(value: unknown): BridgeStackPrior | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const head = raw['head']
  const checkedOutSha = raw['checkedOutSha']
  if (typeof head !== 'string' || !SHA_RE.test(head.toLowerCase())) return null
  if (typeof checkedOutSha !== 'string' || !SHA_RE.test(checkedOutSha.toLowerCase())) return null
  const branch = raw['branch']
  const stashRef = raw['stashRef']
  const ref = raw['checkedOutRef']
  const recordedAt = raw['recordedAt']
  return {
    branch: typeof branch === 'string' && branch !== '' ? sanitizeLabel(branch, 200) : null,
    head: head.toLowerCase(),
    recordedAt: typeof recordedAt === 'string' ? sanitizeLabel(recordedAt, 40) : '',
    checkedOutRef: typeof ref === 'string' ? sanitizeLabel(ref, 200) : '',
    checkedOutSha: checkedOutSha.toLowerCase(),
    stashRef:
      typeof stashRef === 'string' && SHA_RE.test(stashRef.toLowerCase())
        ? stashRef.toLowerCase()
        : null,
  }
}

function parseStackStash(value: unknown): BridgeStackStash | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const ref = raw['ref']
  if (typeof ref !== 'string' || !SHA_RE.test(ref.toLowerCase())) return null
  return {
    action: raw['action'] === 'applied' ? 'applied' : 'created',
    ref: ref.toLowerCase(),
    dropCommand: typeof raw['dropCommand'] === 'string' ? sanitizeLabel(raw['dropCommand'], 200) : '',
  }
}

/** Narrow a `GET /v1/stack` body. Null when it is not one. */
export function parseStackResponse(value: unknown): BridgeStackState | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  const dirtyPaths = parseDirtyPaths(raw['dirtyPaths'])
  const count = raw['dirtyCount']
  return {
    git: parseGitState(raw['git']),
    dirtyPaths,
    dirtyCount: typeof count === 'number' && Number.isFinite(count) ? count : dirtyPaths.length,
    prior: parseStackPrior(raw['prior']),
    app: parseStackApp(raw['app']),
    // A capability read from silence must never be the permissive answer.
    checkoutEnabled: raw['checkoutEnabled'] === true,
  }
}

/**
 * Narrow a `POST /v1/checkout` or `/v1/restore` body.
 *
 * `git` is REQUIRED here, unlike in `/v1/stack`: an action that reports
 * success has by definition moved the tree, so a response that cannot say
 * where the tree now is has not told us the one thing we asked.
 */
export function parseStackAction(value: unknown): BridgeStackAction | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  const git = parseGitState(raw['git'])
  if (git === null) return null
  return {
    git,
    prior: parseStackPrior(raw['prior']),
    stash: parseStackStash(raw['stash']),
    app: parseStackApp(raw['app']),
  }
}

// ---------------------------------------------------------------------------
// `POST /v1/push` — THE ONLY ROUTE THAT LEAVES THE MACHINE.
// MIRROR of bridge/src/protocol.ts and bridge/src/push.ts.
// ---------------------------------------------------------------------------

/**
 * Budget for one push. Uploading objects over a slow link is slower than any
 * other request this app makes to the bridge, and a push cut short is the one
 * failure where "try again" is not obviously safe advice.
 */
export const PUSH_REQUEST_TIMEOUT_MS = 4 * 60 * 1000

/** The remote a push targets when nothing says otherwise. */
export const DEFAULT_PUSH_REMOTE = 'origin'

/**
 * `POST /v1/push`.
 *
 * `expectedRemoteSha` is what makes this a MOVE rather than a placement. The
 * confirmation the user reads names it; the bridge refuses if the branch is no
 * longer there. Without it, a branch that advanced between the confirmation and
 * the click would be pushed over anyway — which is exactly the case where the
 * user would want to be asked again.
 */
export interface BridgePushRequest {
  remote: string
  branch: string
  expectedRemoteSha: string
  sha: string
}

/** What the bridge says it did, in the request's own terms. */
export interface BridgePushResponse {
  ok: true
  remote: string
  branch: string
  before: string
  after: string
  commits: number
  durationMs: number
}

/**
 * Narrow an untrusted `/v1/push` body.
 *
 * Both shas are REQUIRED and must be real shas. A success that cannot say
 * where the branch ended up is not a success this app is willing to render —
 * the whole value of the response is that the user can check it against what
 * they confirmed.
 */
export function parsePushResponse(value: unknown): BridgePushResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['ok'] !== true) return null
  const before = asSha(raw['before'])
  const after = asSha(raw['after'])
  if (before === null || after === null) return null
  if (typeof raw['remote'] !== 'string' || typeof raw['branch'] !== 'string') return null
  return {
    ok: true,
    remote: sanitizeLabel(raw['remote'], 100),
    branch: sanitizeLabel(raw['branch'], 200),
    before,
    after,
    commits: typeof raw['commits'] === 'number' && raw['commits'] >= 0 ? raw['commits'] : 0,
    durationMs: typeof raw['durationMs'] === 'number' ? raw['durationMs'] : 0,
  }
}

// ---------------------------------------------------------------------------
// `POST /v1/ci-fix` — the failing-CI flow. MIRROR of bridge/src/ciFix.ts.
// ---------------------------------------------------------------------------

/** Matches the bridge's cap; a client that sent more would be told off anyway. */
export const MAX_CI_FAILURES = 5

/** Matches the bridge's cap. The TAIL of a log is what carries the failure. */
export const MAX_CI_LOG_CHARS = 20_000

/** One failing CI job, as evidence for the agent. */
export interface BridgeCiFailure {
  id: string
  name: string
  log: string
}

export interface BridgeCiFixRequest {
  cli: BridgeCli
  headSha: string
  failures: BridgeCiFailure[]
  maxRounds?: number
}

/**
 * Did the failure reproduce on the user's machine?
 *
 * THE FIELD THE WHOLE FLOW TURNS ON. Anything other than `reproduced` means the
 * bridge never started an agent, so there are no changes and nothing to push —
 * and the UI must say that, not bury it.
 */
export type BridgeCiReproduction = 'reproduced' | 'not-reproduced' | 'no-local-signal'

export interface BridgeCiFixResponse {
  ok: true
  cli: string
  reproduction: BridgeCiReproduction
  baseline: BridgeFixTestOutcome | null
  baseSha: string
  branch: string
  changes: BridgeFixChange[]
  skipped: BridgeFixSkip[]
  rounds: number
  stopReason: BridgeFixStopReason
  tests: BridgeFixTestOutcome | null
  /** The sha a push would carry. Null when nothing was committed. */
  headCommit: string | null
  durationMs: number
}

const CI_REPRODUCTIONS: readonly string[] = ['reproduced', 'not-reproduced', 'no-local-signal']

/**
 * Narrow an untrusted `/v1/ci-fix` body.
 *
 * Built on `parseFixResponse` because the shared part of the document IS a fix
 * response — same changes, same skips, same stop reasons, because it is the
 * same loop. What is added here is the round-zero verdict.
 *
 * An unreadable `reproduction` becomes `no-local-signal`, never `reproduced`.
 * That is the same rule `parseFixTests` applies to an unknown status and
 * `parseGitState` applies to `dirty`: the value we could not read must be the
 * one that offers the user LESS, not more. Reading it as `reproduced` would
 * enable a push button on the strength of a field nobody could parse.
 */
export function parseCiFixResponse(value: unknown): BridgeCiFixResponse | null {
  const base = parseFixResponse(value)
  if (base === null) return null
  const raw = value as Record<string, unknown>
  const reproduction = raw['reproduction']
  const headCommit = asSha(raw['headCommit'])

  return {
    ...base,
    reproduction: (typeof reproduction === 'string' && CI_REPRODUCTIONS.includes(reproduction)
      ? reproduction
      : 'no-local-signal') as BridgeCiReproduction,
    baseline: parseFixTests(raw['baseline']),
    // Never invented, and never taken from the changes array by this parser:
    // the bridge decides which commit a push may carry, and a client that
    // guessed would be guessing about the one irreversible operation here.
    headCommit,
  }
}
