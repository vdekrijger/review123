import { describe, it, expect } from 'vitest'
import { pairSymbolsWithTests, pairStepTests } from './symbolTests'
import type { ChangedSymbol } from './symbols'
import type { PrFile } from '../github/types'

function sym(symbol: string, file = 'src/a.ts'): ChangedSymbol {
  return { symbol, file, lineRange: { start: 1, end: 1 } }
}

describe('pairSymbolsWithTests — named (high confidence)', () => {
  it('matches a symbol named in an it() title', () => {
    const content = [
      "import { buildKey } from './a'",
      "describe('keys', () => {",
      "  it('buildKey joins parts', () => {",
      '    expect(buildKey(1)).toBe(2)',
      '  })',
      '})',
    ].join('\n')
    const pairs = pairSymbolsWithTests([sym('buildKey')], [{ path: 'src/a.test.ts', content }])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].symbol).toBe('buildKey')
    expect(pairs[0].tests).toHaveLength(1)
    expect(pairs[0].tests[0].confidence).toBe('named')
    expect(pairs[0].tests[0].testFile).toBe('src/a.test.ts')
    expect(pairs[0].tests[0].title).toContain('buildKey')
  })

  it('matches a symbol named in a describe() title', () => {
    const content = "describe('renderPanel', () => {\n  it('works', () => { renderPanel() })\n})"
    const pairs = pairSymbolsWithTests([sym('renderPanel')], [{ path: 'ui.test.ts', content }])
    expect(pairs[0].tests[0].confidence).toBe('named')
  })

  it('matches a Python test function whose name contains the symbol', () => {
    const content = [
      'from billing import compute_total',
      '',
      'def test_compute_total_sums_items():',
      '    assert compute_total([1, 2]) == 3',
    ].join('\n')
    const pairs = pairSymbolsWithTests(
      [sym('compute_total', 'billing.py')],
      [{ path: 'test_billing.py', content }],
    )
    expect(pairs[0].tests[0].confidence).toBe('named')
    expect(pairs[0].tests[0].title).toContain('compute_total')
  })
})

describe('pairSymbolsWithTests — referenced (lower confidence)', () => {
  it('matches a called identifier not in any title', () => {
    const content = [
      "import { computeStuff } from './a'",
      "describe('suite', () => {",
      "  it('does a thing', () => {",
      '    expect(computeStuff(3)).toBe(9)',
      '  })',
      '})',
    ].join('\n')
    const pairs = pairSymbolsWithTests([sym('computeStuff')], [{ path: 'a.test.ts', content }])
    expect(pairs[0].tests[0].confidence).toBe('referenced')
  })

  it('matches a python import-only reference', () => {
    const content = 'from mod import helper\n\ndef test_unrelated():\n    helper()\n    assert True'
    const pairs = pairSymbolsWithTests([sym('helper', 'mod.py')], [{ path: 'test_mod.py', content }])
    expect(pairs[0].tests[0].confidence).toBe('referenced')
  })
})

describe('pairSymbolsWithTests — conservatism (no false pairs)', () => {
  it('symbol absent from the test → no pairing', () => {
    const content = "it('something else', () => { other() })"
    const pairs = pairSymbolsWithTests([sym('buildKey')], [{ path: 'a.test.ts', content }])
    expect(pairs).toHaveLength(0)
  })

  it('does not match a symbol that only appears as a substring of another identifier', () => {
    const content = "it('uses buildKeyCache', () => { buildKeyCache() })"
    const pairs = pairSymbolsWithTests([sym('buildKey')], [{ path: 'a.test.ts', content }])
    expect(pairs).toHaveLength(0)
  })

  it('refuses very short / ambiguous symbol names', () => {
    const content = "it('x calls it', () => { x() })"
    const pairs = pairSymbolsWithTests([sym('x')], [{ path: 'a.test.ts', content }])
    expect(pairs).toHaveLength(0)
  })

  it('empty test content → no pairing', () => {
    const pairs = pairSymbolsWithTests([sym('buildKey')], [{ path: 'a.test.ts', content: '' }])
    expect(pairs).toHaveLength(0)
  })

  it('no test files → no pairing', () => {
    expect(pairSymbolsWithTests([sym('buildKey')], [])).toHaveLength(0)
  })
})

