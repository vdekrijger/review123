// @vitest-environment node
/**
 * worktree.test.ts — the isolation guarantee, tested against a REAL git repo.
 *
 * Everything here uses actual `git` in an actual temp checkout, on purpose.
 * The promise this module makes ("your working tree is never touched") is a
 * promise about git's behaviour, and a mocked git would only prove that the
 * mock behaves. The expensive test is the only honest one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIX_BRANCH_PREFIX } from './protocol.js'
import {
  LINKED_DEPS_DIR,
  commitExists,
  currentHead,
  currentTree,
  detachScratchWorktree,
  discardChanges,
  linkDependencies,
  prepareScratchWorktree,
  readCommitPatch,
  removeOtherScratchWorktrees,
  runGit,
  scratchBranch,
  scratchParentDir,
  scratchSlotDir,
  softResetTo,
  stageAndCommit,
  WorktreeError,
} from './worktree.js'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
}

let repo: string
const created: string[] = []

/** A one-commit repo with a file we can meaningfully edit. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'review123-wt-test-'))
  created.push(dir)
  await runGit(['init', '-q', '-b', 'main', '.'], dir)
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'app.ts'), 'export const value = 1\n')
  await writeFile(join(dir, '.gitignore'), 'node_modules\n')
  await runGit(['add', '-A'], dir)
  await runGit(['commit', '-q', '--no-gpg-sign', '-m', 'init'], dir, { env: IDENTITY })
  return dir
}

async function head(dir: string): Promise<string> {
  return (await currentHead(dir)) ?? ''
}

async function status(dir: string): Promise<string> {
  return (await runGit(['status', '--porcelain'], dir)).stdout
}

async function branchOf(dir: string): Promise<string> {
  return (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  repo = await makeRepo()
})

afterEach(async () => {
  for (const dir of created.splice(0)) {
    // Detach anything we registered so the temp dirs can go away cleanly.
    await runGit(['worktree', 'prune'], dir).catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  const parent = scratchParentDir()
  for (const entry of await readdir(parent).catch(() => [] as string[])) {
    if (entry.includes('review123-wt-test-')) await rm(join(parent, entry), { recursive: true, force: true })
  }
})

describe('scratch slot naming', () => {
  it('lives OUTSIDE the repo — a worktree inside .git reads to a coding agent as git configuration', async () => {
    const sha = await head(repo)
    const dir = scratchSlotDir(repo, sha)
    expect(dir.startsWith(scratchParentDir())).toBe(true)
    expect(dir.startsWith(repo)).toBe(false)
    expect(dir).not.toContain('/.git/')
  })

  it('keys the slot by BOTH repo and head, so two checkouts never collide', async () => {
    const sha = await head(repo)
    expect(scratchSlotDir('/a/project', sha)).not.toBe(scratchSlotDir('/b/project', sha))
    expect(scratchSlotDir(repo, sha)).not.toBe(scratchSlotDir(repo, 'b'.repeat(40)))
  })

  it('names the branch inside the review123/fix/ namespace and nowhere else', () => {
    expect(scratchBranch('abcdef0123456789' + '0'.repeat(24))).toBe(`${FIX_BRANCH_PREFIX}abcdef012345`)
  })
})

describe('commitExists', () => {
  it('accepts the repo HEAD and refuses a sha that is not here', async () => {
    expect(await commitExists(repo, await head(repo))).toBe(true)
    expect(await commitExists(repo, 'f'.repeat(40))).toBe(false)
  })

  it('refuses anything that is not a 40-hex sha, so nothing shaped like a flag reaches git', async () => {
    expect(await commitExists(repo, '--version')).toBe(false)
    expect(await commitExists(repo, 'HEAD')).toBe(false)
    expect(await commitExists(repo, '')).toBe(false)
  })
})

describe('prepareScratchWorktree', () => {
  it('materialises the head commit in its own directory', async () => {
    const sha = await head(repo)
    const wt = await prepareScratchWorktree(repo, sha, { linkDeps: false })
    expect(wt.baseSha).toBe(sha)
    expect(await head(wt.dir)).toBe(sha)
    expect(await readFile(join(wt.dir, 'src', 'app.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  // ---- THE INVARIANT ----
  it('leaves a DIRTY user checkout byte-for-byte unchanged', async () => {
    // The user is mid-work: a modified tracked file AND an untracked one.
    await writeFile(join(repo, 'src', 'app.ts'), 'export const value = 999 // my WIP\n')
    await writeFile(join(repo, 'scratch-notes.md'), 'do not lose me\n')

    const beforeHead = await head(repo)
    const beforeBranch = await branchOf(repo)
    const beforeStatus = await status(repo)
    const beforeApp = await readFile(join(repo, 'src', 'app.ts'), 'utf8')
    const beforeNotes = await readFile(join(repo, 'scratch-notes.md'), 'utf8')

    const wt = await prepareScratchWorktree(repo, beforeHead, { linkDeps: false })
    // …and then do real work in the scratch tree.
    await writeFile(join(wt.dir, 'src', 'app.ts'), 'export const value = 2\n')
    await stageAndCommit(wt.dir, 'fix: change it', 'claude')

    expect(await head(repo)).toBe(beforeHead)
    expect(await branchOf(repo)).toBe(beforeBranch)
    expect(await status(repo)).toBe(beforeStatus)
    expect(await readFile(join(repo, 'src', 'app.ts'), 'utf8')).toBe(beforeApp)
    expect(await readFile(join(repo, 'scratch-notes.md'), 'utf8')).toBe(beforeNotes)
  })

  it('creates exactly ONE ref, inside review123/fix/, and touches no other branch', async () => {
    const sha = await head(repo)
    await runGit(['branch', 'feature/mine'], repo)
    const before = (await runGit(['for-each-ref', '--format=%(refname)'], repo)).stdout.trim().split('\n')

    const wt = await prepareScratchWorktree(repo, sha, { linkDeps: false })

    const after = (await runGit(['for-each-ref', '--format=%(refname)'], repo)).stdout.trim().split('\n')
    const added = after.filter((r) => !before.includes(r))
    expect(added).toEqual([`refs/heads/${wt.branch}`])
    expect(wt.branch.startsWith(FIX_BRANCH_PREFIX)).toBe(true)
    // Every pre-existing ref still points where it did.
    for (const ref of before) expect(after).toContain(ref)
  })

  it('never pushes: the repo has no remote, and nothing tried to reach one', async () => {
    const sha = await head(repo)
    await prepareScratchWorktree(repo, sha, { linkDeps: false })
    const remotes = (await runGit(['remote'], repo)).stdout.trim()
    expect(remotes).toBe('')
    // A push would have failed loudly against a repo with no remote; the
    // absence of any remote-tracking ref is the observable proof.
    const refs = (await runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes'], repo)).stdout.trim()
    expect(refs).toBe('')
  })

  it('REUSES the slot but not the state: a second run starts from the head again', async () => {
    const sha = await head(repo)
    const first = await prepareScratchWorktree(repo, sha, { linkDeps: false })
    await writeFile(join(first.dir, 'src', 'app.ts'), 'export const value = 2\n')
    const stale = await stageAndCommit(first.dir, 'fix: stale work', 'claude')
    expect(stale).not.toBeNull()

    const second = await prepareScratchWorktree(repo, sha, { linkDeps: false })
    expect(second.dir).toBe(first.dir)
    expect(await head(second.dir)).toBe(sha)
    expect(await readFile(join(second.dir, 'src', 'app.ts'), 'utf8')).toBe('export const value = 1\n')
  })

  it('refuses a commit that is not in this repository, before creating anything', async () => {
    const missing = 'a'.repeat(40)
    await expect(prepareScratchWorktree(repo, missing, { linkDeps: false })).rejects.toBeInstanceOf(WorktreeError)
    expect(await exists(scratchSlotDir(repo, missing))).toBe(false)
  })

  it('refuses a sha that is not 40 hex, with head-unknown rather than a git invocation', async () => {
    await expect(prepareScratchWorktree(repo, 'HEAD', { linkDeps: false })).rejects.toMatchObject({
      kind: 'head-unknown',
    })
  })
})

describe('removeOtherScratchWorktrees', () => {
  it('removes only OUR slots, never a worktree the user made', async () => {
    const sha = await head(repo)
    const userWorktree = join(repo, '..', `user-wt-${Date.now()}`)
    await runGit(['worktree', 'add', '--detach', userWorktree, sha], repo)
    created.push(userWorktree)

    const mine = await prepareScratchWorktree(repo, sha, { linkDeps: false })
    const removed = await removeOtherScratchWorktrees(repo, mine.dir)

    expect(removed).not.toContain(userWorktree)
    expect(await exists(userWorktree)).toBe(true)
    expect(await exists(mine.dir)).toBe(true)
  })

  it('retires a stale slot for an OLDER head when a new one is prepared', async () => {
    const first = await head(repo)
    const older = await prepareScratchWorktree(repo, first, { linkDeps: false })

    await writeFile(join(repo, 'src', 'app.ts'), 'export const value = 3\n')
    await runGit(['add', '-A'], repo)
    await runGit(['commit', '-q', '--no-gpg-sign', '-m', 'second'], repo, { env: IDENTITY })
    const second = await head(repo)

    const newer = await prepareScratchWorktree(repo, second, { linkDeps: false })
    expect(newer.dir).not.toBe(older.dir)
    expect(await exists(older.dir)).toBe(false)
  })
})

describe('stageAndCommit', () => {
  it('commits the agent’s work with the bridge identity and returns the sha', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    await writeFile(join(wt.dir, 'src', 'app.ts'), 'export const value = 2\n')
    const sha = await stageAndCommit(wt.dir, 'fix: bump the value', 'claude')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)

    const author = (await runGit(['log', '-1', '--format=%an <%ae>'], wt.dir)).stdout.trim()
    expect(author).toBe('review123 bridge (claude) <bridge@review123.dev>')
  })

  it('returns null when the agent changed nothing — no empty commit is ever made', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    expect(await stageAndCommit(wt.dir, 'fix: nothing', 'claude')).toBeNull()
  })

  it('never commits the linked node_modules, even when the repo does not ignore it', async () => {
    await writeFile(join(repo, '.gitignore'), '')
    await runGit(['add', '-A'], repo)
    await runGit(['commit', '-q', '--no-gpg-sign', '-m', 'unignore deps'], repo, { env: IDENTITY })

    await mkdir(join(repo, LINKED_DEPS_DIR, 'left-pad'), { recursive: true })
    await writeFile(join(repo, LINKED_DEPS_DIR, 'left-pad', 'index.js'), 'module.exports = 1\n')

    const wt = await prepareScratchWorktree(repo, await head(repo))
    expect(wt.linkedDeps).toBe(true)
    await writeFile(join(wt.dir, 'src', 'app.ts'), 'export const value = 2\n')
    const sha = await stageAndCommit(wt.dir, 'fix: bump', 'claude')

    const patch = await readCommitPatch(wt.dir, sha!, 100_000)
    expect(patch!.files).toEqual(['src/app.ts'])
    expect(patch!.diff).not.toContain('left-pad')
  })
})

describe('linkDependencies', () => {
  it('links nothing when the checkout has no node_modules', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    expect(await linkDependencies(repo, wt.dir)).toBe(false)
    expect(await exists(join(wt.dir, LINKED_DEPS_DIR))).toBe(false)
  })

  it('links node_modules and NOTHING else from the user’s checkout', async () => {
    await mkdir(join(repo, LINKED_DEPS_DIR), { recursive: true })
    await writeFile(join(repo, 'secret.env'), 'TOKEN=shh\n')
    const wt = await prepareScratchWorktree(repo, await head(repo))

    expect(wt.linkedDeps).toBe(true)
    expect(await exists(join(wt.dir, LINKED_DEPS_DIR))).toBe(true)
    // The untracked file beside it is NOT reachable from the scratch tree.
    expect(await exists(join(wt.dir, 'secret.env'))).toBe(false)
  })
})

describe('discardChanges', () => {
  it('puts the scratch tree back to HEAD, keeping the linked deps', async () => {
    await mkdir(join(repo, LINKED_DEPS_DIR), { recursive: true })
    const wt = await prepareScratchWorktree(repo, await head(repo))
    await writeFile(join(wt.dir, 'src', 'app.ts'), 'export const value = 99\n')
    await writeFile(join(wt.dir, 'junk.txt'), 'debris\n')

    await discardChanges(wt.dir)

    expect(await readFile(join(wt.dir, 'src', 'app.ts'), 'utf8')).toBe('export const value = 1\n')
    expect(await exists(join(wt.dir, 'junk.txt'))).toBe(false)
    expect(await exists(join(wt.dir, LINKED_DEPS_DIR))).toBe(true)
  })
})

describe('softResetTo', () => {
  it('folds an agent’s own commit back into the working tree, keeping its content', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    const base = await head(wt.dir)
    await writeFile(join(wt.dir, 'src', 'app.ts'), 'export const value = 2\n')
    await runGit(['add', '-A'], wt.dir)
    await runGit(['commit', '-q', '--no-gpg-sign', '-m', 'agent did this'], wt.dir, { env: IDENTITY })
    expect(await head(wt.dir)).not.toBe(base)

    expect(await softResetTo(wt.dir, base)).toBe(true)
    expect(await head(wt.dir)).toBe(base)
    expect(await readFile(join(wt.dir, 'src', 'app.ts'), 'utf8')).toBe('export const value = 2\n')
  })

  it('refuses anything that is not a sha', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    expect(await softResetTo(wt.dir, 'HEAD~1')).toBe(false)
  })
})

describe('readCommitPatch', () => {
  it('returns the subject, the files and the patch', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    await writeFile(join(wt.dir, 'src', 'app.ts'), 'export const value = 2\n')
    const sha = await stageAndCommit(wt.dir, 'fix: bump the value\n\nbody line', 'claude')

    const patch = await readCommitPatch(wt.dir, sha!, 100_000)
    expect(patch!.subject).toBe('fix: bump the value')
    expect(patch!.files).toEqual(['src/app.ts'])
    expect(patch!.diff).toContain('-export const value = 1')
    expect(patch!.diff).toContain('+export const value = 2')
    expect(patch!.truncated).toBe(false)
  })

  it('reports truncation instead of shipping an unbounded patch', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    await writeFile(join(wt.dir, 'src', 'app.ts'), 'x'.repeat(5_000) + '\n')
    const sha = await stageAndCommit(wt.dir, 'fix: big', 'claude')

    const patch = await readCommitPatch(wt.dir, sha!, 200)
    expect(patch!.truncated).toBe(true)
    expect(patch!.diff.length).toBeLessThanOrEqual(200)
  })

  it('refuses a non-sha rather than passing it to git', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    expect(await readCommitPatch(wt.dir, '--output=/tmp/pwned', 100)).toBeNull()
  })
})

describe('currentTree', () => {
  it('changes when the content changes and repeats when the content comes back', async () => {
    const wt = await prepareScratchWorktree(repo, await head(repo), { linkDeps: false })
    const base = await currentTree(wt.dir)

    await writeFile(join(wt.dir, 'src', 'app.ts'), 'export const value = 2\n')
    await stageAndCommit(wt.dir, 'fix: forward', 'claude')
    const changed = await currentTree(wt.dir)
    expect(changed).not.toBe(base)

    await writeFile(join(wt.dir, 'src', 'app.ts'), 'export const value = 1\n')
    await stageAndCommit(wt.dir, 'fix: back again', 'claude')
    // The oscillation signal the loop's `repeat-diff` stop reads.
    expect(await currentTree(wt.dir)).toBe(base)
  })
})

describe('detachScratchWorktree', () => {
  it('is safe to call on a slot that is not there', async () => {
    await expect(detachScratchWorktree(repo, join(scratchParentDir(), 'nope'))).resolves.toBeUndefined()
  })
})
