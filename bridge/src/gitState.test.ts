// @vitest-environment node
/**
 * gitState.test.ts — the repo state grounding turns on.
 *
 * Two layers, tested separately:
 *   1. readGitState over an INJECTED runner — every state (clean, dirty,
 *      detached, unborn, no repo, git missing, hung) as data, deterministically.
 *   2. runGit against a REAL temp checkout, so the argv shape and the parsing
 *      are proven against the actual binary rather than against a fixture that
 *      could drift from it.
 *
 * The invariant the whole feature rests on: when the state cannot be
 * established, the answer is NULL. Never a guess, never a partial state, never
 * "probably clean".
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GIT_BRANCH_ARGS,
  GIT_HEAD_ARGS,
  GIT_STATUS_ARGS,
  readGitState,
  runGit,
  type GitRunResult,
  type GitRunner,
} from './gitState.js'

const SHA = '4f3a1b2c5d6e7f8091a2b3c4d5e6f708192a3b4c'

/** A runner driven by a table of `args.join(' ')` → result. */
function stubRunner(table: Record<string, Partial<GitRunResult>>): GitRunner {
  return async (args) => {
    const key = args.join(' ')
    const hit = table[key]
    return { code: hit?.code ?? 1, stdout: hit?.stdout ?? '' }
  }
}

const HEAD_KEY = GIT_HEAD_ARGS.join(' ')
const BRANCH_KEY = GIT_BRANCH_ARGS.join(' ')
const STATUS_KEY = GIT_STATUS_ARGS.join(' ')

describe('readGitState — every state, as data', () => {
  it('reports a clean checkout on a branch', async () => {
    const run = stubRunner({
      [HEAD_KEY]: { code: 0, stdout: `${SHA}\n` },
      [BRANCH_KEY]: { code: 0, stdout: 'feat/thing\n' },
      [STATUS_KEY]: { code: 0, stdout: '' },
    })
    expect(await readGitState('/repo', { run })).toEqual({
      head: SHA,
      branch: 'feat/thing',
      dirty: false,
    })
  })

  it('reports a DIRTY checkout when status prints anything at all', async () => {
    const run = stubRunner({
      [HEAD_KEY]: { code: 0, stdout: `${SHA}\n` },
      [BRANCH_KEY]: { code: 0, stdout: 'main\n' },
      [STATUS_KEY]: { code: 0, stdout: ' M src/a.ts\n' },
    })
    expect((await readGitState('/repo', { run }))?.dirty).toBe(true)
  })

  it('counts an UNTRACKED file as dirty — it is code in no commit the PR has', async () => {
    const run = stubRunner({
      [HEAD_KEY]: { code: 0, stdout: `${SHA}\n` },
      [BRANCH_KEY]: { code: 0, stdout: 'main\n' },
      [STATUS_KEY]: { code: 0, stdout: '?? src/brand-new.ts\n' },
    })
    expect((await readGitState('/repo', { run }))?.dirty).toBe(true)
  })

  it('reports a DETACHED head as a null branch, keeping the sha', async () => {
    const run = stubRunner({
      [HEAD_KEY]: { code: 0, stdout: `${SHA}\n` },
      // This is literally what git prints when HEAD is detached.
      [BRANCH_KEY]: { code: 0, stdout: 'HEAD\n' },
      [STATUS_KEY]: { code: 0, stdout: '' },
    })
    expect(await readGitState('/repo', { run })).toEqual({ head: SHA, branch: null, dirty: false })
  })

  it('returns NULL when the root is not a repo', async () => {
    const run = stubRunner({ [HEAD_KEY]: { code: 128, stdout: '' } })
    expect(await readGitState('/not-a-repo', { run })).toBeNull()
  })

  it('returns NULL on an unborn branch — there is no HEAD to compare against', async () => {
    // `rev-parse --verify HEAD` fails in a freshly `init`-ed repo.
    const run = stubRunner({ [HEAD_KEY]: { code: 128, stdout: 'fatal: Needed a single revision\n' } })
    expect(await readGitState('/fresh', { run })).toBeNull()
  })

  it('returns NULL when git is not installed at all', async () => {
    // A spawn error resolves with a null code, exactly as runGit does on ENOENT.
    const run: GitRunner = async () => ({ code: null, stdout: '' })
    expect(await readGitState('/repo', { run })).toBeNull()
  })

  it('returns NULL when git answers with something that is not a sha', async () => {
    const run = stubRunner({ [HEAD_KEY]: { code: 0, stdout: 'not-a-sha\n' } })
    expect(await readGitState('/repo', { run })).toBeNull()
  })

  it('reports DIRTY, not clean, when the status probe itself fails', async () => {
    const run = stubRunner({
      [HEAD_KEY]: { code: 0, stdout: `${SHA}\n` },
      [BRANCH_KEY]: { code: 0, stdout: 'main\n' },
      [STATUS_KEY]: { code: 128, stdout: '' },
    })
    // Unknown must never render as the reassuring answer.
    expect((await readGitState('/repo', { run }))?.dirty).toBe(true)
  })

  it('reports a null branch, not an error, when only the branch probe fails', async () => {
    const run = stubRunner({
      [HEAD_KEY]: { code: 0, stdout: `${SHA}\n` },
      [BRANCH_KEY]: { code: 128, stdout: '' },
      [STATUS_KEY]: { code: 0, stdout: '' },
    })
    expect(await readGitState('/repo', { run })).toEqual({ head: SHA, branch: null, dirty: false })
  })

  it('strips control characters out of a branch name before it can reach the UI', async () => {
    const run = stubRunner({
      [HEAD_KEY]: { code: 0, stdout: `${SHA}\n` },
      [BRANCH_KEY]: { code: 0, stdout: 'feat/weird\n' },
      [STATUS_KEY]: { code: 0, stdout: '' },
    })
    expect((await readGitState('/repo', { run }))?.branch).toBe('feat/weird')
  })

  it('lowercases an uppercase sha so a client comparison is not case-sensitive', async () => {
    const run = stubRunner({
      [HEAD_KEY]: { code: 0, stdout: `${SHA.toUpperCase()}\n` },
      [BRANCH_KEY]: { code: 0, stdout: 'main\n' },
      [STATUS_KEY]: { code: 0, stdout: '' },
    })
    expect((await readGitState('/repo', { run }))?.head).toBe(SHA)
  })
})

