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
 *   POST /v1/infer/stream   (the same work, delivered as it is produced)
 *   POST /v1/files
 *   POST /v1/search
 *   POST /v1/fix       (ONLY when the bridge was started with --allow-write)
 *   GET  /v1/stack
 *   POST /v1/checkout  (ONLY when the bridge was started with --allow-checkout)
 *   POST /v1/restore   (ONLY when the bridge was started with --allow-checkout)
 *
 * THE TWO WRITE GRANTS ARE INDEPENDENT. `--allow-write` enables `/v1/fix`,
 * which works only inside an isolated scratch worktree. `--allow-checkout`
 * enables `/v1/checkout` and `/v1/restore`, which move the user's OWN working
 * tree. Neither flag implies the other, and no web origin can set either.
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

/**
 * The default budget for an AGENTIC call (`InferRequest.agentic`), when the
 * request names none.
 *
 * Five minutes rather than two, because the work is genuinely different: a
 * tool-less call is one model turn, while an agentic one reads files, searches,
 * and turns again on what it found. The same ceiling still applies — this moves
 * the DEFAULT, never the maximum.
 *
 * It is also the ONLY budget that grows for agentic mode, and deliberately so:
 * see `InferAgentic` for why there is no tool-call budget to raise.
 */
export const DEFAULT_AGENTIC_INFER_TIMEOUT_MS = 300_000

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
  /**
   * `POST /v1/infer/stream` — a route-READINESS boolean exactly like `infer`,
   * flipped in the same commit that implements the route.
   *
   * It says the bridge UNDERSTANDS the streaming route. It does NOT promise
   * that every CLI produces incremental output: `claude` does, `codex` does
   * not, and the route says which per call in its `start` event
   * (`InferStreamStart.streaming`). Conflating the two would let a client
   * claim "your answer is typing out" for a CLI that physically cannot.
   *
   * A bridge predating this route omits the flag; an absent flag reads as
   * false, and a client that tries anyway gets a plain `404 not-found` and
   * falls back to `/v1/infer` — no CLI is spawned on the way.
   */
  inferStream: boolean
  /**
   * `InferRequest.agentic` — whether this bridge understands the flag that runs
   * the CLI with its own READ-ONLY tools. A route-readiness boolean like
   * `infer`, flipped in the commit that implemented it.
   *
   * IT IS LOAD-BEARING, not informational. `agentic` is an additive request
   * field, so a bridge predating it does not reject the flag — it IGNORES it
   * and runs the ordinary tool-less completion, answering 200 with a perfectly
   * good single-pass answer. A client that asked for an agentic review and does
   * not check this would then present that answer as "grounded in your working
   * tree", which it never was. So the client checks the flag BEFORE offering
   * deep review over the bridge, exactly as it checks `files` and `search`
   * before claiming local grounding.
   *
   * It is NOT a permission flag. Unlike `fix` and `checkout` it reports a
   * release, not a grant, because the capability it describes is read-only and
   * needs no grant: no `--allow-*` flag turns it on or off.
   */
  inferAgentic: boolean
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
  /**
   * `/v1/checkout` and `/v1/restore` — the routes that move the USER'S OWN
   * working tree. Reports `--allow-checkout`, and nothing else.
   *
   * IT IS A SEPARATE FLAG FROM `fix`, AND THAT SEPARATION IS THE POINT. The
   * fix loop writes only inside an isolated scratch worktree and swears never
   * to touch the user's checkout; this capability switches the branch under
   * their feet so their running dev stack serves the PR. They are different
   * risks, so they are different grants: `--allow-write` does NOT enable this,
   * `--allow-checkout` does NOT enable the fix loop, and a browser can turn on
   * neither.
   */
  checkout: boolean
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
  /**
   * `/v1/checkout` or `/v1/restore` on a bridge started WITHOUT
   * `--allow-checkout`. The exact sibling of `write-disabled`, and a SEPARATE
   * code on purpose: a client must never read "writing is on" as "switching
   * branches is on".
   */
  | 'checkout-disabled'
  /**
   * The working tree has uncommitted changes, so nothing was moved. The
   * response carries `dirtyPaths`, so the caller can name exactly what a stash
   * would take before it asks the user for one.
   */
  | 'tree-dirty'
  /** `git fetch` found no such ref on the remote (or could not reach it). */
  | 'ref-unknown'
  /**
   * `git checkout` itself refused — most often because the ref adds a file the
   * tree already has untracked. NOTHING was forced and nothing was discarded;
   * `message` carries git's own reason.
   */
  | 'checkout-failed'
  /** `/v1/restore` with no recorded prior state for this repo. */
  | 'no-prior-state'
  /**
   * The branch recorded before the checkout no longer exists (deleted, or
   * renamed). The recorded SHA is still in `message`; restoring to it detached
   * needs the explicit `detachToSha`.
   */
  | 'prior-gone'
  /**
   * HEAD is not where the checkout left it — the user switched branches or
   * committed since. Restoring anyway needs the explicit `acknowledgeMoved`.
   */
  | 'moved-since'
  /**
   * A checkout was requested without `acknowledgeUntrusted`. Checking a ref
   * out and letting a dev stack autoreload it runs that code; the caller has
   * to say it knows.
   */
  | 'untrusted-unacknowledged'

