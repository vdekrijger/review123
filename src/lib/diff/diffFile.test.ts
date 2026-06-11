import { describe, it, expect } from 'vitest'
import { buildDiffFile, classifyFile } from './diffFile'
import type { PrFile } from '../github/types'

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
  it('builds a renderable DiffFile from a patch', () => {
    const df = buildDiffFile(modified)
    expect(df).not.toBeNull()
  })
  it('returns null for files without patch', () => {
    expect(buildDiffFile({ filename: 'img.png', status: 'added', additions: 0, deletions: 0 })).toBeNull()
  })
})
