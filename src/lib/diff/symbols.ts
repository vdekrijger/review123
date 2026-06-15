/**
 * src/lib/diff/symbols.ts — Changed-symbol extraction (Plan I).
 *
 * extractChangedSymbols(file) reads a PrFile's raw patch and returns the
 * CONFIDENT changed-symbol names, each tied to the file + the changed new-side
 * line range. Pure parsing — no LLM, no network.
 *
 * Two signals, both conservative (a missed symbol beats a wrong one):
 *
 *  1. HUNK-HEADER enclosing context (STRONG). Git's unified-diff hunk header
 *     carries the enclosing function/class on its trailing context after the
 *     closing `@@`:
 *        @@ -318,7 +324,7 @@ async def send_slack_ai_subscription_report(
 *     We pull the symbol name from that text with a per-language regex. This
 *     works across languages because git's xfuncname targets the enclosing def.
 *
 *  2. ADDED DEFINITION lines. A `+` line inside a hunk that itself declares a
 *     symbol (def/class/func/fn/...) contributes that symbol.
 *
 * The line range associated with a symbol is the union of changed (`+`)
 * new-side line numbers in the hunk(s) where it was seen (mirrors the hunk
 * walk in patchLines.ts). Names are deduped per file.
 */

import type { PrFile } from '../github/types'
import { langForFilename, type CodeLang } from './codeNoise'

export interface ChangedSymbol {
  /** Confident enclosing/defined symbol name. */
  symbol: string
  /** PrFile.filename this symbol belongs to. */
  file: string
  /** New-side (RIGHT) changed line span. start/end are 1-based inclusive. */
  lineRange: { start: number; end: number }
}

// A valid identifier in the languages we cover (no leading digit).
const IDENT = '[A-Za-z_][A-Za-z0-9_]*'

// ---------------------------------------------------------------------------
// Hunk-header enclosing-context patterns (text AFTER the closing `@@`)
// ---------------------------------------------------------------------------

