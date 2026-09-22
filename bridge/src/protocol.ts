/**
 * protocol.ts — the review123 bridge wire contract, version 1.
 *
 * JSON over HTTP on 127.0.0.1. Every route lives under `/v1/`; the version is
 * in the PATH (not a header) so an old browser build and a new bridge can never
 * silently half-understand each other — a mismatched client simply 404s.
 *
 * MIRROR: `src/lib/bridge/protocol.ts` in the SPA restates these types for the
 * browser client (the SPA must not take a workspace dependency on this Node
 * package). Change BOTH files together — the README documents the contract.
 *
 * IMPLEMENTED in v1:
 *   GET  /v1/health
 *   POST /v1/infer
 *
 * RESERVED in v1 (documented shapes below, route answers 501 not-implemented):
 *   POST /v1/files
 *   POST /v1/search
 */

/** Wire protocol revision. Bumped only on a breaking change to these shapes. */
export const PROTOCOL_VERSION = 1

/** Default loopback port. Chosen to be memorable and outside the ephemeral range. */
export const DEFAULT_PORT = 7321

/** Hard cap on an accepted request body. Larger → 413 payload-too-large. */
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * Hard cap on the bytes returned for a single file by the (reserved)
 * `/v1/files` route. Larger files come back with `truncated: true`.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Budget for RECEIVING a request (`server.requestTimeout`). It bounds how long
 * a client may take to send headers + body — NOT how long the bridge may take
 * to answer, which is what makes a minutes-long `/v1/infer` call legal under a
 * 30 s receive budget.
 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * `/v1/infer` per-call budget when the request names none.
 *
 * Two minutes, not thirty seconds: a CLI turn spends real model time, and the
 * caller is a local subscription rather than a metered API, so waiting is
 * cheaper than failing.
 */
export const DEFAULT_INFER_TIMEOUT_MS = 120_000

/** Ceiling on `InferRequest.timeoutMs`. Anything larger is clamped to this. */
export const MAX_INFER_TIMEOUT_MS = 600_000

/**
 * Hard cap on the bytes of stdout the bridge will buffer from one CLI run.
 * Reaching it kills the child and answers with `truncated: true` — a memory
 * guard, not an expected path (a real answer is orders of magnitude smaller).
 */
export const MAX_INFER_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Total bytes of `InferRequest.files` content inlined into the prompt. The
 * cap is on the SUM, not per file, because the prompt is what has to fit.
 */
export const MAX_INFER_FILE_CONTEXT_BYTES = 256 * 1024

/**
 * What this bridge can do RIGHT NOW.
 *
 * Two DIFFERENT kinds of entry live here, on purpose:
 *
 * - `inference` — DETECTION. Which of the known CLIs (`claude`, `codex`) exist
 *   on PATH. It says nothing about whether the route works.
 * - `infer` / `files` / `search` — route READINESS booleans, one per route,
 *   named after the route. Each flips to `true` in the same commit that
 *   implements its route, so a client that trusts the flag can never call a
 *   route that is not there. `infer` is `true` from the inference PR onwards;
 *   `files`/`search` are still `false`.
 *
 * A client wanting to run inference needs BOTH: `infer === true` (the route
 * exists) AND a CLI it can name in `inference` (something to run).
 */
export interface BridgeCapabilities {
  inference: string[]
  infer: boolean
  files: boolean
  search: boolean
}

/** `GET /v1/health` — the only implemented route in protocol v1. */
export interface HealthResponse {
  ok: true
  protocol: number
  /**
   * The repo directory's BASENAME only — never the absolute path. The browser
   * shows it so the user can confirm which checkout they paired with; leaking
   * the full path would hand a web origin the user's directory layout.
   */
  root: string
  capabilities: BridgeCapabilities
  /** The bridge package version, e.g. "0.1.0". */
  version: string
}

/**
 * Machine-readable failure codes. ADDITIVE within protocol v1 — a client that
 * does not recognise a code must fall back on `message`, never crash.
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
  /** The named CLI is not on PATH (or vanished since the last health probe). */
  | 'cli-unavailable'
  /** The CLI ran and failed: non-zero exit, or an error result it reported. */
  | 'cli-failed'

/** Every non-2xx response body has this shape. */
export interface ErrorResponse {
  ok: false
  error: BridgeErrorCode
  message: string
}

