/**
 * src/lib/guide/hunkAttention.ts — deterministic PER-HUNK attention triage.
 *
 * The same idea as src/lib/guide/triage.ts (#223), one level down. Triage asks
 * "does this FILE deserve the reviewer's initial read?"; this module asks
 * "does this HUNK carry a decision, or is it mechanical churn?" — so a file
 * holding one genuinely interesting change plus 200 lines of formatting stops
 * reading as uniformly high-attention.
 *
 * Pure and framework-free — NO LLM, no new AI task, no prompt changes. Every
 * signal is computed from the patch text the app already has.
 *
 *   MECHANICAL kinds (visually receded in the diff, never hidden):
 *     - formatting  — both sides normalise to the SAME token stream
 *                     (whitespace, line breaks, trailing commas, semicolons,
 *                     quote style)
 *     - imports     — every changed line is an import (src/lib/diff/codeNoise
 *                     classifyNoiseLines — the span-aware detector, reused)
 *     - comments    — every changed line is a comment (same detector)
 *     - rename      — one consistent identifier substitution, nothing else
 *     - fixture     — generated / snapshot / fixture data
 *                     (src/lib/diff/generated isGeneratedPath, reused)
 *
 * Everything else is a DECISION hunk.
 *
 * THE BIAS — WHEN IN DOUBT, 'decision'. A false "mechanical" recedes real
 * code, which is the one failure mode that matters here; a false "decision"
 * only costs the reviewer the scan they were already doing. So every detector
 * below is narrow: an unknown language, an unparseable patch, a mixed hunk, a
 * one-occurrence identifier swap, a pure addition — all land on 'decision'.
 * This mirrors the "prefer false negatives" stance of codeNoise.ts and
 * generated.ts.
 *
 * OVERRIDE (non-negotiable, mirrors triage's findings/risk override): a hunk
 * that CONTAINS a reviewer finding, a draft comment, or a risk-heuristic hit
 * is ALWAYS 'decision', whatever its shape. `kinds` is still reported — it is
 * truthful data about the hunk's shape — and `overrides` names what forced the
 * call, exactly as triage reports `reasons` under its own override.
 *
 * The per-hunk heuristic re-uses the REAL detectors from src/lib/risk (never a
 * second copy) by running detectHeuristics over a synthesized single-hunk
 * patch, keeping only the hunk-local ids:
 *   - new-dependency, error-masking, duplication → hunk-local, kept
 *   - untested-bulk → a PR-level aggregate, meaningless per hunk, dropped
 *   - sensitive-path → a FILE-level signal, deliberately NOT a per-hunk
 *     override: it is already what lifts the file up the risk-first list, and
 *     applying it here would switch this feature off for exactly the files
 *     (auth/, payments/, …) where finding the real change among the noise
 *     matters most. Within-file guidance still applies inside them.
 *
 * Framing contract (mirrors src/lib/risk and triage): this estimates review
 * ATTENTION — where to look first — never "this hunk is safe".
 */

import type { PrFile } from '../github/types'
import { langForFilename, classifyNoiseLines, type CodeLang } from '../diff/codeNoise'
import { isGeneratedPath } from '../diff/generated'
import { detectHeuristics, type HeuristicId } from '../risk/heuristics'
import { extractChangedSymbols } from '../diff/symbols'
import { pathCompare } from './triage'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HunkAttention = 'decision' | 'mechanical'

export type HunkKind = 'formatting' | 'imports' | 'comments' | 'rename' | 'fixture'

/** What forced a mechanical-shaped hunk back to 'decision'. */
export type HunkOverride = 'finding' | 'draft' | 'heuristic'

/** One line of a parsed hunk, with its per-side source line numbers. */
export interface HunkLine {
  /** '+' added, '-' removed, ' ' context. */
  marker: '+' | '-' | ' '
  /** Raw source text, WITHOUT the diff marker. */
  text: string
  /** 1-based old-side line number, or 0 when the line has no old side. */
  oldNum: number
  /** 1-based new-side line number, or 0 when the line has no new side. */
  newNum: number
}

/** A single unified-diff hunk, parsed. */
export interface DiffHunk {
  /** 0-based ordinal within the file's patch. */
  index: number
  /** Enclosing-context text after the closing `@@` (git's xfuncname). */
  context: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
}

