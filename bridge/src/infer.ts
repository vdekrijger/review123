/**
 * infer.ts — run a prompt through one of the user's LOCAL CLIs.
 *
 * This is the whole point of the bridge: review123's inference is BYO-key and
 * billed per token, but many people already pay for Claude Code or Codex. So
 * the bridge spends their SUBSCRIPTION instead of their API key.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE LEGITIMACY LINE (non-negotiable)
 *
 * The supported path is to INVOKE THE CLI as a subprocess. This module never
 * reads, copies, decodes or reuses the CLI's stored OAuth credentials to call a
 * vendor API directly. Doing that would take the auth that a subscription
 * issues for the subscription's own client and spend it somewhere else — the
 * definition of circumventing it. `spawn(cli)` is the honest interface: the CLI
 * authenticates itself, enforces its own limits, and the user's vendor sees the
 * traffic it expects. There is deliberately NO code path in this package that
 * opens a credentials file.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE COMMAND-EXECUTION LINE (rule 5 of the security model)
 *
 * The request names a CLI by ID from a hard-coded set. It carries no argv, no
 * flags, no shell string, no cwd and no environment. Every invocation is built
 * HERE, from a fixed shape:
 *
 *   - `spawn(bin, argvArray)` — NEVER `exec`, NEVER `shell: true`. With an argv
 *     array there is no word-splitting, so no prompt content can become a flag
 *     or a command separator.
 *   - The PROMPT goes on STDIN, never in argv. argv is world-readable in `ps`
 *     (leaking the user's code to every process on the machine) and is capped
 *     at ARG_MAX (~1 MiB on macOS) — a packed review context would simply fail
 *     to exec.
 *   - The SYSTEM prompt likewise avoids argv: `claude` takes it from a 0600
 *     temp file via `--system-prompt-file`; `codex exec` has no such flag, so
 *     it is framed into the stdin payload.
 *
 * THREE LAYERS, so each can be tested for what it actually owns:
 *   1. buildInvocation() — pure. The argv shape and the stdin payload.
 *   2. runProcess()      — process mechanics: stdin delivery, output cap,
 *                          timeout kill, exit codes, a missing binary.
 *   3. runInference()    — the glue: confinement, per-CLI result extraction,
 *                          usage, and the mapping onto BridgeErrorCodes.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INFERENCE_CLIS, type InferenceCli } from './capabilities.js'
import { PathEscapeError, resolveInRoot } from './confine.js'
import {
  DEFAULT_AGENTIC_INFER_TIMEOUT_MS,
  DEFAULT_INFER_TIMEOUT_MS,
  MAX_INFER_FILE_CONTEXT_BYTES,
  MAX_INFER_OUTPUT_BYTES,
  MAX_INFER_TIMEOUT_MS,
  isValidModelId,
  type BridgeErrorCode,
  type InferAgentic,
  type InferRequest,
  type InferUsage,
} from './protocol.js'

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface InferSuccess {
  ok: true
  text: string
  truncated: boolean
  durationMs: number
  usage?: InferUsage
  /** Present ONLY when the request asked for tools AND the CLI really got them. */
  agentic?: InferAgentic
}

export interface InferFailure {
  ok: false
  code: BridgeErrorCode
  /**
   * A message safe to hand a WEB ORIGIN. Never raw stderr — see
   * sanitizeDiagnostic, which strips absolute paths before anything from the
   * child process is quoted.
   */
  message: string
}

export type InferOutcome = InferSuccess | InferFailure

// ---------------------------------------------------------------------------
// Agentic (read-only tools) — the grant, verified against the real CLIs
// ---------------------------------------------------------------------------

/**
 * The ONLY tools `claude` is given when `InferRequest.agentic` is set.
 *
 * VERIFIED against claude 2.1.278 by running it (see bridge/README.md § Verified
 * agentic invocations). Asking the CLI to enumerate its own tools under the
 * exact argv below answers `Glob, Grep, Read` and nothing else — no Write, no
 * Edit, no Bash, no WebFetch, no MCP tool.
 *
 * WHY THESE THREE, AND WHY NO MORE. A reviewer needs to open a file, find a
 * file, and find a symbol. That is Read, Glob and Grep. Every other built-in
 * either writes (Write/Edit/NotebookEdit), executes (Bash), or leaves the
 * machine (WebFetch/WebSearch) — none of which a review needs, and all of which
 * the bridge's security model promises this route does not do.
 *
 * THIS LIST IS PINNED BY A TEST, and it has to be: an unrecognised name in
 * `--tools` is SILENTLY DROPPED, not an error (verified — `--tools
 * "Read,NotATool"` yields exactly `Read`). So a typo here would not fail the
 * build or the run; it would quietly hand the reviewer fewer tools and produce
 * a worse review that still called itself deep. The test is the only thing that
 * would notice.
 */
export const AGENTIC_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep'] as const

