/**
 * bridge/protocol.ts — the browser's view of the local-bridge wire contract.
 *
 * MIRROR of `bridge/src/protocol.ts`. The two are deliberately duplicated: the
 * SPA must not take a build-time dependency on a Node workspace package (it
 * would drag `node:` types and a second tsconfig into the app bundle graph for
 * three interfaces). Change BOTH files together; `bridge/README.md` documents
 * the canonical contract.
 *
 * IMPLEMENTED in v1: GET /v1/health, POST /v1/infer, POST /v1/files,
 * POST /v1/search, POST /v1/fix. Nothing answers 501 any more.
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
}

/** The CLIs the bridge knows how to drive. Mirrors bridge/src/capabilities.ts. */
export const BRIDGE_CLIS = ['claude', 'codex'] as const

export type BridgeCli = (typeof BRIDGE_CLIS)[number]

/** `POST /v1/infer` request. See bridge/src/protocol.ts for the invariants. */
export interface InferRequest {
  cli: BridgeCli
  prompt: string
  system?: string
  files?: string[]
  maxOutputTokens?: number
  timeoutMs?: number
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

/** A parsed non-2xx bridge body. `code` is null when it was not one we know. */
export interface BridgeErrorBody {
  code: BridgeErrorCode | null
  message: string
}

const KNOWN_ERROR_CODES: readonly string[] = [
  'bad-request', 'unauthorized', 'forbidden-origin', 'forbidden-host', 'forbidden-path',
  'not-found', 'method-not-allowed', 'not-implemented', 'payload-too-large', 'timeout',
  'cli-unavailable', 'cli-failed', 'write-disabled', 'worktree-failed', 'head-unknown',
]

/**
 * Narrow an untrusted error body. Like parseHealth, the bridge is a local
 * process the user started, but the payload still crosses into rendered UI —
 * so `message` is length-capped and stripped of control characters.
 */
export function parseBridgeError(value: unknown): BridgeErrorBody {
  if (typeof value !== 'object' || value === null) return { code: null, message: '' }
  const raw = value as Record<string, unknown>
  const code = raw['error']
  const message = raw['message']
  return {
    code: typeof code === 'string' && KNOWN_ERROR_CODES.includes(code) ? (code as BridgeErrorCode) : null,
    message: typeof message === 'string' ? sanitizeLabel(message, 300) : '',
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
  return parsed
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
export type BridgeCapability = 'infer' | 'files' | 'search' | 'fix'

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
  if (typeof capsRaw['files'] !== 'boolean') return null
  if (typeof capsRaw['search'] !== 'boolean') return null
  // `fix` arrived with the fix-loop release and is additive the same way
  // `infer` was. A bridge without it is not malformed — it simply cannot
  // write, which is exactly what an absent flag must mean. Anything other
  // than a literal `true` reads as false: for a WRITE capability, "unknown"
  // must never render as the permissive answer.
  const fixReady = capsRaw['fix']
  if (fixReady !== undefined && typeof fixReady !== 'boolean') return null

  return {
    ok: true,
    protocol: raw['protocol'],
    root: sanitizeLabel(raw['root'], 80),
    capabilities: {
      inference: (inference as string[]).map((cli) => sanitizeLabel(cli, 40)),
      infer: inferReady === true,
      files: capsRaw['files'],
      search: capsRaw['search'],
      fix: fixReady === true,
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
