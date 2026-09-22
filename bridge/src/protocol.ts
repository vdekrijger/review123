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
 *   POST /v1/files
 *   POST /v1/search
 *   POST /v1/fix     (ONLY when the bridge was started with --allow-write)
 */

/** Wire protocol revision. Bumped only on a breaking change to these shapes. */
export const PROTOCOL_VERSION = 1

/** Default loopback port. Chosen to be memorable and outside the ephemeral range. */
export const DEFAULT_PORT = 7321

/** Hard cap on an accepted request body. Larger → 413 payload-too-large. */
export const MAX_BODY_BYTES = 1024 * 1024

/**
 * Hard cap on the bytes returned for a single file by `/v1/files`. Larger
 * files come back with `truncated: true`.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Hard cap on how many paths ONE `/v1/files` request may name. Over the cap is
 * a `bad-request`, not a silent trim: a caller that asked for 500 files and
 * silently got 200 would ground its answer in a set it did not choose.
 */
export const MAX_FILES_PER_REQUEST = 200

/**
 * Hard cap on the SUM of `content` bytes one `/v1/files` response carries.
 * Files that would cross it are returned truncated (or, once the budget is
 * spent, with empty content and `truncated: true`) — never silently dropped.
 */
export const MAX_FILES_TOTAL_BYTES = 4 * 1024 * 1024

/**
 * Bytes sniffed for a NUL when classifying a file as binary. Same heuristic
 * git uses: a NUL in the first few KB means "not text". A binary file is
 * REPORTED (in `skipped`), never decoded — handing a reviewer mojibake and
 * calling it source is worse than saying nothing.
 */
export const BINARY_SNIFF_BYTES = 8_000

/** `/v1/search` result ceiling when the request names none. */
export const DEFAULT_SEARCH_RESULTS = 200

/** Ceiling on `SearchRequest.maxResults`. Anything larger is clamped to this. */
export const MAX_SEARCH_RESULTS = 1_000

/** A search preview line is trimmed to this many characters. */
export const SEARCH_PREVIEW_MAX_CHARS = 240

/**
 * Wall-clock budget for one `/v1/search`. Local search is fast, but a
 * pathological regex over a monorepo is not, and a hung search would hold a
 * browser request open indefinitely. On expiry the results gathered so far are
 * returned with `truncated: true` — a partial honest answer beats an error.
 */
export const SEARCH_TIMEOUT_MS = 15_000

/** Files larger than this are not searched by either backend. */
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024

/** Ceiling on files the JS fallback walker will open in one search. */
export const SEARCH_MAX_FILES_SCANNED = 20_000

/**
 * Wall-clock budget for the `git` probes behind `/v1/health`. Three read-only
 * commands on a local repo answer in milliseconds; a hung `git` (a stale index
 * lock, a network filesystem) must not hold the health probe open, so it is
 * reported as "no git state" instead.
 */
export const GIT_STATE_TIMEOUT_MS = 5_000

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
 *   route that is not there. All three are `true` from the grounding PR on.
 *
 * A client wanting to run inference needs BOTH: `infer === true` (the route
 * exists) AND a CLI it can name in `inference` (something to run).
 */
export interface BridgeCapabilities {
  inference: string[]
  infer: boolean
  files: boolean
  search: boolean
  /**
   * `/v1/fix` — the ONE route that writes. Unlike its three siblings it is NOT
   * simply "true from the release that implements it": it reports whether this
   * PROCESS was started with `--allow-write`.
   *
   * That difference is the whole safety model. Write capability is granted at
   * the command line by the person sitting at the terminal; a web origin can
   * never turn it on, and cannot even ask. With the flag absent the route
   * answers `403 write-disabled` and this flag is `false`, so a client learns
   * the truth before it offers the user a button.
   */
  fix: boolean
}

