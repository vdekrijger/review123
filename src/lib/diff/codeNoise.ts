/**
 * src/lib/diff/codeNoise.ts — Focus-mode "code noise" line classifier.
 *
 * Best-effort, CONSERVATIVE, line-level detection of import statements and
 * comment lines so Focus mode can visually DIM (never hide) them in the diff.
 *
 * Design notes
 * - This is a pure-heuristic classifier, NOT a parser. It looks only at a
 *   single line's text plus the file's language. It deliberately prefers FALSE
 *   NEGATIVES (missing some noise) over FALSE POSITIVES (dimming real code):
 *   dimming a real statement is more harmful than leaving one import bright.
 * - "Comment" detection is line-LEVEL: a line counts as a comment only when its
 *   first non-whitespace run begins with the language's comment token (or it is
 *   a continuation/close line inside a block comment, e.g. a line starting with
 *   a star). Trailing comments after code are intentionally NOT classified —
 *   that would risk dimming the code on the same line, which we cannot see here.
 * - String-literal awareness is shallow: because we only match LINE-LEADING
 *   tokens, a slash-slash or hash inside a string mid-line is never matched.
 *   The comment token must sit at column 0 of the trimmed text.
 */

export type CodeLang =
  | 'js' // JS / TS / JSX / TSX / Svelte / Vue
  | 'python'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'rust'
  | 'ruby'
  | 'css' // CSS / SCSS / LESS
  | 'sql'
  | 'html' // HTML / XML
  | 'shell'

export type NoiseKind = 'import' | 'comment'

// Extension → language. Lowercased, no leading dot.
const EXT_TO_LANG: Record<string, CodeLang> = {
  // JS / TS family
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  svelte: 'js', vue: 'js',
  // Python
  py: 'python', pyi: 'python',
  // Go
  go: 'go',
  // Java / Kotlin
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  // Rust
  rs: 'rust',
  // Ruby
  rb: 'ruby',
  // CSS family
  css: 'css', scss: 'css', less: 'css', sass: 'css',
  // SQL
  sql: 'sql',
  // HTML / XML
  html: 'html', htm: 'html', xml: 'html', svg: 'html', xhtml: 'html',
  // Shell
  sh: 'shell', bash: 'shell', zsh: 'shell',
}

/**
 * Derive the (best-effort) language from a filename's extension.
 * Returns null when the extension is unknown — callers then dim nothing.
 */
export function langForFilename(filename: string): CodeLang | null {
  const base = filename.slice(filename.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null // no extension, or dotfile with no real ext
  const ext = base.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext] ?? null
}

// ---------------------------------------------------------------------------
// Import detection (line-leading, conservative)
// ---------------------------------------------------------------------------

