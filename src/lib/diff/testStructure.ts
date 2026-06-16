/**
 * src/lib/diff/testStructure.ts — Plan P. Heuristic parser that turns a test
 * file's content into a scannable STRUCTURE for the "Tested by" affordance:
 *
 *   1. Test cases  — `it('…')` / `test('…')` (JS) and `def test_*` (Python),
 *                    grouped under `describe('…')` / `class Test*`. Each carries
 *                    a title + the body line-range.
 *   2. Setup       — shared scaffolding extracted OUT of the test cases:
 *                    JS `beforeEach`/`afterEach`/`beforeAll`/`afterAll` hooks,
 *                    top-of-describe `jest.mock`/`vi.mock` calls, and module/
 *                    describe-scope `const`/`let`/helper fns; Python `setUp`/
 *                    `tearDown`/`setUpClass`/`tearDownClass` methods and
 *                    `@pytest.fixture` functions.
 *   3. Imports     — EXCLUDED entirely (reuse codeNoise import detection).
 *
 * This is a CONSERVATIVE heuristic, NOT a full AST. When no test framework is
 * recognized (or nothing parses), `fallback` is true and the caller keeps the
 * old single-snippet behavior — we never regress those cases.
 *
 * Line ranges are 1-based inclusive. A single very large test BODY may be capped
 * (its `truncated` flag set) but the LIST of titles is never truncated.
 *
 * Pure — no LLM, no network. Content comes from the app's already-fetched
 * full-file contents (story/expand-context `contentsMap`).
 */

import { langForFilename, isImportLine, type CodeLang } from './codeNoise'

export type TestFramework = 'jest' | 'pytest' | null

/** 1-based inclusive line range. */
export interface LineRange {
  start: number
  end: number
}

export interface ParsedTestCase {
  /** Display title (humanized for Python). */
  title: string
  /** Body line-range (the declaration through its closing brace/dedent). */
  lineRange: LineRange
  /** True when the body exceeded the per-body cap and was truncated. */
  truncated?: boolean
}

export interface TestGroup {
  /** describe(...) / class Test... title, or undefined for the top-level group. */
  title?: string
  tests: ParsedTestCase[]
}

export interface TestStructure {
  framework: TestFramework
  groups: TestGroup[]
  /** Shared setup/teardown scaffolding line-ranges (sorted, non-overlapping). */
  setup: LineRange[]
  /**
   * Python only: true when the file likely relies on conftest.py fixtures that
   * live OUT OF FILE and therefore cannot be shown. Surfaced honestly — never
   * fabricated.
   */
  conftestNote: boolean
  /**
   * True when no recognized framework / no test cases were found. The caller
   * should fall back to the legacy single-snippet behavior.
   */
  fallback: boolean
}

/** Maximum source lines a single captured test/setup body may span. */
const MAX_BODY_LINES = 40

/**
 * Humanize a Python test-function name: strip the `test`/`test_` prefix and turn
 * the underscore-delimited remainder into a space-separated phrase.
 * `test_renders_dashboard_tile` → "renders dashboard tile".
 */
export function humanizePyTestName(name: string): string {
  const body = name.replace(/^test_?/, '').replace(/_+/g, ' ').trim()
  return body.length ? body : name
}

// ---------------------------------------------------------------------------
// JS/TS declarations
// ---------------------------------------------------------------------------

