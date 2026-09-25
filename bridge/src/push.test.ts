// @vitest-environment node
/**
 * push.test.ts — the only route that writes to a remote.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THESE TESTS PUSH TO REAL REPOSITORIES, ON PURPOSE.
 *
 * checkout.test.ts makes this argument already and it applies twice over here.
 * The promise `push.ts` makes is "no reachable commit can stop being
 * reachable", and a mocked git proves nothing about that: a stub would happily
 * report success for a refspec that, run for real, would have overwritten
 * somebody's branch. So the harness builds a real bare remote, a real clone,
 * real divergent history — and after every refusal it READS THE REMOTE BACK
 * and asserts the branch did not move.
 *
 * "The remote is unchanged" is the assertion that matters in most of this file.
 *
 * The injected runner is used for the two situations a real remote cannot
 * produce on demand (a remote whose HEAD names no branch; a git that crashes)
 * and, alongside the real one, to record every argv the module ever assembles
 * so the no-force test can read them.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PushError,
  firstLine,
  parseLsRemote,
  parsePushRequest,
  readRemote,
  remoteExists,
  runPush,
  statusForPushError,
  type PushFailureKind,
} from './push.js'
import { PROTECTED_BRANCH_NAMES } from './protocol.js'
import { runGit, type GitRun } from './worktree.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const scratchDirs: string[] = []

/** Every argv this file's git calls have seen. The no-force test reads it. */
let argvLog: string[][] = []

const recordingRun: GitRun = (args, cwd, opts) => {
  argvLog.push([...args])
  return runGit(args, cwd, opts)
}

beforeEach(() => {
  argvLog = []
})

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `bridge-push-${prefix}-`))
  scratchDirs.push(dir)
  return dir
}

/** Run git and throw on failure — harness setup, not code under test. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await runGit(args, cwd, { timeoutMs: 30_000 })
  if (res.code !== 0) throw new Error(`harness git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout.trim()
}

interface Fixture {
  /** The user's checkout. */
  repo: string
  /** A BARE repo standing in for `origin`. Bare so a push can land on it. */
  remote: string
  /** The default branch on the remote. Never pushable. */
  mainSha: string
  /** The pull request's branch on the remote, and where it points. */
  featureSha: string
}

/**
 * A realistic starting point: a bare `origin` whose HEAD is `main`, a `feature`
 * branch one commit ahead of it, and a clone sitting on `feature`.
 */
async function fixture(): Promise<Fixture> {
  const remote = await scratch('remote')
  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main')

  const seed = await scratch('seed')
  await git(seed, 'init', '--quiet', '--initial-branch=main')
  await git(seed, 'config', 'user.email', 'harness@test.invalid')
  await git(seed, 'config', 'user.name', 'harness')
  await writeFile(join(seed, 'app.txt'), 'base\n', 'utf8')
  await git(seed, 'add', '-A')
  await git(seed, 'commit', '--quiet', '-m', 'base')
  const mainSha = await git(seed, 'rev-parse', 'HEAD')
  await git(seed, 'remote', 'add', 'origin', remote)
  await git(seed, 'push', '--quiet', 'origin', 'main:refs/heads/main')

  await git(seed, 'checkout', '--quiet', '-b', 'feature')
  await writeFile(join(seed, 'app.txt'), 'from the pull request\n', 'utf8')
  await git(seed, 'add', '-A')
  await git(seed, 'commit', '--quiet', '-m', 'the pull request')
  const featureSha = await git(seed, 'rev-parse', 'HEAD')
  await git(seed, 'push', '--quiet', 'origin', 'feature:refs/heads/feature')

  const repo = await scratch('repo')
  await git(repo, 'clone', '--quiet', remote, '.')
  await git(repo, 'config', 'user.email', 'harness@test.invalid')
  await git(repo, 'config', 'user.name', 'harness')
  await git(repo, 'checkout', '--quiet', 'feature')

  return { repo, remote, mainSha, featureSha }
}

/** Where a branch points ON THE REMOTE. The "did it move" oracle. */
async function remoteTip(remote: string, branch: string): Promise<string> {
  return git(remote, 'rev-parse', `refs/heads/${branch}`)
}

