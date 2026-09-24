/**
 * src/lib/diff/commitPatch.ts — split ONE commit's patch into per-file hunks.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, and why it is not `buildDiffFile`
 *
 * The agent fix loop hands back `git show --format= --patch` for each commit
 * (bridge/src/worktree.ts `readCommitPatch`). The panel has to SHOW that —
 * "the user asked to see the changes rather than a summary of them" — and the
 * app's real diff viewer (@git-diff-view, via diffFile.ts) cannot render it:
 *
 *   - it renders ONE file per instance, and a commit touches several;
 *   - it wants a `PrFile` (status, additions, deletions, previousFilename) that
 *     a raw patch does not carry;
 *   - it is at its best with FULL FILE CONTENTS so it can expand context, and
 *     the bridge sends a patch, never the files.
 *
 * So this module does the small thing the panel actually needs: turn the raw
 * multi-file patch into typed rows the panel paints with the SAME tokens the
 * viewer's theme uses (src/components/diff-view-theme.css), so the two surfaces
 * read as one system without dragging a whole-file renderer into a place that
 * has no whole files.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TRUNCATION IS A FIRST-CLASS INPUT, not an error
 *
 * The bridge caps the patch at MAX_FIX_DIFF_BYTES and slices it — mid-line,
 * mid-hunk, mid-file, wherever the byte lands. This parser therefore NEVER
 * throws and never discards a partial tail: it parses what is there and leaves
 * the caller to say the diff is incomplete. A parser that "helpfully" dropped
 * the last, broken hunk would render an amputated diff as a whole one, which is
 * exactly the lie the panel must not tell.
 *
 * It is equally tolerant at the other end: a bare `--- / +++ / @@` patch with no
 * `diff --git` header parses fine (that is what GitHub's file API returns, and
 * what the e2e bridge stub sends), and so does a bare hunk with no header at
 * all — the file then has no name, and the caller says so.
 */

/** One rendered row of a hunk. */
export interface PatchLine {
  kind: 'add' | 'del' | 'context' | 'meta'
  /** The line's content WITHOUT its leading +/-/space marker. */
  text: string
  /** 1-based line number on the old side; null for additions and meta rows. */
  oldLine: number | null
  /** 1-based line number on the new side; null for deletions and meta rows. */
  newLine: number | null
}

/** One `@@ … @@` hunk. */
export interface PatchHunk {
  /** The raw `@@ -a,b +c,d @@ trailer` line, verbatim. */
  header: string
  lines: PatchLine[]
}

/** What happened to a file, as far as the patch's own headers say. */
export type PatchFileStatus = 'added' | 'removed' | 'modified' | 'renamed'

export interface PatchFile {
  /** The new-side path. '' only when the patch carried no header at all. */
  path: string
  /** The old-side path when it differs (a rename); null otherwise. */
  oldPath: string | null
  status: PatchFileStatus
  /** True when git declined to diff the contents (`Binary files … differ`). */
  binary: boolean
  hunks: PatchHunk[]
  additions: number
  deletions: number
}

