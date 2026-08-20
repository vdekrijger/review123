// @vitest-environment node
/**
 * treeSitter tests (Tier 3 symbol navigation) — REAL WASM parsers.
 *
 * Runs in the node environment (not jsdom) because web-tree-sitter's
 * emscripten loader picks its web path when `window` exists and then tries to
 * fetch() filesystem paths. Grammars are loaded from node_modules bytes and
 * installed via the test hook — the same registry initTreeSitterBackend fills
 * in the browser — so extraction and the buildSymbolIndex integration are
 * exercised against the real TS/TSX/JS/Python/Go/Ruby grammars.
 *
 * NOTE: every buildSymbolIndex call sits inside a beforeAll/it body — describe
 * bodies execute at COLLECTION time, before the file-level beforeAll installs
 * the parsers, and would silently test the heuristic instead.
 *
 * Coverage: language mapping; syntax-aware definitions (incl. kinds the
 * heuristic can't infer); references that skip strings and comments ACROSS
 * LINES (the single-line regex stripper's blind spot — these assertions prove
 * the parser, not the heuristic, answered); patch-only per-side
 * reconstruction with the old-side deletion-only rule; inDiff tagging;
 * stopword/snippet rules surviving the swap; and the fallback ladder
 * (grammar missing / parse throws / parse returns null / unsupported lang).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Parser, Language } from 'web-tree-sitter'
import {
  treeSitterLangForFilename,
  extractDocumentSymbols,
  onBackendUpgraded,
  _installTreeSitterParserForTest,
  _resetTreeSitterForTest,
  type TreeSitterLang,
} from './treeSitter'
import { buildSymbolIndex, type SymbolIndex, type SymbolSource } from './symbolIndex'

// The project tsconfig is browser-only (no @types/node), so fs is resolved at
// runtime with a local structural type — Node's typings stay out of the
// program. Repo root derived from this file's URL: src/lib/symbols → ../../../
const { readFileSync } = (await import('node' + ':fs')) as unknown as {
  readFileSync: (path: URL) => Uint8Array
}
const wasmUrl = (rel: string): URL => new URL(`../../../node_modules/${rel}`, import.meta.url)

const GRAMMAR_WASM_PATHS: Record<TreeSitterLang, string> = {
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  ruby: 'tree-sitter-ruby/tree-sitter-ruby.wasm',
}

async function installRealParsers(): Promise<void> {
  await Parser.init({
    // POSIX pathname is fine — dev (macOS) and CI (linux) both qualify.
    locateFile: () => wasmUrl('web-tree-sitter/web-tree-sitter.wasm').pathname,
  })
  for (const [lang, rel] of Object.entries(GRAMMAR_WASM_PATHS) as [TreeSitterLang, string][]) {
    const language = await Language.load(readFileSync(wasmUrl(rel)))
    const parser = new Parser()
    parser.setLanguage(language)
    _installTreeSitterParserForTest(lang, (text) => parser.parse(text))
  }
}

beforeAll(async () => {
  await installRealParsers()
}, 30_000)

afterAll(() => {
  _resetTreeSitterForTest()
})

// ---------------------------------------------------------------------------
// Language mapping (pure — no parser involved)
// ---------------------------------------------------------------------------

describe('treeSitterLangForFilename', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.mts', 'typescript'],
    ['src/a.tsx', 'tsx'],
    ['src/a.js', 'javascript'],
    ['src/a.jsx', 'javascript'],
    ['app/models.py', 'python'],
    ['pkg/store.go', 'go'],
    ['lib/report.rb', 'ruby'],
  ] as const)('%s → %s', (filename, lang) => {
    expect(treeSitterLangForFilename(filename)).toBe(lang)
  })

  it('leaves Svelte/Vue and unknown extensions on the heuristic', () => {
    expect(treeSitterLangForFilename('src/App.svelte')).toBeNull()
    expect(treeSitterLangForFilename('src/App.vue')).toBeNull()
    expect(treeSitterLangForFilename('config/settings.toml')).toBeNull()
    expect(treeSitterLangForFilename('Makefile')).toBeNull()
    expect(treeSitterLangForFilename('.gitignore')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TypeScript — extraction + buildSymbolIndex integration (full contents)
// ---------------------------------------------------------------------------

const TS_AFTER = [
  '/** computeTotal mentioned in a doc comment */', // 1
  'export function computeTotal(values: number[]): number {', // 2
  '  return values.reduce((acc, v) => acc + v, 0)', // 3
  '}', // 4
  'const label = `template starts here', // 5
  'computeTotal continues inside the template`', // 6
  'export class ReportBuilder {', // 7
  '  build(): number {', // 8
  '    return computeTotal([1, 2])', // 9
  '  }', // 10
  '}', // 11
  'const handler = async (e: Event) => computeTotal([2])', // 12
  'export interface PayloadShape { total: number }', // 13
  'export type AliasName = string', // 14
  'export enum Color { Red }', // 15
].join('\n')

