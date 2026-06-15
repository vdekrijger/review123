/**
 * src/lib/diff/symbolTests.ts — Symbol↔test pairing (Plan I).
 *
 * pairSymbolsWithTests(symbols, testFiles) ties each CHANGED symbol to the
 * SPECIFIC test block that references it, with a confidence label:
 *
 *   - 'named'      (high)  — the symbol appears in a test TITLE:
 *                            describe('foo'…), it('… foo …'…), test('foo'…),
 *                            or a `def test_*foo*` name (Python).
 *   - 'referenced' (lower) — the symbol is called/imported only (foo(, new Foo(,
 *                            import { foo }, from mod import foo) inside a test.
 *
 * Conservative — false pairings erode trust, so a missing pair beats a wrong
 * one:
 *   - whole-word match only (never a substring of a longer identifier);
 *   - symbols shorter than 3 chars are refused (too ambiguous);
 *   - no match → that symbol is omitted from the output entirely.
 *
 * For each reference we capture the enclosing test block's line range
 * best-effort (brace scan for JS/TS, indentation scan for Python-style).
 *
 * Pure — no LLM, no network. Test file CONTENT comes from the app's already
 * fetched full-file contents (story/expand-context `contentsMap`).
 */

import type { ChangedSymbol } from './symbols'
import { extractChangedSymbols } from './symbols'
import { langForFilename } from './codeNoise'
import { isTestFile } from '../testFile'
import type { PrFile } from '../github/types'

export type PairingConfidence = 'named' | 'referenced'

export interface TestRef {
  testFile: string
  /** 1-based inclusive line range of the enclosing test block. */
  lineRange: { start: number; end: number }
  /** The test title when the symbol was named in one (confidence 'named'). */
  title?: string
  confidence: PairingConfidence
}

export interface SymbolTestPairing {
  symbol: string
  implFile: string
  implLineRange: { start: number; end: number }
  tests: TestRef[]
}

export interface TestFileContent {
  path: string
  content: string
}

/** Minimum symbol length to pair on — shorter is too ambiguous. */
const MIN_SYMBOL_LEN = 3

function wholeWordRegex(symbol: string): RegExp {
  // \b boundaries plus explicit non-identifier guards so `buildKey` does not
  // match inside `buildKeyCache`.
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`)
}

/**
 * Whether a Python test-function name names the symbol. Test names embed the
 * tested symbol underscore-delimited by convention (`test_<symbol>_<case>`),
 * so here `_` IS a token boundary — `compute_total` is named by
 * `test_compute_total_sums_items` but NOT by `test_compute_totally`.
 */
function pyTestNamesSymbol(testName: string, symbol: string): boolean {
  // Strip the leading `test`/`test_` prefix, then look for the symbol as a run
  // of underscore-delimited tokens.
  const body = testName.replace(/^test_?/, '')
  const haystack = `_${body}_`
  return haystack.includes(`_${symbol}_`)
}

// Title-bearing test declarations: it / test / describe / context (JS family),
// plus a `def test...` (Python). Captures the title string (JS) for display.
const JS_TITLE_RE = /\b(?:it|test|describe|context)\s*\(\s*(['"`])([^'"`]*)\1/
const PY_TEST_DEF_RE = /^\s*(?:async\s+)?def\s+(test[A-Za-z0-9_]*)\s*\(/

/**
 * Find the enclosing test block range for a reference on `line` (0-based index
 * into `lines`). Best-effort:
 *  - JS/TS: walk up to the nearest it/test/describe(… , () => {  opener, then
 *    brace-match forward to its close.
 *  - Python-ish: walk up to the nearest `def test...:`, then forward until the
 *    indentation returns to ≤ the def's indent (or EOF).
 * Returns 1-based inclusive { start, end }.
 */
function enclosingBlock(
  lines: string[],
  line: number,
  style: 'brace' | 'indent',
): { start: number; end: number } {
  if (style === 'indent') {
    // Walk up to a `def test...` (or any def) header.
    let start = line
    while (start > 0 && !/^\s*(?:async\s+)?def\s+/.test(lines[start])) start--
    const indent = (lines[start].match(/^\s*/)?.[0].length) ?? 0
    let end = line
    for (let i = start + 1; i < lines.length; i++) {
      const text = lines[i]
      if (text.trim() === '') { end = i; continue }
      const ind = (text.match(/^\s*/)?.[0].length) ?? 0
      if (ind <= indent) break
      end = i
    }
    // Trim a trailing run of blank lines from the block.
    while (end > start && lines[end].trim() === '') end--
    return { start: start + 1, end: end + 1 }
  }

  // brace style — find the opener line (nearest title decl at/above `line`).
  let start = line
  while (start > 0 && !JS_TITLE_RE.test(lines[start])) start--
  // Brace-match forward from the opener.
  let depth = 0
  let seenOpen = false
  let end = start
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seenOpen = true }
      else if (ch === '}') depth--
    }
    end = i
    if (seenOpen && depth <= 0) break
  }
  return { start: start + 1, end: end + 1 }
}