/** One more commit on top of HEAD in the user's checkout. */
async function commitOnTop(repo: string, text: string): Promise<string> {
  await writeFile(join(repo, 'app.txt'), text, 'utf8')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '--quiet', '-m', `agent: ${text.trim()}`)
  return git(repo, 'rev-parse', 'HEAD')
}

/** Await a rejected runPush and hand back its PushError. */
async function refusal(promise: Promise<unknown>): Promise<PushError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof PushError) return err
    throw err
  }
  throw new Error('expected runPush to refuse, but it resolved')
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

// ---------------------------------------------------------------------------
// The happy path — and it is the only one that moves anything
// ---------------------------------------------------------------------------

describe('runPush — moving a branch forward', () => {
  it('fast-forwards the remote branch and echoes the exact move it made', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix for the failing job\n')

    const res = await runPush(
      f.repo,
      { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
      { git: recordingRun },
    )

    expect(res.ok).toBe(true)
    // The response restates the whole plan, in the request's own terms: a user
    // who confirmed "from X to Y" can check that X and Y is what happened.
    expect(res.remote).toBe('origin')
    expect(res.branch).toBe('feature')
    expect(res.before).toBe(f.featureSha)
    expect(res.after).toBe(after)
    expect(res.commits).toBe(1)
    // And the remote really moved, which is the only proof that counts.
    expect(await remoteTip(f.remote, 'feature')).toBe(after)
  })

  it('counts the commits it actually added', async () => {
    const f = await fixture()
    await commitOnTop(f.repo, 'one\n')
    const after = await commitOnTop(f.repo, 'two\n')

    const res = await runPush(
      f.repo,
      { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
      { git: recordingRun },
    )
    expect(res.commits).toBe(2)
  })

  it('leaves every OTHER branch on the remote exactly where it was', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    await runPush(
      f.repo,
      { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
      { git: recordingRun },
    )
    expect(await remoteTip(f.remote, 'main')).toBe(f.mainSha)
  })
})

// ---------------------------------------------------------------------------
// The refusals. Each one has its own sentence, and none of them moves anything.
// ---------------------------------------------------------------------------

describe('runPush — a push that is not a fast-forward', () => {
  it('refuses it, and the remote does not move', async () => {
    const f = await fixture()
    // Diverge: go back to main and build a different commit. It is not a
    // descendant of feature, so pushing it would orphan the PR's commit.
    await git(f.repo, 'checkout', '--quiet', '-B', 'sideline', f.mainSha)
    const diverged = await commitOnTop(f.repo, 'a different history\n')

    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: diverged },
        { git: recordingRun },
      ),
    )

    expect(err.kind).toBe('not-fast-forward')
    expect(err.message).toMatch(/fast-forward/i)
    // The sentence says WHY it matters, not just that a rule fired.
    expect(err.message).toMatch(/would stop being reachable|no way to force/i)
    expect(await remoteTip(f.remote, 'feature')).toBe(f.featureSha)
  })

  it('refuses when the remote tip is not in this repository, so it cannot prove anything', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    // Somebody else pushed a commit this clone has never fetched. The bridge
    // cannot compute an ancestry it does not have, and guessing is exactly what
    // this route must not do.
    const stubbed: GitRun = async (args, cwd, opts) => {
      if (args[0] === 'ls-remote') {
        return { code: 0, stdout: `ref: refs/heads/main\tHEAD\n${SHA_B}\trefs/heads/feature\n`, stderr: '', timedOut: false, spawnFailed: false }
      }
      return recordingRun(args, cwd, opts)
    }
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: SHA_B, sha: after },
        { git: stubbed },
      ),
    )
    expect(err.kind).toBe('not-fast-forward')
    expect(err.message).toMatch(/not in this repository/i)
    expect(err.message).toMatch(/Fetch origin/i)
    expect(await remoteTip(f.remote, 'feature')).toBe(f.featureSha)
  })
})

