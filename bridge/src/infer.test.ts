// @vitest-environment node
/**
 * infer.test.ts — the three layers of /v1/infer.
 *
 * The process-mechanics suite spawns REAL subprocesses (`process.execPath -e
 * …`). A mock child cannot tell you whether a kill actually kills, whether an
 * over-cap writer is really stopped, or whether stdin reaches a program that
 * reads it — which is precisely the set of properties a route that runs the
 * user's CLI has to get right.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  AGENTIC_CLAUDE_TOOLS,
  buildFileContext,
  buildInvocation,
  clampTimeout,
  countCodexCommands,
  readClaudeAgentic,
  NEUTRAL_SYSTEM_PROMPT,
  parseInferRequest,
  readClaudeResult,
  runInference,
  runProcess,
  sanitizeDiagnostic,
  statusForInferError,
  type ProcessResult,
  type RunProcess,
} from './infer.js'
import {
  DEFAULT_AGENTIC_INFER_TIMEOUT_MS,
  DEFAULT_INFER_TIMEOUT_MS,
  MAX_INFER_TIMEOUT_MS,
  type InferRequest,
} from './protocol.js'

const TMP = '/tmp/bridge-fake'

function request(overrides: Partial<InferRequest> = {}): InferRequest {
  return { cli: 'claude', prompt: 'review this diff', ...overrides }
}

/** A RunProcess stub that records what it was asked to run. */
function recordingRun(result: Partial<ProcessResult> = {}): {
  run: RunProcess
  calls: Parameters<RunProcess>[0][]
} {
  const calls: Parameters<RunProcess>[0][] = []
  const run: RunProcess = async (opts) => {
    calls.push(opts)
    return {
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      spawnFailed: false,
      ...result,
    }
  }
  return { run, calls }
}

/** A `claude -p --output-format json` document. */
function claudeDoc(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ subtype: 'success', is_error: false, result, ...extra })
}

// ===========================================================================
// Layer 1 — the invocation shape
// ===========================================================================

describe('buildInvocation — the argv shape', () => {
  it('runs `claude` headless with JSON output, no tools, and no prompt in argv', () => {
    const inv = buildInvocation('claude', request({ prompt: 'SECRET PROMPT TEXT' }), TMP)
    expect(inv.bin).toBe('claude')
    expect(inv.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--permission-prompts',
      'none',
      '--safe-mode',
      '--system-prompt-file',
      join(TMP, 'system.txt'),
    ])
    // THE argv RULE: the prompt is on stdin, because argv is world-readable in
    // `ps` and capped at ARG_MAX.
    expect(inv.args.join(' ')).not.toContain('SECRET PROMPT TEXT')
    expect(inv.stdin).toContain('SECRET PROMPT TEXT')
  })

  // -------------------------------------------------------------------------
  // Model selection. Verified against claude 2.1.278 (`--model <model>`: an
  // alias like 'opus'/'sonnet' or a full name like 'claude-fable-5') and
  // codex-cli (`codex exec -m, --model <MODEL>`).
  // -------------------------------------------------------------------------
  it('adds --model to claude when the request names one', () => {
    const inv = buildInvocation('claude', request({ model: 'opus' }), TMP)
    expect(inv.args).toContain('--model')
    expect(inv.args[inv.args.indexOf('--model') + 1]).toBe('opus')
  })

  it('adds --model to codex exec when the request names one', () => {
    const inv = buildInvocation('codex', request({ cli: 'codex', model: 'gpt-5' }), TMP)
    expect(inv.args).toContain('--model')
    expect(inv.args[inv.args.indexOf('--model') + 1]).toBe('gpt-5')
  })

  it.each(['claude', 'codex'] as const)(
    'omitting model leaves %s argv byte-identical to the pre-flag invocation',
    (cli) => {
      // The whole back-compat contract: no model named → no flag, so the CLI
      // keeps answering with whatever model the user configured it with.
      const withModel = buildInvocation(cli, request({ cli, model: 'x' }), TMP)
      const without = buildInvocation(cli, request({ cli }), TMP)
      expect(without.args).not.toContain('--model')
      expect(without.args).toEqual(withModel.args.filter((a) => a !== '--model' && a !== 'x'))
    },
  )

  it('keeps every safety flag when a model is selected', () => {
    const inv = buildInvocation('claude', request({ model: 'opus' }), TMP)
    expect(inv.args).toEqual(expect.arrayContaining(['--tools', '', '--permission-prompts', 'none', '--safe-mode']))
    const codex = buildInvocation('codex', request({ cli: 'codex', model: 'gpt-5' }), TMP)
    expect(codex.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ephemeral']))
  })

  it('carries the model into the STREAMING invocation too', () => {
    // Both routes share buildInvocation, so a review cannot silently change
    // model just because the CLI happened to support partial output.
    const inv = buildInvocation('claude', request({ model: 'sonnet' }), TMP, undefined, { stream: true })
    expect(inv.args).toContain('--model')
    expect(inv.args[inv.args.indexOf('--model') + 1]).toBe('sonnet')
    expect(inv.args).toContain('stream-json')
  })

  it('keeps the SYSTEM prompt out of argv too — it goes to a temp file', () => {
    const inv = buildInvocation('claude', request({ system: 'SECRET SYSTEM TEXT' }), TMP)
    expect(inv.args.join(' ')).not.toContain('SECRET SYSTEM TEXT')
    expect(inv.systemFile).toBe(join(TMP, 'system.txt'))
  })

  it('runs `codex exec` read-only, reading the prompt from stdin via `-`', () => {
    const inv = buildInvocation('codex', request({ cli: 'codex', prompt: 'SECRET PROMPT TEXT' }), TMP)
    expect(inv.bin).toBe('codex')
    expect(inv.args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--ephemeral',
      '--output-last-message',
      join(TMP, 'last-message.txt'),
      '-',
    ])
    expect(inv.args.join(' ')).not.toContain('SECRET PROMPT TEXT')
    expect(inv.stdin).toContain('SECRET PROMPT TEXT')
  })

  it('folds the system prompt into stdin for codex, which has no system-prompt flag', () => {
    const inv = buildInvocation('codex', request({ cli: 'codex', system: 'BE TERSE' }), TMP)
    expect(inv.systemFile).toBeNull()
    expect(inv.stdin).toContain('BE TERSE')
    expect(inv.stdin).toContain('SYSTEM INSTRUCTIONS')
  })

  it('never puts a shell metacharacter anywhere but inside an argv ELEMENT', () => {
    // An argv array is not parsed by a shell, so this is safe by construction —
    // the test pins that the prompt never reaches argv at all.
    const nasty = '"; rm -rf ~ #`whoami`$(id)'
    for (const cli of ['claude', 'codex'] as const) {
      const inv = buildInvocation(cli, request({ cli, prompt: nasty, system: nasty }), TMP)
      for (const arg of inv.args) expect(arg).not.toContain('rm -rf')
    }
  })

  it('every argv element is a plain flag, value or temp path — never user text', () => {
    const inv = buildInvocation('claude', request({ prompt: 'x'.repeat(5_000) }), TMP)
    for (const arg of inv.args) {
      expect(arg.length).toBeLessThan(200)
    }
  })
})

