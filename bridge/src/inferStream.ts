/**
 * inferStream.ts — `/v1/infer/stream`: the same inference as `/v1/infer`,
 * delivered as the model produces it.
 *
 * WHY THIS IS A SECOND ROUTE AND NOT A FLAG. `/v1/infer` is a request/response
 * pair: one body in, one body out, the handler stays a pure function, and the
 * child process lives entirely inside one `await`. Streaming breaks all three.
 * The response is written incrementally (so the status line is committed
 * before the CLI has produced a byte), the caller can vanish halfway through
 * (so the child needs a kill path that does not exist on the one-shot route),
 * and a failure after the first byte can no longer be an HTTP status. Those
 * are different contracts, so they are different routes — and the one-shot
 * route is untouched by this file.
 *
 * WHAT IS SHARED, DELIBERATELY:
 *   - the argv (infer.ts's buildInvocation, with `stream: true` changing
 *     exactly one flag pair on claude and nothing else);
 *   - every safety flag, the stdin delivery, the 0600 system-prompt file and
 *     the repo confinement of `files`;
 *   - the result extraction (readClaudeResult reads the final `{"type":
 *     "result"}` line, which is the same document `--output-format json`
 *     prints);
 *   - the gate ladder in handler.ts, reached through checkGates — this route
 *     forks NOTHING about auth, CORS, the Host guard or the body cap.
 *
 * THREE LAYERS, as infer.ts has, so each is tested for what it owns:
 *   1. parseClaudeStreamLine() — pure. One NDJSON line → a delta, the final
 *                                result document, or nothing.
 *   2. runStreamProcess()      — process mechanics: line framing, the caller's
 *                                abort reaching the child, timeout kill, caps.
 *   3. runStreamInference()    — the glue: confinement, per-CLI streaming
 *                                capability, and the event sequence.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InferenceCli } from './capabilities.js'
import {
  buildFileContext,
  buildInvocation,
  clampTimeout,
  CLI_STREAMS,
  KILL_GRACE_MS,
  NEUTRAL_SYSTEM_PROMPT,
  readClaudeResult,
  runInference,
  sanitizeDiagnostic,
  type RunProcess,
  type SpawnFn,
} from './infer.js'
import {
  MAX_INFER_OUTPUT_BYTES,
  MAX_INFER_STREAM_LINE_BYTES,
  type BridgeErrorCode,
  type InferRequest,
  type InferStreamEvent,
} from './protocol.js'

// ---------------------------------------------------------------------------
// Layer 1 — one NDJSON line from `claude --output-format stream-json` (pure)
// ---------------------------------------------------------------------------

/**
 * What one line of claude's stream-json output means to us.
 *
 * `null` for everything else, and "everything else" is most of it: the session
 * init banner, status pings, tool events, rate-limit notices, `message_start`,
 * `content_block_stop`. A CLI is free to add event types within a version, so
 * an unrecognised line is skipped, never an error.
 */
export type ClaudeStreamLine =
  | { kind: 'delta'; text: string }
  /** The final `{"type":"result"}` document, VERBATIM, for readClaudeResult. */
  | { kind: 'result'; raw: string }

/**
 * Parse one line of `claude -p --output-format stream-json
 * --include-partial-messages`.
 *
 * VERIFIED against claude 2.1.278 (see bridge/README.md § Verified streaming
 * invocations). The two shapes that matter:
 *
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *    "delta":{"type":"text_delta","text":"…"}}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"…",
 *    "usage":{…}}
 *
 * ONLY `text_delta` becomes a delta. A `thinking_delta` is the model's private
 * reasoning, not its answer: streaming it would put text in the user's summary
 * panel that the final result does not contain, and `result` would then appear
 * to "lose" content at the end.
 */
export function parseClaudeStreamLine(line: string): ClaudeStreamLine | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let doc: unknown
  try {
    doc = JSON.parse(trimmed)
  } catch {
    // Not JSON at all. `claude` prints warnings and update notices on stdout
    // in some configurations; they are diagnostics, not answers.
    return null
  }
  if (typeof doc !== 'object' || doc === null) return null
  const top = doc as Record<string, unknown>

  if (top['type'] === 'result') return { kind: 'result', raw: trimmed }

  if (top['type'] !== 'stream_event') return null
  const event = top['event']
  if (typeof event !== 'object' || event === null) return null
  const ev = event as Record<string, unknown>
  if (ev['type'] !== 'content_block_delta') return null
  const delta = ev['delta']
  if (typeof delta !== 'object' || delta === null) return null
  const d = delta as Record<string, unknown>
  if (d['type'] !== 'text_delta') return null
  if (typeof d['text'] !== 'string' || d['text'] === '') return null
  return { kind: 'delta', text: d['text'] }
}