/**
 * The flags that make claude's agentic run read-only, BEYOND the tool list.
 * Each is defence in depth for a different failure, and all were checked by
 * running the CLI:
 *
 *   --restricted        Confines the file tools to the working directories and
 *                       ignores user/project/local settings files. This is a
 *                       HARD confinement rather than a permission decision, so
 *                       it holds even if the permission layer's default answer
 *                       ever changes. VERIFIED: an absolute path outside the
 *                       root is refused with "outside the restricted working
 *                       directory".
 *   --strict-mcp-config Ignores every MCP server the user has configured. A
 *                       review must not gain tools from the user's own machine
 *                       setup — `--safe-mode` already drops them, and this says
 *                       so a second time at the flag that owns the question.
 *
 * `--permission-prompts none` and `--safe-mode` are NOT here because the
 * tool-less invocation already carries them; they are shared, not agentic-only.
 * `--permission-prompts none` independently refuses an out-of-root read
 * (VERIFIED: denied, and recorded in `permission_denials`), which is why the
 * confinement holds on both layers rather than one.
 */
const AGENTIC_CLAUDE_FLAGS = ['--restricted', '--strict-mcp-config'] as const

/**
 * Grace between SIGTERM and SIGKILL. A CLI that catches SIGTERM gets a moment
 * to flush and exit; one that ignores it does not get to outlive the request.
 */
export const KILL_GRACE_MS = 2_000

/** Cap on the sanitized stderr excerpt quoted back to the caller. */
export const DIAGNOSTIC_MAX_CHARS = 240

// ---------------------------------------------------------------------------
// Layer 1 — the invocation shape (pure)
// ---------------------------------------------------------------------------

export interface Invocation {
  bin: string
  /** argv AFTER the binary. Contains flags and temp-file paths ONLY. */
  args: string[]
  /** Everything the CLI reads on stdin. */
  stdin: string
  /**
   * Written to `<tmpDir>/system.txt` before the spawn when set (0600). Only
   * `claude` uses it; `codex` folds the system text into `stdin` instead.
   */
  systemFile: string | null
  /**
   * `<tmpDir>/last-message.txt` when the CLI writes its final answer to a file
   * rather than stdout. Only `codex` uses it.
   */
  lastMessageFile: string | null
}

/**
 * The delimiter framing inlined file content and (for codex) the system text.
 * A long, unlikely-to-collide marker so nothing in a diff can forge a boundary.
 */
const BLOCK = '================ review123-bridge ================'

function frame(label: string, body: string): string {
  return `${BLOCK}\n${label}\n${BLOCK}\n${body}\n${BLOCK}\nEND ${label}\n${BLOCK}\n`
}

/**
 * Build the stdin payload: optional inlined file context, then the prompt.
 * `system` is folded in ONLY for CLIs with no system-prompt flag.
 */
export function buildStdin(opts: {
  prompt: string
  system?: string | undefined
  fileContext?: string | undefined
  foldSystemIntoStdin: boolean
}): string {
  const parts: string[] = []
  if (opts.foldSystemIntoStdin && opts.system) {
    parts.push(frame('SYSTEM INSTRUCTIONS', opts.system))
  }
  if (opts.fileContext) parts.push(opts.fileContext)
  parts.push(opts.prompt)
  return parts.join('\n')
}

/**
 * The minimal system prompt used when a caller supplies none.
 *
 * We ALWAYS replace the CLI's default system prompt rather than inherit it: the
 * default describes a coding agent with a toolbelt, and this invocation has no
 * tools at all. Inheriting it would prepend thousands of tokens of instructions
 * about capabilities the process does not have — measurably worse answers, and
 * (on `claude`) a far larger cache-creation bill on the user's subscription.
 */
export const NEUTRAL_SYSTEM_PROMPT =
  'You are a precise assistant. Answer the request directly, with no preamble and no sign-off.'