describe('parseInferRequest', () => {
  it('accepts a minimal valid request', () => {
    expect(parseInferRequest({ cli: 'claude', prompt: 'hi' })).toEqual({ cli: 'claude', prompt: 'hi' })
  })

  it.each([
    ['a non-object body', 'not an object'],
    ['a missing cli', { prompt: 'hi' }],
    ['an unknown cli', { cli: 'bash', prompt: 'hi' }],
    ['a command smuggled as the cli id', { cli: 'claude; rm -rf /', prompt: 'hi' }],
    ['a missing prompt', { cli: 'claude' }],
    ['an empty prompt', { cli: 'claude', prompt: '' }],
    ['a non-string system', { cli: 'claude', prompt: 'hi', system: 12 }],
    ['a non-array files', { cli: 'claude', prompt: 'hi', files: 'a.ts' }],
    ['a files array with a non-string', { cli: 'claude', prompt: 'hi', files: ['a.ts', 3] }],
    ['a non-number timeoutMs', { cli: 'claude', prompt: 'hi', timeoutMs: 'soon' }],
    ['a non-string model', { cli: 'claude', prompt: 'hi', model: 7 }],
    ['an empty model', { cli: 'claude', prompt: 'hi', model: '' }],
    // The model id is the ONE caller-supplied string that reaches argv. An
    // argv array stops word-splitting, but not a value that looks like a flag.
    ['a model that is really a flag', { cli: 'claude', prompt: 'hi', model: '--dangerously-skip-permissions' }],
    ['a model with a leading dash', { cli: 'claude', prompt: 'hi', model: '-opus' }],
    ['a model with a space', { cli: 'claude', prompt: 'hi', model: 'opus --tools' }],
    ['a model with a shell metacharacter', { cli: 'claude', prompt: 'hi', model: 'opus; rm -rf /' }],
    ['an absurdly long model', { cli: 'claude', prompt: 'hi', model: 'a'.repeat(101) }],
  ])('rejects %s', (_label, body) => {
    expect(parseInferRequest(body)).toHaveProperty('error')
  })

  it.each([
    ['a bare alias', 'opus'],
    ['a full vendor name', 'claude-fable-5'],
    ['a namespaced id', 'openai/gpt-5'],
    ['a dotted id', 'gpt-5.4'],
  ])('accepts %s as a model', (_label, model) => {
    expect(parseInferRequest({ cli: 'claude', prompt: 'hi', model })).toEqual({
      cli: 'claude',
      prompt: 'hi',
      model,
    })
  })

  it('leaves model ABSENT when it was not sent, rather than defaulting one', () => {
    expect(parseInferRequest({ cli: 'claude', prompt: 'hi' })).not.toHaveProperty('model')
  })

  it('carries the optional fields through when they are well typed', () => {
    expect(
      parseInferRequest({ cli: 'codex', prompt: 'hi', model: 'gpt-5', system: 's', files: ['a.ts'], timeoutMs: 5, maxOutputTokens: 9 }),
    ).toEqual({ cli: 'codex', prompt: 'hi', model: 'gpt-5', system: 's', files: ['a.ts'], timeoutMs: 5, maxOutputTokens: 9 })
  })
})

