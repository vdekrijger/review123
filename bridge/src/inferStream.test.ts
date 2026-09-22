// @vitest-environment node
/**
 * inferStream.test.ts — the three layers of `/v1/infer/stream`.
 *
 * The process-mechanics suite spawns REAL subprocesses, for the reason
 * infer.test.ts gives and one more that is specific to streaming: a mocked
 * child cannot tell you whether an abort actually REAPED anything. The whole
 * point of this route's cancellation path is that a browser closing a tab
 * leaves no `claude` running on the user's subscription, and the only honest
 * way to assert that is to ask the operating system whether the pid is gone.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseClaudeStreamLine,
  runStreamInference,
  runStreamProcess,
  type StreamProcessResult,
} from './inferStream.js'
import { buildInvocation, CLI_STREAMS, type ProcessResult } from './infer.js'
import {
  MAX_INFER_OUTPUT_BYTES,
  type InferRequest,
  type InferStreamEvent,
} from './protocol.js'

const TMP = '/private/tmp/review123-bridge-test'

function request(over: Partial<InferRequest> = {}): InferRequest {
  return { cli: 'claude', prompt: 'the prompt', ...over }
}

/** One `content_block_delta` line, exactly as claude 2.1.278 prints it. */
function deltaLine(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    session_id: 's',
  })
}

/** The final `{"type":"result"}` document, same shape as --output-format json. */
function resultLine(text: string, usage?: { input_tokens: number; output_tokens: number }): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    duration_ms: 12,
    ...(usage ? { usage } : {}),
  })
}

/** Collect events, and remember the order they arrived in. */
function collector(): { events: InferStreamEvent[]; emit: (e: InferStreamEvent) => void } {
  const events: InferStreamEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

/** A fake streaming runner that feeds `lines` to onLine, then reports `result`. */
function fakeStream(
  lines: string[],
  result: Partial<StreamProcessResult> = {},
): (opts: { onLine: (line: string) => boolean }) => Promise<StreamProcessResult> {
  return async (opts) => {
    for (const line of lines) {
      if (!opts.onLine(line)) {
        return { code: null, signal: 'SIGTERM', stderr: '', truncated: true, timedOut: false, spawnFailed: false, aborted: false, pid: 1, ...result }
      }
    }
    return {
      code: 0,
      signal: null,
      stderr: '',
      truncated: false,
      timedOut: false,
      spawnFailed: false,
      aborted: false,
      pid: 1,
      ...result,
    }
  }
}

const RUN_OPTS = { realRoot: TMP, availableClis: ['claude', 'codex'] as string[] }

// ===========================================================================
// Layer 1 — one NDJSON line (pure)
// ===========================================================================

describe('parseClaudeStreamLine', () => {
  it('reads a text_delta as a delta', () => {
    expect(parseClaudeStreamLine(deltaLine('hello '))).toEqual({ kind: 'delta', text: 'hello ' })
  })

  it('reads the final result document, VERBATIM, so readClaudeResult can parse it', () => {
    const line = resultLine('the answer')
    expect(parseClaudeStreamLine(line)).toEqual({ kind: 'result', raw: line })
  })

  it('SKIPS a thinking_delta — private reasoning is not the answer', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    })
    expect(parseClaudeStreamLine(line)).toBeNull()
  })

  it('skips the events that are not output: init, status, block start/stop, rate limits', () => {
    for (const line of [
      JSON.stringify({ type: 'system', subtype: 'init', tools: [] }),
      JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: {} } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
    ]) {
      expect(parseClaudeStreamLine(line)).toBeNull()
    }
  })

  it('skips a line that is not JSON at all rather than failing the run', () => {
    // A CLI is free to print an update notice or a warning on stdout.
    expect(parseClaudeStreamLine('Welcome to Claude Code!')).toBeNull()
    expect(parseClaudeStreamLine('')).toBeNull()
    expect(parseClaudeStreamLine('   ')).toBeNull()
    expect(parseClaudeStreamLine('null')).toBeNull()
    expect(parseClaudeStreamLine('[1,2,3]')).toBeNull()
  })

  it('skips an EMPTY text_delta — an empty delta is not progress', () => {
    expect(parseClaudeStreamLine(deltaLine(''))).toBeNull()
  })
})

// ===========================================================================
// The argv — one flag pair changes, every safety flag survives
// ===========================================================================