describe('runPush — the default branch and the never list', () => {
  it('refuses a branch on the never list without contacting the remote at all', async () => {
    const f = await fixture()
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'main', expectedRemoteSha: f.mainSha, sha: f.featureSha },
        { git: recordingRun },
      ),
    )
    expect(err.kind).toBe('protected-branch')
    expect(err.message).toMatch(/does not push to a branch named "main"/)
    // Nothing was asked of the remote: the refusal is absolute, so there is
    // nothing a remote could have said that would change it.
    expect(argvLog.some((a) => a[0] === 'ls-remote')).toBe(false)
    expect(await remoteTip(f.remote, 'main')).toBe(f.mainSha)
  })

  it.each(PROTECTED_BRANCH_NAMES)('refuses %s by name', async (name) => {
    const f = await fixture()
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: name, expectedRemoteSha: f.mainSha, sha: f.featureSha },
        { git: recordingRun },
      ),
    )
    expect(err.kind).toBe('protected-branch')
  })

  it("refuses the REMOTE'S OWN default branch even when it is not on the list", async () => {
    const f = await fixture()
    // The remote decides `feature` is its default. The static list says nothing
    // about it; asking the remote is what catches this.
    await git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/feature')
    const after = await commitOnTop(f.repo, 'a fix\n')

    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: recordingRun },
      ),
    )
    expect(err.kind).toBe('protected-branch')
    expect(err.message).toMatch(/origin's default branch/)
    expect(await remoteTip(f.remote, 'feature')).toBe(f.featureSha)
  })

  it('refuses when the default branch cannot be established — fail closed, never guess', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    const stubbed: GitRun = async (args, cwd, opts) => {
      if (args[0] === 'ls-remote') {
        // No symref line: some remotes and some mirrors answer like this.
        return { code: 0, stdout: `${f.featureSha}\trefs/heads/feature\n`, stderr: '', timedOut: false, spawnFailed: false }
      }
      return recordingRun(args, cwd, opts)
    }
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: stubbed },
      ),
    )
    expect(err.kind).toBe('default-branch-unknown')
    expect(err.message).toMatch(/could not work out which branch/i)
    expect(await remoteTip(f.remote, 'feature')).toBe(f.featureSha)
  })
})

describe('runPush — the branch has to be there already', () => {
  it('refuses a branch the remote does not have, rather than creating it', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'never-existed', expectedRemoteSha: f.featureSha, sha: after },
        { git: recordingRun },
      ),
    )
    expect(err.kind).toBe('branch-missing')
    expect(err.message).toMatch(/creating one is a separate act/i)
    // And it really did not create it.
    const refs = await git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')
    expect(refs).not.toMatch(/never-existed/)
  })
})

describe('runPush — the pull request advanced mid-flight', () => {
  it('refuses when the remote branch is not where the request said it was', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    // Somebody pushes to the PR branch between the plan and the push.
    const other = await scratch('other')
    await git(other, 'clone', '--quiet', f.remote, '.')
    await git(other, 'config', 'user.email', 'other@test.invalid')
    await git(other, 'config', 'user.name', 'other')
    await git(other, 'checkout', '--quiet', 'feature')
    await writeFile(join(other, 'theirs.txt'), 'their work\n', 'utf8')
    await git(other, 'add', '-A')
    await git(other, 'commit', '--quiet', '-m', 'their commit')
    await git(other, 'push', '--quiet', 'origin', 'feature:refs/heads/feature')
    const movedTo = await remoteTip(f.remote, 'feature')

    const err = await refusal(
      runPush(
        f.repo,
        // Still carrying the sha the user was looking at when they confirmed.
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: recordingRun },
      ),
    )

    expect(err.kind).toBe('remote-moved')
    expect(err.message).toMatch(/moved since this push was planned/i)
    // Both shas are named, so the user can see what changed under them.
    expect(err.message).toContain(movedTo.slice(0, 12))
    expect(err.message).toContain(f.featureSha.slice(0, 12))
    // Their commit is still the tip. Nothing of theirs was overwritten.
    expect(await remoteTip(f.remote, 'feature')).toBe(movedTo)
  })

  it('refuses when the branch is already at that commit', async () => {
    const f = await fixture()
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: f.featureSha },
        { git: recordingRun },
      ),
    )
    expect(err.kind).toBe('nothing-to-push')
    expect(err.message).toMatch(/already at/i)
  })
})