export interface HunkClassification {
  attention: HunkAttention
  /** Every mechanical shape that matched, in a stable order. */
  kinds: HunkKind[]
  /** Short, deterministic description of the hunk ("formatting only", "+12 −3"). */
  summary: string
  /** What forced 'decision' despite a mechanical shape (empty when none). */
  overrides: HunkOverride[]
}

/** Per-hunk classification context. */
export interface HunkContext {
  /** Path of the file the hunk belongs to (language + fixture detection). */
  filename: string
  /** A reviewer finding is anchored inside this hunk. */
  hasFinding?: boolean
  /** A draft comment is anchored inside this hunk. */
  hasDraft?: boolean
  /**
   * Skip the per-hunk risk-heuristic pass (already computed by the caller, or
   * deliberately not wanted). When omitted the detectors run here.
   */
  heuristicHit?: boolean
}

// ---------------------------------------------------------------------------
// Patch parsing
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/**
 * Parse a raw unified patch (bare hunks, no ---/+++ envelope required) into
 * hunks with per-side line numbers. Mirrors the hunk walk in
 * src/lib/diff/patchLines.ts — kept here (rather than exported from there) so
 * src/lib/diff stays read-only for this change.
 *
 * Lines before the first `@@` header are ignored. A patch with no header
 * yields [].
 */
export function parseHunks(patch: string | undefined): DiffHunk[] {
  if (!patch) return []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  const rows = patch.split('\n')
  // A patch that ends with a newline yields a trailing '' that is NOT a diff
  // row; dropping it keeps our line numbers identical to patchLineNumbers'.
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()

  for (const raw of rows) {
    const h = HUNK_HEADER.exec(raw)
    if (h) {
      current = {
        index: hunks.length,
        context: (h[5] ?? '').trim(),
        oldStart: parseInt(h[1], 10),
        oldCount: h[2] === undefined ? 1 : parseInt(h[2], 10),
        newStart: parseInt(h[3], 10),
        newCount: h[4] === undefined ? 1 : parseInt(h[4], 10),
        lines: [],
      }
      hunks.push(current)
      oldLine = current.oldStart
      newLine = current.newStart
      continue
    }
    if (!current) continue
    if (raw === '\\ No newline at end of file') continue
    if (raw.startsWith('+')) {
      current.lines.push({ marker: '+', text: raw.slice(1), oldNum: 0, newNum: newLine })
      newLine++
    } else if (raw.startsWith('-')) {
      current.lines.push({ marker: '-', text: raw.slice(1), oldNum: oldLine, newNum: 0 })
      oldLine++
    } else {
      // Context line. A bare '' (some tools strip the marker off a blank
      // context line) counts as context too — patchLineNumbers does the same,
      // and our line numbers MUST agree with its anchor set.
      current.lines.push({ marker: ' ', text: raw.slice(1), oldNum: oldLine, newNum: newLine })
      oldLine++
      newLine++
    }
  }
  return hunks
}

/** Added lines of a hunk (text only). */
export function hunkAdded(hunk: DiffHunk): string[] {
  return hunk.lines.filter((l) => l.marker === '+').map((l) => l.text)
}

/** Removed lines of a hunk (text only). */
export function hunkRemoved(hunk: DiffHunk): string[] {
  return hunk.lines.filter((l) => l.marker === '-').map((l) => l.text)
}

/** Rebuild a single-hunk patch (header + rows) — input for the risk detectors. */
export function hunkPatch(hunk: DiffHunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
  const body = hunk.lines.map((l) => `${l.marker}${l.text}`)
  return [header, ...body].join('\n')
}

/**
 * Where the hunk's marker/jump anchor belongs: the rendered line immediately
 * BEFORE the first changed line (so a marker sits above the changed block), or
 * the hunk's first line when the hunk opens with a change. Returns null for an
 * empty hunk.
 */
