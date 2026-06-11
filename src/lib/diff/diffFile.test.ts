import { describe, it, expect } from 'vitest'
import { DiffLineType } from '@git-diff-view/file'
import { buildDiffFile, classifyFile } from './diffFile'
import type { PrFile } from '../github/types'

// All patch strings below use BARE hunks — the real format returned by
// GitHub's PR files API.  buildDiffFile is responsible for synthesizing the
// full unified-diff envelope before handing the string to the library parser.

const modified: PrFile = {
  filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n unchanged',
}

describe('classifyFile', () => {
  it('EC-06c: rename without patch classifies as rename-only', () => {
    expect(classifyFile({ filename: 'b.ts', previousFilename: 'a.ts', status: 'renamed', additions: 0, deletions: 0 })).toBe('rename-only')
  })
  it('EC-05j: no patch and not a rename classifies as binary-or-too-large', () => {
    expect(classifyFile({ filename: 'img.png', status: 'added', additions: 0, deletions: 0 })).toBe('binary-or-too-large')
  })
  it('normal patched file classifies as diff', () => {
    expect(classifyFile(modified)).toBe('diff')
  })
})

describe('buildDiffFile', () => {
  it('builds a renderable DiffFile from a bare patch', () => {
    const df = buildDiffFile(modified)
    expect(df).not.toBeNull()
  })
  it('returns null for files without patch', () => {
    expect(buildDiffFile({ filename: 'img.png', status: 'added', additions: 0, deletions: 0 })).toBeNull()
  })

  it('bare GitHub patch produces nonzero parsed diff lines', () => {
    const df = buildDiffFile(modified)!
    expect(df).not.toBeNull()
    expect(df.unifiedLineLength).toBeGreaterThan(0)

    let addCount = 0
    let delCount = 0
    for (let i = 0; i < df.unifiedLineLength; i++) {
      const line = df.getUnifiedLine(i)
      if (line.diff?.type === DiffLineType.Add) addCount++
      if (line.diff?.type === DiffLineType.Delete) delCount++
    }
    expect(addCount).toBe(1)
    expect(delCount).toBe(1)
  })
})

// EC-06b — fixtures now use real bare-hunk GitHub wire format.
// buildDiffFile synthesises the envelope so the parser can locate hunks.
describe('EC-06b: additions-only / deletions-only diff line classification', () => {
  const additionsOnly: PrFile = {
    filename: 'src/new.ts',
    status: 'added',
    additions: 2,
    deletions: 0,
    patch: '@@ -0,0 +1,2 @@\n+line one\n+line two',
  }

  const deletionsOnly: PrFile = {
    filename: 'src/removed.ts',
    status: 'removed',
    additions: 0,
    deletions: 2,
    patch: '@@ -1,2 +0,0 @@\n-line one\n-line two',
  }

  it('EC-06b: additions-only bare patch yields ≥2 Add-typed lines and 0 Delete-typed lines', () => {
    const df = buildDiffFile(additionsOnly)!
    expect(df).not.toBeNull()
    expect(df.unifiedLineLength).toBeGreaterThan(0)

    let addCount = 0
    let delCount = 0
    for (let i = 0; i < df.unifiedLineLength; i++) {
      const line = df.getUnifiedLine(i)
      if (line.diff?.type === DiffLineType.Add) addCount++
      if (line.diff?.type === DiffLineType.Delete) delCount++
    }

    expect(addCount).toBeGreaterThanOrEqual(2)
    expect(delCount).toBe(0)
  })

  it('EC-06b: deletions-only bare patch yields ≥2 Delete-typed lines and 0 Add-typed lines', () => {
    const df = buildDiffFile(deletionsOnly)!
    expect(df).not.toBeNull()
    expect(df.unifiedLineLength).toBeGreaterThan(0)

    let addCount = 0
    let delCount = 0
    for (let i = 0; i < df.unifiedLineLength; i++) {
      const line = df.getUnifiedLine(i)
      if (line.diff?.type === DiffLineType.Add) addCount++
      if (line.diff?.type === DiffLineType.Delete) delCount++
    }

    expect(delCount).toBeGreaterThanOrEqual(2)
    expect(addCount).toBe(0)
  })
})