// JS/TS: `import …`, `export … from …`, `const/let/var x = require(...)`.
const RE_JS_IMPORT = /^\s*import\b/
const RE_JS_EXPORT_FROM = /^\s*export\b[^;]*\bfrom\b/
const RE_JS_REQUIRE = /^\s*(?:const|let|var)\s+[^=]+=\s*require\s*\(/

// Python: `import …` / `from … import …`
const RE_PY_IMPORT = /^\s*import\s+\S/
const RE_PY_FROM = /^\s*from\s+\S+\s+import\b/

// Go: `import "…"`, `import (`, and lines inside an import block: `\t"pkg"` or
// `\talias "pkg"`. We keep the block-line case narrow: a quoted string that is
// the whole (trimmed) line, optionally with a leading identifier/dot/underscore.
const RE_GO_IMPORT = /^\s*import\s*[("]/
const RE_GO_IMPORT_BLOCK_LINE = /^\s*(?:[\w./]+\s+)?"[^"]+"\s*$/

// Java / Kotlin: `import a.b.C;` (Kotlin omits the semicolon)
const RE_JAVA_IMPORT = /^\s*import\s+[\w.*]+\s*;?\s*$/
const RE_KOTLIN_IMPORT = /^\s*import\s+[\w.*]+(?:\s+as\s+\w+)?\s*$/

// Rust: `use …;`, optionally `pub use …;`
const RE_RUST_USE = /^\s*(?:pub\s+)?use\s+\S/

// Ruby: `require '…'` / `require_relative '…'`
const RE_RB_REQUIRE = /^\s*require(?:_relative)?\s+['"]/

// CSS: `@import …`
const RE_CSS_IMPORT = /^\s*@import\b/

export function isImportLine(text: string, lang: CodeLang): boolean {
  switch (lang) {
    case 'js':
      return RE_JS_IMPORT.test(text) || RE_JS_EXPORT_FROM.test(text) || RE_JS_REQUIRE.test(text)
    case 'python':
      return RE_PY_IMPORT.test(text) || RE_PY_FROM.test(text)
    case 'go':
      // Go import blocks: an opening `import (` or a quoted package line. We
      // only treat a bare quoted line as an import inside Go files — acceptable
      // because a standalone quoted string statement is vanishingly rare in Go.
      return RE_GO_IMPORT.test(text) || RE_GO_IMPORT_BLOCK_LINE.test(text)
    case 'java':
      return RE_JAVA_IMPORT.test(text)
    case 'kotlin':
      return RE_KOTLIN_IMPORT.test(text)
    case 'rust':
      return RE_RUST_USE.test(text)
    case 'ruby':
      return RE_RB_REQUIRE.test(text)
    case 'css':
      return RE_CSS_IMPORT.test(text)
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Comment detection (line-leading only, conservative)
// ---------------------------------------------------------------------------

// Languages with `//` line comments and `/* … */` block comments.
const SLASH_LANGS = new Set<CodeLang>(['js', 'go', 'java', 'kotlin', 'rust', 'css'])
// Languages with `#` line comments.
const HASH_LANGS = new Set<CodeLang>(['python', 'ruby', 'shell'])

function isCommentLine(text: string, lang: CodeLang): boolean {
  const trimmed = text.trimStart()
  if (trimmed === '') return false

  if (SLASH_LANGS.has(lang)) {
    // Line comment, block-comment open, or a block-comment continuation/close
    // line (` * …`, ` */`). The leading-` * ` form is the conventional jsdoc /
    // doc-comment body line; treating it as comment is safe and intentional.
    if (trimmed.startsWith('//')) return true
    if (trimmed.startsWith('/*')) return true
    if (trimmed.startsWith('*/')) return true
    if (trimmed.startsWith('*')) return true
  }

  if (HASH_LANGS.has(lang)) {
    // `#` line comment. (Shebangs `#!` are still comments visually.)
    if (trimmed.startsWith('#')) return true
  }

  if (lang === 'sql') {
    if (trimmed.startsWith('--')) return true
    if (trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*')) return true
  }

  if (lang === 'html') {
    if (trimmed.startsWith('<!--')) return true
  }

  return false
}

/**
 * Classify a single diff line's raw text for Focus-mode dimming.
 *
 * @param text raw source text of the line (without the +/- diff marker)
 * @param lang language derived from the filename, or null when unknown
 * @returns 'import' | 'comment' | null
 *
 * Imports take precedence over comments (an `import` line is never a comment),
 * but the two never genuinely collide for a single line.
 *
 * NOTE: This is the PER-LINE helper. It cannot detect multi-line import spans
 * or multi-line block comments (those need sequence + state). Prefer
 * {@link classifyNoiseLines} for the dimming path; this remains for single-line
 * callers / back-compat.
 */
export function classifyNoise(text: string, lang: CodeLang | null): NoiseKind | null {
  if (lang === null) return null
  if (text.trim() === '') return null
  if (isImportLine(text, lang)) return 'import'
  if (isCommentLine(text, lang)) return 'comment'
  return null
}

// ---------------------------------------------------------------------------
// Span-aware classification (stateful across an ORDERED list of lines)
// ---------------------------------------------------------------------------
//
// A pure per-line predicate cannot tell a continuation/closing line of a
// multi-line import (or block comment) apart from arbitrary code, because the
// signal lives in an EARLIER line. classifyNoiseLines walks the file's lines in
// order, tracking whether we're currently inside an OPEN import span (or open
// block comment), and classifies every line of the span — opener, continuation,
// AND closing delimiter — as 'import' (or 'comment').
//
// Conservative still wins: a span only OPENS on a real import-statement opener
// (the same line-leading regexes the per-line path uses). A line that merely
// contains the substring `import` (in a string or identifier) never opens one.

/** Strip string and char literals so brace/paren matching ignores quoted text. */
function stripStringLiterals(text: string): string {
  // Replace the contents of '…', "…" and `…` with spaces. Best-effort: handles
  // the common single-line cases; we only need brace/paren balance, not perfect
  // lexing. Escaped quotes inside strings are rare in import statements.
  return text.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, (m) => ' '.repeat(m.length))
}

/** Net brace balance ( `{` minus `}` ) on a line, ignoring string contents. */
function braceDelta(text: string): number {
  const s = stripStringLiterals(text)
  let d = 0
  for (const ch of s) {
    if (ch === '{') d++
    else if (ch === '}') d--
  }
  return d
}

/** Net paren balance ( `(` minus `)` ) on a line, ignoring string contents. */
function parenDelta(text: string): number {
  const s = stripStringLiterals(text)
  let d = 0
  for (const ch of s) {
    if (ch === '(') d++
    else if (ch === ')') d--
  }
  return d
}

// State while scanning lines in order. Only ONE kind of multi-line span can be
// open at a time for our purposes (imports never nest inside block comments and
// vice-versa for the heuristics we care about).
type SpanState =
  | { kind: 'none' }
  // JS/Rust brace-delimited multi-line import: `import {` / `use a::{` until braces rebalance.
  | { kind: 'js-brace-import'; depth: number }
  // Just closed a JS brace-import on a line with no `from`; an immediately
  // following line that STARTS with `from` belongs to the same statement.
  | { kind: 'js-expect-from' }
  // JS dynamic `import(` / Go `import (` / Python `from x import (` paren block.
  | { kind: 'paren-import'; depth: number }
  // Python backslash line-continuation of a `from … import …` / `import …`.
  | { kind: 'py-backslash-import' }
  // Multi-line block comment `/* … */` (JS-family, CSS, SQL).
  | { kind: 'block-comment' }

const BLOCK_COMMENT_LANGS = new Set<CodeLang>(['js', 'go', 'java', 'kotlin', 'rust', 'css', 'sql'])

/** Does this language use `/* … *​/` block comments? */
function hasBlockComments(lang: CodeLang): boolean {
  return BLOCK_COMMENT_LANGS.has(lang)
}

// A line that clearly STARTS a new top-level statement and therefore cannot be
// the continuation/body of a multi-line import list. Used as a DEFENSIVE bound:
// if an import paren/brace span never closed (because its closing delimiter sits
// in a hidden/collapsed diff region, or the heuristic mis-balanced), it must NOT
// keep marking arbitrary code as 'import'. Conservative ethos: we'd rather leave
// an unterminated import bright than dim a real `def`/`class`/`function` line.
//
// We match the common block-opening keywords across the languages that use
// paren/brace import spans (Python `def`/`class`/`async def`; JS/TS
// `function`/`class`/`export`/`const`/`let`/`var`/`return`/`if`/`for`/`while`;
// Rust `fn`/`pub fn`/`struct`/`impl`/`enum`; Go `func`/`type`/`var`/`const`).
// All are line-LEADING (after optional indentation) to stay conservative.
const RE_STATEMENT_BREAKS_IMPORT =
  /^\s*(?:async\s+)?(?:export\s+)?(?:default\s+)?(?:pub\s+)?(?:def|class|function|func|fn|struct|impl|enum|trait|interface|type|return|if|for|while|switch|match|const|let|var)\b/

/**
 * Is `text` a plausible CONTINUATION/body line of a multi-line import list?
 * Import bodies are import names, dotted paths, commas, parens/braces, `as`
 * aliases, trailing `from`, quoted package strings, and blank lines. A line that
 * opens a new top-level statement (a `def`/`class`/`function`/… — see
 * RE_STATEMENT_BREAKS_IMPORT) is NOT, and forces the span to close defensively.
 *
 * This is the guard that stops an unclosed span (closing `)` hidden in collapsed
 * context) from leaking onto a later hunk's real code.
 */
function isImportContinuationLine(text: string): boolean {
  if (text.trim() === '') return true // blank lines inside a list are fine
  // A line that begins a new top-level statement ends the import body.
  if (RE_STATEMENT_BREAKS_IMPORT.test(text)) return false
  return true
}

/**
 * Detect a multi-line IMPORT span OPENING on `text` for `lang`. Returns the new
 * span state when the line opens a span that does NOT close on the same line, or
 * null when there's no open span (either not an import opener, or it's a
 * complete single-line import). The caller still classifies the opener line as
 * 'import' separately via the per-line predicate.
 */
function openImportSpan(text: string, lang: CodeLang): SpanState | null {
  switch (lang) {
    case 'js': {
      // Dynamic import: `import(` possibly spanning lines.
      if (/^\s*(?:await\s+)?import\s*\(/.test(text)) {
        const d = parenDelta(text)
        if (d > 0) return { kind: 'paren-import', depth: d }
        return null
      }
      // Static import / `export … from`. A brace-delimited list that doesn't
      // close on this line spans further: `import {` , `import x, {`.
      if (RE_JS_IMPORT.test(text) || RE_JS_EXPORT_FROM.test(text)) {
        const d = braceDelta(text)
        if (d > 0) return { kind: 'js-brace-import', depth: d }
        return null
      }
      return null
    }
    case 'rust': {
      // `use a::{ … };` multi-line.
      if (RE_RUST_USE.test(text)) {
        const d = braceDelta(text)
        if (d > 0) return { kind: 'js-brace-import', depth: d }
      }
      return null
    }
    case 'go': {
      // `import (` block.
      if (/^\s*import\s*\(/.test(text)) {
        const d = parenDelta(text)
        if (d > 0) return { kind: 'paren-import', depth: d }
      }
      return null
    }
    case 'python': {
      // `from x import ( … )` paren block.
      if (RE_PY_FROM.test(text) || RE_PY_IMPORT.test(text)) {
        const stripped = stripStringLiterals(text)
        const d = parenDelta(text)
        if (d > 0) return { kind: 'paren-import', depth: d }
        // Backslash line-continuation.
        if (/\\\s*$/.test(stripped)) return { kind: 'py-backslash-import' }
      }
      return null
    }
    default:
      return null
  }
}

/**
 * Span-aware classification over an ORDERED list of source lines (one file /
 * one diff column, top to bottom). Returns a parallel array: for each input
 * line index, its NoiseKind ('import' | 'comment') or null.
 *
 * Multi-line import statements (and multi-line `/* … *​/` block comments) have
 * EVERY line of the span classified — opener, continuation, and closing
 * delimiter. Single-line imports/comments behave exactly as {@link classifyNoise}.
 *
 * @param lines raw source text per line, WITHOUT diff markers, in document order
 * @param lang  language derived from the filename, or null when unknown
 * @param boundaries optional set of line indices at which any OPEN multi-line
 *   span (import / block comment) is forcibly RESET *before* the line is
 *   classified. Callers pass the indices where the rendered lines are NOT
 *   contiguous in the real source (a hunk header, an expander/collapsed-context
 *   gap). Paren/brace balance across a hidden gap is meaningless, so a span must
 *   never carry across one — otherwise an import opened in one hunk would keep
 *   dimming code in the next. Indices outside [0, lines.length) are ignored.
 */
export function classifyNoiseLines(
  lines: string[],
  lang: CodeLang | null,
  boundaries?: ReadonlySet<number>,
): (NoiseKind | null)[] {
  const out: (NoiseKind | null)[] = new Array(lines.length).fill(null)
  if (lang === null) return out

  let span: SpanState = { kind: 'none' }

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]

    // --- Boundary reset: a discontinuity in the rendered lines (hunk header /
    // collapsed-context gap) means any open span's delimiter may be hidden and
    // can never be matched here. Drop the span so it cannot leak across the gap.
    if (boundaries?.has(i)) span = { kind: 'none' }

    // --- Continue an OPEN span ------------------------------------------------
    if (span.kind === 'js-brace-import') {
      // Defensive bound: if this line clearly opens a new top-level statement,
      // the import body must have ended (its `}` was hidden / mis-balanced).
      // Reset and re-classify the line fresh rather than dimming real code.
      if (!isImportContinuationLine(text)) {
        span = { kind: 'none' }
        // fall through to classify this line normally below
      } else {
        out[i] = 'import'
        span.depth += braceDelta(text)
        if (span.depth <= 0) {
          // If the closing line carries no `from`, a lone `from '…'` may follow on
          // the next line (e.g. `}` newline `from './m'`).
          span = /\bfrom\b/.test(stripStringLiterals(text)) ? { kind: 'none' } : { kind: 'js-expect-from' }
        }
        continue
      }
    }
    if (span.kind === 'js-expect-from') {
      // Only the immediately-following `from …` line is absorbed; anything else
      // ends the statement and is classified fresh below.
      if (/^\s*from\b/.test(text)) {
        out[i] = 'import'
        span = { kind: 'none' }
        continue
      }
      span = { kind: 'none' }
      // fall through to classify this line normally
    }
    if (span.kind === 'paren-import') {
      // Defensive bound (the import-runaway fix): a `from x import (` whose
      // closing `)` is hidden in collapsed context would otherwise mark every
      // subsequent line 'import'. If this line opens a new top-level statement
      // (a `def`/`class`/…), the import body has ended — reset and re-classify.
      if (!isImportContinuationLine(text)) {
        span = { kind: 'none' }
        // fall through to classify this line normally below
      } else {
        out[i] = 'import'
        span.depth += parenDelta(text)
        if (span.depth <= 0) span = { kind: 'none' }
        continue
      }
    }
    if (span.kind === 'py-backslash-import') {
      // Same defensive bound: a backslash-continued import that lost its
      // continuation (hidden line) must not absorb a following statement.
      if (!isImportContinuationLine(text)) {
        span = { kind: 'none' }
        // fall through to classify this line normally below
      } else {
        out[i] = 'import'
        // Span continues while THIS line also ends with a backslash.
        if (!/\\\s*$/.test(stripStringLiterals(text))) span = { kind: 'none' }
        continue
      }
    }
    if (span.kind === 'block-comment') {
      out[i] = 'comment'
      // Closes on the line that contains the `*/` terminator.
      if (stripStringLiterals(text).includes('*/')) span = { kind: 'none' }
      continue
    }

    // --- No open span: classify this line, maybe OPEN a new one --------------
    if (text.trim() === '') continue

    if (isImportLine(text, lang)) {
      out[i] = 'import'
      const opened = openImportSpan(text, lang)
      if (opened) span = opened
      continue
    }

    if (isCommentLine(text, lang)) {
      out[i] = 'comment'
      // A block-comment opener that doesn't terminate on the same line starts a
      // multi-line comment span.
      if (hasBlockComments(lang)) {
        const stripped = stripStringLiterals(text)
        const open = stripped.indexOf('/*')
        if (open !== -1 && !stripped.includes('*/', open + 2)) {
          span = { kind: 'block-comment' }
        }
      }
      continue
    }
  }

  return out
}