/**
 * VERIFIED against the real CLIs (see bridge/README.md § Verified invocations).
 *
 * claude 2.1.278:
 *   `claude -p --output-format json --tools "" --permission-prompts none
 *    --safe-mode --system-prompt-file <f>` with the prompt on stdin, printing
 *   one JSON document with `result`, `is_error`, `subtype` and `usage`.
 *
 *   - `--tools ""` disables EVERY built-in tool. This is the load-bearing
 *     safety flag: the bridge promises it does not write to the repo, and a
 *     tool-less `claude` physically cannot. It also makes the call a plain
 *     completion, which is all review123 wants for an ORDINARY call.
 *
 *     `InferRequest.agentic` is the ONE request that changes this, and it
 *     changes it narrowly: `--tools ""` becomes `--tools Read,Glob,Grep` plus
 *     `--restricted --strict-mcp-config`. See AGENTIC_CLAUDE_TOOLS. Note what
 *     this says about the old rationale for refusing agentic review over the
 *     bridge — "the CLI is already an agent" — which was never the reason it
 *     did not work. WE took its tools away, right here, on this line. Giving
 *     three read-only ones back is the whole feature.
 *   - `--permission-prompts none` denies anything that would prompt, instead of
 *     blocking forever on a terminal nobody is watching.
 *   - `--safe-mode` drops CLAUDE.md, hooks, plugins, MCP servers and custom
 *     agents. Without it the user's OWN repo instructions would silently
 *     contaminate review123's prompts. Auth is explicitly unaffected by it —
 *     which is why this is the right flag and `--bare` is the wrong one:
 *     `--bare` forces ANTHROPIC_API_KEY and never reads the subscription, i.e.
 *     it defeats the entire purpose of the bridge.
 *
 * STREAMING (`stream: true`, for `/v1/infer/stream`) changes ONE thing on
 * claude's argv: `--output-format json` becomes
 * `--output-format stream-json --include-partial-messages --verbose`.
 *
 *   - VERIFIED by running claude 2.1.278: `--output-format stream-json`
 *     without `--verbose` exits with "When using --print,
 *     --output-format=stream-json requires --verbose", so `--verbose` is not
 *     optional — it is part of the streaming invocation.
 *   - `--include-partial-messages` is what turns a per-MESSAGE event log into
 *     a per-TOKEN one: without it the only assistant event is the finished
 *     message, which is the non-streaming behaviour with extra steps.
 *   - The final line is still a `{"type":"result", ...}` document with the
 *     same `result` / `is_error` / `subtype` / `usage` fields `--output-format
 *     json` prints, so readClaudeResult reads it unchanged.
 *   - Every safety flag is IDENTICAL. Streaming changes how the answer is
 *     delivered, never what the child is allowed to do.
 *
 * codex-cli 0.155.1:
 *   `codex exec --sandbox read-only --skip-git-repo-check --color never
 *    --ephemeral --output-last-message <f> -` with the prompt on stdin.
 *
 *   - trailing `-` makes it read instructions from stdin.
 *   - `--output-last-message <f>` is why we do not parse its event log: stdout
 *     is a human-readable transcript, but the final assistant message lands in
 *     this file, alone and clean.
 *   - `--sandbox read-only` is the safety flag: codex has no way to disable its
 *     tools, so instead it is confined to reading. It cannot modify the repo,
 *     and cannot read outside the served root (both VERIFIED by running it).
 *
 *     CONSEQUENCE WORTH STATING PLAINLY: codex has ALWAYS been agentic here. It
 *     has a shell it can read the tree with, in every call this bridge has ever
 *     made. `InferRequest.agentic` therefore adds no power to codex — it adds
 *     `--json`, purely so the answer can say whether it investigated.
 *   - `--ephemeral` keeps review123's prompts out of the user's session history.
 */
/**
 * `['--model', '<id>']`, or NOTHING when the request named no model.
 *
 * The empty case is the contract: a request without `model` must produce the
 * byte-identical argv it produced before this flag existed, so every existing
 * client keeps getting its CLI's own configured default.
 *
 * VERIFIED against the real CLIs (see bridge/README.md § Verified invocations):
 *   - claude 2.1.278 — `--model <model>`: "Provide an alias for the latest
 *     model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g.
 *     'claude-fable-5')".
 *   - codex-cli — `codex exec -m, --model <MODEL>`: "Model the agent should
 *     use". The long form is used here so both branches read the same.
 *
 * Neither CLI publishes a stable enumeration of accepted values, so the id is
 * passed through and the CLI is left to reject a bad one — with its own error,
 * which is more useful than a stale allowlist here. `parseInferRequest` has
 * already established the id cannot masquerade as a flag.
 */
function modelArgs(req: InferRequest): string[] {
  return req.model === undefined ? [] : ['--model', req.model]
}

