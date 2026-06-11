import { DiffFile } from '@git-diff-view/svelte'
import type { PrFile } from '../github/types'
import type { DiffMode } from '../settings/settings'

export type FileKind = 'diff' | 'rename-only' | 'binary-or-too-large'

export function classifyFile(f: PrFile): FileKind {
  if (f.patch) return 'diff'
  if (f.status === 'renamed' && f.additions === 0 && f.deletions === 0) return 'rename-only'
  return 'binary-or-too-large'
}

/**
 * Wraps a bare GitHub patch hunk (e.g. `@@ -1,2 +1,2 @@\n-a\n+b`) in the
 * unified-diff envelope that @git-diff-view/core's parser requires.
 *
 * GitHub's PR files API always returns bare hunks; the parser needs at least
 * a `--- <old>` / `+++ <new>` header before the first `@@` line to locate
 * hunk boundaries. Without the envelope `parseDiffHeader()` returns null and
 * zero diff lines are produced.
 */
function buildUnifiedDiffEnvelope(f: PrFile): string {
  const oldPath = f.previousFilename ?? f.filename
  const newPath = f.filename

  const oldSide = f.status === 'added' ? '--- /dev/null' : `--- a/${oldPath}`
  const newSide = f.status === 'removed' ? '+++ /dev/null' : `+++ b/${newPath}`

  const patch = f.patch!.endsWith('\n') ? f.patch! : f.patch! + '\n'
  return `diff --git a/${oldPath} b/${newPath}\n${oldSide}\n${newSide}\n${patch}`
}

export function buildDiffFile(f: PrFile, mode: DiffMode): DiffFile | null {
  if (!f.patch) return null

  const envelope = buildUnifiedDiffEnvelope(f)

  const file = DiffFile.createInstance({
    oldFile: { fileName: f.previousFilename ?? f.filename },
    newFile: { fileName: f.filename },
    hunks: [envelope],
  })

  file.init()
  if (mode === 'split') {
    file.buildSplitDiffLines()
  } else {
    file.buildUnifiedDiffLines()
  }

  return file
}
