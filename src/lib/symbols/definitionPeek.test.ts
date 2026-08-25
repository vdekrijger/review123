import { describe, it, expect } from 'vitest'
import { peekDefinition, MAX_PEEK_LINES } from './definitionPeek'
import type { SymbolSource } from './symbolIndex'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TS_FULL = [
  '// utils', // 1
  'export const A = 1', // 2
  '', // 3
  'export function computeTotal(values: number[]): number {', // 4
  '  return values.reduce((t, v) => t + v, 0)', // 5
  '}', // 6
  'export const B = 2', // 7
].join('\n')

const fullSource: SymbolSource = {
  filename: 'src/util.ts',
  status: 'modified',
  contents: { before: null, after: TS_FULL },
}

describe('peekDefinition — exact extent (tree-sitter endLine)', () => {
  it('returns the full body with real line numbers, complete and uncapped', () => {
    const peek = peekDefinition(fullSource, 'new', 4, 6)
    expect(peek).not.toBeNull()
    expect(peek!.lines).toEqual([
      { line: 4, text: 'export function computeTotal(values: number[]): number {' },
      { line: 5, text: '  return values.reduce((t, v) => t + v, 0)' },
      { line: 6, text: '}' },
    ])
    expect(peek!.moreLines).toBe(0)
    expect(peek!.limitedToPatch).toBe(false)
  })

  it('caps display at MAX_PEEK_LINES and counts the rest in moreLines', () => {
    const body = ['function big() {', ...Array.from({ length: 59 }, (_, i) => `  step(${i})`), '}']
    const src: SymbolSource = { filename: 'src/big.ts', contents: { before: null, after: body.join('\n') } }
    const peek = peekDefinition(src, 'new', 1, 61)
    expect(peek!.lines).toHaveLength(MAX_PEEK_LINES)
    expect(peek!.lines[0]).toEqual({ line: 1, text: 'function big() {' })
    expect(peek!.lines[39].line).toBe(40)
    expect(peek!.moreLines).toBe(21) // 61-line extent − 40 shown
    expect(peek!.limitedToPatch).toBe(false)
  })

  it('clamps a (theoretical) endLine < startLine to a single line', () => {
    const peek = peekDefinition(fullSource, 'new', 4, 2)
    expect(peek!.lines.map((l) => l.line)).toEqual([4])
  })

  it('returns null when the start line is not available at all', () => {
    const src: SymbolSource = { filename: 'src/x.ts', patch: '@@ -1,1 +1,2 @@\n context\n+const a = 1' }
    expect(peekDefinition(src, 'new', 40, 42)).toBeNull()
  })
})

describe('peekDefinition — heuristic extent (no endLine)', () => {
  it('brace languages: matches the def line brace to its close', () => {
    const peek = peekDefinition(fullSource, 'new', 4)
    expect(peek!.lines.map((l) => l.line)).toEqual([4, 5, 6])
    expect(peek!.limitedToPatch).toBe(false)
  })

  it('brace languages: a def line without braces is a single-line definition', () => {
    const src: SymbolSource = {
      filename: 'src/one.ts',
      contents: { before: null, after: 'const double = (x: number) => x * 2\nconst other = 1' },
    }
    const peek = peekDefinition(src, 'new', 1)
    expect(peek!.lines).toEqual([{ line: 1, text: 'const double = (x: number) => x * 2' }])
    expect(peek!.moreLines).toBe(0)
    expect(peek!.limitedToPatch).toBe(false)
  })

  it('ignores braces inside strings and comments during the scan', () => {
    const code = [
      'function tricky() {', // 1
      "  const s = 'closing } brace in a string'", // 2
      '  // and a } in a comment', // 3
      '}', // 4
      'const after = 1', // 5
    ].join('\n')
    const src: SymbolSource = { filename: 'src/tricky.ts', contents: { before: null, after: code } }
    expect(peekDefinition(src, 'new', 1)!.lines.map((l) => l.line)).toEqual([1, 2, 3, 4])
  })

  it('python: indentation body, multi-line signature consumed via the header walk', () => {
    const code = [
      'def compute(', // 1
      '    a: int,', // 2
      '    b: int,', // 3
      ') -> int:', // 4
      '    total = a + b', // 5
      '', // 6
      '    return total', // 7
      'NEXT = 1', // 8
    ].join('\n')
    const src: SymbolSource = { filename: 'app/calc.py', contents: { before: null, after: code } }
    const peek = peekDefinition(src, 'new', 1)
    expect(peek!.lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(peek!.limitedToPatch).toBe(false)
  })

  it('python: the dedented next def is NOT part of the body', () => {
    const code = ['def first():', '    return 1', 'def second():', '    return 2'].join('\n')
    const src: SymbolSource = { filename: 'app/two.py', contents: { before: null, after: code } }
    expect(peekDefinition(src, 'new', 1)!.lines.map((l) => l.line)).toEqual([1, 2])
  })

  it('ruby: the trailing `end` at the def indent belongs to the block', () => {
    const code = [
      'class ReportJob', // 1
      '  def perform(args)', // 2
      '    helper(args)', // 3
      '  end', // 4
      'end', // 5
      'OTHER = 1', // 6
    ].join('\n')
    const src: SymbolSource = { filename: 'lib/job.rb', contents: { before: null, after: code } }
    expect(peekDefinition(src, 'new', 2)!.lines.map((l) => l.line)).toEqual([2, 3, 4])
    expect(peekDefinition(src, 'new', 1)!.lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5])
  })

  it('unknown languages: generic indentation scan', () => {
    const code = ['[section]', '  key = 1', '  other = 2', '[next]'].join('\n')
    const src: SymbolSource = { filename: 'config/settings.toml', contents: { before: null, after: code } }
    expect(peekDefinition(src, 'new', 1)!.lines.map((l) => l.line)).toEqual([1, 2, 3])
  })
})