// Patch covers lines 8–9 only, so inDiff is provable per line.
const TS_PATCH = '@@ -8,1 +8,2 @@\n   build(): number {\n+    return computeTotal([1, 2])'

const tsSource: SymbolSource = {
  filename: 'src/calc.ts',
  status: 'modified',
  patch: TS_PATCH,
  contents: { before: null, after: TS_AFTER },
}

describe('tree-sitter TypeScript — definitions', () => {
  let index: SymbolIndex
  beforeAll(() => {
    index = buildSymbolIndex([tsSource])
  })

  it.each([
    ['computeTotal', 'function', 2],
    ['ReportBuilder', 'class', 7],
    ['build', 'method', 8],
    ['handler', 'variable', 12],
    ['PayloadShape', 'type', 13],
    ['AliasName', 'type', 14],
    ['Color', 'type', 15],
  ] as const)('%s → kind %s at line %d', (name, kind, line) => {
    const defs = index.definitionsOf(name)
    expect(defs).toHaveLength(1)
    expect(defs[0]).toMatchObject({ name, kind, line, side: 'new', file: 'src/calc.ts' })
  })

  it('extractDocumentSymbols exposes the same definitions directly', () => {
    const extracted = extractDocumentSymbols('src/calc.ts', TS_AFTER)
    expect(extracted).not.toBeNull()
    expect(extracted!.definitions).toContainEqual({ name: 'computeTotal', kind: 'function', line: 2 })
    expect(extracted!.definitions).toContainEqual({ name: 'build', kind: 'method', line: 8 })
  })
})