/**
 * Every non-2xx response body has this shape.
 *
 * `dirtyPaths` is ADDITIVE within v1 and present only on `tree-dirty`: a
 * refusal that says "your tree is dirty" without saying WHICH files would make
 * the user take the bridge's word for what a stash is about to move. A client
 * that does not read the field still works.
 */
export interface ErrorResponse {
  ok: false
  error: BridgeErrorCode
  message: string
  /** On `tree-dirty` only: repo-relative paths, capped at MAX_DIRTY_PATHS. */
  dirtyPaths?: string[]
  /** On `tree-dirty` only: how many are dirty in total. See `dirtyPaths`. */
  dirtyCount?: number
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
/**
 * Characters a `InferRequest.model` id may contain.
 *
 * The model id is the ONE piece of caller-supplied text that reaches argv (the
 * prompt and system text go to stdin and a temp file precisely so they never
 * do). An argv ARRAY already makes word-splitting impossible, but it does not
 * stop a value from LOOKING like a flag: `--model --dangerously-skip-permissions`
 * would hand the CLI an extra switch rather than a model name. So the id is
 * restricted to the shape real model ids actually have — letters, digits and
 * `. _ : - /` — and, separately, may not START with `-`. See MODEL_ID_MAX_LEN.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/** Length ceiling for a model id. Generous next to any real id. */
export const MODEL_ID_MAX_LEN = 100

/** Whether `value` is a model id the bridge will put on argv. */
export function isValidModelId(value: string): boolean {
  return value.length > 0 && value.length <= MODEL_ID_MAX_LEN && MODEL_ID_PATTERN.test(value)
}

export interface InferRequest {
  /** Which detected CLI to use. Must appear in `capabilities.inference`. */
  cli: 'claude' | 'codex'
  /** The user-turn prompt text. Delivered on STDIN, never in argv. */
  prompt: string
  /**
   * Which MODEL the chosen CLI should run — `claude --model <id>` /
   * `codex exec --model <id>`. Both accept a vendor alias (`opus`, `sonnet`,
   * `gpt-5`) or a full id (`claude-fable-5`); the bridge passes the string
   * through and lets the CLI validate it, because the CLI's accepted set moves
   * with its releases and a list baked in here would be wrong within a month.
   *
   * ABSENT means absent: no `--model` flag is added at all and the CLI uses
   * whatever the user configured it with — the behaviour every existing client
   * already gets. Must satisfy `isValidModelId`.
   */
  model?: string
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
   * DEFAULT_INFER_TIMEOUT_MS, or DEFAULT_AGENTIC_INFER_TIMEOUT_MS when
   * `agentic` is set. On expiry the child is killed and the call answers
   * `504 timeout`.
   */
  timeoutMs?: number
  /**
   * Run the CLI WITH its own read-only tools, so it can investigate the served
   * working tree instead of answering from the prompt alone.
   *
   * ────────────────────────────────────────────────────────────────────────
   * WHY THIS FLAG EXISTS AT ALL
   *
   * The ordinary call runs `claude` with `--tools ""` — WE strip its tools, on
   * purpose, because an ordinary completion has no business touching the disk.
   * "The CLI is already an agent, so agentic review is impossible over the
   * bridge" was never true: the CLI is not acting as an agent in that
   * invocation because we disabled it. This flag stops disabling it.
   *
   * The result is BETTER grounded than the API path, not worse. review123's own
   * deep-review tools fetch files through the VCS provider's API; the CLI reads
   * the user's actual working tree — the code in front of them, uncommitted
   * changes included.
   *
   * READ-ONLY IS THE WHOLE CONTRACT, and it is enforced DIFFERENTLY per CLI
   * because the two CLIs offer different levers — so it is stated per CLI
   * rather than as one comfortable sentence:
   *
   *   claude — the toolset is narrowed to Read, Glob and Grep by name. There is
   *     no write tool, no edit tool, no shell tool and no network tool in the
   *     process AT ALL (verified by asking it to enumerate them), so writing is
   *     not "denied", it is absent.
   *   codex — its toolset cannot be narrowed; `--sandbox read-only` instead
   *     confines what its shell may DO. So codex DOES run shell commands (`sed`,
   *     `grep`, `ls`) — it simply cannot write with them, and cannot reach
   *     outside the served root. That is a real difference from claude and it is
   *     recorded here rather than smoothed over. Note this is ALREADY true of
   *     the ordinary tool-less call, which has always run codex this way; the
   *     flag does not widen codex's powers at all.
   *
   * What holds for BOTH, and is what the route actually promises: no writes to
   * the repo, and no reads outside the served root (verified against both CLIs
   * with an absolute path to a file outside it — both refused).
   *
   * This is NOT a back door to `--allow-write` / `--allow-checkout`: those
   * grants are made by the person at the terminal, a web origin still cannot
   * request them, and a bridge started with NEITHER serves this route exactly as
   * fully as one started with both. See infer.ts for the argv that enforces all
   * of the above, and `InferAgentic` for what comes back.
   * ────────────────────────────────────────────────────────────────────────
   *
   * Absent or false → the byte-identical tool-less invocation every existing
   * client already gets.
   */
  agentic?: boolean
}

/**
 * What an `agentic: true` run actually did — reported, never promised.
 *
 * ABSENT from a response means the run was NOT agentic. Present means the CLI
 * really was given its tools, and these are the facts it reported back.
 *
 * WHY THERE IS NO TOOL-CALL BUDGET HERE, AND WHY THAT IS HONEST
 *
 * review123's own deep-review loop bounds itself with DEEP_REVIEW_MAX_TOOL_CALLS
 * because IT drives the loop: it decides whether to send another round. Here the
 * CLI owns its loop. Neither `claude` nor `codex exec` exposes a max-turns or
 * max-tool-calls flag, so the bridge has no lever to enforce such a budget with
 * — and a field claiming one would be a number we made up.
 *
 * `claude --max-budget-usd` IS enforced, and was REJECTED on evidence: it is a
 * dollar cap, and the point of the bridge is that the user is spending a
 * SUBSCRIPTION with no per-token price to cap. Worse, exhausting it fails the
 * whole run (`subtype: "error_max_budget_usd"` with no `result`), so the answer
 * already paid for is thrown away. A budget that converts a finished review into
 * an error is not a safety feature.
 *
 * So the run is bounded by the three things the bridge really does enforce, all
 * of them pre-existing machinery:
 *   - WALL CLOCK — `timeoutMs`, killed on the SIGTERM→SIGKILL ladder;
 *   - OUTPUT BYTES — MAX_INFER_OUTPUT_BYTES, which kills the child;
 *   - FILESYSTEM REACH — the CLI's own confinement to the served root.
 * and everything else is REPORTED here rather than pretended about.
 */
export interface InferAgentic {
  /**
   * The tool names granted, as passed to the CLI.
   *
   * `claude` takes an explicit `--tools` list, so this is exactly what it was
   * given. `codex exec` has no way to enumerate or narrow its toolset — its
   * sandbox mode restricts what its shell may DO, not which tools exist — so
   * this is EMPTY for codex. Empty means "this CLI does not let us name them",
   * never "it had none".
   */
  tools: string[]
  /**
   * A LOWER BOUND on the tool calls the CLI made. Never exact, never invented —
   * each CLI reports something different, and this is the honest floor derived
   * from it:
   *   - claude: `num_turns - 1` from its result document. A single turn can
   *     carry SEVERAL tool calls, so this UNDER-counts, which is the safe
   *     direction: it can never overstate how grounded an answer was.
   *   - codex:  the number of `command_execution` items in its `--json` event
   *     stream. That is an exact command count, and a command may read more
   *     than one file, so it under-counts too.
   * ABSENT when the CLI reported nothing countable. Zero means the CLI had its
   * tools and chose not to use them — a real and useful answer, distinct from
   * absent.
   */
  toolCallsAtLeast?: number
  /**
   * Tool calls the CLI's OWN permission layer refused — for `claude`, the
   * length of its `permission_denials` array.
   *
   * It is reported because it is the read-only contract being enforced in
   * public: a run that tried to step outside the served root and was stopped
   * says so here rather than silently. Absent when the CLI reports no such
   * list.
   */
  denied?: number
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
  /**
   * Present ONLY when the run was agentic, and then it is the report of what
   * the CLI's tools actually did. Its absence is how a client knows the answer
   * came from a tool-less completion — which is exactly what a bridge too old
   * to understand `agentic` will return, so a client that claims local
   * grounding must check for this rather than assume its request was honoured.
   */
  agentic?: InferAgentic
}

// ---------------------------------------------------------------------------
// `POST /v1/infer/stream` — the same work, delivered as it is produced.
// ---------------------------------------------------------------------------

/** The route. A constant so the two protocol mirrors cannot drift on a string. */
export const INFER_STREAM_PATH = '/v1/infer/stream'

/**
 * NDJSON — one JSON document per line, `\n`-terminated — NOT Server-Sent
 * Events. Four reasons, in order of weight:
 *
 *  1. `EventSource` is unusable here anyway. It cannot send an `Authorization`
 *     header and cannot POST a body, and this route needs both. So the browser
 *     reads the response with `fetch` + a `ReadableStream` reader either way —
 *     which strips SSE of the only thing it was going to buy us.
 *  2. SSE's auto-reconnect is actively WRONG for this route. A reconnect would
 *     re-POST and spawn a SECOND CLI run, spending the user's subscription
 *     twice for one answer. NDJSON has no such behaviour to disable.
 *  3. SSE `data:` fields cannot contain a raw newline, so every delta would
 *     have to be re-split across continuation lines and re-joined. Model output
 *     is full of newlines. NDJSON carries them inside the JSON string escape.
 *  4. Both CLIs already speak NDJSON natively (`claude --output-format
 *     stream-json`, `codex exec --json`), and every other bridge route speaks
 *     JSON. One framing end to end, one parser, one error envelope.
 */
export const INFER_STREAM_CONTENT_TYPE = 'application/x-ndjson'

/**
 * First line of every streamed response, before any work is reported.
 *
 * `streaming` is the honesty field: TRUE when this CLI genuinely emits text as
 * the model produces it, FALSE when the bridge had to fall back to the CLI's
 * one-shot path and the whole answer will arrive in a single `delta` at the
 * end. The bridge NEVER chops a finished answer into timed fragments to look
 * like streaming — a client that wants to tell the user "this does not type
 * out" needs a fact, not a simulation.
 */
export interface InferStreamStart {
  type: 'start'
  cli: string
  streaming: boolean
}

/** A piece of assistant text, in order. Concatenated they form the answer. */
export interface InferStreamDelta {
  type: 'delta'
  text: string
}

/**
 * The terminator. Its absence is itself meaningful: a stream that ends without
 * a `done` (or an `error`) was CUT, and a client must treat that as a failure
 * rather than as a short answer.
 *
 * `text` is the CLI's own final answer and is AUTHORITATIVE — the deltas are
 * for rendering progress. For `claude` the two agree, but the final result
 * document is what the CLI actually committed to, and on a truncated run it is
 * the only place a complete-as-far-as-it-got answer exists.
 */
export interface InferStreamDone {
  type: 'done'
  text: string
  truncated: boolean
  durationMs: number
  /** Present ONLY when the CLI reported token counts. Never zero-filled. */
  usage?: InferUsage
  /**
   * Present ONLY when the run was agentic — the same report, on the same terms,
   * that `/v1/infer` returns. The two routes share one invocation (#236), so
   * they say the same thing about it.
   */
  agentic?: InferAgentic
}

/**
 * A failure. May be the FIRST line (nothing ran) or arrive mid-stream after
 * deltas (the child died, the budget expired). Either way it is terminal: no
 * further events follow, and a client must surface it as an error even when it
 * already has partial text.
 *
 * The HTTP status is 200 for every mid-stream failure, because the status line
 * was already committed before the CLI produced a byte. That is why the code
 * lives in the event: `code` carries exactly the same BridgeErrorCode the
 * one-shot route would have answered with.
 */
export interface InferStreamError {
  type: 'error'
  code: BridgeErrorCode
  message: string
}

export type InferStreamEvent =
  | InferStreamStart
  | InferStreamDelta
  | InferStreamDone
  | InferStreamError

/** Serialise one event as an NDJSON line, terminator included. */
export function encodeStreamEvent(event: InferStreamEvent): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * Cap on a SINGLE unterminated line of CLI stdout the bridge will buffer while
 * waiting for its newline.
 *
 * Separate from MAX_INFER_OUTPUT_BYTES, which caps the answer. This one caps
 * the FRAMING: `claude --output-format stream-json` emits one JSON document
 * per line, and a CLI that produced a line and no newline would otherwise grow
 * the buffer without bound. 8 MiB is far above any real event and far below
 * anything that threatens a laptop.
 */
export const MAX_INFER_STREAM_LINE_BYTES = 8 * 1024 * 1024

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

// ---------------------------------------------------------------------------
// `GET /v1/stack`, `POST /v1/checkout`, `POST /v1/restore` — RUN THIS PR.
//
// The second family of routes that writes, and the FIRST that writes inside
// the user's own working tree. See bridge/README.md § 8.
// ---------------------------------------------------------------------------

/**
 * Budget for `git fetch <remote> <ref>`. The only command in this package that
 * touches a network, and the slowest thing a checkout does.
 */
export const CHECKOUT_FETCH_TIMEOUT_MS = 120_000

/** Budget for the local git commands a checkout/restore runs. */
export const CHECKOUT_GIT_TIMEOUT_MS = 60_000

/**
 * Cap on the dirty paths reported back. A tree with 4000 changed files does not
 * need to send all of them to make the point; the COUNT is reported separately
 * so the UI never implies the list is complete when it is not.
 */
export const MAX_DIRTY_PATHS = 100

/** Wall-clock budget for the dev-server TCP probe. It is on this machine. */
export const APP_PROBE_TIMEOUT_MS = 1_000

/** The remote a checkout fetches from when the request names none. */
export const DEFAULT_CHECKOUT_REMOTE = 'origin'

/**
 * A ref the bridge is willing to fetch.
 *
 * REQUIRING THE `refs/` PREFIX IS THE WHOLE GUARD. Every argv here is passed
 * through `spawn` with an array so nothing can become a second command, but a
 * value beginning with `-` could still be read by git as a FLAG. A string that
 * must start with `refs/` cannot be one, and it covers every provider's PR ref
 * shape: `refs/pull/<n>/head` (GitHub), `refs/merge-requests/<n>/head`
 * (GitLab), `refs/pull-requests/<n>/from` (Bitbucket).
 *
 * `..` and an empty path segment are refused separately in parseCheckoutRequest
 * — both are refname-illegal, and a caller sending one is not a caller we want
 * to hand to `git fetch`.
 */
export const CHECKOUT_REF_RE = /^refs\/[A-Za-z0-9._][A-Za-z0-9._/-]{0,180}$/

/** A remote name. Same reasoning as the ref: no leading `-`, nothing exotic. */
export const CHECKOUT_REMOTE_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,100}$/