describe('clampTimeout', () => {
  it('defaults when absent or nonsense', () => {
    expect(clampTimeout(undefined)).toBe(DEFAULT_INFER_TIMEOUT_MS)
    expect(clampTimeout(0)).toBe(DEFAULT_INFER_TIMEOUT_MS)
    expect(clampTimeout(-5)).toBe(DEFAULT_INFER_TIMEOUT_MS)
    expect(clampTimeout(Number.NaN)).toBe(DEFAULT_INFER_TIMEOUT_MS)
  })

  it('clamps an over-large budget to the ceiling', () => {
    expect(clampTimeout(MAX_INFER_TIMEOUT_MS * 10)).toBe(MAX_INFER_TIMEOUT_MS)
  })

  it('honours a budget inside the range', () => {
    expect(clampTimeout(45_000)).toBe(45_000)
  })
})

// ===========================================================================
// Layer 2 — process mechanics, against REAL subprocesses
// ===========================================================================

/** Run a node one-liner through runProcess, the same way a CLI would run. */
function runNode(script: string, opts: Partial<Parameters<typeof runProcess>[0]> = {}) {
  return runProcess({
    bin: process.execPath,
    args: ['-e', script],
    stdin: '',
    cwd: tmpdir(),
    timeoutMs: 10_000,
    ...opts,
  })
}

describe('runProcess — stdin', () => {
  it('delivers the prompt on stdin, not argv', async () => {
    const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('GOT:'+s))`
    const res = await runNode(script, { stdin: 'the prompt' })
    expect(res.stdout).toBe('GOT:the prompt')
    expect(res.code).toBe(0)
  })

  it('does not fail when the child exits without reading stdin (EPIPE)', async () => {
    const res = await runNode(`process.stdout.write('done')`, { stdin: 'x'.repeat(200_000) })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('done')
  })
})

describe('runProcess — exit status', () => {
  it('reports a non-zero exit code and captures stderr', async () => {
    const res = await runNode(`process.stderr.write('it broke');process.exit(3)`)
    expect(res.code).toBe(3)
    expect(res.stderr).toContain('it broke')
    expect(res.timedOut).toBe(false)
  })

  it('flags spawnFailed when the binary does not exist', async () => {
    const res = await runProcess({
      bin: '/nonexistent/review123-not-a-real-binary',
      args: [],
      stdin: '',
      cwd: tmpdir(),
      timeoutMs: 5_000,
    })
    expect(res.spawnFailed).toBe(true)
  })
})

describe('runProcess — the timeout kill', () => {
  it('kills a child that outlives its budget and reports timedOut', async () => {
    const started = Date.now()
    // A process that ignores SIGTERM proves the SIGKILL escalation works.
    const res = await runNode(
      `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
      { timeoutMs: 300 },
    )
    expect(res.timedOut).toBe(true)
    expect(res.signal).toBe('SIGKILL')
    // Killed promptly, not left to run out the default budget.
    expect(Date.now() - started).toBeLessThan(9_000)
  })

  it('a child that finishes inside the budget is not flagged', async () => {
    const res = await runNode(`process.stdout.write('quick')`, { timeoutMs: 5_000 })
    expect(res.timedOut).toBe(false)
    expect(res.stdout).toBe('quick')
  })
})

describe('runProcess — the output cap', () => {
  it('stops a runaway writer and reports truncated instead of buffering it all', async () => {
    const res = await runNode(
      `const chunk='x'.repeat(4096);setInterval(()=>process.stdout.write(chunk),0)`,
      { maxOutputBytes: 64 * 1024, timeoutMs: 10_000 },
    )
    expect(res.truncated).toBe(true)
    // The cap is a memory guard: we keep the chunk that crossed it, never an
    // unbounded amount more.
    expect(res.stdout.length).toBeLessThan(64 * 1024 + 64 * 1024)
  })

  it('does not flag truncated for output that fits', async () => {
    const res = await runNode(`process.stdout.write('x'.repeat(100))`, { maxOutputBytes: 64 * 1024 })
    expect(res.truncated).toBe(false)
    expect(res.stdout.length).toBe(100)
  })
})

