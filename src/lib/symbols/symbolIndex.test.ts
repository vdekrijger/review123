import { describe, it, expect } from 'vitest'
import { buildSymbolIndex, stripLiteralsAndComments, type SymbolSource } from './symbolIndex'

// ---------------------------------------------------------------------------
// Fixtures — bare GitHub-style hunks (the real wire format)
// ---------------------------------------------------------------------------

const TS_PATCH = [
  '@@ -1,4 +1,8 @@',
  ' const keep = 1',
  '+export function computeTotal(values: number[]): number {',
  '+  return values.reduce((a, b) => a + b, 0)',
  '+}',
  '+const total = computeTotal([1, 2])',
  ' class Widget {',
  '-  render() {',
  '+  renderFast() {',
  '     computeTotal([3])',
].join('\n')

const tsFile: SymbolSource = { filename: 'src/calc.ts', status: 'modified', patch: TS_PATCH }

describe('buildSymbolIndex — TS/JS', () => {
  const index = buildSymbolIndex([tsFile])

  it('finds a function definition with file/line/side/snippet', () => {
    const defs = index.definitionsOf('computeTotal')
    expect(defs).toHaveLength(1)
    expect(defs[0]).toMatchObject({
      name: 'computeTotal',
      kind: 'function',
      file: 'src/calc.ts',
      line: 2,
      side: 'new',
      inDiff: true,
    })
    expect(defs[0].snippet).toContain('export function computeTotal')
  })

  it('finds const-arrow definitions', () => {
    const src: SymbolSource = {
      filename: 'a.ts',
      patch: '@@ -1,1 +1,2 @@\n context\n+const handler = async (e: Event) => {',
    }
    const defs = buildSymbolIndex([src]).definitionsOf('handler')
    expect(defs).toHaveLength(1)
    expect(defs[0].kind).toBe('variable')
  })

  it('finds class and method-shorthand definitions', () => {
    expect(index.definitionsOf('renderFast')).toHaveLength(1)
    expect(index.definitionsOf('renderFast')[0].kind).toBe('method')
    const src: SymbolSource = {
      filename: 'b.ts',
      patch: '@@ -1,1 +1,2 @@\n context\n+export class ReportBuilder {',
    }
    expect(buildSymbolIndex([src]).definitionsOf('ReportBuilder')[0]?.kind).toBe('class')
  })

  it('finds interface/type definitions', () => {
    const src: SymbolSource = {
      filename: 'c.ts',
      patch: '@@ -1,1 +1,3 @@\n context\n+export interface PayloadShape {\n+export type AliasName = string',
    }
    const idx = buildSymbolIndex([src])
    expect(idx.definitionsOf('PayloadShape')[0]?.kind).toBe('type')
    expect(idx.definitionsOf('AliasName')[0]?.kind).toBe('type')
  })

  it('references exclude the definition line but include call sites', () => {
    const refs = index.referencesOf('computeTotal')
    const lines = refs.map((r) => `${r.side}:${r.line}`)
    expect(lines).toContain('new:5') // const total = computeTotal([1, 2])
    expect(lines).toContain('new:8') // computeTotal([3]) — context line
    expect(lines).not.toContain('new:2') // the definition line itself
  })

  it('tags deletion lines with side old (and new lines with side new)', () => {
    const refs = index.referencesOf('render')
    expect(refs).toHaveLength(0) // render's only occurrence was its own (old) def line
    const defs = index.definitionsOf('render')
    expect(defs).toHaveLength(1)
    expect(defs[0].side).toBe('old')
    expect(defs[0].line).toBe(3)
  })

  it('excludes language keywords', () => {
    expect(index.has('return')).toBe(false)
    expect(index.has('const')).toBe(false)
    expect(index.has('function')).toBe(false)
    expect(index.referencesOf('return')).toHaveLength(0)
  })

  it('excludes string and comment content', () => {
    const src: SymbolSource = {
      filename: 'd.ts',
      patch: [
        '@@ -1,1 +1,4 @@',
        ' context',
        '+const label = "secretToken means nothing"',
        '+// secretToken appears in a comment',
        '+use(realToken)',
      ].join('\n'),
    }
    const idx = buildSymbolIndex([src])
    expect(idx.has('secretToken')).toBe(false)
    expect(idx.has('realToken')).toBe(true)
  })

  it('has() refuses non-identifiers and 1-char names', () => {
    expect(index.has('a b')).toBe(false)
    expect(index.has('123abc')).toBe(false)
    expect(index.has('')).toBe(false)
    expect(index.has('a')).toBe(false)
  })

  it('unknown identifiers are absent', () => {
    expect(index.has('doesNotExistAnywhere')).toBe(false)
    expect(index.definitionsOf('doesNotExistAnywhere')).toHaveLength(0)
    expect(index.referencesOf('doesNotExistAnywhere')).toHaveLength(0)
  })
})