const JS_DESCRIBE_RE = /^\s*(?:describe|context)\s*(?:\.\w+)?\s*\(\s*(['"`])([^'"`]*)\1/
const JS_TEST_RE = /^\s*(?:it|test)\s*(?:\.\w+)?\s*\(\s*(['"`])([^'"`]*)\1/
const JS_HOOK_RE = /^\s*(?:beforeEach|afterEach|beforeAll|afterAll)\s*\(/
const JS_MOCK_RE = /^\s*(?:jest|vi)\s*\.\s*mock\s*\(/
// Describe/module-scope shared declarations (const/let/var and helper functions).
const JS_SCOPE_DECL_RE = /^(\s*)(?:const|let|var|(?:async\s+)?function)\b/

/**
 * Brace-match forward from `start` (0-based) to the line that closes the first
 * `{` opened at/after `start`. Returns the 0-based inclusive end line. If no
 * brace is ever opened, returns `start` (single-line statement).
 */
function jsBlockEnd(lines: string[], start: number): number {
  let depth = 0
  let seenOpen = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seenOpen = true }
      else if (ch === '}') depth--
    }
    if (seenOpen && depth <= 0) return i
    if (!seenOpen && /[;)]\s*$/.test(lines[i]) && i > start) return i
  }
  return seenOpen ? lines.length - 1 : start
}

function capRange(start0: number, end0: number): { range: LineRange; truncated: boolean } {
  const span = end0 - start0 + 1
  if (span > MAX_BODY_LINES) {
    return { range: { start: start0 + 1, end: start0 + MAX_BODY_LINES }, truncated: true }
  }
  return { range: { start: start0 + 1, end: end0 + 1 }, truncated: false }
}

function parseJs(lines: string[]): TestStructure | null {
  // Quick reject: no it/test declarations → not a recognizable JS test file.
  if (!lines.some((l) => JS_TEST_RE.test(l))) return null

  const groups: TestGroup[] = []
  const topGroup: TestGroup = { tests: [] }
  const setup: LineRange[] = []
  // Stack of open describe blocks: { title, end (0-based), group }.
  const stack: Array<{ title: string; end: number; group: TestGroup }> = []

  for (let i = 0; i < lines.length; i++) {
    // Pop describe blocks we've exited.
    while (stack.length && i > stack[stack.length - 1].end) stack.pop()

    const line = lines[i]
    if (isImportLine(line, 'js')) continue

    const describeM = JS_DESCRIBE_RE.exec(line)
    if (describeM) {
      const end = jsBlockEnd(lines, i)
      const group: TestGroup = { title: describeM[2], tests: [] }
      groups.push(group)
      stack.push({ title: describeM[2], end, group })
      continue
    }

    const testM = JS_TEST_RE.exec(line)
    if (testM) {
      const end = jsBlockEnd(lines, i)
      const { range, truncated } = capRange(i, end)
      const tc: ParsedTestCase = { title: testM[2], lineRange: range }
      if (truncated) tc.truncated = true
      const target = stack.length ? stack[stack.length - 1].group : topGroup
      target.tests.push(tc)
      i = end // skip the body so nested decls aren't re-scanned
      continue
    }

    if (JS_HOOK_RE.test(line) || JS_MOCK_RE.test(line)) {
      const end = jsBlockEnd(lines, i)
      const { range } = capRange(i, end)
      setup.push(range)
      i = end
      continue
    }

    // Describe/module-scope shared declaration (helper / const / let) outside
    // any it — part of the shared scaffolding.
    const declM = JS_SCOPE_DECL_RE.exec(line)
    if (declM) {
      const end = jsBlockEnd(lines, i)
      const { range } = capRange(i, end)
      setup.push(range)
      i = end
      continue
    }
  }

  // Only keep the top-level group if it actually holds tests.
  const orderedGroups: TestGroup[] = []
  if (topGroup.tests.length) orderedGroups.push(topGroup)
  for (const g of groups) if (g.tests.length) orderedGroups.push(g)

  if (orderedGroups.every((g) => g.tests.length === 0)) return null

  return {
    framework: 'jest',
    groups: orderedGroups,
    setup: mergeRanges(setup),
    conftestNote: false,
    fallback: false,
  }
}

// ---------------------------------------------------------------------------
// Python declarations
// ---------------------------------------------------------------------------

const PY_CLASS_RE = /^(\s*)class\s+(Test[A-Za-z0-9_]*)\b/
const PY_DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/
const PY_FIXTURE_DECO_RE = /^\s*@(?:pytest\.)?fixture\b/
const PY_SETUP_NAMES = new Set(['setUp', 'tearDown', 'setUpClass', 'tearDownClass', 'setup_method', 'teardown_method'])

function pyIndent(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0
}

/**
 * Body end (0-based inclusive) of a Python block whose header starts on
 * `start`: scan forward until indentation returns to ≤ `headerIndent`, trimming
 * trailing blank lines.
 */
function pyBlockEnd(lines: string[], start: number, headerIndent: number): number {
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { end = i; continue }
    if (pyIndent(lines[i]) <= headerIndent) break
    end = i
  }
  while (end > start && lines[end].trim() === '') end--
  return end
}

function parsePy(lines: string[]): TestStructure | null {
  const hasTestFn = lines.some((l) => {
    const m = PY_DEF_RE.exec(l)
    return m && /^test/i.test(m[2])
  })
  if (!hasTestFn) return null

  const topGroup: TestGroup = { tests: [] }
  const groups: TestGroup[] = []
  const setup: LineRange[] = []
  let conftestNote = false

  // Track the currently-open Test class (by its body indent).
  let classStack: Array<{ group: TestGroup; indent: number; end: number }> = []
  let pendingFixtureDeco = false

  for (let i = 0; i < lines.length; i++) {
    // Pop classes we've exited.
    classStack = classStack.filter((c) => i <= c.end)

    const line = lines[i]
    if (line.trim() === '') continue
    if (isImportLine(line, 'python')) continue

    if (PY_FIXTURE_DECO_RE.test(line)) { pendingFixtureDeco = true; continue }

    const classM = PY_CLASS_RE.exec(line)
    if (classM) {
      const indent = classM[1].length
      const end = pyBlockEnd(lines, i, indent)
      const group: TestGroup = { title: classM[2], tests: [] }
      groups.push(group)
      classStack.push({ group, indent, end })
      continue
    }

    const defM = PY_DEF_RE.exec(line)
    if (defM) {
      const indent = defM[1].length
      const name = defM[2]
      const end = pyBlockEnd(lines, i, indent)
      const start0 = pendingFixtureDeco ? i - 1 : i

      if (pendingFixtureDeco || PY_SETUP_NAMES.has(name)) {
        const { range } = capRange(start0, end)
        setup.push(range)
        conftestNote = conftestNote || pendingFixtureDeco // some fixtures shown; conftest may hold more
        pendingFixtureDeco = false
        i = end
        continue
      }
      pendingFixtureDeco = false

      if (/^test/i.test(name)) {
        const { range, truncated } = capRange(i, end)
        const tc: ParsedTestCase = { title: humanizePyTestName(name), lineRange: range }
        if (truncated) tc.truncated = true
        // Attach to the innermost enclosing class group, else top-level.
        const cls = classStack.find((c) => indent > c.indent)
        ;(cls ? cls.group : topGroup).tests.push(tc)
        i = end
        continue
      }
      // Non-test def at module/class scope → shared helper scaffolding.
      const { range } = capRange(start0, end)
      setup.push(range)
      i = end
      continue
    }
    pendingFixtureDeco = false
  }

  const orderedGroups: TestGroup[] = []
  if (topGroup.tests.length) orderedGroups.push(topGroup)
  for (const g of groups) if (g.tests.length) orderedGroups.push(g)

  if (orderedGroups.every((g) => g.tests.length === 0)) return null

  return {
    framework: 'pytest',
    groups: orderedGroups,
    setup: mergeRanges(setup),
    conftestNote,
    fallback: false,
  }
}

// ---------------------------------------------------------------------------
// Range merge (sort + coalesce overlapping/adjacent)
// ---------------------------------------------------------------------------

function mergeRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length <= 1) return [...ranges]
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: LineRange[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]
    const r = sorted[i]
    if (r.start <= last.end + 1) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

const FALLBACK: TestStructure = {
  framework: null,
  groups: [],
  setup: [],
  conftestNote: false,
  fallback: true,
}

/**
 * Parse a test file's content into its structure. Returns a `fallback` result
 * when the framework isn't recognized or nothing parses — the caller then keeps
 * the legacy single-snippet behavior.
 */
export function parseTestStructure(content: string, filename: string): TestStructure {
  if (!content) return FALLBACK
  const lang: CodeLang | null = langForFilename(filename)
  const lines = content.split('\n')

  let parsed: TestStructure | null = null
  if (lang === 'js') parsed = parseJs(lines)
  else if (lang === 'python') parsed = parsePy(lines)

  return parsed ?? FALLBACK
}