// ---------------------------------------------------------------------------
// Layer 2 — process mechanics for a LINE-ORIENTED child
// ---------------------------------------------------------------------------

export interface StreamProcessResult {
  /** null when the process was killed by a signal rather than exiting. */
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  /** A cap was hit (the answer, or one absurd line) and the child was killed. */
  truncated: boolean
  /** The per-call budget expired and the child was killed. */
  timedOut: boolean
  /** The binary could not be executed at all (ENOENT and friends). */
  spawnFailed: boolean
  /** `options.signal` fired — the CALLER went away — and the child was killed. */
  aborted: boolean
  /** The child's pid, when one was assigned. Lets a caller prove it was reaped. */
  pid: number | undefined
}

export interface RunStreamProcessOptions {
  bin: string
  args: readonly string[]
  stdin: string
  cwd: string
  timeoutMs: number
  /**
   * One COMPLETE line of stdout, newline stripped. Return false to stop
   * reading: the child is killed and the result is reported `truncated`. That
   * is how the answer-size cap is enforced from the layer that can actually
   * measure the answer (this one only sees framing).
   */
  onLine: (line: string) => boolean
  /** The caller gave up. Kills the child on the SIGTERM→SIGKILL ladder. */
  signal?: AbortSignal
  spawn?: SpawnFn
}

export type RunStreamProcess = (opts: RunStreamProcessOptions) => Promise<StreamProcessResult>

/**
 * Spawn a child and hand its stdout to `onLine`, line by line, as it arrives.
 *
 * The same process discipline as infer.ts's runProcess — `shell: false`, argv
 * array, prompt on stdin, `windowsHide`, SIGTERM then SIGKILL after a grace
 * period, stderr on a small fixed budget — with three differences that only
 * matter when output is streamed:
 *
 *  1. STDOUT IS NEVER ACCUMULATED. Only the current partial line is held, so
 *     a long answer costs a line's worth of memory instead of the whole
 *     transcript. The answer's own cap is enforced by `onLine`'s return value.
 *  2. AN UNTERMINATED LINE IS CAPPED. A child that writes without ever
 *     emitting `\n` would otherwise grow the buffer without bound;
 *     MAX_INFER_STREAM_LINE_BYTES stops it, reported as truncation.
 *  3. THE PROMISE SETTLES ON 'close', ALWAYS — including on abort. 'close'
 *     fires after the process has exited AND its stdio has closed, i.e. after
 *     the child is reaped. Resolving on the abort event instead would report
 *     "finished" while a CLI was still running and still spending the user's
 *     subscription. That is the whole point of this function.
 */
export async function runStreamProcess(
  opts: RunStreamProcessOptions,
): Promise<StreamProcessResult> {
  const spawn = opts.spawn ?? nodeSpawn

  return new Promise<StreamProcessResult>((resolve) => {
    let lineBuf = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let spawnFailed = false
    let aborted = false
    let stopped = false
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null

    const child = spawn(opts.bin, [...opts.args], {
      cwd: opts.cwd,
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
        stderr,
        truncated,
        timedOut,
        spawnFailed,
        aborted,
        pid: child.pid,
      })
    }

    /** SIGTERM, then SIGKILL if it is still alive after the grace period. */
    const terminate = (): void => {
      stopped = true
      child.kill('SIGTERM')
      if (killTimer === null) {
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
        // Never hold the event loop open just to escalate a kill.
        killTimer.unref?.()
      }
    }

    const budgetTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, opts.timeoutMs)

    function onAbort(): void {
      aborted = true
      terminate()
    }

    /** Feed one complete line out, honouring a `false` as "stop now". */
    const deliver = (line: string): void => {
      if (stopped) return
      if (!opts.onLine(line)) {
        truncated = true
        terminate()
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stopped) return
      lineBuf += chunk
      let newlineIdx: number
      while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, newlineIdx)
        lineBuf = lineBuf.slice(newlineIdx + 1)
        deliver(line)
        if (stopped) return
      }
      if (Buffer.byteLength(lineBuf, 'utf8') > MAX_INFER_STREAM_LINE_BYTES) {
        lineBuf = ''
        truncated = true
        terminate()
      }
    })

    // stderr is diagnostics only and never returned raw, so it gets a small
    // fixed budget rather than the answer cap — identical to runProcess.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk
    })

    child.on('error', () => {
      spawnFailed = true
      finish()
    })

    child.on('close', (code, signal) => {
      // A last line with no trailing newline is still a line. Skipped once we
      // have stopped: a killed child's final partial write is not an answer.
      if (!stopped && lineBuf !== '') deliver(lineBuf)
      exitCode = code
      exitSignal = signal
      finish()
    })

    child.stdin?.on('error', () => {
      /* EPIPE — the child exited before reading its input. See infer.ts. */
    })
    child.stdin?.end(opts.stdin)

    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Layer 3 — the route's worker