/**
 * Pair changed symbols with the test blocks that reference them.
 * Symbols with no test reference are omitted (graceful, empty by default).
 */
export function pairSymbolsWithTests(
  symbols: ChangedSymbol[],
  testFiles: TestFileContent[],
): SymbolTestPairing[] {
  const out: SymbolTestPairing[] = []
  if (testFiles.length === 0) return out

  // Pre-split each test file once.
  const split = testFiles.map((tf) => ({
    path: tf.path,
    lines: tf.content.length ? tf.content.split('\n') : [],
    style: (langForFilename(tf.path) === 'python' ? 'indent' : 'brace') as 'brace' | 'indent',
  }))

  for (const s of symbols) {
    if (s.symbol.length < MIN_SYMBOL_LEN) continue
    const word = wholeWordRegex(s.symbol)
    const tests: TestRef[] = []

    for (const tf of split) {
      if (tf.lines.length === 0) continue

      // Pass 1: named — symbol appears in a test TITLE.
      let named: TestRef | null = null
      for (let i = 0; i < tf.lines.length; i++) {
        const lineText = tf.lines[i]
        const jsTitle = JS_TITLE_RE.exec(lineText)
        if (jsTitle && word.test(jsTitle[2])) {
          named = {
            testFile: tf.path,
            lineRange: enclosingBlock(tf.lines, i, tf.style),
            title: jsTitle[2],
            confidence: 'named',
          }
          break
        }
        const pyDef = PY_TEST_DEF_RE.exec(lineText)
        if (pyDef && pyTestNamesSymbol(pyDef[1], s.symbol)) {
          named = {
            testFile: tf.path,
            lineRange: enclosingBlock(tf.lines, i, tf.style),
            title: pyDef[1],
            confidence: 'named',
          }
          break
        }
      }
      if (named) { tests.push(named); continue }

      // Pass 2: referenced — symbol used as a whole word anywhere in the file.
      for (let i = 0; i < tf.lines.length; i++) {
        if (word.test(tf.lines[i])) {
          tests.push({
            testFile: tf.path,
            lineRange: enclosingBlock(tf.lines, i, tf.style),
            confidence: 'referenced',
          })
          break
        }
      }
    }

    if (tests.length === 0) continue
    // Named first, then referenced — highest-confidence test leads.
    tests.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'named' ? -1 : 1))
    out.push({
      symbol: s.symbol,
      implFile: s.file,
      implLineRange: s.lineRange,
      tests,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Story-step orchestrator
// ---------------------------------------------------------------------------

export interface StepPairingInput {
  /** Non-test code files shown in this story step (its `files`). */
  stepFiles: PrFile[]
  /** Candidate test files (the step's relatedTests + any PR test files). */
  testFiles: PrFile[]
  /** Already-fetched full file contents, keyed by path → { before, after }. */
  contentsMap: Map<string, { before: string | null; after: string | null }> | null
}

/**
 * Compute symbol↔test pairings for a story step. Extracts changed symbols from
 * the step's NON-TEST code files, gathers the available NEW (after) content for
 * the candidate test files, and runs the matcher. Returns only symbols with at
 * least one paired test — graceful + empty when nothing pairs or content is
 * unavailable.
 *
 * Grouped by implFile so the UI can render pairings beneath the right diff.
 */
export function pairStepTests(input: StepPairingInput): Map<string, SymbolTestPairing[]> {
  const { contentsMap } = input
  const byFile = new Map<string, SymbolTestPairing[]>()
  if (!contentsMap) return byFile

  const testContents: TestFileContent[] = []
  for (const tf of input.testFiles) {
    if (!isTestFile(tf.filename)) continue
    const content = contentsMap.get(tf.filename)?.after
    if (content) testContents.push({ path: tf.filename, content })
  }
  if (testContents.length === 0) return byFile

  for (const f of input.stepFiles) {
    if (isTestFile(f.filename)) continue
    const symbols = extractChangedSymbols(f)
    if (symbols.length === 0) continue
    const pairings = pairSymbolsWithTests(symbols, testContents)
    if (pairings.length > 0) byFile.set(f.filename, pairings)
  }

  return byFile
}