/**
 * How the bridge worked out WHERE the user's dev server is.
 *
 * Reported always, never reconstructed by the client from whether a URL is
 * present — the same discipline `GroundingReason` and `FixStopReason` follow.
 *
 * - `flag`         — `--app-url` was given. The user said so; we believe them.
 * - `posthog`      — the repo is a PostHog checkout, which serves Django, Vite,
 *                    Celery and the plugin-server behind one fixed port, 8010.
 * - `package-json` — a `dev` or `start` script named a port.
 * - `unknown`      — NOTHING could be determined. `url` is null and `detail`
 *                    says why. Deliberately NOT a guess: a default like 5173
 *                    would point the preview panel at whatever else happens to
 *                    be on that port, which is worse than saying nothing.
 */
export type AppUrlSource = 'flag' | 'posthog' | 'package-json' | 'unknown'

export interface StackApp {
  /** The loopback URL of the dev server, or null when `source` is 'unknown'. */
  url: string | null
  source: AppUrlSource
  /**
   * Did a TCP connect to that port succeed just now?
   *
   * FALSE IS NOT AN ERROR — the user may simply not have started their stack.
   * It is always false when `url` is null, because an unprobed port cannot be
   * reported as reachable.
   */
  reachable: boolean
  /** Why `source` is 'unknown', or how the port was read. One honest sentence. */
  detail: string
}