describe('runProcess — no shell', () => {
  it('treats a metacharacter-laden argv element as literal data, never as a command', async () => {
    // With `shell: true` this would delete something. With an argv array it is
    // one opaque string handed to the program.
    const res = await runProcess({
      bin: process.execPath,
      args: ['-e', `process.stdout.write(process.argv[1] ?? '')`, '; rm -rf /tmp/review123-should-not-exist'],
      stdin: '',
      cwd: tmpdir(),
      timeoutMs: 5_000,
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('; rm -rf /tmp/review123-should-not-exist')
  })
})

// ===========================================================================
// Diagnostics — nothing absolute crosses back to the web origin
// ===========================================================================

describe('sanitizeDiagnostic', () => {
  it.each([
    ['a POSIX home path', 'ENOENT: /Users/jane/clients/acme/.config/creds.json missing'],
    ['a nested project path', 'failed at /private/var/folders/xy/T/thing/index.js:12'],
    ['a tilde path', 'could not read ~/Library/Application Support/claude/config'],
    ['a Windows drive path', 'cannot open C:\\Users\\jane\\AppData\\Roaming\\codex'],
    ['a UNC path', 'unreachable \\\\fileserver\\share\\secret'],
  ])('strips %s', (_label, raw) => {
    const out = sanitizeDiagnostic(raw)
    expect(out).not.toMatch(/\/Users\/|\/private\/|AppData|Library|fileserver/)
    expect(out).toContain('<path>')
  })

  it('keeps the useful non-path part of the message', () => {
    expect(sanitizeDiagnostic('ENOENT: /Users/jane/x.json missing')).toContain('ENOENT')
  })

  it('caps the excerpt so a stack trace cannot become the response body', () => {
    expect(sanitizeDiagnostic('e'.repeat(10_000)).length).toBeLessThanOrEqual(241)
  })

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeDiagnostic('a\u0000b\u001b[31mc\n\n  d')).toBe('a b [31mc d')
  })

  it('returns empty for empty input, so the caller can omit the excerpt', () => {
    expect(sanitizeDiagnostic('   \n  ')).toBe('')
  })
})

// ===========================================================================
// claude result extraction
// ===========================================================================

describe('readClaudeResult', () => {
  it('extracts the result text and the token usage', () => {
    const doc = claudeDoc('the answer', { usage: { input_tokens: 445, output_tokens: 15 } })
    expect(readClaudeResult(doc)).toEqual({
      text: 'the answer',
      usage: { inputTokens: 445, outputTokens: 15 },
    })
  })

  it('omits usage entirely when the CLI reported none — never a fabricated zero', () => {
    expect(readClaudeResult(claudeDoc('the answer'))).toEqual({ text: 'the answer' })
  })

  it('reports an is_error document as an error', () => {
    const doc = JSON.stringify({ subtype: 'error_during_execution', is_error: true, result: 'rate limited' })
    expect(readClaudeResult(doc)).toEqual({ error: 'rate limited' })
  })

  it('returns null for output that is not the expected JSON document', () => {
    expect(readClaudeResult('Welcome to Claude Code!\n')).toBeNull()
    expect(readClaudeResult('')).toBeNull()
    expect(readClaudeResult('{"subtype":"success","is_error":false}')).toBeNull()
  })
})

describe('statusForInferError', () => {
  it.each([
    ['bad-request', 400],
    ['forbidden-path', 403],
    ['cli-unavailable', 503],
    ['timeout', 504],
    ['cli-failed', 502],
  ] as const)('maps %s to HTTP %i', (code, status) => {
    expect(statusForInferError(code)).toBe(status)
  })
})

// ===========================================================================
// Layer 3 — runInference
// ===========================================================================

describe('runInference — the CLI must be present', () => {
  it('refuses a CLI that is not on PATH with an actionable cli-unavailable', async () => {
    const outcome = await runInference(request(), { realRoot: tmpdir(), availableClis: ['codex'] })
    expect(outcome).toEqual({
      ok: false,
      code: 'cli-unavailable',
      message: expect.stringContaining('claude'),
    })
  })

  it('maps a failed spawn onto cli-unavailable too', async () => {
    const { run } = recordingRun({ spawnFailed: true })
    const outcome = await runInference(request(), {
      realRoot: tmpdir(),
      availableClis: ['claude'],
      run,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'cli-unavailable' })
  })
})