// ---------------------------------------------------------------------------

/** Where a stream event goes. The HTTP layer writes it; tests collect it. */
export type StreamEmit = (event: InferStreamEvent) => void

export interface RunStreamInferenceOptions {
  realRoot: string
  /** CLIs detected on PATH. A request naming anything else is refused. */
  availableClis: readonly string[]
  /** Where every event goes. The HTTP layer writes it; tests collect it. */
  emit: StreamEmit
  /** Fires when the browser disconnected. Forwarded all the way to the child. */
  signal?: AbortSignal
  /** Injected in tests. Defaults to the real streaming subprocess runner. */
  runStream?: RunStreamProcess
  /** Injected in tests. The ONE-SHOT runner, used for a CLI that cannot stream. */
  run?: RunProcess
  now?: () => number
}

/**
 * Run one streamed inference, emitting events through `opts.emit`.
 *
 * NEVER THROWS and never rejects: the HTTP layer has already committed a 200
 * by the time most of this runs, so an escaping exception could only become a
 * silently truncated stream. Every outcome is an event.
 *
 * THE EVENT CONTRACT this function guarantees:
 *   - at most one `start`, and it precedes every `delta`;
 *   - exactly one terminal event — `done` or `error` — UNLESS the caller
 *     aborted, in which case there is none at all. An abort is not a result:
 *     nobody is listening, and writing a verdict into a closed socket would
 *     only invite a caller to log a failure for a request it cancelled itself.
 */