describe('pairSymbolsWithTests — block range capture', () => {
  it('captures the enclosing it() block range (brace scan)', () => {
    const content = [
      "describe('s', () => {", // line 1
      "  it('buildKey works', () => {", // line 2
      '    const r = buildKey(1)', // 3
      '    expect(r).toBe(2)', // 4
      '  })', // 5
      '})', // 6
    ].join('\n')
    const pairs = pairSymbolsWithTests([sym('buildKey')], [{ path: 'a.test.ts', content }])
    const range = pairs[0].tests[0].lineRange
    expect(range.start).toBe(2)
    expect(range.end).toBeGreaterThanOrEqual(4)
    expect(range.end).toBeLessThanOrEqual(5)
  })

  it('captures a Python test def block by indentation', () => {
    const content = [
      'def test_compute_total_works():', // 1
      '    x = compute_total([1])', // 2
      '    assert x == 1', // 3
      '', // 4
      'def test_other():', // 5
      '    pass', // 6
    ].join('\n')
    const pairs = pairSymbolsWithTests(
      [sym('compute_total', 'billing.py')],
      [{ path: 'test_billing.py', content }],
    )
    const range = pairs[0].tests[0].lineRange
    expect(range.start).toBe(1)
    expect(range.end).toBeGreaterThanOrEqual(3)
    expect(range.end).toBeLessThanOrEqual(4)
  })
})

describe('pairSymbolsWithTests — Python multi-line signature capture', () => {
  it('captures the `):` line AND the body when the signature spans lines', () => {
    const content = [
      'class T:', // 1
      '    def test_event_properties(', // 2 (def header opens)
      '        self,', // 3
      '        _name: str,', // 4  <- `:` inside params must NOT end the header
      '        condition: dict,', // 5
      '    ):', // 6  <- dedented to def indent; old code broke here
      '        result = compute_total(condition)', // 7  <- body
      '        assert result == 1', // 8  <- body last line
      '', // 9
      '    def test_other(self):', // 10
      '        pass', // 11
    ].join('\n')
    const pairs = pairSymbolsWithTests(
      [sym('compute_total', 'billing.py')],
      [{ path: 'test_billing.py', content }],
    )
    const range = pairs[0].tests[0].lineRange
    // header is line 2; body assert is line 8 — both must be inside the range.
    expect(range.start).toBe(2)
    expect(range.end).toBeGreaterThanOrEqual(8)
    // must not bleed into the next def (line 10).
    expect(range.end).toBeLessThanOrEqual(9)
  })

  it('still captures a single-line Python def body', () => {
    const content = [
      'def test_x_works():', // 1
      '    r = compute_total([1])', // 2
      '    assert r == 1', // 3
    ].join('\n')
    const pairs = pairSymbolsWithTests(
      [sym('compute_total', 'billing.py')],
      [{ path: 'test_billing.py', content }],
    )
    const range = pairs[0].tests[0].lineRange
    expect(range.start).toBe(1)
    expect(range.end).toBe(3)
  })

  it('handles a `-> ReturnType:` annotated multi-line signature', () => {
    const content = [
      'def test_typed(', // 1
      '    arg: int,', // 2
      ') -> None:', // 3  <- colon after the return annotation, depth 0
      '    out = compute_total([arg])', // 4
      '    assert out == arg', // 5
    ].join('\n')
    const pairs = pairSymbolsWithTests(
      [sym('compute_total', 'billing.py')],
      [{ path: 'test_billing.py', content }],
    )
    const range = pairs[0].tests[0].lineRange
    expect(range.start).toBe(1)
    expect(range.end).toBe(5)
  })

  it('a `:` inside params (type annotation) does not prematurely end the header', () => {
    const content = [
      'def test_annot(', // 1
      '    mapping: dict,', // 2  <- depth-1 colon, not the header terminator
      '):', // 3
      '    v = compute_total(mapping)', // 4
      '    assert v', // 5
    ].join('\n')
    const pairs = pairSymbolsWithTests(
      [sym('compute_total', 'billing.py')],
      [{ path: 'test_billing.py', content }],
    )
    const range = pairs[0].tests[0].lineRange
    // body line 5 must be captured.
    expect(range.end).toBe(5)
  })

  it('captures the def+body for a decorated test (decorator above def)', () => {
    const content = [
      '@parameterized.expand([(1,), (2,)])', // 1 decorator
      'def test_decorated(self, n):', // 2 def header
      '    r = compute_total([n])', // 3 body
      '    assert r == n', // 4 body
    ].join('\n')
    const pairs = pairSymbolsWithTests(
      [sym('compute_total', 'billing.py')],
      [{ path: 'test_billing.py', content }],
    )
    const range = pairs[0].tests[0].lineRange
    // Range starts at the def (decorator not included), and captures the body.
    expect(range.start).toBe(2)
    expect(range.end).toBe(4)
  })

  it('truncates an over-cap body with a marker (range capped)', () => {
    const bodyLines = Array.from({ length: 60 }, (_, i) => `    line_${i} = compute_total([${i}])`)
    const content = ['def test_huge():', ...bodyLines].join('\n')
    const pairs = pairSymbolsWithTests(
      [sym('compute_total', 'billing.py')],
      [{ path: 'test_billing.py', content }],
    )
    const range = pairs[0].tests[0].lineRange
    // Capped to ≤ 40 lines.
    expect(range.end - range.start + 1).toBeLessThanOrEqual(40)
    expect(pairs[0].tests[0].truncated).toBe(true)
  })
})