describe('runInference — claude', () => {
  it('returns the CLI answer with usage and a duration', async () => {
    const { run, calls } = recordingRun({
      stdout: claudeDoc('{"findings":[]}', { usage: { input_tokens: 100, output_tokens: 20 } }),
    })
    const outcome = await runInference(request(), {
      realRoot: tmpdir(),
      availableClis: ['claude'],
      run,
      now: (() => {
        let t = 1_000
        return () => (t += 250)
      })(),
    })
    expect(outcome).toEqual({
      ok: true,
      text: '{"findings":[]}',
      truncated: false,
      durationMs: 250,
      usage: { inputTokens: 100, outputTokens: 20 },
    })
    expect(calls[0]!.bin).toBe('claude')
    expect(calls[0]!.cwd).toBe(tmpdir())
  })

  it('writes the system prompt to the temp file the argv points at', async () => {
    let seenSystem = ''
    const run: RunProcess = async (opts) => {
      const idx = opts.args.indexOf('--system-prompt-file')
      seenSystem = await readFile(String(opts.args[idx + 1]), 'utf8')
      return {
        code: 0, signal: null, stdout: claudeDoc('ok'), stderr: '',
        truncated: false, timedOut: false, spawnFailed: false,
      }
    }
    await runInference(request({ system: 'You are a reviewer.' }), {
      realRoot: tmpdir(), availableClis: ['claude'], run,
    })
    expect(seenSystem).toBe('You are a reviewer.')
  })

  it('substitutes a NEUTRAL system prompt when the caller sends none', async () => {
    let seenSystem = ''
    const run: RunProcess = async (opts) => {
      const idx = opts.args.indexOf('--system-prompt-file')
      seenSystem = await readFile(String(opts.args[idx + 1]), 'utf8')
      return {
        code: 0, signal: null, stdout: claudeDoc('ok'), stderr: '',
        truncated: false, timedOut: false, spawnFailed: false,
      }
    }
    await runInference(request({ system: '   ' }), { realRoot: tmpdir(), availableClis: ['claude'], run })
    expect(seenSystem).toBe(NEUTRAL_SYSTEM_PROMPT)
  })

  it('reports a non-zero exit honestly, with a PATH-FREE stderr excerpt', async () => {
    const { run } = recordingRun({
      code: 1,
      stderr: 'Error: cannot read /Users/jane/.claude/settings.json',
    })
    const outcome = await runInference(request(), { realRoot: tmpdir(), availableClis: ['claude'], run })
    expect(outcome.ok).toBe(false)
    const failure = outcome as { code: string; message: string }
    expect(failure.code).toBe('cli-failed')
    expect(failure.message).toContain('exited with code 1')
    expect(failure.message).not.toContain('/Users/jane')
    expect(failure.message).toContain('<path>')
  })

  it('reports a timeout as `timeout`, not as a generic failure', async () => {
    const { run } = recordingRun({ timedOut: true, code: null, signal: 'SIGKILL' })
    const outcome = await runInference(request({ timeoutMs: 1_000 }), {
      realRoot: tmpdir(), availableClis: ['claude'], run,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'timeout' })
    expect((outcome as { message: string }).message).toContain('1000 ms')
  })

  it('surfaces an is_error result document as cli-failed', async () => {
    const { run } = recordingRun({
      stdout: JSON.stringify({ subtype: 'error_max_turns', is_error: true, result: 'hit the limit' }),
    })
    const outcome = await runInference(request(), { realRoot: tmpdir(), availableClis: ['claude'], run })
    expect(outcome).toMatchObject({ ok: false, code: 'cli-failed' })
    expect((outcome as { message: string }).message).toContain('hit the limit')
  })

  it('says so plainly when a truncated run leaves the JSON result unreadable', async () => {
    const { run } = recordingRun({ stdout: '{"subtype":"success","result":"half a th', truncated: true })
    const outcome = await runInference(request(), { realRoot: tmpdir(), availableClis: ['claude'], run })
    expect(outcome).toMatchObject({ ok: false, code: 'cli-failed' })
    expect((outcome as { message: string }).message).toContain('more output than the bridge will buffer')
  })

  it('passes the clamped timeout down to the process runner', async () => {
    const { run, calls } = recordingRun({ stdout: claudeDoc('ok') })
    await runInference(request({ timeoutMs: MAX_INFER_TIMEOUT_MS * 5 }), {
      realRoot: tmpdir(), availableClis: ['claude'], run,
    })
    expect(calls[0]!.timeoutMs).toBe(MAX_INFER_TIMEOUT_MS)
  })
})

describe('runInference — codex', () => {
  it('reads the final answer from --output-last-message, not the event transcript', async () => {
    const run: RunProcess = async (opts) => {
      const idx = opts.args.indexOf('--output-last-message')
      await writeFile(String(opts.args[idx + 1]), 'the final answer\n')
      return {
        code: 0, signal: null,
        stdout: 'OpenAI Codex v0.155.1\n--------\nworkdir: /private/tmp\ncodex\nthe final answer\n',
        stderr: '', truncated: false, timedOut: false, spawnFailed: false,
      }
    }
    const outcome = await runInference(request({ cli: 'codex' }), {
      realRoot: tmpdir(), availableClis: ['codex'], run,
    })
    expect(outcome).toMatchObject({ ok: true, text: 'the final answer' })
    // The banner (which carries an absolute workdir) never reaches the caller.
    expect((outcome as { text: string }).text).not.toContain('workdir')
  })

  it('omits usage for codex, which reports no machine-readable token counts', async () => {
    const run: RunProcess = async (opts) => {
      const idx = opts.args.indexOf('--output-last-message')
      await writeFile(String(opts.args[idx + 1]), 'answer')
      return {
        code: 0, signal: null, stdout: '', stderr: '',
        truncated: false, timedOut: false, spawnFailed: false,
      }
    }
    const outcome = await runInference(request({ cli: 'codex' }), {
      realRoot: tmpdir(), availableClis: ['codex'], run,
    })
    expect(outcome).toMatchObject({ ok: true })
    expect(outcome).not.toHaveProperty('usage')
  })

  it('fails honestly when the run produced no final message', async () => {
    const { run } = recordingRun({ code: 0, stderr: 'stream error at /Users/jane/x' })
    const outcome = await runInference(request({ cli: 'codex' }), {
      realRoot: tmpdir(), availableClis: ['codex'], run,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'cli-failed' })
    expect((outcome as { message: string }).message).not.toContain('/Users/jane')
  })
})