/**
 * The working tree's state BEFORE a `/v1/checkout` moved it — recorded so the
 * user can always be put back exactly where they were.
 *
 * Persisted on disk, keyed by repo, so it survives a bridge restart: a user
 * whose bridge died mid-session must never be stranded on a PR branch with no
 * record of where they came from.
 */
export interface StackPriorState {
  /** The branch that was checked out, or null when HEAD was already detached. */
  branch: string | null
  /** The sha HEAD pointed at. Always present — the fallback restore target. */
  head: string
  /** ISO-8601 timestamp of the recording. */
  recordedAt: string
  /** The ref that was checked out over it, e.g. "refs/pull/42/head". */
  checkedOutRef: string
  /** The sha that ref resolved to — what HEAD should still be at on restore. */
  checkedOutSha: string
  /**
   * The stash entry created to get the tree clean, or null when the tree was
   * already clean. A 40-hex commit sha, NOT a `stash@{n}` index: indices shift
   * as other entries are pushed and popped, and restoring the wrong entry
   * would hand the user someone else's work.
   */
  stashRef: string | null
}

/** `GET /v1/stack` — everything the "run this PR" UI needs, in one probe. */
export interface StackResponse {
  ok: true
  /** The tree's current state. Same value and same null meaning as health's. */
  git: GitState | null
  /**
   * Repo-relative paths with uncommitted changes, capped at MAX_DIRTY_PATHS.
   * Present so a stash confirmation can name EXACTLY what it is about to move,
   * rather than asking the user to trust the word "dirty".
   */
  dirtyPaths: string[]
  /** How many paths are dirty. Larger than `dirtyPaths.length` when capped. */
  dirtyCount: number
  /** The recorded pre-checkout state, or null when the bridge holds none. */
  prior: StackPriorState | null
  app: StackApp
  /** Mirrors `capabilities.checkout` — the flag, restated where the UI acts. */
  checkoutEnabled: boolean
}