describe('buildSymbolIndex — Python', () => {
  const src: SymbolSource = {
    filename: 'app/models.py',
    patch: [
      '@@ -1,2 +1,6 @@',
      ' import os',
      '+def compute_total(values):',
      '+    return sum(values)',
      '+class ReportModel:',
      '+    total = compute_total([1])',
      ' print(os)',
    ].join('\n'),
  }
  const index = buildSymbolIndex([src])

  it('finds def and class definitions', () => {
    expect(index.definitionsOf('compute_total')[0]).toMatchObject({ kind: 'function', line: 2, side: 'new' })
    expect(index.definitionsOf('ReportModel')[0]).toMatchObject({ kind: 'class', line: 4 })
  })

  it('finds references, excluding the def line', () => {
    const refs = index.referencesOf('compute_total')
    expect(refs.map((r) => r.line)).toEqual([5])
  })

  it('excludes python builtins/keywords', () => {
    expect(index.has('print')).toBe(false)
    expect(index.has('def')).toBe(false)
  })
})

describe('buildSymbolIndex — Go', () => {
  const src: SymbolSource = {
    filename: 'pkg/store.go',
    patch: [
      '@@ -1,2 +1,7 @@',
      ' package store',
      '+func NewClient(addr string) *Client {',
      '+func (c *Client) Save(v int) error {',
      '+type Client struct {',
      '+  c := NewClient("x")',
      '+  c.Save(1)',
      ' // trailer',
    ].join('\n'),
  }
  const index = buildSymbolIndex([src])

  it('finds plain funcs, receiver methods, and types', () => {
    expect(index.definitionsOf('NewClient')[0]?.kind).toBe('function')
    expect(index.definitionsOf('Save')[0]?.kind).toBe('method')
    expect(index.definitionsOf('Client')[0]?.kind).toBe('type')
  })

  it('finds references excluding def lines', () => {
    expect(index.referencesOf('NewClient').map((r) => r.line)).toEqual([5])
    expect(index.referencesOf('Save').map((r) => r.line)).toEqual([6])
  })

  it('excludes go keywords/builtins', () => {
    expect(index.has('func')).toBe(false)
    expect(index.has('error')).toBe(false)
  })
})

describe('buildSymbolIndex — Ruby', () => {
  const src: SymbolSource = {
    filename: 'lib/report.rb',
    patch: [
      '@@ -1,2 +1,7 @@',
      ' require "json"',
      '+class ReportJob',
      '+  def perform_now(args)',
      '+  end',
      '+end',
      '+ReportJob.new.perform_now(1)',
      ' # trailer',
    ].join('\n'),
  }
  const index = buildSymbolIndex([src])

  it('finds class and def definitions', () => {
    expect(index.definitionsOf('ReportJob')[0]?.kind).toBe('class')
    expect(index.definitionsOf('perform_now')[0]?.kind).toBe('function')
  })

  it('finds references excluding def lines', () => {
    expect(index.referencesOf('perform_now').map((r) => r.line)).toEqual([6])
    expect(index.referencesOf('ReportJob').map((r) => r.line)).toEqual([6])
  })
})

describe('buildSymbolIndex — generic fallback (unknown extension)', () => {
  const src: SymbolSource = {
    filename: 'config/settings.toml',
    patch: '@@ -1,1 +1,3 @@\n context_here\n+primary_region = "fra"\n+backup_region = primary_region',
  }
  const index = buildSymbolIndex([src])

  it('finds no definitions but still answers word-boundary references', () => {
    expect(index.definitionsOf('primary_region')).toHaveLength(0)
    const refs = index.referencesOf('primary_region')
    // Line 2 (assignment) and line 3 (use) — no def detection to exclude either.
    expect(refs.map((r) => r.line)).toEqual([2, 3])
    expect(index.has('primary_region')).toBe(true)
  })

  it('never matches substrings of longer identifiers', () => {
    expect(index.referencesOf('region')).toHaveLength(0)
  })
})

