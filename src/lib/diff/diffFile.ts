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
function buildUnifiedDiffEnvelope(f: PrFile, patchOverride?: string): string {
  const oldPath = f.previousFilename ?? f.filename
  const newPath = f.filename

  const oldSide = f.status === 'added' ? '--- /dev/null' : `--- a/${oldPath}`
  const newSide = f.status === 'removed' ? '+++ /dev/null' : `+++ b/${newPath}`

  const rawPatch = patchOverride ?? f.patch!
  const patch = rawPatch.endsWith('\n') ? rawPatch : rawPatch + '\n'
  return `diff --git a/${oldPath} b/${newPath}\n${oldSide}\n${newSide}\n${patch}`
}

/**
 * Build a DiffFile from a PrFile, optionally with full file contents.
 *
 * When `contents` is provided (before + after text), the library constructs the
 * diff with awareness of the full file, enabling GitHub-style "expand context
 * lines" between hunks (`getExpandEnabled()` returns true). Without contents the
 * library composes the file solely from the patch lines (`composeByDiff = true`)
 * and expansion is not available — this is the hunk-only fallback.
 *
 * Expansion mechanism (verified from @git-diff-view/core source):
 *   - `getExpandEnabled()` = `!composeByDiff && !composeByRange`
 *   - `composeByDiff` is set to `true` only when BOTH oldFileContent and
 *     newFileContent are empty strings (the library then reconstructs content
 *     purely from the diff hunk lines and disables expansion).
 *   - Providing non-empty `content` in `createInstance` keeps `composeByDiff`
 *     false → expansion buttons render in the hunk separator rows.
 */
export function buildDiffFile(
  f: PrFile,
  mode: DiffMode,
  contents?: { before: string | null; after: string | null },
  /**
   * Optional bare-hunk patch to render INSTEAD of f.patch (e.g. the
   * whitespace-hidden recompute). f.patch still gates renderability —
   * callers only pass an override for files that already have a patch.
   */
  patchOverride?: string,
): DiffFile | null {
  if (!f.patch) return null

  const envelope = buildUnifiedDiffEnvelope(f, patchOverride)

  // Use full contents when both sides are available for the diff direction.
  // Added files have no "before"; removed files have no "after".
  // Even one side being non-empty prevents composeByDiff from being set,
  // keeping expansion available.
  const oldContent =
    contents && f.status !== 'added' && contents.before != null ? contents.before : undefined
  const newContent =
    contents && f.status !== 'removed' && contents.after != null ? contents.after : undefined

  const file = DiffFile.createInstance({
    oldFile: {
      fileName: f.previousFilename ?? f.filename,
      content: oldContent ?? undefined,
    },
    newFile: {
      fileName: f.filename,
      content: newContent ?? undefined,
    },
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
