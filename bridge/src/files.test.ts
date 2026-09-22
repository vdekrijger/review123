// @vitest-environment node
/**
 * files.test.ts — `/v1/files` against a REAL temp repo.
 *
 * Confinement is the point of this file. It is tested per PATH, with a real
 * symlink on disk, because the escape that matters (`repo/link -> /etc`) is
 * invisible to any string-level check and only a real filesystem can prove it
 * is blocked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  clampMaxBytes,
  decodeUtf8Prefix,
  looksBinary,
  parseFilesRequest,
  readFiles,
  statusForFilesError,
} from './files.js'
import { MAX_FILES_PER_REQUEST, MAX_FILE_BYTES } from './protocol.js'

let root: string
/** A directory OUTSIDE the root, holding the file every escape test aims at. */
let outside: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-files-')))
  outside = dirname(root)
  await writeFile(join(outside, 'outside-secret.txt'), 'TOP SECRET')

  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'README.md'), '# hello\n')
})

function ok(result: Awaited<ReturnType<typeof readFiles>>) {
  if (result.ok !== true) throw new Error(`expected success, got ${result.code}: ${result.message}`)
  return result
}

describe('parseFilesRequest', () => {
  it('accepts a minimal body', () => {
    expect(parseFilesRequest({ paths: ['a.ts'] })).toEqual({ paths: ['a.ts'] })
  })

  it('carries maxBytes through when it is a number', () => {
    expect(parseFilesRequest({ paths: ['a.ts'], maxBytes: 10 })).toEqual({ paths: ['a.ts'], maxBytes: 10 })
  })

  it.each([
    ['a non-object body', 'nope'],
    ['no paths', {}],
    ['paths that are not strings', { paths: [1] }],
    ['an empty paths array', { paths: [] }],
    ['a non-numeric maxBytes', { paths: ['a'], maxBytes: 'big' }],
  ])('rejects %s', (_label, body) => {
    expect(parseFilesRequest(body)).toHaveProperty('error')
  })

  it('REJECTS an over-cap path list rather than silently trimming it', () => {
    const paths = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) => `f${i}.ts`)
    const parsed = parseFilesRequest({ paths })
    expect(parsed).toHaveProperty('error')
    expect((parsed as { error: string }).error).toContain(String(MAX_FILES_PER_REQUEST))
  })

  it('accepts a path list right at the cap', () => {
    const paths = Array.from({ length: MAX_FILES_PER_REQUEST }, (_, i) => `f${i}.ts`)
    expect(parseFilesRequest({ paths })).not.toHaveProperty('error')
  })
})

describe('clampMaxBytes', () => {
  it.each([
    [undefined, MAX_FILE_BYTES],
    [0, MAX_FILE_BYTES],
    [-5, MAX_FILE_BYTES],
    [Number.NaN, MAX_FILE_BYTES],
    [MAX_FILE_BYTES * 10, MAX_FILE_BYTES],
    [100, 100],
  ])('clamps %s to %s', (input, expected) => {
    expect(clampMaxBytes(input as number | undefined)).toBe(expected)
  })
})

describe('confinement — every path, not just the first', () => {
  it.each([
    ['plain traversal', '../outside-secret.txt'],
    ['nested traversal', 'src/../../outside-secret.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows drive path', 'C:\\Windows\\win.ini'],
    ['a UNC path', '\\\\server\\share'],
  ])('refuses %s with forbidden-path', async (_label, path) => {
    const result = await readFiles(root, { paths: [path] })
    expect(result.ok).toBe(false)
    expect((result as { code: string }).code).toBe('forbidden-path')
  })

  it('refuses a SYMLINK that points out of the repo', async () => {
    await symlink(join(outside, 'outside-secret.txt'), join(root, 'escape.txt'))
    const result = await readFiles(root, { paths: ['escape.txt'] })
    expect(result.ok).toBe(false)
    expect((result as { code: string }).code).toBe('forbidden-path')
  })

  it('refuses a path THROUGH a symlinked directory that points out of the repo', async () => {
    await symlink(outside, join(root, 'up'))
    const result = await readFiles(root, { paths: ['up/outside-secret.txt'] })
    expect(result.ok).toBe(false)
  })

  it('ALLOWS a symlink that stays inside the repo', async () => {
    await symlink(join(root, 'src', 'a.ts'), join(root, 'alias.ts'))
    const result = ok(await readFiles(root, { paths: ['alias.ts'] }))
    expect(result.files[0]?.content).toBe('export const a = 1\n')
  })

  it('checks EVERY path — an escape buried last still fails the whole request', async () => {
    const result = await readFiles(root, {
      paths: ['src/a.ts', 'README.md', '../outside-secret.txt'],
    })
    expect(result.ok).toBe(false)
    expect((result as { code: string }).code).toBe('forbidden-path')
  })

  it('reads NOTHING when any path is refused — no partial results leak out', async () => {
    const result = await readFiles(root, { paths: ['../outside-secret.txt', 'src/a.ts'] })
    expect(JSON.stringify(result)).not.toContain('export const a = 1')
    expect(JSON.stringify(result)).not.toContain('TOP SECRET')
  })

  it('maps forbidden-path to 403 and bad-request to 400', () => {
    expect(statusForFilesError('forbidden-path')).toBe(403)
    expect(statusForFilesError('bad-request')).toBe(400)
  })
})