describe('tree-sitter TypeScript — references skip strings and comments across lines', () => {
  let index: SymbolIndex
  beforeAll(() => {
    index = buildSymbolIndex([tsSource])
  })

  it('finds real call sites, excluding the definition line', () => {
    const refs = index.referencesOf('computeTotal')
    expect(refs.map((r) => r.line)).toEqual([9, 12])
  })

  it('never counts the doc-comment mention (line 1)', () => {
    expect(index.referencesOf('computeTotal').map((r) => r.line)).not.toContain(1)
  })

  it('never counts the multi-line template-literal interior (line 6) — beyond the single-line stripper', () => {
    // The heuristic's stripper is single-line: it cannot know line 6 is still
    // inside the backtick string opened on line 5. The parser can — this
    // assertion is the proof the tree-sitter backend answered.
    expect(index.referencesOf('computeTotal').map((r) => r.line)).not.toContain(6)
  })

  it('tags hunk membership: line 9 is inDiff, line 12 and the def are not', () => {
    const refs = index.referencesOf('computeTotal')
    expect(refs.find((r) => r.line === 9)?.inDiff).toBe(true)
    expect(refs.find((r) => r.line === 12)?.inDiff).toBe(false)
    expect(index.definitionsOf('computeTotal')[0].inDiff).toBe(false)
  })

  it('keeps the query-side identifier rules (stopwords, min length, shape)', () => {
    expect(index.has('return')).toBe(false)
    expect(index.has('const')).toBe(false)
    expect(index.has('a')).toBe(false)
    expect(index.has('123abc')).toBe(false)
    expect(index.has('computeTotal')).toBe(true)
  })

  it('caps snippets at 160 chars', () => {
    const longLine = `const wide = computeThing(${'"x", '.repeat(60)})`
    const src: SymbolSource = { filename: 'src/wide.ts', contents: { before: null, after: longLine } }
    const refs = buildSymbolIndex([src]).referencesOf('computeThing')
    expect(refs).toHaveLength(1)
    expect(refs[0].snippet.length).toBeLessThanOrEqual(160)
    expect(refs[0].snippet.endsWith('…')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Patch-only sides — gap-filled per-side reconstruction
// ---------------------------------------------------------------------------

describe('tree-sitter — patch-only reconstruction', () => {
  // Hunk starts at line 10 on both sides: reconstruction must preserve real
  // line numbers (gaps become empty lines the parser tolerates).
  const PATCH = ['@@ -10,3 +10,3 @@', ' function legacyHelper() {', '-  return oldCompute(1)', '+  return newCompute(1)', ' }'].join('\n')
  let index: SymbolIndex
  beforeAll(() => {
    index = buildSymbolIndex([{ filename: 'src/patchy.ts', status: 'modified', patch: PATCH }])
  })

  it('definitions carry patch line numbers, once, on the new side only', () => {
    // The old-side parse sees the context line (better tree) but only
    // deletions are emitted — so no duplicate old-side definition appears.
    const defs = index.definitionsOf('legacyHelper')
    expect(defs).toHaveLength(1)
    expect(defs[0]).toMatchObject({ kind: 'function', line: 10, side: 'new', inDiff: true })
  })

  it('deleted-line references land on the old side at old line numbers', () => {
    expect(index.referencesOf('oldCompute')).toHaveLength(1)
    expect(index.referencesOf('oldCompute')[0]).toMatchObject({ side: 'old', line: 11, inDiff: true })
    expect(index.referencesOf('newCompute')[0]).toMatchObject({ side: 'new', line: 11, inDiff: true })
  })
})

describe('tree-sitter — removed files', () => {
  let index: SymbolIndex
  beforeAll(() => {
    index = buildSymbolIndex([
      {
        filename: 'src/gone.ts',
        status: 'removed',
        patch: '@@ -1,3 +0,0 @@\n-export function goneHelper() {\n-  return goneHelper\n-}',
      },
    ])
  })

  it('indexes the old side of a removed file via the parser', () => {
    expect(index.definitionsOf('goneHelper')[0]).toMatchObject({ side: 'old', line: 1, kind: 'function' })
    expect(index.referencesOf('goneHelper').map((r) => `${r.side}:${r.line}`)).toEqual(['old:2'])
  })
})

// ---------------------------------------------------------------------------
// Python / Go / Ruby / TSX
// ---------------------------------------------------------------------------

describe('tree-sitter Python', () => {
  const PY = [
    'import os', // 1
    'def compute_total(values):', // 2
    '    return sum(values)', // 3
    'class ReportModel:', // 4
    '    def refresh(self):', // 5
    '        return compute_total([1])', // 6
    'total = compute_total([2])  # compute_total in a comment too', // 7
    'print(os)', // 8
  ].join('\n')
  let index: SymbolIndex
  beforeAll(() => {
    index = buildSymbolIndex([{ filename: 'app/models.py', contents: { before: null, after: PY } }])
  })

  it('separates functions from methods (class-nested defs)', () => {
    expect(index.definitionsOf('compute_total')[0]).toMatchObject({ kind: 'function', line: 2 })
    expect(index.definitionsOf('refresh')[0]).toMatchObject({ kind: 'method', line: 5 })
    expect(index.definitionsOf('ReportModel')[0]).toMatchObject({ kind: 'class', line: 4 })
  })

  it('references skip the def line (and the comment mention adds nothing extra)', () => {
    expect(index.referencesOf('compute_total').map((r) => r.line)).toEqual([6, 7])
  })

  it('python builtins stay stopworded on parsed lines', () => {
    // Line 8 mentions `print` as a real identifier node — the stoplist still
    // refuses it at query time, exactly like the heuristic did.
    expect(index.has('print')).toBe(false)
    expect(index.referencesOf('print')).toHaveLength(0)
  })
})

describe('tree-sitter Go', () => {
  const GO = [
    'package store', // 1
    'func NewClient(addr string) *Client {', // 2
    '\treturn &Client{}', // 3
    '}', // 4
    'func (c *Client) Save(v int) error {', // 5
    '\treturn nil', // 6
    '}', // 7
    'type Client struct {', // 8
    '\taddr string', // 9
    '}', // 10
  ].join('\n')
  let index: SymbolIndex
  beforeAll(() => {
    index = buildSymbolIndex([{ filename: 'pkg/store.go', contents: { before: null, after: GO } }])
  })

  it('finds funcs, receiver methods, and type specs', () => {
    expect(index.definitionsOf('NewClient')[0]).toMatchObject({ kind: 'function', line: 2 })
    expect(index.definitionsOf('Save')[0]).toMatchObject({ kind: 'method', line: 5 })
    expect(index.definitionsOf('Client')[0]).toMatchObject({ kind: 'type', line: 8 })
  })

  it('type references include return types, literals, and receivers — not the def line', () => {
    expect(index.referencesOf('Client').map((r) => r.line)).toEqual([2, 3, 5])
  })
})

describe('tree-sitter Ruby', () => {
  const RB = [
    'class ReportJob', // 1
    '  def perform_now(args)', // 2
    '    helper_call(args)', // 3
    '  end', // 4
    'end', // 5
    'ReportJob.new.perform_now(1)', // 6
  ].join('\n')
  let index: SymbolIndex
  beforeAll(() => {
    index = buildSymbolIndex([{ filename: 'lib/report.rb', contents: { before: null, after: RB } }])
  })

  it('finds the class and its method (class-nested def → method)', () => {
    expect(index.definitionsOf('ReportJob')[0]).toMatchObject({ kind: 'class', line: 1 })
    expect(index.definitionsOf('perform_now')[0]).toMatchObject({ kind: 'method', line: 2 })
  })

  it('resolves constant and call references', () => {
    expect(index.referencesOf('ReportJob').map((r) => r.line)).toEqual([6])
    expect(index.referencesOf('perform_now').map((r) => r.line)).toEqual([6])
  })
})

describe('tree-sitter TSX', () => {
  const TSX = [
    'export const Widget = () => {', // 1
    '  return <button onClick={handleClick}>{label}</button>', // 2
    '}', // 3
  ].join('\n')
  let index: SymbolIndex
  beforeAll(() => {
    index = buildSymbolIndex([{ filename: 'src/Widget.tsx', contents: { before: null, after: TSX } }])
  })

  it('finds the arrow-function component definition', () => {
    expect(index.definitionsOf('Widget')[0]).toMatchObject({ kind: 'variable', line: 1 })
  })

  it('finds identifiers inside JSX expressions', () => {
    expect(index.referencesOf('handleClick').map((r) => r.line)).toEqual([2])
    expect(index.referencesOf('label').map((r) => r.line)).toEqual([2])
  })
})

// ---------------------------------------------------------------------------
// Fallback ladder (kept LAST — these tests replace/remove installed parsers)
// ---------------------------------------------------------------------------

describe('heuristic fallback', () => {
  const TEMPLATE_SPILL = [
    'export function spillHelper() {', // 1
    '}', // 2
    'const label = `template starts here', // 3
    'spillHelper continues inside the template`', // 4
  ].join('\n')
  const spillSource: SymbolSource = { filename: 'src/spill.ts', contents: { before: null, after: TEMPLATE_SPILL } }

  it('unsupported languages answer heuristically even with grammars loaded', () => {
    const index = buildSymbolIndex([
      { filename: 'config/settings.toml', patch: '@@ -1,1 +1,3 @@\n context_here\n+primary_region = "fra"\n+backup_region = primary_region' },
    ])
    expect(index.referencesOf('primary_region').map((r) => r.line)).toEqual([2, 3])
    expect(index.definitionsOf('primary_region')).toHaveLength(0)
  })

  it('with the real parser, the template-literal spill line is NOT a reference', () => {
    const refs = buildSymbolIndex([spillSource]).referencesOf('spillHelper')
    expect(refs.map((r) => r.line)).not.toContain(4)
  })

  it('a throwing parser falls back to the heuristic (spill line IS a reference again)', () => {
    _installTreeSitterParserForTest('typescript', () => {
      throw new Error('boom')
    })
    const index = buildSymbolIndex([spillSource])
    expect(index.definitionsOf('spillHelper')[0]).toMatchObject({ kind: 'function', line: 1 })
    expect(index.referencesOf('spillHelper').map((r) => r.line)).toContain(4)
  })

  it('a parser returning null falls back to the heuristic', () => {
    _installTreeSitterParserForTest('typescript', () => null)
    const index = buildSymbolIndex([spillSource])
    expect(index.definitionsOf('spillHelper')[0]).toMatchObject({ kind: 'function', line: 1 })
  })

  it('no parser at all (pre-load window) falls back to the heuristic', () => {
    _resetTreeSitterForTest()
    const index = buildSymbolIndex([spillSource])
    expect(index.definitionsOf('spillHelper')[0]).toMatchObject({ kind: 'function', line: 1 })
    expect(extractDocumentSymbols('src/spill.ts', TEMPLATE_SPILL)).toBeNull()
  })

  it('installing a parser fires the upgrade hook; unsubscribe stops it', () => {
    let fired = 0
    const off = onBackendUpgraded(() => fired++)
    _installTreeSitterParserForTest('typescript', () => null)
    expect(fired).toBe(1)
    off()
    _installTreeSitterParserForTest('typescript', () => null)
    expect(fired).toBe(1)
  })
})
