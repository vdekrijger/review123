import { describe, it, expect } from 'vitest'
import { computeWhitespaceHiddenPatch, stripWhitespace } from './whitespace'

describe('stripWhitespace', () => {
  it('removes leading, trailing, and internal whitespace runs', () => {
    expect(stripWhitespace('  foo \t bar  ')).toBe('foobar')
  })
  it('removes tabs and mixed whitespace', () => {
    expect(stripWhitespace('\tfoo\t\tbar\t')).toBe('foobar')
  })
  it('leaves non-whitespace content untouched', () => {
    expect(stripWhitespace('foo(bar)')).toBe('foo(bar)')
  })
  it('reduces a whitespace-only line to the empty string', () => {
    expect(stripWhitespace('   \t  ')).toBe('')
  })
})

describe('computeWhitespaceHiddenPatch', () => {
  it('collapses a file whose only changes are whitespace (indentation)', () => {
    const before = 'function f() {\nreturn 1\n}\n'
    const after = 'function f() {\n  return 1\n}\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('collapsed')
  })

  it('collapses whitespace-only changes in internal runs', () => {
    const before = 'const a = 1\nfoo bar\n'
    const after = 'const a = 1\nfoo    bar\n'
    expect(computeWhitespaceHiddenPatch(before, after).kind).toBe('collapsed')
  })

  it('collapses trailing-whitespace-only changes', () => {
    const before = 'line one\nline two\n'
    const after = 'line one   \nline two\t\n'
    expect(computeWhitespaceHiddenPatch(before, after).kind).toBe('collapsed')
  })

  it('mirrors git -w: whitespace added where there was none collapses too', () => {
    // git diff -w treats "foobar" and "foo bar" as equal (ALL whitespace ignored)
    const before = 'foobar\n'
    const after = 'foo bar\n'
    expect(computeWhitespaceHiddenPatch(before, after).kind).toBe('collapsed')
  })

  it('keeps real changes in a mixed hunk and drops whitespace-only lines', () => {
    const before = 'a\nfoo bar\nkeep\nreal change\nend\n'
    const after = 'a\nfoo  bar\nkeep\nreal CHANGE\nend\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
    if (result.kind !== 'recomputed') return
    // The ws-only line ("foo bar" → "foo  bar") must appear as context, not +/-
    expect(result.patch).not.toContain('-foo bar')
    expect(result.patch).not.toContain('+foo  bar')
    // The real change survives
    expect(result.patch).toContain('-real change')
    expect(result.patch).toContain('+real CHANGE')
  })

  it('emits context lines from the NEW side (git -w behaviour)', () => {
    // Verified against real git: a ws-differing line shown as context uses the
    // new file's text ("foo  bar"), not the old one.
    const before = 'a\nfoo bar\nkeep\nreal change\nend\n'
    const after = 'a\nfoo  bar\nkeep\nreal CHANGE\nend\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
    if (result.kind !== 'recomputed') return
    expect(result.patch).toContain(' foo  bar')
  })

  it('produces a valid bare-hunk header with original line numbers', () => {
    const before = 'a\nfoo bar\nkeep\nreal change\nend\n'
    const after = 'a\nfoo  bar\nkeep\nreal CHANGE\nend\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
    if (result.kind !== 'recomputed') return
    expect(result.patch).toMatch(/^@@ -1,5 \+1,5 @@\n/)
  })

  it('preserves original (un-normalized) line content in the patch body', () => {
    const before = 'const x = 1\nfn( a, b )\n'
    const after = 'const x = 2\nfn( a, b )\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
    if (result.kind !== 'recomputed') return
    // Context line keeps its real spacing, not the stripped comparison key
    expect(result.patch).toContain(' fn( a, b )')
    expect(result.patch).toContain('-const x = 1')
    expect(result.patch).toContain('+const x = 2')
  })

  it('handles pure insertions with correct numbering', () => {
    const before = 'a\nb\n'
    const after = 'a\nx\nb\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
    if (result.kind !== 'recomputed') return
    expect(result.patch).toContain('@@ -1,2 +1,3 @@')
    expect(result.patch).toContain('+x')
  })

  it('handles pure deletions', () => {
    const before = 'a\nx\nb\n'
    const after = 'a\nb\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
    if (result.kind !== 'recomputed') return
    expect(result.patch).toContain('-x')
  })

  it('preserves "No newline at end of file" markers', () => {
    const before = 'a\nb'
    const after = 'a\nc'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
    if (result.kind !== 'recomputed') return
    expect(result.patch).toContain('\\ No newline at end of file')
  })

  it('collapses identical files', () => {
    const content = 'a\nb\nc\n'
    expect(computeWhitespaceHiddenPatch(content, content).kind).toBe('collapsed')
  })

  it('keeps multiple distant hunks with separate headers', () => {
    const mkLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`)
    const before = [...mkLines(20)].join('\n') + '\n'
    const afterLines = mkLines(20)
    afterLines[1] = 'line 1 CHANGED'
    afterLines[18] = 'line 18 CHANGED'
    const after = afterLines.join('\n') + '\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
    if (result.kind !== 'recomputed') return
    const headers = result.patch.match(/^@@ /gm) ?? []
    expect(headers.length).toBe(2)
  })

  it('a blank line added is still a real change (line count differs)', () => {
    // git -w does NOT hide added/removed blank LINES — only intra-line whitespace.
    const before = 'a\nb\n'
    const after = 'a\n\nb\n'
    const result = computeWhitespaceHiddenPatch(before, after)
    expect(result.kind).toBe('recomputed')
  })
})