describe('runPush — the local repository', () => {
  it('refuses a dirty working tree, and names what is in the way', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    await writeFile(join(f.repo, 'scratch-note.txt'), 'something I was in the middle of\n', 'utf8')

    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: recordingRun },
      ),
    )

    expect(err.kind).toBe('tree-dirty')
    expect(err.dirtyPaths).toContain('scratch-note.txt')
    expect(err.dirtyCount).toBeGreaterThan(0)
    expect(err.message).toMatch(/uncommitted changes/i)
    // Refused BEFORE the network: a dirty tree is answerable, so there is no
    // reason to have asked the remote anything.
    expect(argvLog.some((a) => a[0] === 'ls-remote')).toBe(false)
    expect(await remoteTip(f.remote, 'feature')).toBe(f.featureSha)
  })

  it('refuses a commit that is not in this repository', async () => {
    const f = await fixture()
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: SHA_A },
        { git: recordingRun },
      ),
    )
    expect(err.kind).toBe('commit-unknown')
    expect(err.message).toMatch(/is not in this repository/i)
  })

  it('refuses a remote this repository does not have', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'upstream', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: recordingRun },
      ),
    )
    expect(err.kind).toBe('remote-unknown')
    expect(err.message).toMatch(/no remote named "upstream"/)
  })

  it('reports a remote it cannot reach, without claiming anything about the branch', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    await git(f.repo, 'remote', 'set-url', 'origin', join(f.repo, 'no-such-repo.git'))

    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: recordingRun },
      ),
    )
    expect(err.kind).toBe('remote-unreachable')
    expect(err.message).toMatch(/could not read origin/i)
  })
})

describe('runPush — the remote says no', () => {
  it('reports a hook refusal verbatim enough to act on, and nothing moved', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    const hook = join(f.remote, 'hooks', 'pre-receive')
    await writeFile(hook, '#!/bin/sh\necho "this branch is protected" >&2\nexit 1\n', 'utf8')
    await chmod(hook, 0o755)

    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: recordingRun },
      ),
    )

    expect(err.kind).toBe('push-rejected')
    expect(err.message).toMatch(/origin refused the push/i)
    expect(err.message).toMatch(/protected/i)
    expect(await remoteTip(f.remote, 'feature')).toBe(f.featureSha)
  })

  it('reports an unrunnable git as push-failed rather than pretending it landed', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    const stubbed: GitRun = async (args, cwd, opts) => {
      if (args[0] === 'push') {
        return { code: null, stdout: '', stderr: '', timedOut: false, spawnFailed: true }
      }
      return recordingRun(args, cwd, opts)
    }
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: stubbed },
      ),
    )
    expect(err.kind).toBe('push-failed')
  })

  it('says a timed-out push may or may not have landed, and does not retry', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    let pushes = 0
    const stubbed: GitRun = async (args, cwd, opts) => {
      if (args[0] === 'push') {
        pushes += 1
        return { code: null, stdout: '', stderr: '', timedOut: true, spawnFailed: false }
      }
      return recordingRun(args, cwd, opts)
    }
    const err = await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
        { git: stubbed },
      ),
    )
    expect(err.kind).toBe('push-failed')
    // The honest sentence: it does not claim to know, and it does not guess by
    // trying again — a second attempt is a second push.
    expect(err.message).toMatch(/may or may not have landed/i)
    expect(err.message).toMatch(/will not retry/i)
    expect(pushes).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The property the whole module exists for
// ---------------------------------------------------------------------------

