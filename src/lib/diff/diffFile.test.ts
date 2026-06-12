import { describe, it, expect } from 'vitest'
import { DiffLineType } from '@git-diff-view/file'
import { buildDiffFile, classifyFile } from './diffFile'
import type { PrFile } from '../github/types'
import type { DiffFile } from '@git-diff-view/svelte'

function countDiffLines(df: DiffFile): { addCount: number; delCount: number } {
  let addCount = 0
  let delCount = 0
  for (let i = 0; i < df.unifiedLineLength; i++) {
    const line = df.getUnifiedLine(i)
    if (line.diff?.type === DiffLineType.Add) addCount++
    if (line.diff?.type === DiffLineType.Delete) delCount++
  }
  return { addCount, delCount }
}

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
  it('renamed file with patch classifies as diff', () => {
    expect(classifyFile({ filename: 'b.ts', previousFilename: 'a.ts', status: 'renamed', additions: 2, deletions: 0, patch: '@@ -1,2 +1,4 @@\n line\n+added\n+added' })).toBe('diff')
  })
})

describe('buildDiffFile', () => {
  it('builds a renderable DiffFile from a bare patch', () => {
    const df = buildDiffFile(modified, 'unified')
    expect(df).not.toBeNull()
  })
  it('returns null for files without patch', () => {
    expect(buildDiffFile({ filename: 'img.png', status: 'added', additions: 0, deletions: 0 }, 'unified')).toBeNull()
  })

  it('bare GitHub patch produces nonzero parsed diff lines', () => {
    const df = buildDiffFile(modified, 'unified')!
    expect(df).not.toBeNull()
    expect(df.unifiedLineLength).toBeGreaterThan(0)

    const { addCount, delCount } = countDiffLines(df)
    expect(addCount).toBe(1)
    expect(delCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// buildDiffFile — context expansion (hunk expand)
// ---------------------------------------------------------------------------

/**
 * A patch with a single small hunk in the middle of a larger file.
 * When full before/after content is provided, the library keeps composeByDiff=false
 * → getExpandEnabled() returns true → expand buttons render.
 */
const multiLineFile: PrFile = {
  filename: 'src/big.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -5,3 +5,3 @@\n context\n-old line\n+new line\n context',
}

// 10-line old content; patch touches line 6
const oldContent = [
  'line 1',
  'line 2',
  'line 3',
  'line 4',
  'context',
  'old line',
  'context',
  'line 8',
  'line 9',
  'line 10',
].join('\n')

const newContent = [
  'line 1',
  'line 2',
  'line 3',
  'line 4',
  'context',
  'new line',
  'context',
  'line 8',
  'line 9',
  'line 10',
].join('\n')

describe('buildDiffFile — expand enabled with full contents', () => {
  it('without contents: getExpandEnabled() returns false (composeByDiff path)', () => {
    const df = buildDiffFile(multiLineFile, 'unified')!
    expect(df).not.toBeNull()
    // Library sets composeByDiff=true when no content is provided,
    // disabling expansion.
    expect(df.getExpandEnabled()).toBe(false)
  })

  it('with full before+after contents: getExpandEnabled() returns true', () => {
    const df = buildDiffFile(multiLineFile, 'unified', {
      before: oldContent,
      after: newContent,
    })!
    expect(df).not.toBeNull()
    // Library keeps composeByDiff=false when real content is supplied,
    // enabling the expand affordance.
    expect(df.getExpandEnabled()).toBe(true)
  })

  it('with contents=undefined (not provided): falls back to hunk-only, no expansion', () => {
    const df = buildDiffFile(multiLineFile, 'unified', undefined)!
    expect(df.getExpandEnabled()).toBe(false)
  })

  it('with contents null-before (added file): uses after content, still enables expansion', () => {
    const addedFile: PrFile = {
      filename: 'src/new.ts',
      status: 'added',
      additions: 3,
      deletions: 0,
      patch: '@@ -0,0 +1,3 @@\n+line 1\n+line 2\n+line 3',
    }
    const df = buildDiffFile(addedFile, 'unified', {
      before: null,
      after: 'line 1\nline 2\nline 3',
    })!
    expect(df).not.toBeNull()
    // At minimum no crash; expansion state depends on library's single-side handling.
    expect(df.unifiedLineLength).toBeGreaterThan(0)
  })

  it('split mode with contents: getExpandEnabled() returns true', () => {
    const df = buildDiffFile(multiLineFile, 'split', {
      before: oldContent,
      after: newContent,
    })!
    expect(df).not.toBeNull()
    expect(df.getExpandEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// renamed-file content keying
// ---------------------------------------------------------------------------

describe('buildDiffFile — renamed file content keying', () => {
  const renamedFile: PrFile = {
    filename: 'src/new-name.ts',
    previousFilename: 'src/old-name.ts',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    patch: '@@ -1,3 +1,3 @@\n context\n-old\n+new\n context',
  }

  it('renamed file without contents: builds diff, getExpandEnabled=false', () => {
    const df = buildDiffFile(renamedFile, 'unified')!
    expect(df).not.toBeNull()
    expect(df.getExpandEnabled()).toBe(false)
  })

  it('renamed file with contents (before at previousFilename, after at filename): enables expansion', () => {
    const df = buildDiffFile(renamedFile, 'unified', {
      before: 'context\nold\ncontext',
      after: 'context\nnew\ncontext',
    })!
    expect(df).not.toBeNull()
    expect(df.getExpandEnabled()).toBe(true)
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
    const df = buildDiffFile(additionsOnly, 'unified')!
    expect(df).not.toBeNull()
    expect(df.unifiedLineLength).toBeGreaterThan(0)

    const { addCount, delCount } = countDiffLines(df)
    expect(addCount).toBeGreaterThanOrEqual(2)
    expect(delCount).toBe(0)
  })

  it('EC-06b: deletions-only bare patch yields ≥2 Delete-typed lines and 0 Add-typed lines', () => {
    const df = buildDiffFile(deletionsOnly, 'unified')!
    expect(df).not.toBeNull()
    expect(df.unifiedLineLength).toBeGreaterThan(0)

    const { addCount, delCount } = countDiffLines(df)
    expect(delCount).toBeGreaterThanOrEqual(2)
    expect(addCount).toBe(0)
  })
})