/**
 * `POST /v1/checkout` — fetch a pull request's ref and check it out IN THE
 * USER'S OWN WORKING TREE, so the dev stack they already have running serves
 * it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS A DIFFERENT CONTRACT FROM `/v1/fix`, ON PURPOSE.
 *
 * Every previous writing route promised never to touch the user's checkout.
 * This one's entire job is to touch it. That promise is not being broken — it
 * was made about the FIX LOOP, which still runs in an isolated scratch
 * worktree and still never goes near the user's tree. This is a SEPARATE
 * capability with a SEPARATE flag and its own gate, precisely so that someone
 * who enabled agent fixes does not silently also get branch switching.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * SAFETY INVARIANTS (each has a test):
 *   1. Refused with `403 checkout-disabled` unless the process was started
 *      with `--allow-checkout`. `--allow-write` does NOT enable it, and no
 *      web origin can turn either on.
 *   2. Refused with `409 tree-dirty` on ANY uncommitted change, until the
 *      caller explicitly sets `stashDirty`. Nothing is ever checked out over
 *      the user's work.
 *   3. `git stash push -u` is the ONLY way work is ever moved, it happens only
 *      on that explicit flag, and the entry's sha is recorded. There is no
 *      `checkout --force`, no `reset --hard`, no `clean`, and no `stash drop`
 *      anywhere in this route or its restore.
 *   4. The prior branch (or sha, when detached) is recorded BEFORE anything
 *      moves, and persisted, so `/v1/restore` can always put it back.
 *   5. `acknowledgeUntrusted` is REQUIRED. Checking a ref out and letting a
 *      dev stack autoreload it IS running that code — install scripts, config
 *      and all. The bridge cannot know whether a ref came from a fork, so it
 *      refuses to check ANY of them out unless the caller says, in one
 *      explicit field, that it understands the code will run.
 *   6. Every existing gate still applies: loopback bind, pairing token,
 *      exact-origin CORS, Host anti-rebinding, caps.
 *   7. The request carries no command, argv, cwd or environment. The ref and
 *      remote are pattern-validated and passed through `spawn` with an argv
 *      ARRAY — never a shell.
 */
