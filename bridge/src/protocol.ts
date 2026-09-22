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
 *   GET /v1/health
 *
 * RESERVED in v1 (documented shapes below, route answers 501 not-implemented):
 *   POST /v1/infer
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

/** Per-request wall clock budget enforced by the HTTP server. */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * What this bridge can do RIGHT NOW.
 *
 * - `inference` — CLIs DETECTED on PATH (`claude`, `codex`). This is a
 *   detection signal, not route readiness: `/v1/infer` answers 501 until the
 *   inference PR lands.
 * - `files` / `search` — route READINESS booleans. Both `false` in v1 because
 *   the routes are reserved; the follow-up PRs flip them when they implement
 *   the route. A client must never call a route whose flag is false.
 */
export interface BridgeCapabilities {
  inference: string[]
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

/** Machine-readable failure codes. Stable across protocol v1. */
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

/** Every non-2xx response body has this shape. */
export interface ErrorResponse {
  ok: false
  error: BridgeErrorCode
  message: string
}

// ---------------------------------------------------------------------------
// RESERVED — shapes fixed here so the follow-up PRs implement against a
// contract the browser client can already be written against. The routes
// currently answer 501 { ok: false, error: 'not-implemented' }.
// ---------------------------------------------------------------------------

/**
 * `POST /v1/infer` — run a prompt through one of the user's LOCAL CLIs.
 *
 * SECURITY INVARIANT: the request names a CLI by ID from a hard-coded set. It
 * never carries a command, argv, shell string, cwd, or environment. The bridge
 * builds the process invocation itself.
 */
export interface InferRequest {
  /** Which detected CLI to use. Must appear in `capabilities.inference`. */
  cli: 'claude' | 'codex'
  /** The user-turn prompt text. */
  prompt: string
  /** Optional system/instructions preamble. */
  system?: string
  /**
   * Repo-relative paths the CLI is allowed to read for this call. Each is
   * confined to the repo root (see `confine.ts`); an escape is a 403.
   */
  files?: string[]
  /** Soft ceiling on generated tokens, when the CLI supports one. */
  maxOutputTokens?: number
  /** Per-call budget; clamped by the bridge's own request timeout. */
  timeoutMs?: number
}

export interface InferResponse {
  ok: true
  cli: string
  /** The CLI's final text output, stdout only. */
  text: string
  /** True when output was cut at a cap rather than ending naturally. */
  truncated: boolean
  durationMs: number
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
