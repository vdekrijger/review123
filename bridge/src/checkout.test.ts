// @vitest-environment node
/**
 * checkout.test.ts — the route family that moves the user's own working tree.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THESE TESTS USE REAL GIT REPOSITORIES, ON PURPOSE.
 *
 * Every other module in this package can be tested against an injected runner,
 * because what is being asserted is which argv was assembled. Not this one.
 * The promise here is "nothing you have written is ever destroyed", and a
 * mocked git proves nothing about that — it would happily report success for a
 * command that, run for real, would have eaten someone's afternoon.
 *
 * So the harness builds a real repo with real uncommitted content, runs the
 * real commands, and then READS THE FILES BACK. The assertion that matters in
 * half this file is literally "the bytes are still there".
 *
 * The injected runner IS used, alongside the real one, for a second purpose: a
 * recording wrapper collects every argv the module ever passes to git, and one
 * test asserts that the destructive vocabulary — --force, reset --hard, clean,
 * stash drop, checkout -f — never appears in any of them, on any path.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CheckoutError,
  applyStash,
  branchExists,
  clearPriorState,
  parseCheckoutRequest,
  parseRestoreRequest,
  readDirtyState,
  readPriorState,
  readTreeState,
  runCheckout,
  runRestore,
  stashDropCommand,
  statusForCheckoutError,
  writePriorState,
} from './checkout.js'
import { runGit, type GitRun } from './worktree.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const scratchDirs: string[] = []

/**
 * Every argv this test file's git calls have seen, in order, across the whole
 * run. The "nothing is ever forced" test reads it.
 */
let argvLog: string[][] = []

/** The real runner, wrapped so every invocation is recorded. */
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
  const dir = await mkdtemp(join(tmpdir(), `bridge-checkout-${prefix}-`))
  scratchDirs.push(dir)
  return dir
}

/** Run git in `cwd` and throw on failure — harness setup, not code under test. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await runGit(args, cwd, { timeoutMs: 30_000 })
  if (res.code !== 0) {
    throw new Error(`harness git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  }
  return res.stdout.trim()
}

interface Fixture {
  /** The user's checkout — the tree under test. */
  repo: string
  /** A second repo standing in for `origin`, holding the PR ref. */
  remote: string
  /** The sha `refs/pull/1/head` points at in the remote. */
  prSha: string
  /** The sha the user's `main` is on before anything happens. */
  mainSha: string
  /** Where the prior-state record is written (a disposable fake home). */
  home: string
}

/**
 * A realistic starting point: a repo on `main` with one commit, a `origin`
 * remote that has a `refs/pull/1/head` carrying a different commit, and a
 * throwaway home directory for the prior-state record.
 */
async function fixture(): Promise<Fixture> {
  const remote = await scratch('remote')
  await git(remote, 'init', '--quiet', '--initial-branch=main')
  await git(remote, 'config', 'user.email', 'harness@test.invalid')
  await git(remote, 'config', 'user.name', 'harness')
  await writeFile(join(remote, 'app.txt'), 'base\n', 'utf8')
  await git(remote, 'add', '-A')
  await git(remote, 'commit', '--quiet', '-m', 'base')
  const mainSha = await git(remote, 'rev-parse', 'HEAD')

  // The "pull request": one more commit, parked at a PR ref the way a forge
  // exposes one. No branch — exactly how refs/pull/N/head arrives.
  await writeFile(join(remote, 'app.txt'), 'from the pull request\n', 'utf8')
  await writeFile(join(remote, 'added-by-pr.txt'), 'new file\n', 'utf8')
  await git(remote, 'add', '-A')
  await git(remote, 'commit', '--quiet', '-m', 'the pull request')
  const prSha = await git(remote, 'rev-parse', 'HEAD')
  await git(remote, 'update-ref', 'refs/pull/1/head', prSha)
  // Put the remote back on the base commit so its own HEAD is not the PR.
  await git(remote, 'reset', '--quiet', '--hard', mainSha)

  const repo = await scratch('repo')
  await git(repo, 'clone', '--quiet', remote, '.')
  await git(repo, 'config', 'user.email', 'harness@test.invalid')
  await git(repo, 'config', 'user.name', 'harness')
  await git(repo, 'checkout', '--quiet', 'main')

  return { repo, remote, prSha, mainSha, home: await scratch('home') }
}