describe('buildInvocation({ stream: true })', () => {
  it('asks claude for stream-json with partial messages, and --verbose (which it requires)', () => {
    const inv = buildInvocation('claude', request(), TMP, undefined, { stream: true })
    const joined = inv.args.join(' ')
    expect(joined).toContain('--output-format stream-json')
    expect(inv.args).toContain('--include-partial-messages')
    // VERIFIED: claude 2.1.278 exits with "When using --print,
    // --output-format=stream-json requires --verbose".
    expect(inv.args).toContain('--verbose')
    expect(inv.args).not.toContain('json')
  })

  it('keeps EVERY safety flag — streaming changes delivery, never permissions', () => {
    const oneShot = buildInvocation('claude', request(), TMP)
    const streamed = buildInvocation('claude', request(), TMP, undefined, { stream: true })
    for (const flag of ['--tools', '--permission-prompts', '--safe-mode', '--system-prompt-file']) {
      expect(streamed.args).toContain(flag)
    }
    // --tools is followed by the empty string in both: every built-in tool off.
    expect(streamed.args[streamed.args.indexOf('--tools') + 1]).toBe('')
    expect(streamed.stdin).toBe(oneShot.stdin)
    expect(streamed.systemFile).toBe(oneShot.systemFile)
  })

  it('still keeps the prompt off argv', () => {
    const inv = buildInvocation('claude', request({ prompt: 'SECRET PROMPT' }), TMP, undefined, { stream: true })
    expect(inv.args.join(' ')).not.toContain('SECRET PROMPT')
    expect(inv.stdin).toContain('SECRET PROMPT')
  })

  it('leaves codex unchanged — it has no streaming surface to ask for', () => {
    const req = request({ cli: 'codex' })
    expect(buildInvocation('codex', req, TMP, undefined, { stream: true })).toEqual(
      buildInvocation('codex', req, TMP),
    )
  })
})

describe('CLI_STREAMS', () => {
  it('records what the CLIs ACTUALLY do, verified by running them', () => {
    // claude 2.1.278 emits per-chunk content_block_delta events.
    expect(CLI_STREAMS.claude).toBe(true)
    // codex-cli 0.155.1 emits one item.completed carrying the whole message.
    expect(CLI_STREAMS.codex).toBe(false)
  })
})

// ===========================================================================
// Layer 2 — process mechanics, against REAL subprocesses
// ===========================================================================

/** Run a node one-liner through runStreamProcess, collecting its lines. */
function runNodeStream(
  script: string,
  opts: Partial<Parameters<typeof runStreamProcess>[0]> = {},
): { lines: string[]; done: Promise<StreamProcessResult> } {
  const lines: string[] = []
  const done = runStreamProcess({
    bin: process.execPath,
    args: ['-e', script],
    stdin: '',
    cwd: tmpdir(),
    timeoutMs: 10_000,
    onLine: (line) => {
      lines.push(line)
      return true
    },
    ...opts,
  })
  return { lines, done }
}

