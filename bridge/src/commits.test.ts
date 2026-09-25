// @vitest-environment node
/**
 * commits.test.ts — the containment probe, against a REAL git repo.
 *
 * THE POINT OF THIS FILE, in one sentence: a commit that is in the object store
 * is present whatever the working tree happens to be sitting on, and a commit
 * the repository has never seen is absent — which is the exact distinction the
 * fix loop's readiness rule was missing when it compared HEAD for equality.
 *
 * Real git, like worktree.test.ts, and for the same reason: the claim is a claim
 * about git's behaviour, and a mocked git would only prove the mock behaves.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_COMMIT_PROBE_SHAS } from './protocol.js'
import { parseCommitsRequest, presentCommits } from './commits.js'
import { currentHead, runGit } from './worktree.js'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
}

/** A sha that is a legal 40-hex id and cannot be in anybody's object store. */
const NEVER_SEEN = '0'.repeat(39) + '1'

const created: string[] = []

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'review123-commits-test-'))
  created.push(dir)
  await runGit(['init', '-q', '-b', 'main', '.'], dir)
  await writeFile(join(dir, 'a.txt'), 'one\n')
  await runGit(['add', '-A'], dir)
  await runGit(['commit', '-q', '--no-gpg-sign', '-m', 'one'], dir, { env: IDENTITY })
  return dir
}

async function commitOnBranch(dir: string, branch: string, body: string): Promise<string> {
  await runGit(['checkout', '-q', '-b', branch], dir)
  await writeFile(join(dir, 'a.txt'), body)
  await runGit(['add', '-A'], dir)
  await runGit(['commit', '-q', '--no-gpg-sign', '-m', body.trim()], dir, { env: IDENTITY })
  return (await currentHead(dir)) ?? ''
}

afterEach(async () => {
  while (created.length > 0) {
    await rm(created.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

describe('presentCommits', () => {
  it('finds a commit the checkout is NOT sitting on — the whole reason it exists', async () => {
    const repo = await makeRepo()
    const feature = await commitOnBranch(repo, 'feature', 'two\n')
    // Go back to main. `feature`'s commit is now on no checked-out branch, and
    // HEAD is a different sha entirely — the state a queue of twenty pull
    // requests puts every row but one in.
    await runGit(['checkout', '-q', 'main'], repo)
    const head = (await currentHead(repo)) ?? ''
    expect(head).not.toBe(feature)

    expect(await presentCommits(repo, [feature])).toEqual([feature])
  })

  it('leaves out a commit this repository has never seen', async () => {
    const repo = await makeRepo()
    expect(await presentCommits(repo, [NEVER_SEEN])).toEqual([])
  })

  it('answers a mixed batch in one call, keeping only what is here', async () => {
    const repo = await makeRepo()
    const feature = await commitOnBranch(repo, 'feature', 'two\n')
    await runGit(['checkout', '-q', 'main'], repo)
    const head = (await currentHead(repo)) ?? ''

    expect(await presentCommits(repo, [head, NEVER_SEEN, feature])).toEqual([head, feature])
  })

  it('refuses an id that resolves to something other than a commit', async () => {
    const repo = await makeRepo()
    // A TREE sha is a real object in this store. `^{commit}` is what stops a
    // worktree ever being attempted at one.
    const tree = (await runGit(['rev-parse', 'HEAD^{tree}'], repo)).stdout.trim()
    expect(tree).toMatch(/^[0-9a-f]{40}$/)
    expect(await presentCommits(repo, [tree])).toEqual([])
  })

  it('reports nothing present when the root is not a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review123-commits-nonrepo-'))
    created.push(dir)
    expect(await presentCommits(dir, [NEVER_SEEN])).toEqual([])
  })

  it('creates no worktree, no branch and no ref — it is a read', async () => {
    const repo = await makeRepo()
    const feature = await commitOnBranch(repo, 'feature', 'two\n')
    await runGit(['checkout', '-q', 'main'], repo)

    const refsBefore = (await runGit(['for-each-ref', '--format=%(refname)'], repo)).stdout
    const treesBefore = (await runGit(['worktree', 'list', '--porcelain'], repo)).stdout
    await presentCommits(repo, [feature])
    expect((await runGit(['for-each-ref', '--format=%(refname)'], repo)).stdout).toBe(refsBefore)
    expect((await runGit(['worktree', 'list', '--porcelain'], repo)).stdout).toBe(treesBefore)
  })
})

describe('parseCommitsRequest', () => {
  const sha = 'a'.repeat(40)

  it('accepts a list of full shas', () => {
    expect(parseCommitsRequest({ shas: [sha] })).toEqual({ shas: [sha] })
  })

  it('lowercases, because the client compares lowercase and GitHub sends both', () => {
    expect(parseCommitsRequest({ shas: [sha.toUpperCase()] })).toEqual({ shas: [sha] })
  })

  it('collapses duplicates rather than looking the same commit up twice', () => {
    expect(parseCommitsRequest({ shas: [sha, sha] })).toEqual({ shas: [sha] })
  })

  it.each([
    ['not an object', 'nope'],
    ['no shas at all', {}],
    ['an empty list', { shas: [] }],
    ['an abbreviated sha', { shas: ['abc1234'] }],
    ['a non-string entry', { shas: [7] }],
    ['a ref name', { shas: ['refs/heads/main'] }],
    ['something that could be read as a flag', { shas: ['--upload-pack=touch /tmp/x'] }],
  ])('refuses %s', (_label, body) => {
    expect(parseCommitsRequest(body)).toHaveProperty('error')
  })

  it(`refuses more than ${MAX_COMMIT_PROBE_SHAS} at once`, () => {
    const many = Array.from({ length: MAX_COMMIT_PROBE_SHAS + 1 }, (_, i) =>
      i.toString(16).padStart(40, '0'),
    )
    expect(parseCommitsRequest({ shas: many })).toHaveProperty('error')
    expect(parseCommitsRequest({ shas: many.slice(0, MAX_COMMIT_PROBE_SHAS) })).not.toHaveProperty(
      'error',
    )
  })
})