describe('buildSymbolIndex — full contents vs patch-only', () => {
  const after = [
    'export function helperFn() {', // line 1 — OUTSIDE the hunks
    '  return 1',
    '}',
    'const keep = 1',
    'const added = helperFn()', // line 5 — inside the hunk
  ].join('\n')
  const src: SymbolSource = {
    filename: 'src/full.ts',
    status: 'modified',
    patch: '@@ -4,1 +4,2 @@\n const keep = 1\n+const added = helperFn()',
    contents: { before: 'export function helperFn() {\n  return 1\n}\nconst keep = 1', after },
  }
  const index = buildSymbolIndex([src])

  it('indexes full after-contents when available, tagging hunk membership', () => {
    const defs = index.definitionsOf('helperFn')
    expect(defs).toHaveLength(1)
    expect(defs[0].line).toBe(1)
    expect(defs[0].inDiff).toBe(false) // known from contents, not in the rendered hunks
    const refs = index.referencesOf('helperFn')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ line: 5, inDiff: true })
  })

  it('does not double-report context lines from the old side', () => {
    // 'keep' appears once in after-contents (line 4). Old side only indexes
    // deletions, so no duplicate old-side context entry exists.
    const refs = index.referencesOf('keep')
    expect(refs).toHaveLength(1)
    expect(refs[0].side).toBe('new')
  })
})

describe('buildSymbolIndex — removed files', () => {
  const src: SymbolSource = {
    filename: 'src/gone.ts',
    status: 'removed',
    patch: '@@ -1,3 +0,0 @@\n-export function goneHelper() {\n-  return goneHelper\n-}',
  }
  const index = buildSymbolIndex([src])

  it('indexes the old side of a removed file', () => {
    const defs = index.definitionsOf('goneHelper')
    expect(defs).toHaveLength(1)
    expect(defs[0].side).toBe('old')
    expect(defs[0].line).toBe(1)
    const refs = index.referencesOf('goneHelper')
    expect(refs.map((r) => `${r.side}:${r.line}`)).toEqual(['old:2'])
  })
})

describe('buildSymbolIndex — cross-file', () => {
  const def: SymbolSource = {
    filename: 'src/util.ts',
    patch: '@@ -1,1 +1,2 @@\n context\n+export function sharedThing() {}',
  }
  const use: SymbolSource = {
    filename: 'src/app.ts',
    patch: '@@ -1,1 +1,2 @@\n context\n+const v = sharedThing()',
  }
  const index = buildSymbolIndex([def, use])

  it('resolves definitions and references across files', () => {
    expect(index.definitionsOf('sharedThing')[0]?.file).toBe('src/util.ts')
    const refs = index.referencesOf('sharedThing')
    expect(refs).toHaveLength(1)
    expect(refs[0].file).toBe('src/app.ts')
  })
})

describe('stripLiteralsAndComments', () => {
  it('blanks string interiors (js)', () => {
    expect(stripLiteralsAndComments('const a = "hidden token"', 'js')).toBe('const a = "            "')
  })

  it('cuts // comments (js) and # comments (python)', () => {
    expect(stripLiteralsAndComments('call() // trailing note', 'js')).toBe('call() ')
    expect(stripLiteralsAndComments('call()  # trailing note', 'python')).toBe('call()  ')
  })

  it('keeps # intact in js and // intact in python (not comment tokens there)', () => {
    expect(stripLiteralsAndComments('sel("#id")', 'js')).toBe('sel("   ")')
    expect(stripLiteralsAndComments('a = b // c', 'python')).toBe('a = b // c')
  })

  it('blanks single-line block comments and cuts unterminated ones (js)', () => {
    expect(stripLiteralsAndComments('a /* mid */ b', 'js')).toBe('a           b')
    expect(stripLiteralsAndComments('a /* runs on', 'js')).toBe('a ')
  })

  it('handles escaped quotes inside strings', () => {
    const out = stripLiteralsAndComments('const s = "a \\" b" + tail', 'js')
    expect(out).toContain('+ tail')
    expect(out).not.toContain('a \\" b')
  })
})