/** The request shape `runCheckout` takes, with the safe defaults filled in. */
function checkoutReq(overrides: Partial<Parameters<typeof runCheckout>[1]> = {}) {
  return {
    ref: 'refs/pull/1/head',
    remote: 'origin',
    stashDirty: false,
    acknowledgeUntrusted: true,
    ...overrides,
  }
}

function restoreReq(overrides: Partial<Parameters<typeof runRestore>[1]> = {}) {
  return {
    stashDirty: false,
    detachToSha: false,
    acknowledgeMoved: false,
    restoreStash: false,
    ...overrides,
  }
}

/** Assert a call rejects with a CheckoutError of exactly this kind. */
async function expectRefusal(
  promise: Promise<unknown>,
  kind: string,
): Promise<CheckoutError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(CheckoutError)
    expect((err as CheckoutError).kind).toBe(kind)
    return err as CheckoutError
  }
  throw new Error(`expected a ${kind} refusal, but the call resolved`)
}

// ---------------------------------------------------------------------------
// Request parsing — the ref is the one field that becomes a git argv element
// ---------------------------------------------------------------------------

describe('parseCheckoutRequest', () => {
  it('accepts every provider PR ref shape', () => {
    for (const ref of [
      'refs/pull/42/head',
      'refs/merge-requests/7/head',
      'refs/pull-requests/12/from',
      'refs/heads/feat/some-branch',
    ]) {
      expect(parseCheckoutRequest({ ref })).toMatchObject({ ref, remote: 'origin' })
    }
  })

  // THE GUARD. A value starting with `-` would be read by git as a FLAG even
  // through a spawn argv array, and `refs/` makes that impossible by
  // construction.
  it('REFUSES anything that could be read as a git flag', () => {
    for (const ref of [
      '--upload-pack=touch /tmp/pwned',
      '-x',
      '--exec=rm -rf /',
      'HEAD',
      'main',
      '/etc/passwd',
    ]) {
      expect(parseCheckoutRequest({ ref })).toHaveProperty('error')
    }
  })

  it('refuses refname-illegal shapes even under the refs/ prefix', () => {
    for (const ref of [
      'refs/pull/../../evil',
      'refs/pull//1/head',
      'refs/pull/1/head/',
      'refs/heads/x.lock',
    ]) {
      expect(parseCheckoutRequest({ ref })).toHaveProperty('error')
    }
  })

  it('refuses a missing ref, a non-string ref and a non-object body', () => {
    expect(parseCheckoutRequest({})).toHaveProperty('error')
    expect(parseCheckoutRequest({ ref: 42 })).toHaveProperty('error')
    expect(parseCheckoutRequest(null)).toHaveProperty('error')
    expect(parseCheckoutRequest('refs/pull/1/head')).toHaveProperty('error')
  })

  it('defaults the remote to origin and refuses a flag-shaped one', () => {
    expect(parseCheckoutRequest({ ref: 'refs/pull/1/head' })).toMatchObject({ remote: 'origin' })
    expect(parseCheckoutRequest({ ref: 'refs/pull/1/head', remote: 'upstream' })).toMatchObject({
      remote: 'upstream',
    })
    expect(
      parseCheckoutRequest({ ref: 'refs/pull/1/head', remote: '--upload-pack=x' }),
    ).toHaveProperty('error')
  })

  // For flags that authorise moving someone's work, "unknown" must never read
  // as consent — the same rule parseGitState applies to `dirty`.
  it('treats anything but a literal true as NOT consent', () => {
    const parsed = parseCheckoutRequest({
      ref: 'refs/pull/1/head',
      stashDirty: 'yes',
      acknowledgeUntrusted: 1,
    })
    expect(parsed).toMatchObject({ stashDirty: false, acknowledgeUntrusted: false })
  })
})

describe('parseRestoreRequest', () => {
  it('treats an absent body as a plain restore with no special cases', () => {
    expect(parseRestoreRequest(null)).toEqual({
      stashDirty: false,
      detachToSha: false,
      acknowledgeMoved: false,
      restoreStash: false,
    })
  })

  it('reads each consent independently, and only from a literal true', () => {
    expect(parseRestoreRequest({ restoreStash: true, detachToSha: 'true' })).toEqual({
      stashDirty: false,
      detachToSha: false,
      acknowledgeMoved: false,
      restoreStash: true,
    })
  })
})