export interface ParsedPatch {
  files: PatchFile[]
  /** Total `+` rows across every file. */
  additions: number
  /** Total `-` rows across every file. */
  deletions: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const DIFF_GIT = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/

function emptyFile(): PatchFile {
  return {
    path: '',
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  }
}

/**
 * Parse a commit patch into per-file hunks.
 *
 * Never throws. Unrecognised lines between files are ignored rather than
 * guessed at: an `index abc..def 100644` line carries nothing the panel shows,
 * and inventing a row for it would put noise in a surface whose whole job is to
 * be read closely.
 */
export function parseCommitPatch(patch: string): ParsedPatch {
  const files: PatchFile[] = []
  let file: PatchFile | null = null
  let hunk: PatchHunk | null = null
  let oldLine = 0
  let newLine = 0
  /** The `--- a/x` path, held until `+++ b/y` says whether it was a rename. */
  let pendingOld: string | null = null

  /** Start a new file, closing the previous one. */
  const openFile = (next: PatchFile): void => {
    files.push(next)
    file = next
    hunk = null
    pendingOld = null
  }
  /** A patch may start straight at `---` or even at `@@`; give it a file. */
  const ensureFile = (): PatchFile => {
    if (file === null) openFile(emptyFile())
    return file as PatchFile
  }

  for (const raw of patch.split('\n')) {
    const gitHeader = DIFF_GIT.exec(raw)
    if (gitHeader) {
      const [, a, b] = gitHeader
      openFile({ ...emptyFile(), path: b, oldPath: a === b ? null : a })
      continue
    }

    if (file !== null && hunk === null) {
      // Extended headers, which only appear before the first hunk of a file.
      if (raw.startsWith('new file mode')) {
        file.status = 'added'
        continue
      }
      if (raw.startsWith('deleted file mode')) {
        file.status = 'removed'
        continue
      }
      if (raw.startsWith('rename from ')) {
        file.oldPath = raw.slice('rename from '.length)
        file.status = 'renamed'
        continue
      }
      if (raw.startsWith('rename to ')) {
        file.path = raw.slice('rename to '.length)
        file.status = 'renamed'
        continue
      }
      if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
        file.binary = true
        continue
      }
    }

    // The `--- / +++` envelope. It also NAMES the file for a bare patch that had
    // no `diff --git` line at all (GitHub's shape, and the e2e stub's).
    if (raw.startsWith('--- ')) {
      // Already inside a hunk (or with no file at all): this envelope starts a
      // NEW file. That is the only boundary a bare patch gives us.
      if (hunk !== null || file === null) openFile(emptyFile())
      const cur = file as PatchFile
      const p = raw.slice(4).trim()
      if (p === '/dev/null') cur.status = 'added'
      else pendingOld = p.replace(/^a\//, '')
      continue
    }
    if (raw.startsWith('+++ ')) {
      const cur = ensureFile()
      const p = raw.slice(4).trim()
      if (p === '/dev/null') {
        cur.status = 'removed'
        if (cur.path === '' && pendingOld !== null) cur.path = pendingOld
      } else {
        const newPath = p.replace(/^b\//, '')
        if (cur.path === '') cur.path = newPath
        // Differing sides with no `rename from/to` header — a bare patch's only
        // way of saying "renamed". Never overrides a header that already spoke.
        if (pendingOld !== null && pendingOld !== cur.path && cur.oldPath === null) {
          cur.oldPath = pendingOld
          if (cur.status === 'modified') cur.status = 'renamed'
        }
      }
      pendingOld = null
      continue
    }

    const header = HUNK_HEADER.exec(raw)
    if (header) {
      const cur = ensureFile()
      oldLine = parseInt(header[1], 10)
      newLine = parseInt(header[3], 10)
      hunk = { header: raw, lines: [] }
      cur.hunks.push(hunk)
      continue
    }

    if (hunk === null) continue // preamble / index lines / trailing noise

    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine })
      newLine++
      ;(file as PatchFile).additions++
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: raw.slice(1), oldLine, newLine: null })
      oldLine++
      ;(file as PatchFile).deletions++
    } else if (raw.startsWith('\\')) {
      // `\ No newline at end of file` — real, shown, advances neither counter.
      hunk.lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null })
    } else if (raw === '' ) {
      // A trailing empty string from the final newline is not a context row.
      // An empty CONTEXT line inside a hunk arrives as ' ' (a single space), so
      // this only ever drops the split artefact, never real content.
      continue
    } else {
      const text = raw.startsWith(' ') ? raw.slice(1) : raw
      hunk.lines.push({ kind: 'context', text, oldLine, newLine })
      oldLine++
      newLine++
    }
  }

  let additions = 0
  let deletions = 0
  for (const f of files) {
    additions += f.additions
    deletions += f.deletions
  }
  return { files, additions, deletions }
}

/**
 * Is there anything to SHOW? A patch that parses to no rows at all — empty
 * string, headers only, a byte cap that landed before the first hunk — must
 * render as "nothing to show" rather than as an empty, convincing-looking
 * viewer frame.
 */
export function patchIsEmpty(parsed: ParsedPatch): boolean {
  return parsed.files.every((f) => f.hunks.every((h) => h.lines.length === 0))
}