describe('there is no force anywhere', () => {
  it('never assembles a forcing argument, on any path this file exercised', async () => {
    const f = await fixture()
    const after = await commitOnTop(f.repo, 'a fix\n')
    await runPush(
      f.repo,
      { remote: 'origin', branch: 'feature', expectedRemoteSha: f.featureSha, sha: after },
      { git: recordingRun },
    )
    // Refusals too — every path, not only the one that succeeds.
    await refusal(
      runPush(
        f.repo,
        { remote: 'origin', branch: 'feature', expectedRemoteSha: after, sha: after },
        { git: recordingRun },
      ),
    )

    const flat = argvLog.map((a) => a.join(' '))
    for (const argv of flat) {
      expect(argv).not.toMatch(/--force/)
      expect(argv).not.toMatch(/--force-with-lease/)
      expect(argv).not.toMatch(/--delete/)
      expect(argv).not.toMatch(/-f\b/)
    }
    // A `+` refspec is a force in a different spelling.
    expect(flat.some((a) => /\s\+[0-9a-f]/.test(a))).toBe(false)
  })

  it('the source itself contains no forcing vocabulary — the protocol cannot express it', async () => {
    const source = await readFile(new URL('./push.ts', import.meta.url), 'utf8')
    // Comments say the words; code must not. Strip block and line comments
    // first so the file can explain itself without failing its own test.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/'--force'/)
    expect(code).not.toMatch(/'--force-with-lease'/)
    expect(code).not.toMatch(/'\+refs\//)
    expect(code).not.toMatch(/reset', '--hard/)
  })
})

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parsePushRequest', () => {
  const good = {
    remote: 'origin',
    branch: 'my-feature',
    expectedRemoteSha: SHA_A,
    sha: SHA_B,
  }

  it('accepts a complete request and lowercases both shas', () => {
    const parsed = parsePushRequest({ ...good, expectedRemoteSha: SHA_A.toUpperCase() })
    expect(parsed).toEqual({ ...good, expectedRemoteSha: SHA_A })
  })

  it('defaults the remote to origin', () => {
    const { remote: _drop, ...noRemote } = good
    expect(parsePushRequest(noRemote)).toMatchObject({ remote: 'origin' })
  })

  it('REQUIRES expectedRemoteSha — without it a push is not a move, it is an overwrite', () => {
    const { expectedRemoteSha: _drop, ...noExpected } = good
    const parsed = parsePushRequest(noExpected)
    expect(parsed).toHaveProperty('error')
    expect((parsed as { error: string }).error).toMatch(/overwrite/i)
  })

  it('refuses a ref path rather than helpfully stripping it', () => {
    const parsed = parsePushRequest({ ...good, branch: 'refs/heads/my-feature' })
    expect((parsed as { error: string }).error).toMatch(/plain branch name/i)
  })

  it.each([
    ['-f', 'a name that could be read as a flag'],
    ['--force', 'the same, spelled out'],
    ['.hidden', 'a leading dot is refname-illegal'],
    ['a..b', 'a double dot is refname-illegal'],
    ['a//b', 'an empty path segment is refname-illegal'],
    ['trailing/', 'a trailing slash is refname-illegal'],
    ['x.lock', 'a .lock suffix is refname-illegal'],
    ['', 'empty'],
  ])('refuses the branch name %j (%s)', (branch) => {
    const parsed = parsePushRequest({ ...good, branch })
    expect(parsed).toHaveProperty('error')
  })

  it.each(['not-a-sha', SHA_A.slice(0, 39), `${SHA_A}0`, 'zzzz'])(
    'refuses %j as a sha',
    (sha) => {
      expect(parsePushRequest({ ...good, sha })).toHaveProperty('error')
      expect(parsePushRequest({ ...good, expectedRemoteSha: sha })).toHaveProperty('error')
    },
  )

  it('refuses a remote name that is not a plain remote name', () => {
    expect(parsePushRequest({ ...good, remote: '--upload-pack=evil' })).toHaveProperty('error')
    expect(parsePushRequest({ ...good, remote: 'https://example.test/r.git' })).toHaveProperty('error')
  })

  it('refuses a non-object body', () => {
    expect(parsePushRequest(null)).toHaveProperty('error')
    expect(parsePushRequest('origin')).toHaveProperty('error')
  })
})