/**
 * What the served working tree currently IS — the load-bearing field of the
 * whole grounding feature.
 *
 * The bridge serves whatever is on disk RIGHT NOW. That may be a different
 * branch, a dirty tree, or a checkout three weeks stale. Grounding a review of
 * PR #123 in `main`'s copy of a file would produce findings about code the PR
 * does not contain — silently wrong, and worse than no local grounding at all.
 *
 * So the bridge REPORTS its state and lets the client decide. review123 uses
 * local files only when `head` equals the PR's head sha; on any mismatch it
 * falls back to the provider API and says so in the UI.
 *
 * Produced by three READ-ONLY `git` commands with hard-coded argv (see
 * gitState.ts). `null` in `HealthResponse.git` means "this root is not a git
 * repository, has no commits yet, or git did not answer" — all of which mean
 * the same thing to a client: you cannot prove a match, so do not claim one.
 */
export interface GitState {
  /** Full 40-character HEAD commit sha. */
  head: string
  /** Current branch name, or `null` on a detached HEAD. */
  branch: string | null
  /**
   * True when `git status --porcelain` reports anything at all: staged or
   * unstaged modifications, AND untracked files. Untracked counts because an
   * untracked file is still code a reviewer could be handed that is in no
   * commit the PR contains.
   */
  dirty: boolean
}

/** `GET /v1/health` — the cheap "what is this bridge" probe. */
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
  /**
   * The working tree's current git state, or null when it cannot be
   * established. Clients MUST treat null as "no match provable". See GitState.
   *
   * A bridge predating the grounding PR omits this field entirely; a client
   * must read an absent `git` as null rather than as a parse failure.
   */
  git: GitState | null
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
  /**
   * `/v1/fix` was called on a bridge started WITHOUT `--allow-write`. Not a
   * 404 and not a 501: the route exists and is understood, it is simply not
   * authorised — and only the person at the terminal can authorise it.
   */
  | 'write-disabled'
  /**
   * The scratch git worktree could not be created (or reused). The user's own
   * checkout is untouched by definition — the failure happened before any
   * agent ran.
   */
  | 'worktree-failed'
  /**
   * The commit the request names is not in the local object store, so a
   * worktree cannot be created at it. Fetch or check out the PR locally first.
   */
  | 'head-unknown'

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

/**
 * `POST /v1/files` — read file contents from the working tree.
 *
 * EVERY path goes through confine.ts, one at a time: absolute paths, `..`
 * traversal and symlinks pointing out of the repo are all `403 forbidden-path`.
 * One bad path fails the WHOLE request rather than being dropped from the
 * results, so a caller can never mistake a refusal for a missing file.
 */