export function buildInvocation(
  cli: InferenceCli,
  req: InferRequest,
  tmpDir: string,
  fileContext?: string,
  opts?: { stream?: boolean },
): Invocation {
  const system = req.system?.trim() ? req.system : NEUTRAL_SYSTEM_PROMPT

  const agentic = req.agentic === true

  if (cli === 'claude') {
    const systemFile = join(tmpDir, 'system.txt')
    // The ONLY difference between the one-shot and the streaming invocation.
    // Everything after it — every safety flag — is shared, so streaming can
    // never widen what the child may do.
    const outputFormat = opts?.stream === true
      ? ['--output-format', 'stream-json', '--include-partial-messages', '--verbose']
      : ['--output-format', 'json']
    // The tool grant, and the ONLY place the two modes differ. Tool-less mode is
    // byte-identical to what it has always been; agentic mode swaps the empty
    // `--tools ""` for the pinned read-only list and adds the confinement flags.
    const toolArgs = agentic
      ? ['--tools', AGENTIC_CLAUDE_TOOLS.join(','), ...AGENTIC_CLAUDE_FLAGS]
      : ['--tools', '']
    return {
      bin: 'claude',
      args: [
        '-p',
        ...outputFormat,
        ...modelArgs(req),
        ...toolArgs,
        '--permission-prompts',
        'none',
        '--safe-mode',
        '--system-prompt-file',
        systemFile,
      ],
      stdin: buildStdin({ prompt: req.prompt, fileContext, foldSystemIntoStdin: false }),
      systemFile,
      lastMessageFile: null,
    }
  }

  const lastMessageFile = join(tmpDir, 'last-message.txt')
  return {
    bin: 'codex',
    args: [
      'exec',
      ...modelArgs(req),
      // `--json` is added ONLY for an agentic run, and only to COUNT tool use.
      //
      // codex needs no argv change to become agentic: `--sandbox read-only`
      // already gives it a shell it can read the tree with, and always has —
      // VERIFIED by running the existing tool-less invocation, which happily ran
      // `sed -n '1,120p' canary.ts` and reported the contents. So there is
      // nothing to switch ON here; the only gap was that its answer arrived with
      // no way to say whether it had investigated at all.
      //
      // `--json` closes that: stdout becomes NDJSON carrying
      // `{"type":"item.completed","item":{"type":"command_execution",…}}` per
      // command. The ANSWER still comes from --output-last-message exactly as
      // before (VERIFIED: the file is written identically with --json), so this
      // changes what we can OBSERVE and nothing about what codex does.
      ...(agentic ? ['--json'] : []),
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--ephemeral',
      '--output-last-message',
      lastMessageFile,
      '-',
    ],
    stdin: buildStdin({ prompt: req.prompt, system, fileContext, foldSystemIntoStdin: true }),
    systemFile: null,
    lastMessageFile,
  }
}

/**
 * Which CLIs actually produce INCREMENTAL output, verified by running them.
 *
 *   claude 2.1.278 — YES. `--output-format stream-json
 *     --include-partial-messages --verbose` emits one
 *     `content_block_delta` / `text_delta` NDJSON line per chunk as the model
 *     writes, then the usual `{"type":"result"}` document.
 *
 *   codex-cli 0.155.1 — NO. `codex exec --json` emits NDJSON too, but the
 *     assistant text arrives in exactly one `{"type":"item.completed",
 *     "item":{"type":"agent_message","text":"…"}}` line containing the whole
 *     finished message. There is no partial-message flag on `codex exec`.
 *
 * So `/v1/infer/stream` runs codex through the ORDINARY one-shot path and says
 * `streaming: false` in its `start` event. It does NOT chop the finished text
 * into timed fragments: a fake typewriter would make the bridge's own
 * capability report a lie, and would tell the user their codex subscription is
 * doing something it is not.
 */
export const CLI_STREAMS: Record<InferenceCli, boolean> = {
  claude: true,
  codex: false,
}

// ---------------------------------------------------------------------------
// Layer 2 — process mechanics
// ---------------------------------------------------------------------------

export interface ProcessResult {
  /** null when the process was killed by a signal rather than exiting. */
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** stdout hit MAX_INFER_OUTPUT_BYTES and the child was killed. */
  truncated: boolean
  /** The per-call budget expired and the child was killed. */
  timedOut: boolean
  /** The binary could not be executed at all (ENOENT and friends). */
  spawnFailed: boolean
  /**
   * The CALLER went away (`options.signal` fired) and the child was killed.
   *
   * Optional because every pre-existing caller passes no signal and can never
   * see it. It exists for `/v1/infer/stream`, where the browser closing the
   * socket must reach the subprocess: a request that ends with a CLI still
   * running would keep spending the user's subscription on an answer nobody
   * will ever read.
   */
  aborted?: boolean
  /** The child's pid, when it was spawned at all. Used to prove it was reaped. */
  pid?: number | undefined
}

export type SpawnFn = typeof nodeSpawn

export interface RunProcessOptions {
  bin: string
  args: readonly string[]
  stdin: string
  cwd: string
  timeoutMs: number
  maxOutputBytes?: number
  spawn?: SpawnFn
  /**
   * Fires when the CALLER gave up. The child is killed on the same
   * SIGTERM-then-SIGKILL ladder the timeout uses — a cancelled request must
   * not leave a CLI running on the user's subscription.
   */
  signal?: AbortSignal
}

export type RunProcess = (opts: RunProcessOptions) => Promise<ProcessResult>

/**
 * Spawn a child, feed it stdin, and collect a CAPPED stdout/stderr under a hard
 * wall-clock budget.
 *
 * Deliberate choices:
 * - `shell: false` (the default, stated anyway). With a shell, any `;`, `$(` or
 *   backtick reaching argv would be executed.
 * - `windowsHide: true` so a bridge on Windows does not flash console windows.
 * - Output is capped WHILE streaming. Buffering an unbounded subprocess and
 *   measuring afterwards is how a local server gets OOM-killed; the same rule
 *   server.ts applies to request bodies.
 * - Over the cap we KILL rather than keep draining: we already have more text
 *   than we can return, and a runaway CLI should not keep spending the user's
 *   subscription to produce output nobody will read.
 * - stdin write errors are SWALLOWED. A child that exits before reading its
 *   input gives us EPIPE, and the real diagnosis is its exit code and stderr,
 *   not the broken pipe.
 */