describe('peekDefinition — patch-only honesty', () => {
  it('a body fully inside the hunk is complete — no patch-only note', () => {
    const patch = [
      '@@ -1,1 +1,4 @@',
      '+export function computeTotal(values: number[]): number {',
      '+  return values.reduce((t, v) => t + v, 0)',
      '+}',
      ' export const VERSION = 1',
    ].join('\n')
    const src: SymbolSource = { filename: 'src/util.ts', status: 'modified', patch }
    const peek = peekDefinition(src, 'new', 1)
    expect(peek!.lines.map((l) => l.line)).toEqual([1, 2, 3])
    expect(peek!.limitedToPatch).toBe(false)
  })

  it('a body cut off by the hunk is flagged limitedToPatch (heuristic end never found)', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' export function helper() {', '+  const added = 1'].join('\n')
    const src: SymbolSource = { filename: 'src/cut.ts', status: 'modified', patch }
    const peek = peekDefinition(src, 'new', 1)
    expect(peek!.lines.map((l) => l.line)).toEqual([1, 2])
    expect(peek!.limitedToPatch).toBe(true)
    expect(peek!.moreLines).toBe(0) // nothing more is AVAILABLE to count
  })

  it('a known extent outrunning the hunk is flagged limitedToPatch', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' export function helper() {', '+  const added = 1'].join('\n')
    const src: SymbolSource = { filename: 'src/cut.ts', status: 'modified', patch }
    const peek = peekDefinition(src, 'new', 1, 6)
    expect(peek!.lines.map((l) => l.line)).toEqual([1, 2])
    expect(peek!.limitedToPatch).toBe(true)
  })

  it('full contents are never limitedToPatch, even when the scan finds no terminator', () => {
    const src: SymbolSource = {
      filename: 'src/eof.ts',
      contents: { before: null, after: 'function trailing() {\n  const x = 1' },
    }
    const peek = peekDefinition(src, 'new', 1)
    expect(peek!.lines.map((l) => l.line)).toEqual([1, 2])
    expect(peek!.limitedToPatch).toBe(false)
  })
})

describe('peekDefinition — side handling', () => {
  it('old side reads fetched BEFORE contents when available', () => {
    const src: SymbolSource = {
      filename: 'app/old.py',
      contents: { before: 'def legacy():\n    return 1\nX = 2', after: 'X = 2' },
    }
    const peek = peekDefinition(src, 'old', 1, 2)
    expect(peek!.lines).toEqual([
      { line: 1, text: 'def legacy():' },
      { line: 2, text: '    return 1' },
    ])
    expect(peek!.limitedToPatch).toBe(false)
  })

  it('old side patch-only reads context + deletions at OLD line numbers', () => {
    const patch = ['@@ -10,3 +10,2 @@', ' function keep() {', '-  const removed = legacy()', ' }'].join('\n')
    const src: SymbolSource = { filename: 'src/del.ts', status: 'modified', patch }
    const peek = peekDefinition(src, 'old', 10)
    expect(peek!.lines).toEqual([
      { line: 10, text: 'function keep() {' },
      { line: 11, text: '  const removed = legacy()' },
      { line: 12, text: '}' },
    ])
    expect(peek!.limitedToPatch).toBe(false)
  })

  it('new side patch-only never sees deletion lines', () => {
    const patch = ['@@ -10,3 +10,2 @@', ' function keep() {', '-  const removed = legacy()', ' }'].join('\n')
    const src: SymbolSource = { filename: 'src/del.ts', status: 'modified', patch }
    const peek = peekDefinition(src, 'new', 10)
    expect(peek!.lines).toEqual([
      { line: 10, text: 'function keep() {' },
      { line: 11, text: '}' },
    ])
  })
})