export interface FilesRequest {
  /** Repo-relative paths. At most MAX_FILES_PER_REQUEST of them. */
  paths: string[]
  /** Per-file byte ceiling; clamped to [1, MAX_FILE_BYTES]. */
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

/**
 * Why a requested path produced no content even though something IS there.
 *
 * - `binary` — a NUL byte in the first BINARY_SNIFF_BYTES. Decoding it as
 *   UTF-8 would return replacement-character soup that reads like source but
 *   is not, so it is reported instead.
 * - `not-a-file` — a directory, socket, fifo, …
 * - `unreadable` — it exists but open/read failed (permissions, a race).
 */
export type FileSkipReason = 'binary' | 'not-a-file' | 'unreadable'

export interface FileSkip {
  path: string
  reason: FileSkipReason
}

export interface FilesResponse {
  ok: true
  files: FileEntry[]
  /** Requested paths that do not exist (a missing file is not an error). */
  missing: string[]
  /**
   * Paths that exist but yielded no text, with the reason. ADDITIVE within
   * v1: a client that only reads `files`/`missing` still works, it just does
   * not get to explain the gap. Never overlaps `files` or `missing`.
   */
  skipped: FileSkip[]
}

/**
 * `POST /v1/search` — content search across the working tree.
 *
 * Backed by `ripgrep` when it is on PATH (gitignore-aware and far faster),
 * otherwise by a bounded JS walk that applies the common subset of
 * `.gitignore` semantics. Neither backend follows a symlink, so a link
 * pointing out of the repo cannot smuggle outside content into results.
 */
export interface SearchRequest {
  query: string
  /** Treat `query` as a regular expression instead of a literal. */
  regex?: boolean
  caseSensitive?: boolean
  /** Ceiling on returned matches; clamped to [1, MAX_SEARCH_RESULTS]. */
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
  /**
   * True when the result set was CUT: `maxResults` reached, the scan budget
   * (SEARCH_MAX_FILES_SCANNED) spent, or SEARCH_TIMEOUT_MS expired. The
   * distinction does not change what a caller should do — "there may be more"
   * — so it is one honest boolean rather than three.
   */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// `POST /v1/fix` — the agent fix loop. IMPLEMENTED, and the ONE route that
// writes anything anywhere. See fix.ts and bridge/README.md § 7.
// ---------------------------------------------------------------------------

/**
 * Hard cap on findings one `/v1/fix` request may carry.
 *
 * Every finding costs a full CLI turn on the user's subscription, so this is a
 * spend guard as much as a memory one. Over the cap is a `bad-request`, never
 * a silent trim: a caller that sent twelve findings and silently got eight
 * would show the user a "done" surface that quietly dropped four.
 */
export const MAX_FIX_FINDINGS = 10

/**
 * Hard ceiling on fix→re-check ROUNDS PER FINDING, and the default.
 *
 * A round is one agent turn. Round 1 makes the change; a further round happens
 * ONLY when the test command failed afterwards, and hands the agent its own
 * failure to repair. That loop oscillates in the wild — round 2 "fixes" round
 * 1, round 3 puts it back — so it is capped hard, and stopped early when a
 * round changes nothing or reproduces a state an earlier round already
 * produced. Three is enough for one honest follow-up and short enough that a
 * loop cannot burn an afternoon of subscription quota.
 *
 * `FixRequest.maxRounds` may only LOWER it.
 */
export const MAX_FIX_ROUNDS = 3

/** Per-FINDING CLI budget when the request names none. */
export const DEFAULT_FIX_TIMEOUT_MS = 300_000

/** Ceiling on `FixRequest.timeoutMs`. Anything larger is clamped to this. */
export const MAX_FIX_TIMEOUT_MS = 600_000

/**
 * Wall-clock budget for the WHOLE loop, across every round and finding. The
 * per-finding budget bounds one turn; this bounds the request. On expiry the
 * loop stops with `stopReason: 'budget-exhausted'` and returns the commits it
 * already has — a partial honest answer, never an error that throws the
 * finished work away.
 */
export const FIX_TOTAL_BUDGET_MS = 1_800_000

/** Wall-clock budget for one test-command run. */
export const FIX_TEST_TIMEOUT_MS = 600_000

/** Cap on the test output carried back per run (tail, sanitized). */
export const MAX_FIX_TEST_OUTPUT_BYTES = 64 * 1024

/**
 * Cap on ONE change's returned patch. A fix that needs more than this is not a
 * small attributed diff any more, and the response says so with `truncated`
 * rather than shipping a megabyte into a browser tab.
 */
export const MAX_FIX_DIFF_BYTES = 256 * 1024

/** Cap on the sanitized one-line intent the agent reports per change. */
export const FIX_INTENT_MAX_CHARS = 400

/**
 * The ref namespace every scratch branch lives in. Nothing outside this prefix
 * is ever created, moved or deleted by the bridge.
 */
export const FIX_BRANCH_PREFIX = 'review123/fix/'

/**
 * ONE proposed finding, as the browser sends it.
 *
 * THIS IS DATA, NOT INSTRUCTIONS. Every field here is text a language model
 * wrote while reviewing a diff. The bridge frames it to the coding agent as a
 * claim to EVALUATE and requires the agent to be able to refuse it — a finding
 * that says "delete the auth check" must be refusable. See fix.ts.
 */
export interface FixFinding {
  /**
   * The CALLER's own opaque id, echoed back on every change and skip so the
   * browser can put each result next to the card it came from. Never
   * interpreted by the bridge.
   */
  id: string
  /** Repo-relative path the finding anchors to. Confined like every path. */
  path: string
  /** 1-based line, or null for a file-level finding. */
  line: number | null
  severity: 'high' | 'medium' | 'low'
  /** The finding text. */
  body: string
  /**
   * The finding's CONCRETE fix. Required here, which is the routing rule made
   * structural: a finding whose fix is the honest "No clean fix — <tradeoff>"
   * is a judgment call for a human and the browser never sends it.
   */
  suggestedFix: string
}

/**
 * `POST /v1/fix` — hand selected findings to the user's local coding agent,
 * let it fix them IN ISOLATION, and return the resulting commits as a diff.
 *
 * SAFETY INVARIANTS (each has a test):
 *   1. Refused with `403 write-disabled` unless the bridge process was started
 *      with `--allow-write`. A web origin cannot turn writing on.
 *   2. All work happens in a dedicated scratch worktree created from `headSha`.
 *      The user's checkout, branch, index and uncommitted work are never
 *      touched.
 *   3. Nothing is pushed and nothing lands on any branch the user uses. The
 *      route produces commits in the scratch worktree and RETURNS them.
 *   4. Every existing gate still applies: loopback bind, pairing token,
 *      exact-origin CORS, Host anti-rebinding, repo confinement, caps.
 *   5. The request carries no command, argv, cwd or environment — exactly like
 *      `/v1/infer`. The test command is DETECTED by the bridge or set with the
 *      `--test-command` flag at the terminal; it is deliberately not a request
 *      field, because that would be arbitrary command execution from a web
 *      origin wearing a different hat.
 */
export interface FixRequest {
  /** Which detected CLI to drive. Must appear in `capabilities.inference`. */
  cli: 'claude' | 'codex'
  /**
   * The 40-hex commit the scratch worktree is created from — the PR's head.
   * Validated as a full sha, so it can never be mistaken for a git flag, and
   * checked to exist locally (`head-unknown` when it does not).
   */
  headSha: string
  /** 1..MAX_FIX_FINDINGS proposed findings. */
  findings: FixFinding[]
  /** Rounds to allow. Clamped to [1, MAX_FIX_ROUNDS]; absent → MAX_FIX_ROUNDS. */
  maxRounds?: number
  /** Per-finding CLI budget; clamped to [1, MAX_FIX_TIMEOUT_MS]. */
  timeoutMs?: number
}

/** How a test run ended. `skipped` means the bridge never ran one. */
export type FixTestStatus = 'passed' | 'failed' | 'unrunnable' | 'timeout' | 'skipped'

export interface FixTestOutcome {
  status: FixTestStatus
  /**
   * The command as argv, joined for display — e.g. "pnpm test". Present even
   * when `unrunnable`/`skipped` is the answer, so the UI can say WHICH command
   * it could not run. Empty only when no command was ever determined.
   */
  command: string
  durationMs: number
  /**
   * Sanitized tail of the run's output, capped. Absolute paths are stripped
   * exactly as `/v1/infer` strips them from CLI stderr.
   */
  output: string
  /**
   * Set when `status` is `unrunnable` or `skipped`: the honest reason, e.g.
   * "no test script in package.json". Absent otherwise.
   */
  detail?: string
}

/** ONE finding's fix: one commit, its intent, its files, its patch. */
export interface FixChange {
  /** The caller's `FixFinding.id`, echoed. */
  findingId: string
  /** Full 40-hex sha of the commit in the scratch worktree. */
  commit: string
  /** The commit's subject line. */
  subject: string
  /**
   * The agent's own one-line account of WHAT it changed and WHY — the thing
   * the human actually reviews. Never invented by the bridge: when the agent
   * gave none, this is its final message, trimmed.
   */
  intent: string
  /** Repo-relative paths the commit touches. */
  files: string[]
  /** The commit's patch (`git show`), capped at MAX_FIX_DIFF_BYTES. */
  diff: string
  /** True when `diff` was cut at the cap. */
  truncated: boolean
  /** Agent turns this finding took. 1 means it was right first time. */
  rounds: number
  /** Why THIS finding's fix→re-check loop ended. See FixStopReason. */
  stopReason: FixStopReason
  /**
   * The test result for the tree AT THIS COMMIT, or null when the bridge ran
   * no test for it. A fix that breaks the suite is reported as `failed` here —
   * it is never hidden, and never quietly dropped from the response.
   */
  tests: FixTestOutcome | null
}

/**
 * Why one finding produced no commit. Every value is a DIFFERENT thing to tell
 * the user, which is why there is no generic "failed".
 *
 * - `refused`       — the agent evaluated the finding and judged it wrong, out
 *                     of scope or harmful, and said so. The GOOD outcome for a
 *                     bad finding; `detail` carries its reason.
 * - `no-change`     — the agent reported success but the tree is identical.
 * - `agent-failed`  — the CLI errored or could not be started.
 * - `timeout`       — the per-finding budget expired and the child was killed.
 * - `forbidden-path`— the finding's path escapes the repo root.
 * - `budget`        — the loop's total wall clock ran out before its turn.
 */
export type FixSkipReason =
  | 'refused'
  | 'no-change'
  | 'agent-failed'
  | 'timeout'
  | 'forbidden-path'
  | 'budget'

export interface FixSkip {
  findingId: string
  reason: FixSkipReason
  /** One sanitized sentence: the agent's reason, or the bridge's. */
  detail: string
}

/**
 * Why a fix→re-check loop stopped. Reported ALWAYS, never reconstructed by the
 * client from counts — the same discipline `decideGrounding` uses for its
 * reasons.
 *
 * - `all-addressed`    — the loop finished on its own terms: the change was
 *                        made and the tests were not failing. The normal end.
 * - `round-cap`        — `maxRounds` turns ran and the tests were still
 *                        failing. The commit is RETURNED anyway, with its red
 *                        test result, because hiding it would be worse.
 * - `no-progress`      — a round left the tree exactly as the previous round
 *                        did. Running it again would produce the same nothing.
 * - `repeat-diff`      — a round reproduced a tree an earlier round already
 *                        produced: the loop is oscillating.
 * - `budget-exhausted` — FIX_TOTAL_BUDGET_MS expired. Whatever landed is
 *                        returned; the rest are skipped with reason `budget`.
 *
 * On `FixChange` it is that ONE finding's reason. On `FixResponse` it is the
 * run's: `budget-exhausted` when the clock ran out, otherwise the strongest
 * reason any single finding hit (round-cap ▸ repeat-diff ▸ no-progress ▸
 * all-addressed), so a summary line never reads greener than the detail.
 */
export type FixStopReason =
  | 'all-addressed'
  | 'round-cap'
  | 'no-progress'
  | 'repeat-diff'
  | 'budget-exhausted'

export interface FixResponse {
  ok: true
  cli: string
  /** The commit the scratch worktree was created from (echoes `headSha`). */
  baseSha: string
  /**
   * The scratch branch, e.g. "review123/fix/abc1234def0". It lives in the
   * user's repo — this is the one ref the bridge creates — so every returned
   * `commit` is cherry-pickable from their own checkout. Nothing is pushed.
   */
  branch: string
  /** One entry per finding that produced a commit, in commit order. */
  changes: FixChange[]
  /** One entry per finding that produced none, with WHY. */
  skipped: FixSkip[]
  /** The most rounds any single finding needed. 0 when nothing ran. */
  rounds: number
  stopReason: FixStopReason
  /**
   * The test result for the FINAL state of the scratch branch, or null when no
   * test was run at all. Per-commit results live on each change.
   */
  tests: FixTestOutcome | null
  durationMs: number
}