// ---------------------------------------------------------------------------
// `POST /v1/infer` — IMPLEMENTED (see infer.ts).
// ---------------------------------------------------------------------------

/**
 * `POST /v1/infer` — run a prompt through one of the user's LOCAL CLIs, on
 * their existing subscription.
 *
 * SECURITY INVARIANT: the request names a CLI by ID from a hard-coded set. It
 * never carries a command, argv, shell string, cwd, or environment. The bridge
 * builds the process invocation itself, from a fixed shape, with `spawn` and an
 * argv ARRAY — never a shell.
 *
 * LEGITIMACY INVARIANT: the bridge INVOKES the CLI. It never reads, copies or
 * reuses the CLI's stored credentials to call a vendor API directly — that
 * would route a subscription's auth around the subscription.
 */
export interface InferRequest {
  /** Which detected CLI to use. Must appear in `capabilities.inference`. */
  cli: 'claude' | 'codex'
  /** The user-turn prompt text. Delivered on STDIN, never in argv. */
  prompt: string
  /**
   * Optional system/instructions preamble. `claude` receives it through
   * `--system-prompt-file` (a 0600 temp file, so it stays out of `ps` too);
   * `codex exec` has no system-prompt flag, so it is framed into the stdin
   * payload instead. See infer.ts.
   */
  system?: string
  /**
   * Repo-relative paths whose CONTENT is inlined into the prompt for this call.
   * Each is confined to the repo root (see `confine.ts`); an escape is a 403
   * `forbidden-path`. A path that does not exist is skipped, not an error. The
   * total inlined content is capped at MAX_INFER_FILE_CONTEXT_BYTES.
   */
  files?: string[]
  /**
   * Soft ceiling on generated tokens.
   *
   * IGNORED TODAY, honestly: neither `claude -p` nor `codex exec` exposes an
   * output-token cap in headless mode. The field stays in the contract because
   * a future CLI release may, and callers should keep sending their intent.
   */
  maxOutputTokens?: number
  /**
   * Per-call budget in ms. Clamped to [1, MAX_INFER_TIMEOUT_MS]; absent →
   * DEFAULT_INFER_TIMEOUT_MS. On expiry the child is killed and the call
   * answers `504 timeout`.
   */
  timeoutMs?: number
}

/**
 * Token counts, when the CLI reports them. `claude -p --output-format json`
 * does; `codex exec` does not, and then this field is ABSENT — never zeroed,
 * never guessed. An absent `usage` means "unknown", and the caller must render
 * it as unknown rather than as free.
 */
export interface InferUsage {
  inputTokens: number
  outputTokens: number
}

export interface InferResponse {
  ok: true
  cli: string
  /** The CLI's final assistant text — the answer only, never its event log. */
  text: string
  /** True when output was cut at a cap rather than ending naturally. */
  truncated: boolean
  durationMs: number
  /** Present only when the CLI reported token counts. See InferUsage. */
  usage?: InferUsage
}

/** `POST /v1/files` — read file contents from the working tree. */
export interface FilesRequest {
  /** Repo-relative paths. Each is confined to the repo root. */
  paths: string[]
  /** Per-file byte ceiling; clamped to MAX_FILE_BYTES. */
  maxBytes?: number
}

export interface FileEntry {
  path: string
  /** Byte length of the file on disk (NOT of `content`, which may be cut). */
  bytes: number
  truncated: boolean
  content: string
  encoding: 'utf-8'
}

export interface FilesResponse {
  ok: true
  files: FileEntry[]
  /** Requested paths that do not exist (a missing file is not an error). */
  missing: string[]
}

/** `POST /v1/search` — content search across the working tree. */
export interface SearchRequest {
  query: string
  /** Treat `query` as a regular expression instead of a literal. */
  regex?: boolean
  caseSensitive?: boolean
  /** Ceiling on returned matches; the bridge clamps it. */
  maxResults?: number
  /** Optional repo-relative glob filters, e.g. ["src/**\/*.ts"]. */
  include?: string[]
}

export interface SearchMatch {
  /** Repo-relative path. */
  path: string
  /** 1-based line number. */
  line: number
  /** 1-based column of the match start. */
  column: number
  /** The matching line, trimmed to a readable length. */
  preview: string
}

export interface SearchResponse {
  ok: true
  matches: SearchMatch[]
  /** True when `maxResults` cut the result set. */
  truncated: boolean
}