export interface CheckoutRequest {
  /** The ref to fetch. Must match CHECKOUT_REF_RE. */
  ref: string
  /** Remote to fetch from; must match CHECKOUT_REMOTE_RE. Absent → 'origin'. */
  remote?: string
  /**
   * Explicitly authorise `git stash push -u` when the tree is dirty.
   *
   * A SEPARATE confirmation from the checkout itself, because moving someone's
   * uncommitted work is a separate decision from switching branches. Absent on
   * a dirty tree → `409 tree-dirty` with the paths, so the UI can name them
   * before it asks.
   */
  stashDirty?: boolean
  /**
   * Explicitly acknowledge that the checked-out code WILL RUN on this machine.
   * Required on every checkout — see invariant 5.
   */
  acknowledgeUntrusted?: boolean
}

/**
 * What happened to the user's uncommitted work.
 *
 * `dropCommand` is deliberately a command for the USER to run rather than
 * something the bridge does: dropping a stash entry destroys it, and this
 * package does not destroy things. Applying leaves the entry in place, so a
 * restore that goes wrong can simply be applied again.
 */
export interface StackStashOutcome {
  /** 'created' by a checkout, 'applied' by a restore. */
  action: 'created' | 'applied'
  /** The entry's commit sha. Stable, unlike a `stash@{n}` index. */
  ref: string
  /** The exact command that removes the entry, for the user to run themselves. */
  dropCommand: string
}

