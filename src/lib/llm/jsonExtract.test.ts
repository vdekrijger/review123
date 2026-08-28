/**
 * jsonExtract.test.ts — the tolerant JSON extractor.
 *
 * The contract under test:
 *   - a returned string is ALWAYS JSON.parse-able (never a "probably fine" guess)
 *   - null means there is genuinely no complete JSON document in the text —
 *     which is what keeps a truncated reply classified as a real failure
 *   - brace matching respects string literals and escapes (no regex shortcuts)
 */

import { describe, it, expect } from 'vitest'
import { extractJsonCandidate, parseJsonLoose, stripTrailingCommas } from './jsonExtract'

/** Every non-null result must parse — asserted on every positive case. */
function parsed(text: string): unknown {
  const candidate = extractJsonCandidate(text)
  expect(candidate).not.toBeNull()
  return JSON.parse(candidate as string)
}

describe('extractJsonCandidate — the clean path is untouched', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}')
  })

  it('returns a bare array unchanged', () => {
    expect(extractJsonCandidate('[1,2,3]')).toBe('[1,2,3]')
  })

  it('trims surrounding whitespace only', () => {
    expect(extractJsonCandidate('  \n{"a":1}\n  ')).toBe('{"a":1}')
  })

  it('accepts a top-level scalar (valid JSON)', () => {
    expect(parsed('"just a string"')).toBe('just a string')
    expect(parsed('42')).toBe(42)
    expect(parsed('null')).toBeNull()
  })
})