describe('parseLsRemote', () => {
  it('reads the symref and the branch tip out of one listing', () => {
    const out = `ref: refs/heads/main\tHEAD\n${SHA_A}\tHEAD\n${SHA_B}\trefs/heads/feature\n`
    expect(parseLsRemote(out, 'feature')).toEqual({ defaultBranch: 'main', branchSha: SHA_B })
  })

  it('reports a missing branch as null rather than as an error', () => {
    const out = `ref: refs/heads/main\tHEAD\n${SHA_A}\tHEAD\n`
    expect(parseLsRemote(out, 'feature')).toEqual({ defaultBranch: 'main', branchSha: null })
  })

  it('ignores a HEAD that does not point at a branch — that is not a name to compare', () => {
    const out = `ref: refs/tags/v1\tHEAD\n${SHA_A}\tHEAD\n`
    expect(parseLsRemote(out, 'feature').defaultBranch).toBeNull()
  })

  it('does not confuse a similarly named ref for the branch', () => {
    const out = `ref: refs/heads/main\tHEAD\n${SHA_B}\trefs/heads/feature-two\n`
    expect(parseLsRemote(out, 'feature').branchSha).toBeNull()
  })
})

describe('readRemote / remoteExists', () => {
  it('finds a configured remote and not an unconfigured one', async () => {
    const f = await fixture()
    expect(await remoteExists(f.repo, 'origin', recordingRun)).toBe(true)
    expect(await remoteExists(f.repo, 'upstream', recordingRun)).toBe(false)
  })

  it('reads the real default branch and branch tip in one call', async () => {
    const f = await fixture()
    const view = await readRemote(f.repo, 'origin', 'feature', recordingRun)
    expect(view).toEqual({ defaultBranch: 'main', branchSha: f.featureSha })
    // ONE network call, not two: two could disagree, and a check that can be
    // raced is not a check.
    expect(argvLog.filter((a) => a[0] === 'ls-remote')).toHaveLength(1)
  })
})

describe('statusForPushError', () => {
  const kinds: PushFailureKind[] = [
    'bad-request',
    'protected-branch',
    'default-branch-unknown',
    'remote-unknown',
    'branch-missing',
    'commit-unknown',
    'tree-dirty',
    'remote-moved',
    'not-fast-forward',
    'nothing-to-push',
    'remote-unreachable',
    'push-rejected',
    'push-failed',
  ]

  it.each(kinds)('maps %s to a status in range', (kind) => {
    const status = statusForPushError(kind)
    expect(status).toBeGreaterThanOrEqual(400)
    expect(status).toBeLessThan(600)
  })

  it('answers a refusal the caller could act on with a 4xx, never a 5xx', () => {
    for (const kind of ['protected-branch', 'branch-missing', 'remote-moved', 'not-fast-forward', 'tree-dirty'] as const) {
      expect(statusForPushError(kind)).toBeLessThan(500)
    }
  })

  it('answers "the far end said no" with a 502 — the bridge worked', () => {
    expect(statusForPushError('push-rejected')).toBe(502)
    expect(statusForPushError('remote-unreachable')).toBe(502)
  })
})

describe('firstLine', () => {
  it('picks the line that says why, not the progress chatter above it', () => {
    const stderr = [
      'Enumerating objects: 5, done.',
      'Counting objects: 100% (5/5), done.',
      'remote: error: GH006: Protected branch update failed',
      'To github.com:owner/repo.git',
    ].join('\n')
    expect(firstLine(stderr)).toMatch(/Protected branch update failed/)
  })

  it('redacts a URL rather than echoing wherever the remote lives', () => {
    expect(firstLine('fatal: could not read from https://user:tok@example.test/r.git')).toContain('<url>')
    expect(firstLine('fatal: could not read from https://user:tok@example.test/r.git')).not.toContain('tok')
  })

  it('never returns an empty sentence', () => {
    expect(firstLine('')).toBe('no reason given')
    expect(firstLine('\n\n')).toBe('no reason given')
  })

  it('strips control characters and caps the length', () => {
    const noisy = `error: ${'x'.repeat(500)}`
    const out = firstLine(noisy)
    expect(out.length).toBeLessThanOrEqual(301)
    expect(out).not.toContain('')
  })
})