export function hunkAnchor(hunk: DiffHunk): { line: number; side: 'LEFT' | 'RIGHT' } | null {
  if (hunk.lines.length === 0) return null
  const firstChanged = hunk.lines.findIndex((l) => l.marker !== ' ')
  const idx = firstChanged > 0 ? firstChanged - 1 : 0
  const line = hunk.lines[idx]
  if (line.newNum > 0) return { line: line.newNum, side: 'RIGHT' }
  if (line.oldNum > 0) return { line: line.oldNum, side: 'LEFT' }
  return null
}

/** True when an anchor (finding / draft) falls inside this hunk. */
export function hunkContainsAnchor(hunk: DiffHunk, line: number, side: 'LEFT' | 'RIGHT'): boolean {
  return hunk.lines.some((l) => (side === 'LEFT' ? l.oldNum : l.newNum) === line)
}

// ---------------------------------------------------------------------------
// Token normalisation (formatting + rename detection)
// ---------------------------------------------------------------------------

/**
 * Coarse, language-agnostic tokenizer: string literals (kept whole), numbers,
 * identifiers, and every other non-space character as its own token. Good
 * enough to answer "is this the same code, differently laid out?" — it is NOT
 * a parser and never needs to be.
 */
const TOKEN_RE =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|\S/g

/** Punctuation with no semantic weight once both sides are compared equally. */
const DROPPED_PUNCTUATION = new Set([',', ';'])

/** Normalise `'a'` / `` `a` `` to `"a"` so quote-style churn reads as formatting. */
function normalizeStringToken(token: string): string {
  const m = /^(['"`])(.*)\1$/s.exec(token)
  if (!m) return token
  // Escapes change meaning across quote styles — leave those tokens alone.
  if (m[2].includes('\\')) return token
  return `"${m[2]}"`
}

/**
 * Token stream of a block of source lines, with layout-only differences
 * normalised away: all whitespace and line breaks (the lines are joined),
 * commas and semicolons (dropped — this is what makes a trailing comma or a
 * dropped semicolon invisible), and quote style.
 *
 * Because identifiers and numbers are whole tokens, deleting the space in
 * `foo bar` does NOT normalise to `foobar` — that stays a real difference.
 */
export function tokenStream(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const matches = line.match(TOKEN_RE)
    if (!matches) continue
    for (const t of matches) {
      if (DROPPED_PUNCTUATION.has(t)) continue
      out.push(normalizeStringToken(t))
    }
  }
  return out
}

function sameStream(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// (1) Formatting-only
// ---------------------------------------------------------------------------

/**
 * True when the removed and added sides carry the SAME token stream — the code
 * was re-laid-out, not changed. Requires churn on BOTH sides: a pure addition
 * or a pure deletion is a real change, never "formatting".
 *
 * The one exception is blank-line churn: added/removed lines that are entirely
 * blank are formatting even one-sided.
 */
export function isFormattingOnly(added: readonly string[], removed: readonly string[]): boolean {
  if (added.length === 0 && removed.length === 0) return false
  const allBlank = [...added, ...removed].every((l) => l.trim() === '')
  if (allBlank) return true
  if (added.length === 0 || removed.length === 0) return false
  return sameStream(tokenStream(removed), tokenStream(added))
}

// ---------------------------------------------------------------------------
// (2)/(3) Imports-only / comments-only
// ---------------------------------------------------------------------------

/**
 * Which noise kinds cover EVERY changed line of the hunk. Returns an empty
 * array when the language is unknown, when a changed line is neither an import
 * nor a comment, or when there is no substantive churn at all.
 *
 * Each SIDE is classified as its own ordered sequence (removed+context for the
 * old side, added+context for the new one) so classifyNoiseLines' span state —
 * multi-line import lists, block comments — sees real document order. This is
 * the SAME detector focus mode uses; there is no second implementation.
 */
export function noiseKindsCovering(hunk: DiffHunk, lang: CodeLang | null): HunkKind[] {
  if (lang === null) return []
  const kinds = new Set<HunkKind>()
  let sawChange = false

  for (const side of ['old', 'new'] as const) {
    const seq = hunk.lines.filter((l) => l.marker === ' ' || l.marker === (side === 'old' ? '-' : '+'))
    if (seq.length === 0) continue
    const classified = classifyNoiseLines(seq.map((l) => l.text), lang)
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].marker === ' ') continue
      if (seq[i].text.trim() === '') continue
      sawChange = true
      const kind = classified[i]
      if (kind === 'import') kinds.add('imports')
      else if (kind === 'comment') kinds.add('comments')
      else return [] // a changed line that is real code → not noise-only
    }
  }

  if (!sawChange) return []
  return [...kinds].sort()
}