export async function runProcess(opts: RunProcessOptions): Promise<ProcessResult> {
  const spawn = opts.spawn ?? nodeSpawn
  const maxBytes = opts.maxOutputBytes ?? MAX_INFER_OUTPUT_BYTES

  return new Promise<ProcessResult>((resolve) => {
    let stdout = ''
    let stdoutBytes = 0
    let stderr = ''
    let truncated = false
    let timedOut = false
    let spawnFailed = false
    let aborted = false
    let settled = false
    let killTimer: NodeJS.Timeout | null = null

    const child = spawn(opts.bin, [...opts.args], {
      cwd: opts.cwd,
      // The CLI needs the user's environment to find its own config and to
      // authenticate as the subscription holder. NO_COLOR keeps ANSI escapes
      // out of anything we parse.
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(budgetTimer)
      if (killTimer) clearTimeout(killTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        code: exitCode,
        signal: exitSignal,
        stdout,
        stderr,
        truncated,
        timedOut,
        spawnFailed,
        aborted,
        pid: child.pid,
      })
    }

    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null

    /** SIGTERM, then SIGKILL if it is still alive after the grace period. */
    const terminate = (): void => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      // Never hold the event loop open just to escalate a kill.
      killTimer.unref?.()
    }

    const budgetTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, opts.timeoutMs)

    /**
     * The caller gave up. We do NOT resolve here: we kill and wait for
     * 'close', so the promise settles only once the child is actually reaped.
     * Resolving early would hand the caller a "done" while a CLI was still
     * running — precisely the orphan this exists to prevent.
     */
    function onAbort(): void {
      aborted = true
      terminate()
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (truncated) return
      const bytes = Buffer.byteLength(chunk, 'utf8')
      if (stdoutBytes + bytes > maxBytes) {
        stdout += chunk
        truncated = true
        terminate()
        return
      }
      stdoutBytes += bytes
      stdout += chunk
    })

    // stderr is diagnostics only and never returned raw, so it gets a small
    // fixed budget rather than the output cap.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk
    })

    child.on('error', () => {
      // ENOENT (binary missing), EACCES (not executable), EAGAIN (fork limit).
      spawnFailed = true
      finish()
    })

    child.on('close', (code, signal) => {
      exitCode = code
      exitSignal = signal
      finish()
    })

    child.stdin?.on('error', () => {
      /* EPIPE — the child exited before reading stdin. See the header. */
    })
    child.stdin?.end(opts.stdin)
  })
}

// ---------------------------------------------------------------------------
// Diagnostics that are safe to send to a web origin
// ---------------------------------------------------------------------------

/**
 * Strip absolute paths out of child-process output before it crosses back to
 * the browser.
 *
 * `/v1/health` goes to the trouble of sending the repo BASENAME only, so it
 * would be absurd to hand the same origin `/Users/you/clients/acme/...` in an
 * error message. CLI errors are full of absolute paths (config files, node
 * module stacks, the cwd), so every POSIX path and Windows drive path is
 * replaced wholesale — a denylist of "sensitive" prefixes would leak the first
 * path nobody thought of.
 */