describe('statusForCheckoutError', () => {
  it('maps an answerable refusal to 409, not 400', () => {
    expect(statusForCheckoutError('tree-dirty')).toBe(409)
    expect(statusForCheckoutError('prior-gone')).toBe(409)
    expect(statusForCheckoutError('moved-since')).toBe(409)
  })

  it('maps the missing acknowledgement to 403 — it is an authorisation failure', () => {
    expect(statusForCheckoutError('untrusted-unacknowledged')).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

describe('readDirtyState', () => {
  it('reports a clean tree as clean', async () => {
    const { repo } = await fixture()
    expect(await readDirtyState(repo)).toEqual({ dirty: false, paths: [], count: 0 })
  })

  it('reports a modified tracked file', async () => {
    const { repo } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'edited\n', 'utf8')
    const dirty = await readDirtyState(repo)
    expect(dirty.dirty).toBe(true)
    expect(dirty.paths).toContain('app.txt')
  })

  // Untracked counts, matching readGitState's broad definition: an untracked
  // file is still work a checkout could refuse over.
  it('counts an UNTRACKED file as dirty', async () => {
    const { repo } = await fixture()
    await writeFile(join(repo, 'scratch-note.txt'), 'mine\n', 'utf8')
    const dirty = await readDirtyState(repo)
    expect(dirty.dirty).toBe(true)
    expect(dirty.paths).toContain('scratch-note.txt')
  })

  it('reports a FAILED probe as dirty — unknown never renders as the safe answer', async () => {
    const failing: GitRun = async () => ({
      code: 1,
      stdout: '',
      stderr: 'boom',
      timedOut: false,
      spawnFailed: true,
    })
    expect(await readDirtyState('/nowhere', failing)).toMatchObject({ dirty: true })
  })
})

describe('readTreeState', () => {
  it('reports the branch and sha on a branch', async () => {
    const { repo, mainSha } = await fixture()
    expect(await readTreeState(repo)).toEqual({ head: mainSha, branch: 'main', dirty: false })
  })

  it('reports a detached HEAD as a null branch, with the sha intact', async () => {
    const { repo, mainSha } = await fixture()
    await git(repo, 'checkout', '--quiet', '--detach', mainSha)
    expect(await readTreeState(repo)).toEqual({ head: mainSha, branch: null, dirty: false })
  })

  it('reports null for a directory that is not a repo', async () => {
    expect(await readTreeState(await scratch('empty'))).toBeNull()
  })
})

describe('branchExists', () => {
  it('finds a live branch and misses a deleted one', async () => {
    const { repo, mainSha } = await fixture()
    await git(repo, 'branch', 'side', mainSha)
    expect(await branchExists(repo, 'side')).toBe(true)
    await git(repo, 'branch', '-D', 'side')
    expect(await branchExists(repo, 'side')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Prior-state persistence
// ---------------------------------------------------------------------------

describe('the prior-state record', () => {
  const sample = {
    branch: 'main',
    head: 'a'.repeat(40),
    recordedAt: '2026-01-01T00:00:00.000Z',
    checkedOutRef: 'refs/pull/1/head',
    checkedOutSha: 'b'.repeat(40),
    stashRef: null,
  }

  it('round-trips', async () => {
    const home = await scratch('home')
    await writePriorState('/repo/a', sample, home)
    expect(await readPriorState('/repo/a', home)).toEqual(sample)
  })

  it('is keyed by repo — one repo never reads another repo’s way home', async () => {
    const home = await scratch('home')
    await writePriorState('/repo/a', sample, home)
    expect(await readPriorState('/repo/b', home)).toBeNull()
  })

  it('survives being read when nothing was ever written', async () => {
    expect(await readPriorState('/repo/never', await scratch('home'))).toBeNull()
  })

  // A record we cannot fully trust is not a record — the same shape
  // readGitState uses for "no match provable".
  it('reads a corrupt or foreign record as ABSENT rather than trusting it', async () => {
    const home = await scratch('home')
    await writePriorState('/repo/a', sample, home)
    // Find the file the writer chose and replace its contents.
    const { stateFileFor } = await import('./checkout.js')
    const file = stateFileFor('/repo/a', home)

    await writeFile(file, 'not json at all', 'utf8')
    expect(await readPriorState('/repo/a', home)).toBeNull()

    await writeFile(file, JSON.stringify({ ...sample, version: 99, root: '/repo/a' }), 'utf8')
    expect(await readPriorState('/repo/a', home)).toBeNull()

    // A record whose `root` is somebody else's, sitting at our key.
    await writeFile(file, JSON.stringify({ ...sample, version: 1, root: '/repo/other' }), 'utf8')
    expect(await readPriorState('/repo/a', home)).toBeNull()

    // A head that is not a sha.
    await writeFile(
      file,
      JSON.stringify({ ...sample, head: 'HEAD', version: 1, root: '/repo/a' }),
      'utf8',
    )
    expect(await readPriorState('/repo/a', home)).toBeNull()
  })

  it('clears without complaint when there is nothing to clear', async () => {
    const home = await scratch('home')
    await expect(clearPriorState('/repo/nothing', home)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Checkout — the gates
// ---------------------------------------------------------------------------

describe('runCheckout — the untrusted-code gate', () => {
  it('REFUSES without acknowledgeUntrusted, before anything happens', async () => {
    const { repo, home, mainSha } = await fixture()
    await expectRefusal(
      runCheckout(repo, checkoutReq({ acknowledgeUntrusted: false }), { home }),
      'untrusted-unacknowledged',
    )
    // Nothing moved, and no record was written.
    expect((await readTreeState(repo))?.head).toBe(mainSha)
    expect(await readPriorState(repo, home)).toBeNull()
  })

  it('names the risk in the refusal, rather than saying "forbidden"', async () => {
    const { repo, home } = await fixture()
    const err = await expectRefusal(
      runCheckout(repo, checkoutReq({ acknowledgeUntrusted: false }), { home }),
      'untrusted-unacknowledged',
    )
    expect(err.message).toMatch(/running its code/i)
  })
})

describe('runCheckout — the dirty gate', () => {
  it('REFUSES a dirty tree and names exactly what is dirty', async () => {
    const { repo, home } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'my unsaved work\n', 'utf8')
    await writeFile(join(repo, 'notes.txt'), 'my untracked notes\n', 'utf8')

    const err = await expectRefusal(runCheckout(repo, checkoutReq(), { home }), 'tree-dirty')
    expect(err.dirtyPaths).toEqual(expect.arrayContaining(['app.txt', 'notes.txt']))
    expect(err.dirtyCount).toBe(2)
  })

  // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
  it('leaves every byte of the dirty content exactly where it was', async () => {
    const { repo, home, mainSha } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'my unsaved work\n', 'utf8')
    await writeFile(join(repo, 'notes.txt'), 'my untracked notes\n', 'utf8')

    await expectRefusal(runCheckout(repo, checkoutReq(), { home }), 'tree-dirty')

    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('my unsaved work\n')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('my untracked notes\n')
    expect((await readTreeState(repo))?.head).toBe(mainSha)
    expect((await readTreeState(repo))?.branch).toBe('main')
    // And nothing was quietly stashed "to be helpful".
    expect(await git(repo, 'stash', 'list')).toBe('')
  })

  it('refuses a dirty tree BEFORE fetching anything', async () => {
    const { repo, home } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'work\n', 'utf8')
    argvLog = []
    await expectRefusal(runCheckout(repo, checkoutReq(), { home, run: recordingRun }), 'tree-dirty')
    expect(argvLog.some((args) => args[0] === 'fetch')).toBe(false)
  })
})

describe('runCheckout — the happy path', () => {
  it('fetches the ref, lands on it detached, and reports the new state', async () => {
    const { repo, home, prSha } = await fixture()
    const result = await runCheckout(repo, checkoutReq(), { home })

    expect(result.git.head).toBe(prSha)
    // Detached on purpose: no ref is created, so there is nothing to clean up.
    expect(result.git.branch).toBeNull()
    expect(result.stash).toBeNull()
    // The pull request's content is actually on disk — the dev server will
    // serve THIS.
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('from the pull request\n')
    expect(existsSync(join(repo, 'added-by-pr.txt'))).toBe(true)
  })

  it('records where the user was, BEFORE moving, and persists it', async () => {
    const { repo, home, mainSha, prSha } = await fixture()
    const result = await runCheckout(repo, checkoutReq(), { home })

    expect(result.prior).toMatchObject({
      branch: 'main',
      head: mainSha,
      checkedOutRef: 'refs/pull/1/head',
      checkedOutSha: prSha,
      stashRef: null,
    })
    // Persisted, so a bridge restart cannot strand the user.
    expect(await readPriorState(repo, home)).toEqual(result.prior)
  })

  it('records a DETACHED starting point as a null branch with its sha', async () => {
    const { repo, home, mainSha } = await fixture()
    await git(repo, 'checkout', '--quiet', '--detach', mainSha)

    const result = await runCheckout(repo, checkoutReq(), { home })
    expect(result.prior.branch).toBeNull()
    expect(result.prior.head).toBe(mainSha)
  })

  it('creates NO new ref — nothing to clean up afterwards', async () => {
    const { repo, home } = await fixture()
    const before = await git(repo, 'for-each-ref', '--format=%(refname)')
    await runCheckout(repo, checkoutReq(), { home })
    expect(await git(repo, 'for-each-ref', '--format=%(refname)')).toBe(before)
  })

  it('refuses a ref the remote does not have, without moving anything', async () => {
    const { repo, home, mainSha } = await fixture()
    await expectRefusal(
      runCheckout(repo, checkoutReq({ ref: 'refs/pull/999/head' }), { home }),
      'ref-unknown',
    )
    expect((await readTreeState(repo))?.head).toBe(mainSha)
  })
})

describe('runCheckout — the stash path', () => {
  it('moves the work into a stash entry on explicit consent, and records its sha', async () => {
    const { repo, home, prSha } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'my unsaved work\n', 'utf8')
    await writeFile(join(repo, 'notes.txt'), 'my untracked notes\n', 'utf8')

    const result = await runCheckout(repo, checkoutReq({ stashDirty: true }), { home })

    expect(result.git.head).toBe(prSha)
    expect(result.stash).toMatchObject({ action: 'created' })
    expect(result.stash?.ref).toMatch(/^[0-9a-f]{40}$/)
    expect(result.prior.stashRef).toBe(result.stash?.ref)
    // The tree is the PR's now…
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('from the pull request\n')
    // …and the work is SAFE in the stash, not gone.
    expect(await git(repo, 'stash', 'list')).toMatch(/review123-bridge/)
  })

  it('the stashed content is recoverable, byte for byte', async () => {
    const { repo, home } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'my unsaved work\n', 'utf8')
    await writeFile(join(repo, 'notes.txt'), 'my untracked notes\n', 'utf8')

    const result = await runCheckout(repo, checkoutReq({ stashDirty: true }), { home })
    const stashRef = result.stash!.ref

    // Read the stashed blobs straight out of the object store, by sha.
    expect(await git(repo, 'show', `${stashRef}:app.txt`)).toBe('my unsaved work')
    // An untracked file lives on the stash's third parent, which `-u` creates.
    expect(await git(repo, 'show', `${stashRef}^3:notes.txt`)).toBe('my untracked notes')
  })

  it('hands back the command that drops the entry, rather than dropping it', async () => {
    const { repo, home } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'work\n', 'utf8')
    const result = await runCheckout(repo, checkoutReq({ stashDirty: true }), { home })
    expect(result.stash?.dropCommand).toBe(stashDropCommand(result.stash!.ref))
    expect(result.stash?.dropCommand).toMatch(/^git stash drop /)
    // The entry is still there — the bridge did not drop it.
    expect(await git(repo, 'stash', 'list')).not.toBe('')
  })

  it('does not stash when the fetch fails — no work parked for a move that never happened', async () => {
    const { repo, home } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'work\n', 'utf8')
    await expectRefusal(
      runCheckout(repo, checkoutReq({ ref: 'refs/pull/999/head', stashDirty: true }), { home }),
      'ref-unknown',
    )
    expect(await git(repo, 'stash', 'list')).toBe('')
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('work\n')
  })
})

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

describe('runRestore', () => {
  it('refuses when nothing was recorded', async () => {
    const { repo, home } = await fixture()
    await expectRefusal(runRestore(repo, restoreReq(), { home }), 'no-prior-state')
  })

  it('returns the user to the EXACT branch and commit they came from', async () => {
    const { repo, home, mainSha } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })

    const result = await runRestore(repo, restoreReq(), { home })
    expect(result.git).toEqual({ head: mainSha, branch: 'main', dirty: false })
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('base\n')
    // The PR's added file is gone from the tree, as it must be.
    expect(existsSync(join(repo, 'added-by-pr.txt'))).toBe(false)
  })

  it('consumes the record, so a second restore has nothing to do', async () => {
    const { repo, home } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })
    await runRestore(repo, restoreReq(), { home })
    expect(await readPriorState(repo, home)).toBeNull()
    await expectRefusal(runRestore(repo, restoreReq(), { home }), 'no-prior-state')
  })

  it('returns to a DETACHED starting point exactly, when that is where they were', async () => {
    const { repo, home, mainSha } = await fixture()
    await git(repo, 'checkout', '--quiet', '--detach', mainSha)
    await runCheckout(repo, checkoutReq(), { home })

    const result = await runRestore(repo, restoreReq(), { home })
    expect(result.git).toEqual({ head: mainSha, branch: null, dirty: false })
  })

  it('refuses a tree dirtied SINCE the checkout, and the content survives', async () => {
    const { repo, home } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })
    await writeFile(join(repo, 'while-on-the-pr.txt'), 'notes I took\n', 'utf8')

    const err = await expectRefusal(runRestore(repo, restoreReq(), { home }), 'tree-dirty')
    expect(err.dirtyPaths).toContain('while-on-the-pr.txt')
    expect(await readFile(join(repo, 'while-on-the-pr.txt'), 'utf8')).toBe('notes I took\n')
  })

  it('stashes that new work on explicit consent, then restores', async () => {
    const { repo, home, mainSha } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })
    await writeFile(join(repo, 'while-on-the-pr.txt'), 'notes I took\n', 'utf8')

    const result = await runRestore(repo, restoreReq({ stashDirty: true }), { home })
    expect(result.git.head).toBe(mainSha)
    expect(result.stash).toMatchObject({ action: 'created' })
    expect(await git(repo, 'show', `${result.stash!.ref}^3:while-on-the-pr.txt`)).toBe('notes I took')
  })

  // ---- The branch was deleted while they were on the PR ----

  it('refuses when the recorded branch is GONE, and says the sha is still there', async () => {
    const { repo, home, mainSha } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })
    await git(repo, 'branch', '-D', 'main')

    const err = await expectRefusal(runRestore(repo, restoreReq(), { home }), 'prior-gone')
    expect(err.message).toContain('main')
    expect(err.message).toContain(mainSha.slice(0, 7))
    // Still on the PR — nothing was done on a guess.
    expect((await readTreeState(repo))?.head).not.toBe(mainSha)
  })

  it('restores to the recorded sha detached, on the explicit detachToSha answer', async () => {
    const { repo, home, mainSha } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })
    await git(repo, 'branch', '-D', 'main')

    const result = await runRestore(repo, restoreReq({ detachToSha: true }), { home })
    expect(result.git).toEqual({ head: mainSha, branch: null, dirty: false })
  })

  // ---- They moved HEAD by hand since ----

  it('refuses when HEAD is not where the checkout left it', async () => {
    const { repo, home, mainSha } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })
    // The user wandered off by hand.
    await git(repo, 'checkout', '--quiet', 'main')

    const err = await expectRefusal(runRestore(repo, restoreReq(), { home }), 'moved-since')
    expect(err.message).toContain(mainSha.slice(0, 7))
  })

  it('restores anyway on the explicit acknowledgeMoved answer', async () => {
    const { repo, home, mainSha } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })
    await git(repo, 'checkout', '--quiet', '--detach', mainSha)

    const result = await runRestore(repo, restoreReq({ acknowledgeMoved: true }), { home })
    expect(result.git).toEqual({ head: mainSha, branch: 'main', dirty: false })
  })

  // ---- The stash, applied ----

  it('applies the checkout-time stash on request, and does NOT drop it', async () => {
    const { repo, home } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'my unsaved work\n', 'utf8')
    await writeFile(join(repo, 'notes.txt'), 'my untracked notes\n', 'utf8')
    const checkedOut = await runCheckout(repo, checkoutReq({ stashDirty: true }), { home })

    const result = await runRestore(repo, restoreReq({ restoreStash: true }), { home })

    expect(result.stash).toMatchObject({ action: 'applied', ref: checkedOut.stash!.ref })
    // The work is BACK in the tree…
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('my unsaved work\n')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('my untracked notes\n')
    // …AND still in the stash list, because apply never drops.
    expect(await git(repo, 'stash', 'list')).toMatch(/review123-bridge/)
  })

  it('leaves the stash alone when restoreStash was not asked for', async () => {
    const { repo, home } = await fixture()
    await writeFile(join(repo, 'app.txt'), 'my unsaved work\n', 'utf8')
    await runCheckout(repo, checkoutReq({ stashDirty: true }), { home })

    const result = await runRestore(repo, restoreReq(), { home })
    expect(result.stash).toBeNull()
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('base\n')
    // Untouched and recoverable.
    expect(await git(repo, 'stash', 'list')).toMatch(/review123-bridge/)
  })
})