describe('pairSymbolsWithTests — JS multi-line signature capture', () => {
  it('captures the body of a test with a multi-line arrow signature', () => {
    const content = [
      "describe('s', () => {", // 1
      "  it('buildKey across many args',", // 2 (multi-line call/arrow)
      '    async (', // 3
      '      done', // 4
      '    ) => {', // 5
      '      const r = buildKey(1)', // 6 body
      '      expect(r).toBe(2)', // 7 body
      '    })', // 8
      '})', // 9
    ].join('\n')
    const pairs = pairSymbolsWithTests([sym('buildKey')], [{ path: 'a.test.ts', content }])
    const range = pairs[0].tests[0].lineRange
    expect(range.start).toBe(2)
    // body (lines 6-7) must be inside the range; brace match closes at line 8.
    expect(range.end).toBeGreaterThanOrEqual(7)
  })
})

describe('pairSymbolsWithTests — prefers named over referenced; multiple tests', () => {
  it('keeps the highest-confidence test first and reports count', () => {
    const t1 = "it('buildKey edge', () => { buildKey(0) })"
    const t2 = "it('uses helper', () => { buildKey(1) })"
    const pairs = pairSymbolsWithTests([sym('buildKey')], [
      { path: 'b.test.ts', content: t2 },
      { path: 'a.test.ts', content: t1 },
    ])
    expect(pairs[0].tests.length).toBe(2)
    expect(pairs[0].tests[0].confidence).toBe('named')
  })
})

function prFile(filename: string, patch?: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch }
}

describe('pairStepTests — story-step orchestrator', () => {
  const implPatch = '@@ -1,2 +1,3 @@ function buildKey(x) {\n   const a = 1\n+  return x + 1\n }'
  const testContent = "describe('keys', () => {\n  it('buildKey works', () => { expect(buildKey(1)).toBe(2) })\n})"

  it('pairs a changed function with its named test, grouped by impl file', () => {
    const contentsMap = new Map([
      ['src/keys.test.ts', { before: null, after: testContent }],
    ])
    const out = pairStepTests({
      stepFiles: [prFile('src/keys.ts', implPatch)],
      testFiles: [prFile('src/keys.test.ts')],
      contentsMap,
    })
    expect(out.get('src/keys.ts')).toBeDefined()
    expect(out.get('src/keys.ts')![0].symbol).toBe('buildKey')
    expect(out.get('src/keys.ts')![0].tests[0].confidence).toBe('named')
  })

  it('null contentsMap → empty (graceful)', () => {
    const out = pairStepTests({
      stepFiles: [prFile('src/keys.ts', implPatch)],
      testFiles: [prFile('src/keys.test.ts')],
      contentsMap: null,
    })
    expect(out.size).toBe(0)
  })

  it('test content not in contentsMap → empty', () => {
    const out = pairStepTests({
      stepFiles: [prFile('src/keys.ts', implPatch)],
      testFiles: [prFile('src/keys.test.ts')],
      contentsMap: new Map(),
    })
    expect(out.size).toBe(0)
  })

  it('ignores non-test files passed as testFiles and skips test files as stepFiles', () => {
    const contentsMap = new Map([
      ['src/keys.test.ts', { before: null, after: testContent }],
    ])
    const out = pairStepTests({
      // a test file accidentally in stepFiles must be skipped for extraction
      stepFiles: [prFile('src/keys.ts', implPatch), prFile('src/keys.test.ts', implPatch)],
      // a non-test file in testFiles must be ignored
      testFiles: [prFile('src/keys.test.ts'), prFile('src/other.ts')],
      contentsMap,
    })
    expect([...out.keys()]).toEqual(['src/keys.ts'])
  })
})