// ===========================================================================
// File context — repo confinement still applies
// ===========================================================================

describe('buildFileContext — confinement', () => {
  async function repo(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-infer-repo-')))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    return root
  }

  it('inlines a confined file into a framed block', async () => {
    const root = await repo()
    const out = await buildFileContext(root, ['src/a.ts'])
    expect(out.ok).toBe(true)
    expect((out as { context: string }).context).toContain('export const a = 1')
    expect((out as { context: string }).context).toContain('FILE src/a.ts')
  })

  it.each([
    ['traversal', '../outside.env'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\Windows\\win.ini'],
    ['a NUL byte', 'src/a.ts\u0000.png'],
  ])('refuses %s with forbidden-path', async (_label, path) => {
    const root = await repo()
    const out = await buildFileContext(root, [path])
    expect(out).toMatchObject({ ok: false, code: 'forbidden-path' })
  })

  it('refuses a SYMLINK that escapes the repo — the check that resolve() alone misses', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'bridge-infer-outside-')))
    await writeFile(join(outside, 'secrets.env'), 'TOKEN=hunter2\n')
    const root = await repo()
    await symlink(join(outside, 'secrets.env'), join(root, 'escape.env'))

    const out = await buildFileContext(root, ['escape.env'])
    expect(out).toMatchObject({ ok: false, code: 'forbidden-path' })
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('skips a file that does not exist rather than failing the call', async () => {
    const root = await repo()
    const out = await buildFileContext(root, ['src/a.ts', 'src/gone.ts'])
    expect(out.ok).toBe(true)
    expect((out as { context: string }).context).toContain('export const a = 1')
    expect((out as { context: string }).context).not.toContain('gone.ts')
  })

  it('caps the TOTAL inlined content so a big file list cannot blow up the prompt', async () => {
    const root = await repo()
    await writeFile(join(root, 'big.txt'), 'y'.repeat(400_000))
    const out = await buildFileContext(root, ['big.txt'])
    expect(out.ok).toBe(true)
    expect((out as { context: string }).context.length).toBeLessThan(300_000)
  })

  it('propagates the 403 out of runInference before anything is spawned', async () => {
    const root = await repo()
    const { run, calls } = recordingRun({ stdout: claudeDoc('ok') })
    const outcome = await runInference(request({ files: ['../../etc/passwd'] }), {
      realRoot: root, availableClis: ['claude'], run,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'forbidden-path' })
    expect(calls).toHaveLength(0)
  })

  it('puts inlined file content into stdin, never argv', async () => {
    const root = await repo()
    const { run, calls } = recordingRun({ stdout: claudeDoc('ok') })
    await runInference(request({ files: ['src/a.ts'] }), {
      realRoot: root, availableClis: ['claude'], run,
    })
    expect(calls[0]!.stdin).toContain('export const a = 1')
    expect(calls[0]!.args.join(' ')).not.toContain('export const a')
  })
})

// ===========================================================================
// Agentic mode — the CLI runs with its OWN read-only tools
//
// Every expectation here was checked against the real CLIs before it was
// written (claude 2.1.278, codex-cli 0.155.1); the notes say which run proved
// what, because these are claims about someone else's software.
// ===========================================================================