export function sanitizeDiagnostic(raw: string): string {
  const collapsed = raw
    // POSIX absolute paths, including ~-relative ones.
    .replace(/(?:~|\/)[\w.\-+@]*(?:\/[\w.\-+@ ]+)+\/?/g, '<path>')
    // Windows drive + UNC paths.
    .replace(/[A-Za-z]:\\[^\s"']*/g, '<path>')
    .replace(/\\\\[^\s"']+/g, '<path>')
    // Control characters (ANSI escapes survive NO_COLOR in some tools).
    .replace(/[ --]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return collapsed.length > DIAGNOSTIC_MAX_CHARS
    ? `${collapsed.slice(0, DIAGNOSTIC_MAX_CHARS)}…`
    : collapsed
}

/** `<generic sentence>` plus a sanitized excerpt, when there is one. */
function withDiagnostic(lead: string, stderr: string): string {
  const detail = sanitizeDiagnostic(stderr)
  return detail ? `${lead} (${detail})` : lead
}

// ---------------------------------------------------------------------------
// Per-CLI result extraction
// ---------------------------------------------------------------------------

/** The subset of `claude -p --output-format json` this module relies on. */
interface ClaudeResultDoc {
  result?: unknown
  is_error?: unknown
  subtype?: unknown
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
  /**
   * Assistant turns. 1 = answered without calling a tool; each further turn
   * followed at least one tool call. See InferAgentic.toolCallsAtLeast for why
   * this is reported as a lower bound and not as a call count.
   */
  num_turns?: unknown
  /** Tool calls claude's own permission layer refused. See InferAgentic.denied. */
  permission_denials?: unknown
}

/**
 * Build the agentic report from claude's result document.
 *
 * SEPARATE FROM readClaudeResult on purpose: that function reads the ANSWER, and
 * every caller of it — agentic or not, streaming or not — wants exactly the
 * answer. Folding the report into its return value would make a tool-less run
 * carry a tool report, which is the one thing this field must never do. Two
 * functions, one concern each, as the rest of this module is arranged.
 *
 * Every field is derived from something the CLI actually stated; anything it did
 * not state is left ABSENT rather than defaulted, because a zero here would read
 * as "it used no tools" — a claim, not a gap.
 *
 * Returns the report with `tools` alone when stdout is unreadable: the tools WERE
 * granted (that is a fact about the argv we built, not about the answer), we
 * simply cannot say what was done with them.
 */
export function readClaudeAgentic(stdout: string): InferAgentic {
  const report: InferAgentic = { tools: [...AGENTIC_CLAUDE_TOOLS] }
  let doc: ClaudeResultDoc
  try {
    doc = JSON.parse(stdout.trim()) as ClaudeResultDoc
  } catch {
    return report
  }
  const turns = doc.num_turns
  if (typeof turns === 'number' && Number.isFinite(turns) && turns >= 1) {
    // Turns AFTER the first. The first turn is the answer itself; every turn
    // beyond it exists because the previous one called a tool.
    report.toolCallsAtLeast = Math.max(0, Math.trunc(turns) - 1)
  }
  if (Array.isArray(doc.permission_denials)) report.denied = doc.permission_denials.length
  return report
}

/**
 * Count codex's tool use from its `--json` event stream.
 *
 * One `{"type":"item.completed","item":{"type":"command_execution"}}` per shell
 * command it ran. Unparseable lines are skipped rather than failing the count —
 * stdout is also where codex writes its banner, and a stricter reader would turn
 * a cosmetic change into a failed review.
 *
 * Returns null when the stream contained no countable events at all, which is
 * how "unreported" stays distinct from "ran no commands".
 */
export function countCodexCommands(stdout: string): number | null {
  let commands = 0
  let sawEvent = false
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.startsWith('{')) continue
    let doc: { type?: unknown; item?: { type?: unknown } }
    try {
      doc = JSON.parse(trimmed) as { type?: unknown; item?: { type?: unknown } }
    } catch {
      continue
    }
    if (typeof doc.type !== 'string') continue
    sawEvent = true
    if (doc.type === 'item.completed' && doc.item?.type === 'command_execution') commands++
  }
  return sawEvent ? commands : null
}

/**
 * Pull the answer out of `claude`'s JSON result document.
 *
 * Returns null when the document is not parseable — which, on a truncated run,
 * it will not be, and the caller reports that honestly rather than inventing a
 * partial answer.
 */
export function readClaudeResult(
  stdout: string,
): { text: string; usage?: InferUsage } | { error: string } | null {
  let doc: ClaudeResultDoc
  try {
    doc = JSON.parse(stdout.trim()) as ClaudeResultDoc
  } catch {
    return null
  }
  if (doc.is_error === true || (typeof doc.subtype === 'string' && doc.subtype !== 'success')) {
    return { error: typeof doc.result === 'string' ? doc.result : String(doc.subtype ?? 'error') }
  }
  if (typeof doc.result !== 'string') return null

  const input = doc.usage?.input_tokens
  const output = doc.usage?.output_tokens
  const usage =
    typeof input === 'number' && typeof output === 'number'
      ? { inputTokens: input, outputTokens: output }
      : undefined
  return usage ? { text: doc.result, usage } : { text: doc.result }
}

// ---------------------------------------------------------------------------
// File context
// ---------------------------------------------------------------------------

/**
 * Read `req.files` into one framed context block.
 *
 * Every path goes through confine.ts — the same realpath-based check the rest
 * of the bridge uses, so `../`, absolute paths and symlinks out of the repo are
 * all refused with `forbidden-path`. A MISSING file is skipped, not an error
 * (the contract says so: a caller asking about a file that was deleted should
 * get an answer, not a 404).
 */
export async function buildFileContext(
  realRoot: string,
  paths: readonly string[],
): Promise<{ ok: true; context: string } | InferFailure> {
  const blocks: string[] = []
  let budget = MAX_INFER_FILE_CONTEXT_BYTES

  for (const requested of paths) {
    let resolved: string
    try {
      resolved = await resolveInRoot(realRoot, requested)
    } catch (err) {
      if (err instanceof PathEscapeError) {
        // The requested path is the CALLER's own string, so echoing it leaks
        // nothing the caller did not already send.
        return { ok: false, code: 'forbidden-path', message: `Path is outside the repo: ${requested}` }
      }
      return { ok: false, code: 'bad-request', message: `Could not resolve path: ${requested}` }
    }

    if (budget <= 0) break
    let content: string
    try {
      const st = await stat(resolved)
      if (!st.isFile()) continue
      content = await readFile(resolved, 'utf8')
    } catch {
      continue // missing / unreadable — not an error, per the contract
    }
    const slice = content.length > budget ? content.slice(0, budget) : content
    budget -= Buffer.byteLength(slice, 'utf8')
    blocks.push(frame(`FILE ${requested}`, slice))
  }

  return { ok: true, context: blocks.join('\n') }
}

// ---------------------------------------------------------------------------
// Layer 3 — the route's worker
// ---------------------------------------------------------------------------

export interface RunInferenceOptions {
  realRoot: string
  /** CLIs detected on PATH. A request naming anything else is refused. */
  availableClis: readonly string[]
  /** Injected in tests. Defaults to the real subprocess runner. */
  run?: RunProcess
  /** Injected in tests so no temp directory is created. */
  now?: () => number
  /**
   * Fires when the caller gave up, and is forwarded to the child so it dies
   * with the request. `/v1/infer/stream`'s codex path passes the browser's
   * disconnect through here; `/v1/infer` passes nothing and behaves exactly
   * as it did.
   *
   * An aborted run's OUTCOME is deliberately not special-cased into a new
   * error code: the caller that aborted is the one who knows it aborted, and
   * it is responsible for discarding whatever comes back rather than
   * reporting it as a CLI failure.
   */
  signal?: AbortSignal
}

/**
 * Clamp a requested budget into the range the bridge will actually honour.
 *
 * `agentic` moves only the DEFAULT — what an unspecified budget means — because
 * an agentic run is several model turns plus file reads where a tool-less one is
 * a single turn. The CEILING is untouched: a caller may still ask for less, and
 * still cannot ask for more than MAX_INFER_TIMEOUT_MS.
 */
export function clampTimeout(requested: number | undefined, agentic = false): number {
  const fallback = agentic ? DEFAULT_AGENTIC_INFER_TIMEOUT_MS : DEFAULT_INFER_TIMEOUT_MS
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return fallback
  }
  return Math.min(Math.trunc(requested), MAX_INFER_TIMEOUT_MS)
}

/**
 * Validate an untrusted `/v1/infer` body.
 *
 * `cli` is checked against the hard-coded INFERENCE_CLIS set, NOT against the
 * detected list — an undetected-but-known CLI is `cli-unavailable` (a fixable
 * situation the user can act on), while an unknown id is `bad-request`.
 */
export function parseInferRequest(body: unknown): InferRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'Body must be a JSON object.' }
  const raw = body as Record<string, unknown>

  const cli = raw['cli']
  if (typeof cli !== 'string' || !(INFERENCE_CLIS as readonly string[]).includes(cli)) {
    return { error: `Unknown cli. Expected one of: ${INFERENCE_CLIS.join(', ')}.` }
  }
  const prompt = raw['prompt']
  if (typeof prompt !== 'string' || prompt === '') return { error: 'prompt must be a non-empty string.' }

  // The model id is the only caller-supplied string that reaches argv, so it is
  // validated HERE rather than trusted at the spawn — see MODEL_ID_PATTERN.
  const model = raw['model']
  if (model !== undefined) {
    if (typeof model !== 'string') return { error: 'model must be a string.' }
    if (!isValidModelId(model)) {
      return { error: 'model must be a plain model id (letters, digits and . _ : / -), not starting with "-".' }
    }
  }

  const system = raw['system']
  if (system !== undefined && typeof system !== 'string') return { error: 'system must be a string.' }

  const files = raw['files']
  if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))) {
    return { error: 'files must be an array of strings.' }
  }

  const maxOutputTokens = raw['maxOutputTokens']
  if (maxOutputTokens !== undefined && typeof maxOutputTokens !== 'number') {
    return { error: 'maxOutputTokens must be a number.' }
  }
  const timeoutMs = raw['timeoutMs']
  if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
    return { error: 'timeoutMs must be a number.' }
  }

  // Strictly boolean. A truthy string like "false" must NOT turn on the tools:
  // this is the field that decides whether a subprocess may read the user's
  // disk, so it is the last field that should be lenient about its type.
  const agentic = raw['agentic']
  if (agentic !== undefined && typeof agentic !== 'boolean') {
    return { error: 'agentic must be a boolean.' }
  }

  const parsed: InferRequest = { cli: cli as InferenceCli, prompt }
  if (typeof model === 'string') parsed.model = model
  if (typeof system === 'string') parsed.system = system
  if (Array.isArray(files)) parsed.files = files as string[]
  if (typeof maxOutputTokens === 'number') parsed.maxOutputTokens = maxOutputTokens
  if (typeof timeoutMs === 'number') parsed.timeoutMs = timeoutMs
  // Only ever set to literal true, so `agentic: false` is indistinguishable from
  // absent everywhere downstream — one tool-less path, not two.
  if (agentic === true) parsed.agentic = true
  return parsed
}

