import { DiffFile } from '@git-diff-view/svelte'
import type { PrFile } from '../github/types'

export type FileKind = 'diff' | 'rename-only' | 'binary-or-too-large'

export function classifyFile(f: PrFile): FileKind {
  if (f.patch) return 'diff'
  if (f.status === 'renamed' && f.additions === 0 && f.deletions === 0) return 'rename-only'
  return 'binary-or-too-large'
}

export function buildDiffFile(f: PrFile): DiffFile | null {
  if (!f.patch) return null

  const file = DiffFile.createInstance({
    oldFile: { fileName: f.previousFilename ?? f.filename },
    newFile: { fileName: f.filename },
    hunks: [f.patch],
  })

  file.init()
  file.buildSplitDiffLines()
  file.buildUnifiedDiffLines()

  return file
}
