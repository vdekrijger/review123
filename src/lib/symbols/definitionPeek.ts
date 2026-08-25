/**
 * src/lib/symbols/definitionPeek.ts — IDE-style "peek definition" source
 * extraction for the symbol popover.
 *
 * peekDefinition(source, side, startLine, endLine?) returns the definition's
 * actual code lines, read from the SAME text the symbol index was built on
 * (availableSideLines — fetched full contents when present, else the raw
 * patch), so the peek can never show anything the index didn't see.
 *
 * EXTENT — two ladders, mirroring the index's two backends:
 *   1. `endLine` given (tree-sitter produced the definition) → exact,
 *      grammar-backed full extent.
 *   2. absent (heuristic backend) → forward body scan from the definition
 *      line: brace matching for brace languages, indentation for Python
 *      (multi-line signatures consumed via pyHeaderEndLine — the #95/#109
 *      helper), indentation + trailing `end`/`}` for Ruby/shell/unknown.
 *
 * HONESTY:
 *   - Display is capped at MAX_PEEK_LINES; lines KNOWN to exist beyond the cap
 *     are counted in `moreLines` ("… (N more lines)" in the UI — the
 *     jump-to-line action is the escape hatch).
 *   - Patch-only sources may simply LACK body lines beyond the hunk. The peek
 *     shows the contiguous run that exists and sets `limitedToPatch` so the UI
 *     can say "only the changed lines are available" instead of rendering a
 *     silently amputated block as if it were complete.
 *
 * Pure + synchronous — no network, no DOM; unit-testable.
 */

import { langForFilename, type CodeLang } from '../diff/codeNoise'
import { pyHeaderEndLine } from '../diff/symbolTests'
import { availableSideLines, stripLiteralsAndComments, type DiffSide, type SymbolSource } from './symbolIndex'

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface PeekLine {
  /** Real 1-based line number on the definition's side of the file. */
  line: number
  text: string
}

export interface DefinitionPeek {
  /** Contiguous lines from the definition start, capped at MAX_PEEK_LINES. */
  lines: PeekLine[]
  /** Available lines of the extent beyond the display cap (0 = fully shown). */
  moreLines: number
  /**
   * True when the source is patch-only and the definition's body runs past
   * the lines the patch carries — the block is honest but incomplete.
   */
  limitedToPatch: boolean
}

/** Display cap — same 40-line idiom as the symbol-test snippets (#95/#109). */
export const MAX_PEEK_LINES = 40

/** Forward-scan bound for the heuristic extent (and the availability probe). */
const MAX_PEEK_SCAN = 500

// ---------------------------------------------------------------------------
// Heuristic body extent (used only when no grammar-backed endLine exists)
// ---------------------------------------------------------------------------

/** Languages whose bodies are brace-delimited (of the ones we classify). */
const BRACE_LANGS = new Set<CodeLang>(['js', 'go', 'java', 'kotlin', 'rust', 'css'])

interface HeuristicExtent {
  /** 0-based index into `run` of the last body line. */
  endIndex: number
  /** True when a real terminator was seen; false = ran out of lines. */
  found: boolean
}

function indentOf(line: string): number {
  return line.match(/^[ \t]*/)![0].length
}

/** Brace languages: match the def line's `{` forward to its close. */
function braceExtent(run: string[], lang: CodeLang): HeuristicExtent {
  let depth = 0
  let seenOpen = false
  for (let i = 0; i < run.length; i++) {
    const code = stripLiteralsAndComments(run[i], lang)
    for (const ch of code) {
      if (ch === '{') {
        depth++
        seenOpen = true
      } else if (ch === '}') depth--
    }
    // No `{` on the definition line itself → a single-line definition
    // (`const f = (x) => x + 1`, `type A = string`, …).
    if (i === 0 && !seenOpen) return { endIndex: 0, found: true }
    if (seenOpen && depth <= 0) return { endIndex: i, found: true }
  }
  return { endIndex: run.length - 1, found: false }
}

/** Python: consume the (possibly multi-line) header, then indent-scan the body. */
function pythonExtent(run: string[]): HeuristicExtent {
  const headerEnd = pyHeaderEndLine(run, 0)
  const indent = indentOf(run[0])
  let end = headerEnd
  for (let i = headerEnd + 1; i < run.length; i++) {
    if (run[i].trim() === '') continue // blank lines don't end the body
    if (indentOf(run[i]) <= indent) return { endIndex: end, found: true }
    end = i
  }
  return { endIndex: end, found: false }
}

/**
 * Ruby / shell / unknown: indent scan; a dedented terminator line (`end`, `}`)
 * at the definition's own indent belongs to the block and is included.
 */
function indentExtent(run: string[]): HeuristicExtent {
  const indent = indentOf(run[0])
  let end = 0
  for (let i = 1; i < run.length; i++) {
    if (run[i].trim() === '') continue
    if (indentOf(run[i]) <= indent) {
      const t = run[i].trim()
      return { endIndex: t === 'end' || t === '}' ? i : end, found: true }
    }
    end = i
  }
  return { endIndex: end, found: false }
}

function heuristicExtent(run: string[], lang: CodeLang | null): HeuristicExtent {
  if (lang !== null && BRACE_LANGS.has(lang)) return braceExtent(run, lang)
  if (lang === 'python') return pythonExtent(run)
  return indentExtent(run)
}

// ---------------------------------------------------------------------------
// Peek
// ---------------------------------------------------------------------------

/**
 * The definition's code block starting at `startLine` on `side`, read from
 * `source`'s available text. `endLine` is the exact tree-sitter extent when
 * known; otherwise the extent is inferred heuristically (see module note).
 * Returns null when the start line isn't available at all (nothing honest to
 * show — the popover then simply offers no expand affordance).
 */
export function peekDefinition(
  source: SymbolSource,
  side: DiffSide,
  startLine: number,
  endLine?: number,
): DefinitionPeek | null {
  const { lines: map, full } = availableSideLines(source, side)
  if (!map.has(startLine)) return null

  // Last contiguous available line from the start (bounded).
  let availEnd = startLine
  while (availEnd - startLine < MAX_PEEK_SCAN && map.has(availEnd + 1)) availEnd++

  let extentEnd: number
  let endKnown: boolean
  if (endLine !== undefined) {
    extentEnd = Math.max(startLine, endLine)
    endKnown = true
  } else {
    const run: string[] = []
    for (let n = startLine; n <= availEnd; n++) run.push(map.get(n)!)
    const h = heuristicExtent(run, langForFilename(source.filename))
    extentEnd = startLine + h.endIndex
    endKnown = h.found
  }

  const shownEnd = Math.min(extentEnd, availEnd, startLine + MAX_PEEK_LINES - 1)
  const lines: PeekLine[] = []
  for (let n = startLine; n <= shownEnd; n++) lines.push({ line: n, text: map.get(n)! })

  return {
    lines,
    moreLines: Math.max(0, Math.min(extentEnd, availEnd) - shownEnd),
    // Patch-only and either the known extent outruns the available lines, or
    // no terminator was found before they ran out — the body may continue in
    // lines the patch doesn't carry.
    limitedToPatch: !full && (extentEnd > availEnd || !endKnown),
  }
}