describe('extractJsonCandidate — fenced blocks', () => {
  it('unwraps a ```json fence', () => {
    expect(parsed('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('unwraps a bare ``` fence', () => {
    expect(parsed('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('is case-insensitive about the info string and tolerates extra words', () => {
    expect(parsed('```JSON output\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('unwraps a fence buried in prose', () => {
    const text = 'Sure! Here you go:\n\n```json\n{"a":1}\n```\n\nLet me know.'
    expect(parsed(text)).toEqual({ a: 1 })
  })

  it('takes the FIRST fenced block that parses when there are several', () => {
    const text = '```json\n{"first":true}\n```\nand also\n```json\n{"second":true}\n```'
    expect(parsed(text)).toEqual({ first: true })
  })

  it('skips a leading non-JSON fence and uses the next one', () => {
    const text = '```bash\nnpm install\n```\n```json\n{"a":1}\n```'
    expect(parsed(text)).toEqual({ a: 1 })
  })

  it('handles an UNTERMINATED fence around complete JSON', () => {
    expect(parsed('```json\n{"a":1}')).toEqual({ a: 1 })
  })

  it('handles a four-backtick fence wrapping a three-backtick one', () => {
    const text = '````\n```json\n{"a":1}\n```\n````'
    expect(parsed(text)).toEqual({ a: 1 })
  })
})

describe('extractJsonCandidate — prose around the document', () => {
  it('finds an object after a preamble', () => {
    expect(parsed('Here is the analysis:\n{"a":1}')).toEqual({ a: 1 })
  })

  it('finds an object before a suffix', () => {
    expect(parsed('{"a":1}\n\nHope that helps!')).toEqual({ a: 1 })
  })

  it('ignores a stray trailing fence', () => {
    expect(parsed('{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('finds an array wrapped in prose', () => {
    expect(parsed('The findings are:\n[{"id":1}]\nThat is all.')).toEqual([{ id: 1 }])
  })

  it('prefers the REAL payload over a decoy `{}` mentioned earlier in the prose', () => {
    const text = 'If there is nothing to report, return {} — otherwise:\n{"a":1,"b":2}'
    expect(parsed(text)).toEqual({ a: 1, b: 2 })
  })
})

describe('extractJsonCandidate — adversarial: braces and fences inside strings', () => {
  it('does not end the span on a `}` inside a string value', () => {
    expect(parsed('prefix {"code":"function f() { return 1 }","a":1} suffix')).toEqual({
      code: 'function f() { return 1 }',
      a: 1,
    })
  })

  it('does not end the span on a `]` inside a string value', () => {
    expect(parsed('note: {"expr":"arr[0]]]","ok":true}')).toEqual({ expr: 'arr[0]]]', ok: true })
  })

  it('handles a value containing ``` inside a fenced block', () => {
    const text = '```json\n{"snippet":"```ts\\nconst a = 1\\n```"}\n```'
    expect(parsed(text)).toEqual({ snippet: '```ts\nconst a = 1\n```' })
  })

  it('handles an ESCAPED quote before a brace', () => {
    expect(parsed('{"q":"he said \\"} not really\\"","a":1}')).toEqual({
      q: 'he said "} not really"',
      a: 1,
    })
  })

  it('handles an escaped backslash directly before the closing quote', () => {
    expect(parsed('{"path":"C:\\\\","a":1}')).toEqual({ path: 'C:\\', a: 1 })
  })

  it('handles deep nesting', () => {
    const deep = { a: { b: { c: [{ d: [1, 2, { e: 'f}' }] }] } } }
    expect(parsed(`prose ${JSON.stringify(deep)} more prose`)).toEqual(deep)
  })

  it('an unmatched OPENER stops the scan (truncation safety beats prose salvage)', () => {
    // An unclosed `{` is the signature of a cut-off reply. Descending past it
    // would return an inner fragment as if it were the whole document, so the
    // scan stops instead — the rare "stray brace in the preamble" case is
    // sacrificed on purpose.
    expect(extractJsonCandidate('oops { unbalanced\n{"a":1}')).toBeNull()
  })

  it('keeps a COMPLETE span found before a later unmatched opener', () => {
    expect(parsed('{"a":1}\nand then a stray { at the end')).toEqual({ a: 1 })
  })

  it('ignores a stray CLOSER that precedes the real document', () => {
    expect(parsed('} stray\n{"a":1}')).toEqual({ a: 1 })
  })

  it('does not mix a `[` opener with a `}` closer', () => {
    expect(extractJsonCandidate('[1,2}')).toBeNull()
  })
})

describe('extractJsonCandidate — trailing commas', () => {
  it('tolerates a trailing comma in an object', () => {
    expect(parsed('{"a":1,}')).toEqual({ a: 1 })
  })

  it('tolerates a trailing comma in an array', () => {
    expect(parsed('[1,2,]')).toEqual([1, 2])
  })

  it('tolerates trailing commas nested and with whitespace', () => {
    expect(parsed('{\n  "a": [1, 2, ],\n  "b": {"c": 3, },\n}')).toEqual({ a: [1, 2], b: { c: 3 } })
  })

  it('tolerates a trailing comma inside a fenced block', () => {
    expect(parsed('```json\n{"a":1,}\n```')).toEqual({ a: 1 })
  })

  it('never removes a comma inside a string value', () => {
    expect(parsed('{"a":"x, }","b":2}')).toEqual({ a: 'x, }', b: 2 })
  })
})

describe('stripTrailingCommas — string-aware', () => {
  it('drops only structural trailing commas', () => {
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}')
    expect(stripTrailingCommas('[1,2,]')).toBe('[1,2]')
  })

  it('leaves a comma followed by more content alone', () => {
    expect(stripTrailingCommas('{"a":1,"b":2}')).toBe('{"a":1,"b":2}')
  })

  it('leaves commas inside strings alone', () => {
    expect(stripTrailingCommas('{"a":"1,}"}')).toBe('{"a":"1,}"}')
  })

  it('respects escaped quotes when tracking string state', () => {
    expect(stripTrailingCommas('{"a":"\\",}"}')).toBe('{"a":"\\",}"}')
  })
})

describe('extractJsonCandidate — null for genuinely unparseable input', () => {
  it('empty / whitespace', () => {
    expect(extractJsonCandidate('')).toBeNull()
    expect(extractJsonCandidate('   \n\t ')).toBeNull()
  })

  it('plain prose with no JSON at all', () => {
    expect(extractJsonCandidate('I cannot answer that question.')).toBeNull()
  })

  it('a TRUNCATED object (the max_tokens case) — never balances', () => {
    expect(extractJsonCandidate('{"a": 1, "b": "unterminated stri')).toBeNull()
  })

  it('a truncated object inside an unterminated fence', () => {
    expect(extractJsonCandidate('```json\n{"a": 1, "items": [{"x": 1}, {"y"')).toBeNull()
  })

  it('an unbalanced array', () => {
    expect(extractJsonCandidate('[1, 2, 3')).toBeNull()
  })

  it('a non-string input', () => {
    expect(extractJsonCandidate(undefined as unknown as string)).toBeNull()
    expect(extractJsonCandidate(null as unknown as string)).toBeNull()
  })

  it('XML-ish output that merely LOOKS structured', () => {
    expect(extractJsonCandidate('<result><a>1</a></result>')).toBeNull()
  })
})

describe('extractJsonCandidate — every non-null result actually parses', () => {
  const samples = [
    '{"a":1}',
    '```json\n{"a":1}\n```',
    'prose {"a":1} prose',
    '{"a":1,}',
    '[{"a":1},]',
    '```\n[1,2,3]\n```',
    'x {"s":"}}}"} y',
  ]
  it.each(samples)('parses %j', (sample) => {
    const candidate = extractJsonCandidate(sample)
    expect(candidate).not.toBeNull()
    expect(() => JSON.parse(candidate as string)).not.toThrow()
  })
})

describe('parseJsonLoose', () => {
  it('returns the parsed value on success', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('returns ok:false rather than throwing on failure', () => {
    expect(parseJsonLoose('{"a": 1')).toEqual({ ok: false })
  })

  it('never throws for arbitrary junk', () => {
    for (const junk of ['', '```', '{{{{', ']]]]', 'null bytes \u0000 here']) {
      expect(() => parseJsonLoose(junk)).not.toThrow()
    }
  })
})
