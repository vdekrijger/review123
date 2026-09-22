// @vitest-environment node
/**
 * confine.test.ts — repo confinement, against a REAL temp filesystem.
 *
 * Symlink escape is the case a string-only guard gets wrong, so it is tested
 * with an actual symlink rather than a mocked fs: `repo/link -> outside` passes
 * `path.resolve` containment and must still be refused.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathEscapeError, isInside, resolveInRoot, resolveRepoRoot } from './confine.js'

let root: string
let outsideFile: string

beforeAll(async () => {
  // realpath the sandbox: macOS /tmp is a symlink to /private/tmp, and a root
  // that is not fully resolved makes every containment check meaningless.
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'bridge-confine-')))
  root = join(sandbox, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')

  const outside = join(sandbox, 'outside')
  await mkdir(outside, { recursive: true })
  outsideFile = join(outside, 'secrets.env')
  await writeFile(outsideFile, 'TOKEN=hunter2\n')

  // The escape hatches an attacker would reach for.
  await symlink(outside, join(root, 'escape-dir'))
  await symlink(outsideFile, join(root, 'escape-file'))
  // A symlink that stays inside the repo must still work.
  await symlink(join(root, 'src'), join(root, 'src-link'))
})

describe('resolveRepoRoot', () => {
  it('returns the fully resolved root', async () => {
    expect(await resolveRepoRoot(root)).toBe(root)
  })

  it('rejects a root that is not a directory', async () => {
    await expect(resolveRepoRoot(join(root, 'src', 'index.ts'))).rejects.toThrow(/not a directory/)
  })
})

describe('isInside', () => {
  it('treats the root itself as inside', () => {
    expect(isInside('/repo', '/repo')).toBe(true)
  })

  it('does not treat a sibling with the root as a prefix as inside', () => {
    expect(isInside('/repo', '/repo-secrets/x')).toBe(false)
  })
})

describe('resolveInRoot', () => {
  it('resolves a normal repo-relative path', async () => {
    expect(await resolveInRoot(root, 'src/index.ts')).toBe(join(root, 'src', 'index.ts'))
  })

  it('resolves a path that does not exist yet (missing ≠ rejected)', async () => {
    expect(await resolveInRoot(root, 'src/new-file.ts')).toBe(join(root, 'src', 'new-file.ts'))
  })

  it('allows a symlink that stays inside the repo', async () => {
    expect(await resolveInRoot(root, 'src-link/index.ts')).toBe(join(root, 'src', 'index.ts'))
  })

  it('allows an interior `..` that lands back inside', async () => {
    expect(await resolveInRoot(root, 'src/../src/index.ts')).toBe(join(root, 'src', 'index.ts'))
  })

  it.each([
    ['a `..` escape', '../outside/secrets.env'],
    ['a deep `..` escape', 'src/../../outside/secrets.env'],
    ['a `..` escape to the filesystem root', '../../../../../../etc/passwd'],
    ['a bare `..`', '..'],
  ])('rejects %s', async (_label, requested) => {
    await expect(resolveInRoot(root, requested)).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects an absolute path', async () => {
    await expect(resolveInRoot(root, outsideFile)).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInRoot(root, '/etc/passwd')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects a Windows-style absolute path', async () => {
    await expect(resolveInRoot(root, 'C:\\Windows\\win.ini')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInRoot(root, '\\\\server\\share')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects a path with a NUL byte', async () => {
    await expect(resolveInRoot(root, 'src/index.ts\0.png')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('rejects a SYMLINK that escapes the repo — the case path.resolve misses', async () => {
    // Both of these pass a lexical containment check: nothing in the string
    // leaves the root. Only realpath catches them.
    await expect(resolveInRoot(root, 'escape-file')).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInRoot(root, 'escape-dir/secrets.env')).rejects.toBeInstanceOf(PathEscapeError)
  })

  it('names the reason so a 403 can be explained without leaking the real path', async () => {
    await expect(resolveInRoot(root, 'escape-file')).rejects.toThrow(/symlink escape/)
    await expect(resolveInRoot(root, '../outside')).rejects.toThrow(/traversal/)
  })
})