/** What a `/v1/checkout` or `/v1/restore` did, stated plainly. */
export interface StackActionResponse {
  ok: true
  /** The tree's state AFTER the operation. Never null on success. */
  git: GitState
  /** The recorded prior state (checkout), or null once a restore consumed it. */
  prior: StackPriorState | null
  /** The stash this call created (checkout) or applied (restore), if any. */
  stash: StackStashOutcome | null
  app: StackApp
}

/**
 * `POST /v1/restore` — put the working tree back exactly where `/v1/checkout`
 * found it.
 *
 * Every irregular case is a DIFFERENT refusal the caller must answer
 * explicitly, never a guess:
 *   - the tree is dirty now            → `409 tree-dirty`,  answer `stashDirty`
 *   - the recorded branch was deleted  → `409 prior-gone`,  answer `detachToSha`
 *   - HEAD is not where we left it     → `409 moved-since`, answer `acknowledgeMoved`
 */
export interface RestoreRequest {
  /** Authorise `git stash push -u` when the tree is dirty NOW. See above. */
  stashDirty?: boolean
  /**
   * The recorded branch no longer exists — restore to the recorded SHA with a
   * detached HEAD instead. Explicit because landing on a detached HEAD is not
   * what the user asked for, and must not happen silently.
   */
  detachToSha?: boolean
  /**
   * HEAD has moved since the checkout (the user switched branches by hand, or
   * committed). Restoring anyway is legitimate, but it is their call.
   */
  acknowledgeMoved?: boolean
  /**
   * Apply the stash recorded at checkout time.
   *
   * `git stash apply`, NEVER `pop`: apply leaves the entry in the stash list,
   * so a conflict or a mistake costs nothing. The entry is the user's to drop.
   */
  restoreStash?: boolean
}