describe('buildInvocation — agentic (read-only tools)', () => {
  it('grants claude exactly Read, Glob and Grep — nothing that writes, runs or fetches', () => {
    const inv = buildInvocation('claude', request({ agentic: true }), TMP)
    const tools = inv.args[inv.args.indexOf('--tools') + 1]
    expect(tools).toBe('Read,Glob,Grep')
    // VERIFIED by running the CLI under this exact argv and asking it to
    // enumerate its tools: it answers "Glob, Grep, Read" and nothing else.
    expect([...AGENTIC_CLAUDE_TOOLS]).toEqual(['Read', 'Glob', 'Grep'])
  })

  /**
   * THE REASON THIS TEST EXISTS, and it is not pedantry.
   *
   * An unrecognised name in `--tools` is SILENTLY DROPPED by the CLI — verified:
   * `--tools "Read,NotATool"` yields exactly `Read`, exit code 0, no warning.
   * So a typo in AGENTIC_CLAUDE_TOOLS would not fail the build, would not fail
   * the run, and would not fail any test that only checked "some tools were
   * passed". It would quietly hand the reviewer fewer tools and produce a worse
   * review still labelled deep. Pinning the exact list is the only thing that
   * would notice.
   */
  it('pins the tool list exactly, because an unknown name is silently dropped', () => {
    for (const banned of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task']) {
      expect(AGENTIC_CLAUDE_TOOLS as readonly string[]).not.toContain(banned)
    }
  })

  it('adds the confinement flags, so a read cannot leave the served root', () => {
    const inv = buildInvocation('claude', request({ agentic: true }), TMP)
    // --restricted is a HARD confinement of the file tools to the working
    // directory (verified: an absolute path outside it is refused). It also
    // ignores the user's settings files.
    expect(inv.args).toContain('--restricted')
    // The user's own MCP servers must not become review tools.
    expect(inv.args).toContain('--strict-mcp-config')
    // Both pre-existing safety flags survive: --permission-prompts none
    // independently denies an out-of-root read, so confinement holds on two
    // layers rather than one.
    expect(inv.args).toContain('--safe-mode')
    expect(inv.args.join(' ')).toContain('--permission-prompts none')
  })

  it('leaves the TOOL-LESS claude invocation byte-identical', () => {
    // The ordinary path is the one every existing client uses. Agentic mode is
    // additive or it is a regression.
    const plain = buildInvocation('claude', request(), TMP)
    expect(plain.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--permission-prompts',
      'none',
      '--safe-mode',
      '--system-prompt-file',
      join(TMP, 'system.txt'),
    ])
    expect(plain.args).not.toContain('--restricted')
  })

  it('treats `agentic: false` exactly as absent — one tool-less path, not two', () => {
    expect(buildInvocation('claude', request({ agentic: false }), TMP).args).toEqual(
      buildInvocation('claude', request(), TMP).args,
    )
  })

  it('keeps every safety flag when agentic mode is STREAMED', () => {
    // Streaming may change how the answer is delivered, never what the child is
    // allowed to do (#236 — the two routes share one invocation).
    const inv = buildInvocation('claude', request({ agentic: true }), TMP, undefined, { stream: true })
    expect(inv.args).toContain('--restricted')
    expect(inv.args).toContain('--strict-mcp-config')
    expect(inv.args[inv.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
    expect(inv.args).toContain('stream-json')
  })

  /**
   * codex needs NO new power, and this test says so.
   *
   * `--sandbox read-only` has always given codex a shell it can read the tree
   * with — verified by running the EXISTING tool-less invocation, which ran
   * `sed -n '1,120p' canary.ts` and reported the contents. So the only thing
   * agentic mode adds for codex is the ability to COUNT that activity.
   */
  it('adds only --json to codex, whose read-only sandbox was already agentic', () => {
    const plain = buildInvocation('codex', request({ cli: 'codex' }), TMP)
    const agentic = buildInvocation('codex', request({ cli: 'codex', agentic: true }), TMP)
    expect(agentic.args).toContain('--json')
    expect(plain.args).not.toContain('--json')
    // Identical apart from that one flag: no sandbox change, no new grant.
    expect(agentic.args.filter((a) => a !== '--json')).toEqual(plain.args)
    // The sandbox stays read-only in BOTH.
    expect(agentic.args.join(' ')).toContain('--sandbox read-only')
  })
})

describe('clampTimeout — the agentic default', () => {
  it('gives an agentic run five minutes when it names no budget', () => {
    // An agentic run reads files and turns again on what it found; a tool-less
    // one is a single turn. The DEFAULT moves for that reason.
    expect(clampTimeout(undefined, true)).toBe(DEFAULT_AGENTIC_INFER_TIMEOUT_MS)
    expect(clampTimeout(undefined, false)).toBe(DEFAULT_INFER_TIMEOUT_MS)
  })

  it('does NOT raise the ceiling for agentic mode', () => {
    // The only budget that moves is the default. A caller still cannot buy more
    // wall clock by asking for tools.
    expect(clampTimeout(MAX_INFER_TIMEOUT_MS * 10, true)).toBe(MAX_INFER_TIMEOUT_MS)
  })

  it('honours a caller that asks for LESS than the agentic default', () => {
    expect(clampTimeout(1_000, true)).toBe(1_000)
  })
})

describe('parseInferRequest — agentic', () => {
  it('accepts a boolean and normalises false to absent', () => {
    const yes = parseInferRequest({ cli: 'claude', prompt: 'p', agentic: true })
    expect(yes).toMatchObject({ agentic: true })
    const no = parseInferRequest({ cli: 'claude', prompt: 'p', agentic: false })
    expect('agentic' in (no as object)).toBe(false)
  })

  it('refuses a non-boolean rather than reading it as truthy', () => {
    // This is the field that decides whether a subprocess may read the user's
    // disk. "false" as a STRING is truthy in JS, and must not turn tools on.
    for (const bad of ['true', 'false', 1, 0, {}, []]) {
      expect(parseInferRequest({ cli: 'claude', prompt: 'p', agentic: bad })).toEqual({
        error: 'agentic must be a boolean.',
      })
    }
  })
})

describe('readClaudeAgentic — what the run reported', () => {
  it('derives a LOWER-BOUND tool count from num_turns', () => {
    // num_turns counts assistant turns: 1 = answered with no tool call, and
    // every turn beyond the first followed at least one. A single turn can
    // carry several calls, so this UNDER-counts — the safe direction.
    expect(readClaudeAgentic(JSON.stringify({ num_turns: 1 })).toolCallsAtLeast).toBe(0)
    expect(readClaudeAgentic(JSON.stringify({ num_turns: 2 })).toolCallsAtLeast).toBe(1)
    expect(readClaudeAgentic(JSON.stringify({ num_turns: 7 })).toolCallsAtLeast).toBe(6)
  })

  it('reports refused tool calls, so a blocked escape is visible not silent', () => {
    // Shape verified: an out-of-root Read lands here as
    // {"tool_name":"Read","tool_use_id":"…","tool_input":{"file_path":"…"}}.
    const doc = JSON.stringify({ num_turns: 2, permission_denials: [{ tool_name: 'Read' }] })
    expect(readClaudeAgentic(doc).denied).toBe(1)
  })

  it('leaves counts ABSENT rather than zero when the CLI reported none', () => {
    // Absent means "unreported"; 0 would be a claim that it used no tools.
    const report = readClaudeAgentic(JSON.stringify({ result: 'x' }))
    expect(report.toolCallsAtLeast).toBeUndefined()
    expect(report.denied).toBeUndefined()
  })

  it('still reports the GRANT when stdout is unreadable', () => {
    // The tools were granted — that is a fact about the argv we built, not
    // about the answer. We simply cannot say what was done with them.
    expect(readClaudeAgentic('not json at all').tools).toEqual(['Read', 'Glob', 'Grep'])
  })
})

describe('countCodexCommands — codex tool use', () => {
  const line = (o: unknown): string => JSON.stringify(o)

  it('counts completed command executions', () => {
    // Event shape verified by running `codex exec --json`.
    const stdout = [
      line({ type: 'thread.started' }),
      line({ type: 'item.started', item: { type: 'command_execution' } }),
      line({ type: 'item.completed', item: { type: 'command_execution' } }),
      line({ type: 'item.completed', item: { type: 'command_execution' } }),
      line({ type: 'item.completed', item: { type: 'agent_message' } }),
      line({ type: 'turn.completed' }),
    ].join('\n')
    // Only COMPLETED command executions — `item.started` would double-count,
    // and agent_message is the answer, not a tool call.
    expect(countCodexCommands(stdout)).toBe(2)
  })

  it('returns 0 for a run that used no commands but did emit events', () => {
    expect(countCodexCommands(line({ type: 'turn.completed' }))).toBe(0)
  })

  it('returns null when nothing countable arrived, keeping unreported distinct from zero', () => {
    expect(countCodexCommands('OpenAI Codex v0.155.1\nsome human transcript\n')).toBeNull()
    expect(countCodexCommands('')).toBeNull()
  })

  it('skips unparseable lines rather than failing the whole count', () => {
    // stdout also carries codex's banner; a stricter reader would turn a
    // cosmetic change upstream into a failed review.
    const stdout = ['garbage {', line({ type: 'item.completed', item: { type: 'command_execution' } })].join('\n')
    expect(countCodexCommands(stdout)).toBe(1)
  })
})

describe('runInference — the agentic report reaches the caller', () => {
  const claudeDoc = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ result: 'the answer', is_error: false, subtype: 'success', num_turns: 3, ...over })

  function fakeRun(stdout: string): RunProcess {
    return async () =>
      ({
        code: 0,
        signal: null,
        stdout,
        stderr: '',
        truncated: false,
        timedOut: false,
        spawnFailed: false,
      }) as ProcessResult
  }

  it('reports the run when tools were asked for', async () => {
    const out = await runInference(request({ agentic: true }), {
      realRoot: TMP,
      availableClis: ['claude'],
      run: fakeRun(claudeDoc({ permission_denials: [] })),
    })
    expect(out).toMatchObject({
      ok: true,
      agentic: { tools: ['Read', 'Glob', 'Grep'], toolCallsAtLeast: 2, denied: 0 },
    })
  })

  it('reports NOTHING when tools were not asked for, even though num_turns is there', async () => {
    // claude's result document always carries num_turns. Echoing it back on a
    // tool-less run would advertise a grounding that never happened, and the
    // client reads the field's ABSENCE as exactly that signal.
    const out = await runInference(request(), {
      realRoot: TMP,
      availableClis: ['claude'],
      run: fakeRun(claudeDoc()),
    })
    expect(out).toMatchObject({ ok: true })
    expect((out as { agentic?: unknown }).agentic).toBeUndefined()
  })
})