// ---------------------------------------------------------------------------
// (4) Rename-only
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Keywords across the languages we cover. A differing keyword token is a
 * CONTROL-FLOW change, never a rename — it disqualifies the hunk immediately.
 */
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'try', 'catch', 'finally', 'throw', 'throws', 'new', 'delete', 'typeof',
  'instanceof', 'in', 'of', 'this', 'super', 'class', 'extends', 'implements',
  'interface', 'enum', 'struct', 'impl', 'trait', 'type', 'function', 'func', 'fn',
  'def', 'lambda', 'const', 'let', 'var', 'static', 'public', 'private', 'protected',
  'async', 'await', 'yield', 'import', 'export', 'from', 'as', 'use', 'pub', 'mut',
  'package', 'module', 'require', 'null', 'nil', 'none', 'true', 'false', 'and', 'or',
  'not', 'is', 'pass', 'with', 'match', 'defer', 'go', 'chan', 'select', 'end', 'elif',
])

/** At most this many distinct identifier pairs still reads as "a rename". */
export const MAX_RENAME_PAIRS = 3

/** The identifier substitutions a rename-only hunk performs, or null. */
export function renamePairs(
  added: readonly string[],
  removed: readonly string[],
): { from: string; to: string }[] | null {
  if (added.length === 0 || removed.length === 0) return null
  const oldStream = tokenStream(removed)
  const newStream = tokenStream(added)
  if (oldStream.length === 0) return null
  if (oldStream.length !== newStream.length) return null

  const forward = new Map<string, string>()
  const backward = new Map<string, string>()
  let differences = 0

  for (let i = 0; i < oldStream.length; i++) {
    const a = oldStream[i]
    const b = newStream[i]
    if (a === b) continue
    differences++
    // Only identifier-for-identifier substitutions can be a rename.
    if (!IDENT_RE.test(a) || !IDENT_RE.test(b)) return null
    if (KEYWORDS.has(a) || KEYWORDS.has(b)) return null
    const mappedTo = forward.get(a)
    if (mappedTo !== undefined && mappedTo !== b) return null
    const mappedFrom = backward.get(b)
    if (mappedFrom !== undefined && mappedFrom !== a) return null
    forward.set(a, b)
    backward.set(b, a)
  }

  if (differences === 0) return null // identical streams → formatting, not rename
  if (forward.size > MAX_RENAME_PAIRS) return null

  const oldCounts = new Map<string, number>()
  for (const t of oldStream) oldCounts.set(t, (oldCounts.get(t) ?? 0) + 1)
  const newSet = new Set(newStream)
  const oldSet = new Set(oldStream)

  for (const [from, to] of forward) {
    // A single-occurrence swap is indistinguishable from a real logic change
    // (`if (a > b)` → `if (a > c)`), so it stays a decision.
    if ((oldCounts.get(from) ?? 0) < 2) return null
    // The new name must be genuinely NEW and the old one genuinely GONE —
    // otherwise this is "use a different existing variable", a real change.
    if (oldSet.has(to)) return null
    if (newSet.has(from)) return null
  }

  return [...forward.entries()]
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => pathCompare(a.from, b.from))
}

// ---------------------------------------------------------------------------
// (5) Fixture / snapshot data
// ---------------------------------------------------------------------------

/** Directory segments that conventionally hold test data, not logic. */
const FIXTURE_DIR_SEGMENTS = new Set(['fixtures', '__fixtures__', 'testdata', 'test-data'])

/** Data-ish extensions — a fixture directory alone is not enough. */
const DATA_EXT_RE = /\.(?:json|ya?ml|csv|tsv|xml|txt|sql|ndjson|jsonl|snap|golden|ambr)$/i

/**
 * True for generated/snapshot artifacts (src/lib/diff/generated — the single
 * source of truth, reused) and for DATA files living in a conventional fixture
 * directory. Both are "content a human reads only when something fails", not
 * lines to review one by one.
 */