/** True while the OS still knows this pid. Signal 0 checks existence only. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runStreamProcess — framing', () => {
  it('delivers COMPLETE lines, newline stripped, in order', async () => {
    const { lines, done } = runNodeStream(`process.stdout.write('a\\nbb\\nccc\\n')`)
    await done
    expect(lines).toEqual(['a', 'bb', 'ccc'])
  })

  it('reassembles a line split across two writes', async () => {
    const script = `process.stdout.write('{"hal');setTimeout(()=>process.stdout.write('f":1}\\n'),30)`
    const { lines, done } = runNodeStream(script)
    await done
    expect(lines).toEqual(['{"half":1}'])
  })

  it('delivers a final line that has no trailing newline', async () => {
    const { lines, done } = runNodeStream(`process.stdout.write('a\\nno-newline')`)
    await done
    expect(lines).toEqual(['a', 'no-newline'])
  })

  it('still delivers the prompt on stdin, never argv', async () => {
    const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('GOT:'+s+'\\n'))`
    const { lines, done } = runNodeStream(script, { stdin: 'the prompt' })
    await done
    expect(lines).toEqual(['GOT:the prompt'])
  })
})

describe('runStreamProcess — incremental delivery', () => {
  it('hands lines out AS THEY ARRIVE, not all at the end', async () => {
    // Three lines, 60ms apart. If the runner buffered, the first line would be
    // observed at roughly the same moment as the last.
    const script = `let i=0;const t=setInterval(()=>{process.stdout.write('line'+(++i)+'\\n');if(i===3){clearInterval(t);process.exit(0)}},60)`
    const at: number[] = []
    const started = Date.now()
    const done = runStreamProcess({
      bin: process.execPath,
      args: ['-e', script],
      stdin: '',
      cwd: tmpdir(),
      timeoutMs: 10_000,
      onLine: () => {
        at.push(Date.now() - started)
        return true
      },
    })
    const res = await done
    expect(at).toHaveLength(3)
    expect(res.code).toBe(0)
    // The first line was seen well before the process ended.
    expect(at[0]!).toBeLessThan(at[2]! - 40)
  })
})

describe('runStreamProcess — the caller going away', () => {
  it('KILLS THE CHILD and the pid is gone — no orphaned CLI on the subscription', async () => {
    const controller = new AbortController()
    // A process that would run forever if nobody stopped it.
    const { done } = runNodeStream(`process.stdout.write('started\\n');setInterval(()=>{},1000)`, {
      signal: controller.signal,
      timeoutMs: 60_000,
    })
    await new Promise((r) => setTimeout(r, 120))
    controller.abort()

    const res = await done
    expect(res.aborted).toBe(true)
    expect(typeof res.pid).toBe('number')
    // THE PROOF. runStreamProcess resolves on 'close', which fires only after
    // the child has exited and been reaped, so by the time we are here the OS
    // must no longer know the pid.
    expect(isAlive(res.pid!)).toBe(false)
  })

  it('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    const controller = new AbortController()
    const { done } = runNodeStream(
      `process.on('SIGTERM',()=>{});process.stdout.write('x\\n');setInterval(()=>{},1000)`,
      { signal: controller.signal, timeoutMs: 60_000 },
    )
    await new Promise((r) => setTimeout(r, 120))
    controller.abort()
    const res = await done
    expect(res.aborted).toBe(true)
    expect(res.signal).toBe('SIGKILL')
    expect(isAlive(res.pid!)).toBe(false)
  })

  it('an ALREADY-aborted signal kills it immediately rather than running it to completion', async () => {
    const res = await runStreamProcess({
      bin: process.execPath,
      args: ['-e', `setInterval(()=>{},1000)`],
      stdin: '',
      cwd: tmpdir(),
      timeoutMs: 60_000,
      onLine: () => true,
      signal: AbortSignal.abort(),
    })
    expect(res.aborted).toBe(true)
    expect(isAlive(res.pid!)).toBe(false)
  })

  it('does not flag aborted for a run nobody cancelled', async () => {
    const controller = new AbortController()
    const { done } = runNodeStream(`process.stdout.write('ok\\n')`, { signal: controller.signal })
    const res = await done
    expect(res.aborted).toBe(false)
    expect(res.code).toBe(0)
  })
})

describe('runStreamProcess — the timeout kill', () => {
  it('kills a child that outlives its budget and reports timedOut', async () => {
    const { done } = runNodeStream(`process.stdout.write('a\\n');setInterval(()=>{},1000)`, {
      timeoutMs: 250,
    })
    const res = await done
    expect(res.timedOut).toBe(true)
    expect(res.aborted).toBe(false)
    expect(isAlive(res.pid!)).toBe(false)
  })
})

describe('runStreamProcess — caps', () => {
  it('stops reading when onLine says stop, kills the child, and reports truncated', async () => {
    const script = `setInterval(()=>process.stdout.write('x'.repeat(100)+'\\n'),0)`
    let seen = 0
    const res = await runStreamProcess({
      bin: process.execPath,
      args: ['-e', script],
      stdin: '',
      cwd: tmpdir(),
      timeoutMs: 10_000,
      onLine: () => ++seen < 5,
    })
    expect(res.truncated).toBe(true)
    expect(seen).toBe(5)
    expect(isAlive(res.pid!)).toBe(false)
  })

  it('caps one absurd UNTERMINATED line instead of buffering it without bound', async () => {
    // Never writes a newline. Without the line cap this would grow forever.
    const script = `const c='x'.repeat(1024*1024);setInterval(()=>process.stdout.write(c),0)`
    const { lines, done } = runNodeStream(script, { timeoutMs: 20_000 })
    const res = await done
    expect(res.truncated).toBe(true)
    // Nothing was ever a complete line, so nothing was delivered as one.
    expect(lines).toEqual([])
  }, 30_000)
})

describe('runStreamProcess — no shell', () => {
  it('treats a metacharacter-laden argv element as literal data', async () => {
    const { lines, done } = runNodeStream(`process.stdout.write((process.argv[1] ?? '')+'\\n')`, {
      args: ['-e', `process.stdout.write((process.argv[1] ?? '')+'\\n')`, '; rm -rf /tmp/nope'],
    })
    await done
    expect(lines).toEqual(['; rm -rf /tmp/nope'])
  })
})

describe('runStreamProcess — a missing binary', () => {
  it('reports spawnFailed rather than hanging', async () => {
    const res = await runStreamProcess({
      bin: '/nonexistent/review123-not-a-real-binary',
      args: [],
      stdin: '',
      cwd: tmpdir(),
      timeoutMs: 5_000,
      onLine: () => true,
    })
    expect(res.spawnFailed).toBe(true)
  })
})

// ===========================================================================
// Layer 3 — the event sequence
// ===========================================================================

describe('runStreamInference — the happy path', () => {
  it('emits start, then every delta in order, then done with the CLI’s own final text', async () => {
    const { events, emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        deltaLine('Hello'),
        deltaLine(', '),
        deltaLine('world'),
        resultLine('Hello, world'),
      ]),
      now: (() => {
        let t = 1000
        return () => (t += 5)
      })(),
    })

    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'delta', 'done'])
    expect(events[0]).toEqual({ type: 'start', cli: 'claude', streaming: true })
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual([
      'Hello',
      ', ',
      'world',
    ])
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'Hello, world', truncated: false })
  })

  it('reports usage ONLY when the CLI reported it — never a zero that reads as free', async () => {
    const withUsage = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit: withUsage.emit,
      runStream: fakeStream([deltaLine('x'), resultLine('x', { input_tokens: 467, output_tokens: 41 })]),
    })
    expect(withUsage.events.at(-1)).toMatchObject({ usage: { inputTokens: 467, outputTokens: 41 } })

    const without = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit: without.emit,
      runStream: fakeStream([deltaLine('x'), resultLine('x')]),
    })
    expect(without.events.at(-1)).not.toHaveProperty('usage')
  })

  it('refuses a CLI the machine does not have, before anything is spawned', async () => {
    const { events, emit } = collector()
    let spawned = false
    await runStreamInference(request(), {
      realRoot: TMP,
      availableClis: ['codex'],
      emit,
      runStream: async () => {
        spawned = true
        throw new Error('should never run')
      },
    })
    expect(spawned).toBe(false)
    expect(events).toEqual([
      { type: 'error', code: 'cli-unavailable', message: expect.stringContaining('claude') },
    ])
  })
})

describe('runStreamInference — a CLI that cannot stream', () => {
  it('runs codex through the ONE-SHOT path and says streaming: false', async () => {
    const { events, emit } = collector()
    const oneShot: ProcessResult = {
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      spawnFailed: false,
    }
    await runStreamInference(request({ cli: 'codex' }), {
      ...RUN_OPTS,
      emit,
      // codex reads its final message from --output-last-message, which the
      // real runInference reads off disk; an unreadable file is the honest
      // "no final message" failure, so the run below asserts that shape.
      run: async () => oneShot,
      runStream: async () => {
        throw new Error('codex must never take the streaming runner')
      },
    })
    expect(events[0]).toEqual({ type: 'start', cli: 'codex', streaming: false })
    // No fabricated deltas: whatever came back arrives in ONE piece or as an
    // error, never as a simulated typewriter.
    expect(events.filter((e) => e.type === 'delta').length).toBeLessThanOrEqual(1)
  })

  it('delivers a codex answer as exactly one delta, then done', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'review123-codex-')))
    const { events, emit } = collector()
    await runStreamInference(request({ cli: 'codex' }), {
      realRoot: root,
      availableClis: ['codex'],
      emit,
      // Write the final message where codex would, then exit 0.
      run: async (opts) => {
        const file = opts.args[opts.args.indexOf('--output-last-message') + 1]!
        await writeFile(file, 'the codex answer')
        return { code: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, spawnFailed: false }
      },
    })
    expect(events).toEqual([
      { type: 'start', cli: 'codex', streaming: false },
      { type: 'delta', text: 'the codex answer' },
      expect.objectContaining({ type: 'done', text: 'the codex answer', truncated: false }),
    ])
  })
})

describe('runStreamInference — failures are classified, never a truncated success', () => {
  it('a child that DIES mid-stream is an error, not a done with the partial text', async () => {
    const { events, emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([deltaLine('half an ans')], {
        code: 1,
        stderr: 'the CLI crashed',
      }),
    })
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'error'])
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'cli-failed' })
    expect((events.at(-1) as { message: string }).message).toContain('the CLI crashed')
  })

  it('a child that exits 0 WITHOUT its result document is an error, not a short answer', async () => {
    const { events, emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([deltaLine('some text')]),
    })
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'cli-failed' })
    expect((events.at(-1) as { message: string }).message).toMatch(/without a final result/i)
  })

  it('a mid-stream TIMEOUT is `timeout`, with the budget named', async () => {
    const { events, emit } = collector()
    await runStreamInference(request({ timeoutMs: 45_000 }), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([deltaLine('starting')], { timedOut: true, code: null, signal: 'SIGKILL' }),
    })
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'timeout' })
    expect((events.at(-1) as { message: string }).message).toContain('45000')
  })

  it('a binary that cannot be started is `cli-unavailable`', async () => {
    const { events, emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([], { spawnFailed: true, code: null }),
    })
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'cli-unavailable' })
  })

  it('a result document the CLI itself marked as an error is `cli-failed`', async () => {
    const { events, emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([
        JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'rate limited' }),
      ]),
    })
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'cli-failed' })
    expect((events.at(-1) as { message: string }).message).toContain('rate limited')
  })

  it('never lets an absolute path out in a diagnostic', async () => {
    const { events, emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([], { code: 2, stderr: 'ENOENT: /Users/jane/clients/acme/config.json' }),
    })
    const message = (events.at(-1) as { message: string }).message
    expect(message).toContain('ENOENT')
    expect(message).not.toContain('/Users/jane')
  })
})

describe('runStreamInference — truncation', () => {
  it('stops at the answer cap, kills the child, and reports done with truncated: true', async () => {
    const { events, emit } = collector()
    const huge = 'x'.repeat(MAX_INFER_OUTPUT_BYTES + 1)
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([deltaLine('kept'), deltaLine(huge), deltaLine('never')]),
    })
    const deltas = events.filter((e) => e.type === 'delta')
    // The over-cap delta is NOT emitted, and nothing after it is read.
    expect(deltas.map((d) => (d as { text: string }).text)).toEqual(['kept'])
    expect(events.at(-1)).toMatchObject({ type: 'done', truncated: true, text: 'kept' })
  })

  it('a truncated run still hands back the real partial text — #238 could only report the cap', async () => {
    const { events, emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      runStream: fakeStream([deltaLine('as far as it got')], { truncated: true, code: null, signal: 'SIGTERM' }),
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', truncated: true, text: 'as far as it got' })
  })
})

describe('runStreamInference — an aborted caller gets NO verdict', () => {
  it('emits no terminal event when the caller aborted: nobody is listening', async () => {
    const controller = new AbortController()
    const { events, emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      signal: controller.signal,
      runStream: async (opts) => {
        opts.onLine(deltaLine('partial'))
        controller.abort()
        return { code: null, signal: 'SIGTERM', stderr: '', truncated: false, timedOut: false, spawnFailed: false, aborted: true, pid: 1 }
      },
    })
    expect(events.map((e) => e.type)).toEqual(['start', 'delta'])
  })

  it('forwards the signal to the child runner, so the abort reaches the process', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const { emit } = collector()
    await runStreamInference(request(), {
      ...RUN_OPTS,
      emit,
      signal: controller.signal,
      runStream: async (opts: { signal?: AbortSignal; onLine: (l: string) => boolean }) => {
        received = opts.signal
        return { code: 0, signal: null, stderr: '', truncated: false, timedOut: false, spawnFailed: false, aborted: false, pid: 1 }
      },
    })
    expect(received).toBe(controller.signal)
  })
})

describe('runStreamInference — repo confinement still applies to `files`', () => {
  it('refuses a path outside the repo with forbidden-path, before spawning anything', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'review123-confine-')))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1')
    const { events, emit } = collector()
    let spawned = false
    await runStreamInference(request({ files: ['../../../etc/passwd'] }), {
      realRoot: root,
      availableClis: ['claude'],
      emit,
      runStream: async () => {
        spawned = true
        throw new Error('should never run')
      },
    })
    expect(spawned).toBe(false)
    expect(events).toEqual([
      { type: 'error', code: 'forbidden-path', message: expect.stringContaining('outside the repo') },
    ])
  })
})