describe('applyStash', () => {
  it('refuses anything that is not a sha, so no stash@{n} can slip in', async () => {
    const { repo } = await fixture()
    expect(await applyStash(repo, 'stash@{0}')).toBe(false)
    expect(await applyStash(repo, 'refs/stash')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// THE INVARIANT, asserted over every command this module has ever run
// ---------------------------------------------------------------------------

describe('nothing is ever forced, reset or discarded', () => {
  /**
   * Exercise every path — the refusals and the successes — through the
   * recording runner, then read the whole argv log at once.
   *
   * A test per command would be easy to satisfy and easy to fool. Collecting
   * the vocabulary across every path and asserting the destructive words never
   * appear is the assertion that actually holds the promise, and it keeps
   * holding as paths are added.
   */
  it('never issues a destructive git command on any path', async () => {
    const { repo, home, mainSha } = await fixture()
    const deps = { home, run: recordingRun }
    argvLog = []

    // Refusals.
    await expectRefusal(
      runCheckout(repo, checkoutReq({ acknowledgeUntrusted: false }), deps),
      'untrusted-unacknowledged',
    )
    await writeFile(join(repo, 'work.txt'), 'mine\n', 'utf8')
    await expectRefusal(runCheckout(repo, checkoutReq(), deps), 'tree-dirty')
    await expectRefusal(runRestore(repo, restoreReq(), deps), 'no-prior-state')

    // The stash path, a checkout, a dirty restore refusal, and a full restore.
    await runCheckout(repo, checkoutReq({ stashDirty: true }), deps)
    await writeFile(join(repo, 'more.txt'), 'also mine\n', 'utf8')
    await expectRefusal(runRestore(repo, restoreReq(), deps), 'tree-dirty')
    await runRestore(repo, restoreReq({ stashDirty: true, restoreStash: true }), deps)

    const flat = argvLog.map((args) => args.join(' '))
    expect(flat.length).toBeGreaterThan(10)

    for (const command of flat) {
      expect(command).not.toMatch(/--force\b/)
      expect(command).not.toMatch(/(^|\s)-f($|\s)/)
      expect(command).not.toMatch(/reset\s+.*--hard/)
      expect(command).not.toMatch(/^clean\b/)
      expect(command).not.toMatch(/^stash (drop|clear|pop)\b/)
      expect(command).not.toMatch(/^push\b/)
      expect(command).not.toMatch(/^branch -D\b/)
    }

    // And the positive half: the ONE way work moved was a stash push, and the
    // ONE way it came back was an apply.
    expect(flat.some((c) => c.startsWith('stash push'))).toBe(true)
    expect(flat.some((c) => c.startsWith('stash apply'))).toBe(true)

    // Ended up home, with the work restored.
    expect(await readTreeState(repo)).toMatchObject({ head: mainSha, branch: 'main' })
    expect(await readFile(join(repo, 'work.txt'), 'utf8')).toBe('mine\n')
  })

  it('never writes its record inside the repo — that would dirty the tree', async () => {
    const { repo, home } = await fixture()
    await runCheckout(repo, checkoutReq(), { home })
    // The tree it just checked out is clean: the record went to `home`.
    expect((await readTreeState(repo))?.dirty).toBe(false)
    expect(existsSync(join(repo, '.review123-bridge'))).toBe(false)
  })
})