describe('reading', () => {
  it('returns content, on-disk size, and the utf-8 encoding tag', async () => {
    const result = ok(await readFiles(root, { paths: ['src/a.ts'] }))
    expect(result.files).toEqual([
      {
        path: 'src/a.ts',
        bytes: 19,
        truncated: false,
        content: 'export const a = 1\n',
        encoding: 'utf-8',
      },
    ])
    expect(result.missing).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('echoes back the path the CALLER asked for, not the resolved one', async () => {
    const result = ok(await readFiles(root, { paths: ['./src/a.ts'] }))
    expect(result.files[0]?.path).toBe('./src/a.ts')
  })

  it('lists a missing path as MISSING, not as an error', async () => {
    const result = ok(await readFiles(root, { paths: ['src/a.ts', 'src/nope.ts'] }))
    expect(result.files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(result.missing).toEqual(['src/nope.ts'])
  })

  it('reads a batch in the order asked', async () => {
    const result = ok(await readFiles(root, { paths: ['README.md', 'src/a.ts'] }))
    expect(result.files.map((f) => f.path)).toEqual(['README.md', 'src/a.ts'])
  })

  it('reports a DIRECTORY as skipped:not-a-file, never as missing', async () => {
    const result = ok(await readFiles(root, { paths: ['src'] }))
    expect(result.files).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.skipped).toEqual([{ path: 'src', reason: 'not-a-file' }])
  })

  it('handles an empty file without calling it missing', async () => {
    await writeFile(join(root, 'empty.txt'), '')
    const result = ok(await readFiles(root, { paths: ['empty.txt'] }))
    expect(result.files).toEqual([
      { path: 'empty.txt', bytes: 0, truncated: false, content: '', encoding: 'utf-8' },
    ])
  })
})

describe('truncation', () => {
  it('cuts at maxBytes and says so, reporting the REAL on-disk size', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(1000))
    const result = ok(await readFiles(root, { paths: ['big.txt'], maxBytes: 10 }))
    expect(result.files[0]).toEqual({
      path: 'big.txt',
      bytes: 1000,
      truncated: true,
      content: 'x'.repeat(10),
      encoding: 'utf-8',
    })
  })

  it('does NOT flag truncation when the file fits exactly', async () => {
    await writeFile(join(root, 'ten.txt'), 'x'.repeat(10))
    const result = ok(await readFiles(root, { paths: ['ten.txt'], maxBytes: 10 }))
    expect(result.files[0]?.truncated).toBe(false)
  })

  it('never invents a replacement character when the cut lands mid-codepoint', async () => {
    // 'é' is two bytes; cutting at 3 lands inside the second one.
    await writeFile(join(root, 'utf8.txt'), 'aéb')
    const result = ok(await readFiles(root, { paths: ['utf8.txt'], maxBytes: 2 }))
    expect(result.files[0]?.content).toBe('a')
    expect(result.files[0]?.content).not.toContain('\uFFFD')
    expect(result.files[0]?.truncated).toBe(true)
  })
})

describe('decodeUtf8Prefix', () => {
  it('drops a dangling lead byte rather than emitting U+FFFD', () => {
    const full = Buffer.from('aé', 'utf8')
    expect(decodeUtf8Prefix(full.subarray(0, 2), true)).toBe('a')
  })

  it('keeps a complete sequence at the cut', () => {
    expect(decodeUtf8Prefix(Buffer.from('aé', 'utf8'), true)).toBe('aé')
  })

  it('leaves a WHOLE file alone even when it is invalid utf-8', () => {
    const invalid = Buffer.from([0x61, 0xc3])
    expect(decodeUtf8Prefix(invalid, false)).toBe(invalid.toString('utf8'))
  })

  it('handles an empty buffer', () => {
    expect(decodeUtf8Prefix(Buffer.alloc(0), true)).toBe('')
  })
})

describe('binary files', () => {
  it('detects a NUL byte as binary', () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
    expect(looksBinary(Buffer.from('plain text'))).toBe(false)
  })

  it('reports a binary file as skipped:binary — never as decoded text', async () => {
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]))
    const result = ok(await readFiles(root, { paths: ['logo.png'] }))
    expect(result.files).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.skipped).toEqual([{ path: 'logo.png', reason: 'binary' }])
  })

  it('keeps reading the rest of the batch after a binary file', async () => {
    await writeFile(join(root, 'logo.png'), Buffer.from([0x00, 0x01]))
    const result = ok(await readFiles(root, { paths: ['logo.png', 'src/a.ts'] }))
    expect(result.files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(result.skipped.map((s) => s.path)).toEqual(['logo.png'])
  })

  it('never puts a path in more than one bucket', async () => {
    await writeFile(join(root, 'logo.png'), Buffer.from([0x00]))
    const result = ok(await readFiles(root, { paths: ['src/a.ts', 'gone.ts', 'logo.png', 'src'] }))
    const all = [
      ...result.files.map((f) => f.path),
      ...result.missing,
      ...result.skipped.map((s) => s.path),
    ]
    expect(new Set(all).size).toBe(all.length)
    expect(all.sort()).toEqual(['gone.ts', 'logo.png', 'src', 'src/a.ts'])
  })
})