function symbolFromHunkContext(ctx: string, lang: CodeLang): string | null {
  const t = ctx.trim()
  if (t === '') return null

  switch (lang) {
    case 'python': {
      // def foo( / async def foo( / class Foo
      const m = t.match(new RegExp(`^(?:async\\s+)?def\\s+(${IDENT})`)) ||
        t.match(new RegExp(`^class\\s+(${IDENT})`))
      return m ? m[1] : null
    }
    case 'go': {
      // func (r R) Save( OR func NewClient(
      const recv = t.match(new RegExp(`^func\\s+\\([^)]*\\)\\s+(${IDENT})`))
      if (recv) return recv[1]
      const fn = t.match(new RegExp(`^func\\s+(${IDENT})`))
      return fn ? fn[1] : null
    }
    case 'rust': {
      const m = t.match(new RegExp(`^(?:pub\\s+)?(?:async\\s+)?fn\\s+(${IDENT})`)) ||
        t.match(new RegExp(`^(?:pub\\s+)?(?:struct|enum|trait|impl)\\s+(${IDENT})`))
      return m ? m[1] : null
    }
    case 'ruby': {
      const m = t.match(new RegExp(`^def\\s+(?:self\\.)?(${IDENT})`)) ||
        t.match(new RegExp(`^(?:class|module)\\s+(${IDENT})`))
      return m ? m[1] : null
    }
    case 'java':
    case 'kotlin': {
      // Kotlin: fun foo(. Java: returnType foo(... ) {  / class Foo
      const kfun = t.match(new RegExp(`\\bfun\\s+(${IDENT})`))
      if (kfun) return kfun[1]
      const cls = t.match(new RegExp(`\\b(?:class|interface|enum)\\s+(${IDENT})`))
      if (cls) return cls[1]
      // Java method: ... name(args) {   — name is the ident immediately before "("
      const meth = t.match(new RegExp(`(${IDENT})\\s*\\([^)]*\\)\\s*(?:throws[^{]*)?\\{?\\s*$`))
      if (meth && !isJsKeyword(meth[1])) return meth[1]
      return null
    }
    case 'js': {
      return symbolFromJsDecl(t)
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Added-definition-line patterns (the `+` line text itself declares a symbol)
// ---------------------------------------------------------------------------

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await',
  'class', 'const', 'let', 'var', 'new', 'else', 'do', 'try',
])
function isJsKeyword(s: string): boolean {
  return JS_KEYWORDS.has(s)
}

function symbolFromJsDecl(text: string): string | null {
  const t = text.trim()
  // function foo / export function foo / async function foo
  const fn = t.match(new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`))
  if (fn) return fn[1]
  // class Foo / export class Foo
  const cls = t.match(new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`))
  if (cls) return cls[1]
  // const foo = (...) => / const foo = async (...) => / const foo = function
  const arrow = t.match(new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:async\\s*)?(?:\\(|function\\b|${IDENT}\\s*=>)`))
  if (arrow) return arrow[1]
  // method shorthand inside a class/object: `name(args) {` (must end the line at `{`)
  const meth = t.match(new RegExp(`^(?:async\\s+)?(?:static\\s+)?(?:get\\s+|set\\s+)?(${IDENT})\\s*\\([^)]*\\)\\s*\\{\\s*$`))
  if (meth && !isJsKeyword(meth[1])) return meth[1]
  return null
}

function symbolFromAddedLine(text: string, lang: CodeLang): string | null {
  switch (lang) {
    case 'js':
      return symbolFromJsDecl(text)
    case 'python': {
      const t = text.trim()
      const m = t.match(new RegExp(`^(?:async\\s+)?def\\s+(${IDENT})`)) ||
        t.match(new RegExp(`^class\\s+(${IDENT})`))
      return m ? m[1] : null
    }
    case 'go': {
      const t = text.trim()
      const recv = t.match(new RegExp(`^func\\s+\\([^)]*\\)\\s+(${IDENT})`))
      if (recv) return recv[1]
      const fn = t.match(new RegExp(`^func\\s+(${IDENT})`))
      return fn ? fn[1] : null
    }
    case 'rust': {
      const t = text.trim()
      const m = t.match(new RegExp(`^(?:pub\\s+)?(?:async\\s+)?fn\\s+(${IDENT})`)) ||
        t.match(new RegExp(`^(?:pub\\s+)?(?:struct|enum|trait)\\s+(${IDENT})`))
      return m ? m[1] : null
    }
    case 'ruby': {
      const t = text.trim()
      const m = t.match(new RegExp(`^def\\s+(?:self\\.)?(${IDENT})`)) ||
        t.match(new RegExp(`^(?:class|module)\\s+(${IDENT})`))
      return m ? m[1] : null
    }
    case 'java':
    case 'kotlin': {
      const t = text.trim()
      const kfun = t.match(new RegExp(`\\bfun\\s+(${IDENT})`))
      if (kfun) return kfun[1]
      const cls = t.match(new RegExp(`\\b(?:class|interface|enum)\\s+(${IDENT})`))
      if (cls) return cls[1]
      return null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Patch walk
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

/**
 * Extract confident changed symbols from a PrFile's patch.
 * Returns [] when the patch is absent or the language is unknown.
 */
export function extractChangedSymbols(file: PrFile): ChangedSymbol[] {
  const lang = langForFilename(file.filename)
  if (!file.patch || lang === null) return []

  // symbol → accumulated new-side changed line range
  const byName = new Map<string, { start: number; end: number }>()

  function record(symbol: string, line: number | null): void {
    if (!symbol) return
    const existing = byName.get(symbol)
    if (!existing) {
      byName.set(symbol, line === null
        ? { start: 0, end: 0 }
        : { start: line, end: line })
      return
    }
    if (line !== null) {
      if (existing.start === 0 || line < existing.start) existing.start = line
      if (line > existing.end) existing.end = line
    }
  }

  let newLine = 0
  let enclosing: string | null = null

  for (const raw of file.patch.split('\n')) {
    const h = HUNK_HEADER.exec(raw)
    if (h) {
      newLine = parseInt(h[1], 10)
      enclosing = symbolFromHunkContext(h[2] ?? '', lang)
      // The enclosing symbol exists even before we see added lines; seed it so
      // a pure-context change (no new def line) still surfaces the function.
      if (enclosing) record(enclosing, null)
      continue
    }

    if (raw.startsWith('+')) {
      const text = raw.slice(1)
      // Attribute this added line's range to the enclosing symbol.
      if (enclosing) record(enclosing, newLine)
      // An added line that itself declares a symbol contributes that symbol.
      const declared = symbolFromAddedLine(text, lang)
      if (declared) record(declared, newLine)
      newLine++
    } else if (raw.startsWith('-')) {
      // removed line — does not advance new-side counter, never adds symbols
    } else if (raw === '\\ No newline at end of file') {
      // marker — ignore
    } else {
      // context line — advances new-side counter
      newLine++
    }
  }

  const out: ChangedSymbol[] = []
  for (const [symbol, range] of byName) {
    out.push({
      symbol,
      file: file.filename,
      lineRange: range.start === 0
        ? { start: 0, end: 0 }
        : { start: range.start, end: range.end },
    })
  }
  return out
}
