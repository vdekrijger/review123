/**
 * gitState.ts — what the served working tree currently IS.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The bridge serves files from the working tree RIGHT NOW. Nothing about that
 * tree is guaranteed to match the pull request the user is reading: they may
 * have switched branches, be mid-rebase, or have a checkout from last month.
 * Serving `main`'s copy of a file while the browser reviews PR #123 would
 * ground findings in code the PR does not contain — silently wrong, which is
 * strictly worse than having no local grounding at all.
 *
 * So the bridge does not guess and it does not "try its best". It REPORTS
 * `head` / `branch` / `dirty`, and the client refuses local grounding unless
 * `head` matches the PR's head sha exactly.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE SUBPROCESS EXCEPTION (rule 5 of the security model)
 *
 * The bridge's standing promise is "no arbitrary command execution". This
 * module is the one place outside `/v1/infer` that spawns anything, and it
 * stays inside the promise the same way infer.ts does:
 *
 *   - `spawn(bin, argvArray)`, NEVER a shell, NEVER `exec`. There is no word
 *     splitting, so nothing can become a second command.
 *   - Every argv here is a HARD-CODED LITERAL. No request field, no path, no
 *     user string is ever appended — `readGitState` takes no arguments beyond
 *     the root the bridge was started in.
 *   - Every command is READ-ONLY: `rev-parse` and `status --porcelain`. There
 *     is deliberately no code path in this file that can write, fetch, check
 *     out, or stash.
 *   - Failure is silence: a missing git, a non-repo, a hung index lock all
 *     resolve to `null`, which the client must read as "no match provable".
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { GIT_STATE_TIMEOUT_MS, type GitState } from './protocol.js'

/** The three read-only invocations, as literals. Nothing is appended. */
export const GIT_HEAD_ARGS = ['rev-parse', '--verify', 'HEAD'] as const
export const GIT_BRANCH_ARGS = ['rev-parse', '--abbrev-ref', 'HEAD'] as const
export const GIT_STATUS_ARGS = ['status', '--porcelain'] as const

/** Grace between SIGTERM and SIGKILL, mirroring infer.ts. */
const KILL_GRACE_MS = 1_000

/** Cap on the bytes we buffer from `git status` — a huge dirty tree is fine. */
const MAX_GIT_OUTPUT_BYTES = 256 * 1024

export interface GitRunResult {
  /** null when the process was killed rather than exiting. */
  code: number | null
  stdout: string
}

/** Injected in tests so the suite never needs a real repo (or a real git). */
export type GitRunner = (args: readonly string[], cwd: string, timeoutMs: number) => Promise<GitRunResult>

/**
 * Run one hard-coded `git` invocation and collect capped stdout under a wall
 * clock. Never throws and never rejects: a missing binary, a crash and a
 * timeout all come back as a non-zero/null code.
 */
export const runGit: GitRunner = (args, cwd, timeoutMs) =>
  new Promise<GitRunResult>((resolve) => {
    let stdout = ''
    let bytes = 0
    let settled = false
    let killTimer: NodeJS.Timeout | null = null

    const child = nodeSpawn('git', [...args], {
      cwd,
      // A minimal, non-interactive environment. GIT_OPTIONAL_LOCKS=0 keeps
      // `status` from taking the index lock, so a read-only probe can never
      // interfere with a command the user is running in their own terminal.
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    })

    let code: number | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(budget)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, stdout })
    }

    const budget = setTimeout(() => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (bytes >= MAX_GIT_OUTPUT_BYTES) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      stdout += chunk
    })
    // ENOENT: git is not installed. Same outcome as "not a repo" — null state.
    child.on('error', finish)
    child.on('close', (exit) => {
      code = exit
      finish()
    })
  })

/** A 40-hex commit id. Anything else is not a sha and is not trusted. */
const SHA_RE = /^[0-9a-f]{40}$/

/**
 * A branch name we are willing to send to a browser. Git's own refname rules
 * are broader than this, but everything outside it is either impossible in
 * practice or something we would rather not render.
 */
const BRANCH_MAX_CHARS = 200

function cleanBranch(raw: string): string | null {
  const trimmed = raw.trim()
  // `rev-parse --abbrev-ref HEAD` literally prints "HEAD" on a detached head.
  if (trimmed === '' || trimmed === 'HEAD') return null
  let out = ''
  for (const ch of trimmed.slice(0, BRANCH_MAX_CHARS)) {
    const codePoint = ch.codePointAt(0) ?? 0
    if (codePoint < 0x20 || codePoint === 0x7f) continue
    out += ch
  }
  return out === '' ? null : out
}

export interface ReadGitStateOptions {
  run?: GitRunner
  timeoutMs?: number
}

/**
 * The repo state behind `/v1/health`.
 *
 * Returns `null` — meaning "no match is provable" — when the root is not a git
 * repository, has no commits yet (an unborn branch has no HEAD to compare),
 * git is not installed, or git did not answer inside the budget. Every one of
 * those is a normal situation, not an error: the client simply grounds from
 * the provider API instead.
 *
 * `dirty` is deliberately the BROAD reading — any `git status --porcelain`
 * output at all, untracked files included. A narrower definition would let the
 * bridge call a tree clean while it holds a brand-new file that is in no
 * commit the PR contains.
 */
export async function readGitState(
  realRoot: string,
  opts: ReadGitStateOptions = {},
): Promise<GitState | null> {
  const run = opts.run ?? runGit
  const timeoutMs = opts.timeoutMs ?? GIT_STATE_TIMEOUT_MS

  const head = await run(GIT_HEAD_ARGS, realRoot, timeoutMs)
  if (head.code !== 0) return null
  const sha = head.stdout.trim().toLowerCase()
  if (!SHA_RE.test(sha)) return null

  const branch = await run(GIT_BRANCH_ARGS, realRoot, timeoutMs)
  const status = await run(GIT_STATUS_ARGS, realRoot, timeoutMs)

  return {
    head: sha,
    // A failed branch probe is reported as detached rather than as an error:
    // the head sha is what grounding actually turns on, and the branch name is
    // only there to help the user recognise where their checkout is.
    branch: branch.code === 0 ? cleanBranch(branch.stdout) : null,
    // A failed status probe is reported as DIRTY, not clean. Unknown must
    // never render as the reassuring answer.
    dirty: status.code !== 0 || status.stdout.trim() !== '',
  }
}