export function isFixturePath(path: string): boolean {
  if (isGeneratedPath(path)) return true
  const segments = path.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (!DATA_EXT_RE.test(base)) return false
  return segments.slice(0, -1).some((s) => FIXTURE_DIR_SEGMENTS.has(s.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Per-hunk risk heuristics (reuses src/lib/risk detectors verbatim)
// ---------------------------------------------------------------------------

/** Heuristic ids whose evidence is LOCAL to a hunk (see the module doc). */
const HUNK_LOCAL_HEURISTICS = new Set<HeuristicId>(['new-dependency', 'error-masking', 'duplication'])

/**
 * Run the real risk heuristics over a synthesized single-hunk patch and report
 * whether a hunk-local one fired. Never reimplements a detector.
 */
export function hunkHeuristicHit(hunk: DiffHunk, filename: string): boolean {
  const synthetic: PrFile = {
    filename,
    status: 'modified',
    additions: hunk.lines.filter((l) => l.marker === '+').length,
    deletions: hunk.lines.filter((l) => l.marker === '-').length,
    patch: hunkPatch(hunk),
  }
  return detectHeuristics([synthetic]).some((f) => HUNK_LOCAL_HEURISTICS.has(f.id))
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** Chip/marker label per mechanical kind. */
export const HUNK_KIND_LABEL: Record<HunkKind, string> = {
  formatting: 'formatting only',
  imports: 'imports only',
  comments: 'comments only',
  rename: 'renamed identifiers',
  fixture: 'fixture data',
}

/** Plural noun for the file-card strip ("4 formatting hunks"). */
export const HUNK_KIND_GROUP_LABEL: Record<HunkKind, string> = {
  formatting: 'formatting',
  imports: 'import',
  comments: 'comment',
  rename: 'rename',
  fixture: 'fixture-data',
}

/** Stable kind order so summaries and chips never reorder between renders. */
const KIND_ORDER: HunkKind[] = ['formatting', 'imports', 'comments', 'rename', 'fixture']

function sortKinds(kinds: readonly HunkKind[]): HunkKind[] {
  return KIND_ORDER.filter((k) => kinds.includes(k))
}

/** "+12 −3" / "+12" / "−3" — the same ± vocabulary the file header uses. */
export function churnSummary(added: number, removed: number): string {
  if (added === 0 && removed === 0) return 'no changes'
  if (removed === 0) return `+${added}`
  if (added === 0) return `−${removed}`
  return `+${added} −${removed}`
}

// ---------------------------------------------------------------------------
// classifyHunk
// ---------------------------------------------------------------------------

/**
 * Classify one hunk as a 'decision' point or 'mechanical' churn.
 *
 * @param hunk a hunk from {@link parseHunks}
 * @param ctx  the file path plus the finding / draft / heuristic overrides
 *
 * When in doubt the answer is 'decision' — see the module doc.
 */
export function classifyHunk(hunk: DiffHunk, ctx: HunkContext): HunkClassification {
  const added = hunkAdded(hunk)
  const removed = hunkRemoved(hunk)
  const lang = langForFilename(ctx.filename)

  const kinds: HunkKind[] = []
  let renames: { from: string; to: string }[] | null = null

  if (isFixturePath(ctx.filename)) kinds.push('fixture')
  if (isFormattingOnly(added, removed)) {
    kinds.push('formatting')
  } else {
    // Rename and formatting are mutually exclusive by construction (identical
    // streams are formatting; a rename has differing identifier tokens).
    renames = renamePairs(added, removed)
    if (renames) kinds.push('rename')
  }
  for (const k of noiseKindsCovering(hunk, lang)) kinds.push(k)

  const orderedKinds = sortKinds(kinds)

  const overrides: HunkOverride[] = []
  if (ctx.hasFinding) overrides.push('finding')
  if (ctx.hasDraft) overrides.push('draft')
  const heuristic = ctx.heuristicHit ?? hunkHeuristicHit(hunk, ctx.filename)
  if (heuristic) overrides.push('heuristic')

  // Shape says mechanical ONLY when something matched AND nothing overrides.
  const attention: HunkAttention =
    orderedKinds.length > 0 && overrides.length === 0 ? 'mechanical' : 'decision'

  const summary =
    orderedKinds.length > 0
      ? orderedKinds
          .map((k) =>
            k === 'rename' && renames && renames.length === 1
              ? `renamed ${renames[0].from} → ${renames[0].to}`
              : HUNK_KIND_LABEL[k],
          )
          .join(' · ')
      : churnSummary(added.length, removed.length)

  return { attention, kinds: orderedKinds, summary, overrides }
}

// ---------------------------------------------------------------------------
// Whole-file convenience
// ---------------------------------------------------------------------------

/** A line anchor (finding or draft) as the caller already has it. */
export interface LineAnchor {
  line: number
  side: 'LEFT' | 'RIGHT'
}

export interface HunkAttentionInput {
  filename: string
  /** The patch AS RENDERED (the recomputed one when whitespace is hidden). */
  patch: string | undefined
  /** Effective finding anchors on this file. */
  findings?: readonly LineAnchor[]
  /** Draft-comment anchors on this file. */
  drafts?: readonly LineAnchor[]
}

export interface HunkAttentionResult {
  hunks: DiffHunk[]
  classifications: HunkClassification[]
}

/**
 * Parse + classify every hunk of one file, resolving the finding/draft
 * overrides by anchor containment. Deterministic: same input, same output.
 */
export function classifyFileHunks(input: HunkAttentionInput): HunkAttentionResult {
  const hunks = parseHunks(input.patch)
  const classifications = hunks.map((h) =>
    classifyHunk(h, {
      filename: input.filename,
      hasFinding: (input.findings ?? []).some((a) => hunkContainsAnchor(h, a.line, a.side)),
      hasDraft: (input.drafts ?? []).some((a) => hunkContainsAnchor(h, a.line, a.side)),
    }),
  )
  return { hunks, classifications }
}

// ---------------------------------------------------------------------------
// The per-file "what changed" strip
// ---------------------------------------------------------------------------

/** How many decision entries the strip lists before folding the rest away. */
export const MAX_STRIP_DECISIONS = 6

export interface ChangeStripEntry {
  attention: HunkAttention
  /** Primary text: a changed symbol, a line range, or a mechanical group. */
  label: string
  /** True when `label` is a real code symbol (render it as code, not prose). */
  isSymbol: boolean
  /** Secondary text: the hunk summary (empty for group/overflow entries). */
  detail: string
  /** Hunk this entry jumps to. */
  hunkIndex: number
  /** Jump target inside that hunk. */
  line: number
  side: 'LEFT' | 'RIGHT'
  /** Number of hunks folded into this entry (mechanical groups / overflow). */
  count: number
}

export interface ChangeStrip {
  entries: ChangeStripEntry[]
  /** No decision hunk at all — say so plainly instead of padding the list. */
  nothingSubstantive: boolean
  decisionCount: number
  mechanicalCount: number
  /**
   * Whether the strip tells the reviewer anything the diff below does not.
   * A single unnamed decision hunk ("Lines 1–3 · +2") is padding — a file with
   * one change IS its own summary — so the caller renders nothing. True as
   * soon as there is a named symbol, a second entry, or churn worth calling
   * mechanical.
   */
  informative: boolean
}

function rangeLabel(hunk: DiffHunk): string {
  const newLines = hunk.lines.filter((l) => l.newNum > 0)
  if (newLines.length > 0) {
    const start = newLines[0].newNum
    const end = newLines[newLines.length - 1].newNum
    return start === end ? `Line ${start}` : `Lines ${start}–${end}`
  }
  const oldLines = hunk.lines.filter((l) => l.oldNum > 0)
  if (oldLines.length > 0) {
    const start = oldLines[0].oldNum
    const end = oldLines[oldLines.length - 1].oldNum
    return start === end ? `Line ${start} (removed)` : `Lines ${start}–${end} (removed)`
  }
  return `Hunk ${hunk.index + 1}`
}

/**
 * The symbol a hunk touches, from src/lib/diff/symbols.ts (#95) — no second
 * extractor. Candidates are the changed symbols whose new-side range overlaps
 * this hunk; a symbol that ALSO appears in git's enclosing-function context on
 * the hunk header wins, since that is the strongest signal git gives us.
 * Remaining ties break on start line then name, so the strip is stable.
 */
function symbolForHunk(hunk: DiffHunk, symbols: readonly { symbol: string; lineRange: { start: number; end: number } }[]): string | null {
  const newLines = hunk.lines.filter((l) => l.newNum > 0)
  if (newLines.length === 0) return null
  const start = newLines[0].newNum
  const end = newLines[newLines.length - 1].newNum
  const inContext = (name: string): boolean =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hunk.context)
  const overlapping = symbols
    .filter((s) => s.lineRange.start > 0 && s.lineRange.start <= end && s.lineRange.end >= start)
    .sort(
      (a, b) =>
        Number(inContext(b.symbol)) - Number(inContext(a.symbol)) ||
        a.lineRange.start - b.lineRange.start ||
        pathCompare(a.symbol, b.symbol),
    )
  return overlapping[0]?.symbol ?? null
}

/**
 * Build the file card's "what changed" list: one entry per decision hunk
 * (named by its changed symbol when git gives us one, else by line range),
 * then the mechanical hunks folded into one entry per kind ("4 formatting
 * hunks"). Every entry carries a jump target.
 *
 * Nothing substantive → `nothingSubstantive` is set and the caller says so
 * plainly rather than padding the list.
 */
export function buildChangeStrip(
  file: Pick<PrFile, 'filename' | 'status' | 'additions' | 'deletions'> & { patch?: string },
  result: HunkAttentionResult,
): ChangeStrip {
  const { hunks, classifications } = result
  const symbols = file.patch
    ? extractChangedSymbols({ ...file, patch: file.patch } as PrFile)
    : []

  const entries: ChangeStripEntry[] = []
  const decisions = hunks.filter((_, i) => classifications[i].attention === 'decision')
  const mechanical = hunks.filter((_, i) => classifications[i].attention === 'mechanical')

  for (const hunk of decisions.slice(0, MAX_STRIP_DECISIONS)) {
    const anchor = hunkAnchor(hunk)
    if (!anchor) continue
    const symbol = symbolForHunk(hunk, symbols)
    entries.push({
      attention: 'decision',
      label: symbol ?? rangeLabel(hunk),
      isSymbol: symbol !== null,
      detail: classifications[hunk.index].summary,
      hunkIndex: hunk.index,
      line: anchor.line,
      side: anchor.side,
      count: 1,
    })
  }

  const overflow = decisions.slice(MAX_STRIP_DECISIONS)
  if (overflow.length > 0) {
    const anchor = hunkAnchor(overflow[0])
    if (anchor) {
      entries.push({
        attention: 'decision',
        label: `${overflow.length} more section${overflow.length === 1 ? '' : 's'}`,
        isSymbol: false,
        detail: '',
        hunkIndex: overflow[0].index,
        line: anchor.line,
        side: anchor.side,
        count: overflow.length,
      })
    }
  }

  // Mechanical hunks fold by their PRIMARY kind, in the canonical kind order.
  const groups = new Map<HunkKind, DiffHunk[]>()
  for (const hunk of mechanical) {
    const primary = classifications[hunk.index].kinds[0]
    const arr = groups.get(primary) ?? []
    arr.push(hunk)
    groups.set(primary, arr)
  }
  for (const kind of KIND_ORDER) {
    const group = groups.get(kind)
    if (!group || group.length === 0) continue
    const anchor = hunkAnchor(group[0])
    if (!anchor) continue
    entries.push({
      attention: 'mechanical',
      label: `${group.length} ${HUNK_KIND_GROUP_LABEL[kind]} hunk${group.length === 1 ? '' : 's'}`,
      isSymbol: false,
      detail: '',
      hunkIndex: group[0].index,
      line: anchor.line,
      side: anchor.side,
      count: group.length,
    })
  }

  const nothingSubstantive = hunks.length > 0 && decisions.length === 0
  return {
    entries,
    nothingSubstantive,
    decisionCount: decisions.length,
    mechanicalCount: mechanical.length,
    informative:
      entries.length > 1 || nothingSubstantive || (entries.length === 1 && entries[0].isSymbol),
  }
}