export async function runStreamInference(
  req: InferRequest,
  opts: RunStreamInferenceOptions,
): Promise<void> {
  const { emit } = opts
  const now = opts.now ?? Date.now
  const started = now()
  const cli = req.cli as InferenceCli

  const fail = (code: BridgeErrorCode, message: string): void => {
    // An aborted caller gets no verdict — see the contract above.
    if (opts.signal?.aborted) return
    emit({ type: 'error', code, message })
  }

  if (!opts.availableClis.includes(req.cli)) {
    fail(
      'cli-unavailable',
      `The ${req.cli} CLI is not on this machine's PATH. Install it, then restart the bridge.`,
    )
    return
  }

  let fileContext: string | undefined
  if (req.files && req.files.length > 0) {
    const built = await buildFileContext(opts.realRoot, req.files)
    if (!built.ok) {
      fail(built.code, built.message)
      return
    }
    fileContext = built.context || undefined
  }

  const streams = CLI_STREAMS[cli] === true
  emit({ type: 'start', cli: req.cli, streaming: streams })

  if (!streams) {
    await runOneShotIntoStream(req, opts, started)
    return
  }

  // 0700 so no other user on a shared machine can read the system prompt.
  // Created INSIDE its own guard rather than beside the try below: this
  // function promises never to throw, and a full disk here would otherwise
  // reject after the 200 was committed — a cut stream with no terminal event,
  // which a client can only report as "the bridge died".
  let tmpDir: string
  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'review123-bridge-'))
  } catch {
    fail('cli-failed', 'The bridge could not create a working directory for the CLI.')
    return
  }

  try {
    const invocation = buildInvocation(cli, req, tmpDir, fileContext, { stream: true })
    if (invocation.systemFile !== null) {
      const system = req.system?.trim() ? req.system : NEUTRAL_SYSTEM_PROMPT
      await writeFile(invocation.systemFile, system, { mode: 0o600 })
    }

    let streamedBytes = 0
    let streamedText = ''
    let resultLine: string | null = null

    const onLine = (line: string): boolean => {
      const parsed = parseClaudeStreamLine(line)
      if (parsed === null) return true
      if (parsed.kind === 'result') {
        resultLine = line
        return true
      }
      streamedBytes += Buffer.byteLength(parsed.text, 'utf8')
      if (streamedBytes > MAX_INFER_OUTPUT_BYTES) return false
      streamedText += parsed.text
      emit({ type: 'delta', text: parsed.text })
      return true
    }

    const runStream = opts.runStream ?? runStreamProcess
    const result = await runStream({
      bin: invocation.bin,
      args: invocation.args,
      stdin: invocation.stdin,
      cwd: opts.realRoot,
      timeoutMs: clampTimeout(req.timeoutMs),
      onLine,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    const durationMs = now() - started

    // ORDER MATTERS. Every one of these ends with a dead child, so the exit
    // code is SIGTERM-shaped in most of them; the REASON we killed it is the
    // honest diagnosis, and it has to be read before the exit code is.
    if (result.aborted || opts.signal?.aborted) return
    if (result.spawnFailed) {
      fail('cli-unavailable', `The ${req.cli} CLI could not be started on this machine.`)
      return
    }
    if (result.timedOut) {
      fail(
        'timeout',
        `The ${req.cli} CLI did not finish within the ${clampTimeout(req.timeoutMs)} ms budget and was stopped.`,
      )
      return
    }
    if (result.truncated) {
      // A cap, not a failure — and unlike the one-shot route we have REAL
      // partial text to hand back, because it was delivered as it arrived.
      // #238 could only report "more output than the bridge will buffer".
      const parsed = resultLine === null ? null : readClaudeResult(resultLine)
      const text = parsed !== null && 'text' in parsed ? parsed.text : streamedText
      emit({ type: 'done', text, truncated: true, durationMs })
      return
    }
    if (result.code !== 0) {
      fail('cli-failed', withDiagnostic(`The ${req.cli} CLI exited with code ${result.code ?? 'unknown'}.`, result.stderr))
      return
    }
    if (resultLine === null) {
      // The child exited 0 without ever printing its result document. That is
      // NOT a short answer: whatever deltas we streamed are unterminated, and
      // reporting them as `done` would turn a broken run into a confident one.
      fail(
        'cli-failed',
        withDiagnostic(`The ${req.cli} CLI ended its stream without a final result.`, result.stderr),
      )
      return
    }

    const parsed = readClaudeResult(resultLine)
    if (parsed === null) {
      fail('cli-failed', withDiagnostic('The claude CLI did not return a readable JSON result.', result.stderr))
      return
    }
    if ('error' in parsed) {
      fail('cli-failed', `The claude CLI reported an error: ${sanitizeDiagnostic(parsed.error)}`)
      return
    }
    if (opts.signal?.aborted) return
    emit({
      type: 'done',
      text: parsed.text,
      truncated: false,
      durationMs,
      // Usage ONLY when the CLI reported it. Never zero-filled — an absent
      // `usage` means unknown, and unknown must not render as free.
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    })
  } catch {
    // A temp-file or filesystem failure. Generic on purpose: the real message
    // would name an absolute path.
    fail('cli-failed', 'The bridge could not run the CLI.')
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The path for a CLI that cannot stream (codex).
 *
 * It runs the ORDINARY one-shot inference and delivers the finished answer as
 * a single `delta` followed by `done`. It does NOT slice the text into timed
 * fragments: the `start` event already told the client `streaming: false`, and
 * a simulated typewriter would contradict it.
 *
 * The one delta is not decoration — a client that renders only from deltas
 * would otherwise show a permanently blank panel for a perfectly good answer.
 */
async function runOneShotIntoStream(
  req: InferRequest,
  opts: RunStreamInferenceOptions,
  started: number,
): Promise<void> {
  const { emit } = opts
  const now = opts.now ?? Date.now
  const outcome = await runInference(req, {
    realRoot: opts.realRoot,
    availableClis: opts.availableClis,
    ...(opts.run ? { run: opts.run } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  // The caller aborted: its child is already dead and nobody is reading. An
  // aborted run's outcome is noise, which is exactly why runInference does not
  // invent an error code for it.
  if (opts.signal?.aborted) return

  if (!outcome.ok) {
    emit({ type: 'error', code: outcome.code, message: outcome.message })
    return
  }
  if (outcome.text !== '') emit({ type: 'delta', text: outcome.text })
  emit({
    type: 'done',
    text: outcome.text,
    truncated: outcome.truncated,
    durationMs: outcome.durationMs || now() - started,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  })
}

/** `<generic sentence>` plus a sanitized excerpt, when there is one. */
function withDiagnostic(lead: string, stderr: string): string {
  const detail = sanitizeDiagnostic(stderr)
  return detail ? `${lead} (${detail})` : lead
}