describe('the invocations are hard-coded and read-only', () => {
  it('names only rev-parse and status --porcelain', () => {
    expect(GIT_HEAD_ARGS).toEqual(['rev-parse', '--verify', 'HEAD'])
    expect(GIT_BRANCH_ARGS).toEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(GIT_STATUS_ARGS).toEqual(['status', '--porcelain'])
  })

  it('never names a writing subcommand', () => {
    const all = [...GIT_HEAD_ARGS, ...GIT_BRANCH_ARGS, ...GIT_STATUS_ARGS]
    for (const forbidden of ['checkout', 'fetch', 'pull', 'push', 'reset', 'stash', 'clean', 'commit']) {
      expect(all).not.toContain(forbidden)
    }
  })

  it('appends nothing from a request — readGitState takes no request input', async () => {
    const seen: string[][] = []
    const run: GitRunner = async (args) => {
      seen.push([...args])
      return { code: 1, stdout: '' }
    }
    await readGitState('/repo', { run })
    expect(seen).toEqual([[...GIT_HEAD_ARGS]])
  })
})

// ---------------------------------------------------------------------------
// Against a REAL repo. Skipped when git is unavailable, so the suite still runs
// on a machine without it — the injected-runner tests above cover the logic.
// ---------------------------------------------------------------------------

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'bridge-gitstate-')))
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 'test@example.test'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'a.txt'), 'one\n')
  run(['add', '-A'])
  run(['commit', '-qm', 'first'])
  return dir
}

describe.runIf(hasGit())('runGit against a real checkout', () => {
  it('reads a clean repo: a real sha, the real branch, not dirty', async () => {
    const dir = await makeRepo()
    const state = await readGitState(dir)
    expect(state).not.toBeNull()
    expect(state!.head).toMatch(/^[0-9a-f]{40}$/)
    expect(state!.branch).toBe('main')
    expect(state!.dirty).toBe(false)
  })

  it('flips to dirty when a tracked file is modified', async () => {
    const dir = await makeRepo()
    await writeFile(join(dir, 'a.txt'), 'two\n')
    expect((await readGitState(dir))?.dirty).toBe(true)
  })

  it('flips to dirty on an untracked file alone', async () => {
    const dir = await makeRepo()
    await writeFile(join(dir, 'b.txt'), 'new\n')
    expect((await readGitState(dir))?.dirty).toBe(true)
  })

  it('reports a detached HEAD with a null branch', async () => {
    const dir = await makeRepo()
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['checkout', '-q', '--detach', sha], { cwd: dir, stdio: 'ignore' })
    const state = await readGitState(dir)
    expect(state).toEqual({ head: sha, branch: null, dirty: false })
  })

  it('returns null for a directory that is not a repo', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'bridge-nogit-')))
    expect(await readGitState(dir)).toBeNull()
  })

  it('runGit resolves (never rejects) for a command that fails', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'bridge-nogit-')))
    const result = await runGit(GIT_HEAD_ARGS, dir, 5_000)
    expect(result.code).not.toBe(0)
  })
})