/**
 * Run one inference. Never throws — every outcome is an InferOutcome, because
 * an escaping exception in the HTTP layer becomes the generic 500 (which is
 * right for safety, but useless for the user).
 */
export async function runInference(
  req: InferRequest,
  opts: RunInferenceOptions,
): Promise<InferOutcome> {
  if (!opts.availableClis.includes(req.cli)) {
    return {
      ok: false,
      code: 'cli-unavailable',
      message: `The ${req.cli} CLI is not on this machine's PATH. Install it, then restart the bridge.`,
    }
  }

  const now = opts.now ?? Date.now
  const started = now()

  let fileContext: string | undefined
  if (req.files && req.files.length > 0) {
    const built = await buildFileContext(opts.realRoot, req.files)
    if (!built.ok) return built
    fileContext = built.context || undefined
  }

  // 0700 so no other user on a shared machine can read the system prompt.
  const tmpDir = await mkdtemp(join(tmpdir(), 'review123-bridge-'))
  try {
    const invocation = buildInvocation(req.cli as InferenceCli, req, tmpDir, fileContext)
    if (invocation.systemFile !== null) {
      const system = req.system?.trim() ? req.system : NEUTRAL_SYSTEM_PROMPT
      await writeFile(invocation.systemFile, system, { mode: 0o600 })
    }

    const run = opts.run ?? runProcess
    const result = await run({
      bin: invocation.bin,
      args: invocation.args,
      stdin: invocation.stdin,
      cwd: opts.realRoot,
      timeoutMs: clampTimeout(req.timeoutMs, req.agentic === true),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    const durationMs = now() - started

    if (result.spawnFailed) {
      return {
        ok: false,
        code: 'cli-unavailable',
        message: `The ${req.cli} CLI could not be started on this machine.`,
      }
    }
    if (result.timedOut) {
      return {
        ok: false,
        code: 'timeout',
        message: `The ${req.cli} CLI did not finish within the ${clampTimeout(req.timeoutMs, req.agentic === true)} ms budget and was stopped.`,
      }
    }
    if (result.code !== 0) {
      return {
        ok: false,
        code: 'cli-failed',
        message: withDiagnostic(
          `The ${req.cli} CLI exited with code ${result.code ?? 'unknown'}.`,
          result.stderr,
        ),
      }
    }

    return extractOutcome(req.cli as InferenceCli, invocation, result, durationMs, req.agentic === true)
  } catch {
    // A temp-file or filesystem failure. The message is deliberately generic:
    // the real one would name an absolute path.
    return { ok: false, code: 'cli-failed', message: 'The bridge could not run the CLI.' }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Turn a successful process run into the route's answer, per CLI. */
async function extractOutcome(
  cli: InferenceCli,
  invocation: Invocation,
  result: ProcessResult,
  durationMs: number,
  agentic: boolean,
): Promise<InferOutcome> {
  if (cli === 'claude') {
    const parsed = readClaudeResult(result.stdout)
    if (parsed === null) {
      return {
        ok: false,
        code: 'cli-failed',
        message: result.truncated
          ? 'The claude CLI produced more output than the bridge will buffer, so its JSON result could not be read.'
          : withDiagnostic('The claude CLI did not return a readable JSON result.', result.stderr),
      }
    }
    if ('error' in parsed) {
      return {
        ok: false,
        code: 'cli-failed',
        message: withDiagnostic(`The claude CLI reported an error: ${sanitizeDiagnostic(parsed.error)}`, ''),
      }
    }
    const base: InferSuccess = { ok: true, text: parsed.text, truncated: result.truncated, durationMs }
    if (parsed.usage) base.usage = parsed.usage
    // Reported ONLY when this run actually asked for tools. The turn count is
    // present on every claude result document, agentic or not, and echoing it
    // back on a tool-less run would advertise a grounding that never happened.
    if (agentic) base.agentic = readClaudeAgentic(result.stdout)
    return base
  }

  // codex: the final assistant message goes to --output-last-message, so stdout
  // (a human transcript, or NDJSON under --json) is never returned. An
  // unreadable file means the run produced no final message.
  let text: string
  try {
    text = await readFile(invocation.lastMessageFile!, 'utf8')
  } catch {
    return {
      ok: false,
      code: 'cli-failed',
      message: withDiagnostic('The codex CLI finished without producing a final message.', result.stderr),
    }
  }
  const codex: InferSuccess = { ok: true, text: text.trim(), truncated: result.truncated, durationMs }
  if (agentic) {
    // `tools` is EMPTY for codex and that is the honest answer, not an omission:
    // its toolset cannot be enumerated or narrowed. See InferAgentic.tools.
    const report: InferAgentic = { tools: [] }
    const commands = countCodexCommands(result.stdout)
    if (commands !== null) report.toolCallsAtLeast = commands
    codex.agentic = report
  }
  return codex
}

/** HTTP status for each failure the route can produce. */
export function statusForInferError(code: BridgeErrorCode): number {
  switch (code) {
    case 'bad-request':
      return 400
    case 'forbidden-path':
      return 403
    case 'cli-unavailable':
      return 503
    case 'timeout':
      return 504
    default:
      return 502
  }
}
