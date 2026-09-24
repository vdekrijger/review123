import { describe, it, expect } from 'vitest'
import { capPatchRows, parseCommitPatch, patchIsEmpty, patchRowCount } from './commitPatch'

describe('parseCommitPatch — a real `git show` patch', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,4 +10,5 @@ export function thing() {',
    ' const before = 1',
    '-  return before',
    '+  const after = 2',
    '+  return after',
    ' }',
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1,2 @@',
    '+export const x = 1',
    '+export const y = 2',
    '',
  ].join('\n')

  it('splits every file out of one commit', () => {
    const parsed = parseCommitPatch(patch)
    expect(parsed.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('counts additions and deletions per file and for the commit', () => {
    const parsed = parseCommitPatch(patch)
    expect(parsed.files[0]).toMatchObject({ additions: 2, deletions: 1, status: 'modified' })
    expect(parsed.files[1]).toMatchObject({ additions: 2, deletions: 0, status: 'added' })
    expect(parsed.additions).toBe(4)
    expect(parsed.deletions).toBe(1)
  })

  it('numbers each side the way git does, and strips the marker column', () => {
    const [a] = parseCommitPatch(patch).files
    expect(a.hunks).toHaveLength(1)
    expect(a.hunks[0].header).toBe('@@ -10,4 +10,5 @@ export function thing() {')
    expect(a.hunks[0].lines).toEqual([
      { kind: 'context', text: 'const before = 1', oldLine: 10, newLine: 10 },
      { kind: 'del', text: '  return before', oldLine: 11, newLine: null },
      { kind: 'add', text: '  const after = 2', oldLine: null, newLine: 11 },
      { kind: 'add', text: '  return after', oldLine: null, newLine: 12 },
      { kind: 'context', text: '}', oldLine: 12, newLine: 13 },
    ])
  })
})

describe('parseCommitPatch — shapes that are not `git show`', () => {
  it('parses a BARE envelope with no `diff --git` line (GitHub / the e2e stub)', () => {
    const parsed = parseCommitPatch('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old 0\n+new 0\n')
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0].path).toBe('x.ts')
    expect(parsed.files[0].hunks[0].lines.map((l) => l.text)).toEqual(['old 0', 'new 0'])
  })

  it('finds the file boundary in a bare MULTI-file patch, where only `---` marks it', () => {
    const parsed = parseCommitPatch(
      '--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n-c\n+d\n',
    )
    expect(parsed.files.map((f) => f.path)).toEqual(['one.ts', 'two.ts'])
    expect(parsed.files[1].hunks[0].lines.map((l) => l.text)).toEqual(['c', 'd'])
  })

  it('parses a hunk with no header at all rather than dropping it', () => {
    const parsed = parseCommitPatch('@@ -1 +1 @@\n-a\n+b\n')
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0].path).toBe('')
    expect(parsed.additions).toBe(1)
  })

  it('reads a deletion, keeping the name from the OLD side', () => {
    const parsed = parseCommitPatch(
      'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n',
    )
    expect(parsed.files[0]).toMatchObject({ path: 'gone.ts', status: 'removed', deletions: 2 })
  })

  it('reads a rename from its headers, keeping both names', () => {
    const parsed = parseCommitPatch(
      [
        'diff --git a/old/name.ts b/new/name.ts',
        'similarity index 95%',
        'rename from old/name.ts',
        'rename to new/name.ts',
        '--- a/old/name.ts',
        '+++ b/new/name.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n'),
    )
    expect(parsed.files[0]).toMatchObject({
      path: 'new/name.ts',
      oldPath: 'old/name.ts',
      status: 'renamed',
    })
  })

  it('marks a binary file rather than inventing rows for it', () => {
    const parsed = parseCommitPatch(
      'diff --git a/logo.png b/logo.png\nindex aaa..bbb 100644\nBinary files a/logo.png and b/logo.png differ\n',
    )
    expect(parsed.files[0]).toMatchObject({ path: 'logo.png', binary: true })
    expect(parsed.files[0].hunks).toEqual([])
  })

  it('keeps the no-newline marker as a meta row, advancing neither side', () => {
    const parsed = parseCommitPatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n')
    const kinds = parsed.files[0].hunks[0].lines.map((l) => l.kind)
    expect(kinds).toEqual(['del', 'meta', 'add'])
    // The add is still line 1 on the new side — the marker did not consume one.
    expect(parsed.files[0].hunks[0].lines[2].newLine).toBe(1)
  })

  it('keeps an empty CONTEXT line (a single space) as a row', () => {
    const parsed = parseCommitPatch('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n')
    const lines = parsed.files[0].hunks[0].lines
    expect(lines.map((l) => l.kind)).toEqual(['context', 'context', 'del', 'add'])
    expect(lines[1].text).toBe('')
  })

  it('handles several hunks in one file, each with its own header', () => {
    const parsed = parseCommitPatch(
      '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -50,2 +50,2 @@\n z\n-y\n+Y\n',
    )
    expect(parsed.files[0].hunks).toHaveLength(2)
    expect(parsed.files[0].hunks[1].lines[0]).toMatchObject({ oldLine: 50, newLine: 50 })
  })
})

describe('parseCommitPatch — truncation and emptiness', () => {
  // The bridge slices at MAX_FIX_DIFF_BYTES wherever the byte lands. Parsing
  // must survive it; SAYING the diff is incomplete is the panel's job, and it
  // reads the change's own `truncated` flag rather than guessing from here.
  it('keeps the partial tail of a patch cut mid-line', () => {
    const full = '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n+trailing line that gets cut'
    const parsed = parseCommitPatch(full.slice(0, full.length - 10))
    const lines = parsed.files[0].hunks[0].lines
    expect(lines[lines.length - 1]).toMatchObject({ kind: 'add', text: 'trailing line tha' })
  })

  it('survives a cut that lands inside the `diff --git` header of the next file', () => {
    const parsed = parseCommitPatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.ts b/')
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0].path).toBe('x')
  })

  it('reports an empty patch as empty instead of an empty-looking viewer', () => {
    expect(patchIsEmpty(parseCommitPatch(''))).toBe(true)
    expect(patchIsEmpty(parseCommitPatch('\n'))).toBe(true)
    // Headers but no hunk — a cap that landed before the first `@@`.
    expect(patchIsEmpty(parseCommitPatch('diff --git a/x b/x\nindex a..b 100644\n'))).toBe(true)
  })

  it('does not call a patch with rows empty', () => {
    expect(patchIsEmpty(parseCommitPatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n+a\n'))).toBe(false)
  })
})

describe('capPatchRows — the RENDER cap, which is NOT the bridge byte cap', () => {
  // Two different limits with two different meanings: the bridge's is "we did
  // not receive the rest", this one is "we have it, press to draw it". The
  // panel must never report one as the other.
  const big = (rows: number, name = 'x.ts'): string => {
    const lines = [`--- a/${name}`, `+++ b/${name}`, `@@ -1,${rows} +1,${rows} @@`]
    for (let i = 0; i < rows; i++) lines.push(`+line ${i}`)
    return lines.join('\n')
  }

  it('draws everything when the patch fits', () => {
    expect(capPatchRows(parseCommitPatch(big(10)), 600).hidden).toBe(0)
  })

  it('stops at the limit and says how many rows it is holding back', () => {
    const capped = capPatchRows(parseCommitPatch(big(1000)), 600)
    expect(capped.hidden).toBe(400)
    let drawn = 0
    for (const f of capped.files) for (const h of f.hunks) drawn += h.lines.length
    expect(drawn).toBe(600)
  })

  it('keeps file and hunk structure while trimming across several files', () => {
    const capped = capPatchRows(parseCommitPatch([big(400), big(400, 'y.ts')].join('\n')), 600)
    expect(capped.files.map((f) => f.path)).toEqual(['x.ts', 'y.ts'])
    expect(capped.files[0].hunks[0].lines).toHaveLength(400)
    expect(capped.files[1].hunks[0].lines).toHaveLength(200)
    expect(capped.hidden).toBe(200)
  })

  it('counts rows across every file', () => {
    expect(patchRowCount(parseCommitPatch(big(7)))).toBe(7)
    expect(patchRowCount(parseCommitPatch(''))).toBe(0)
  })
})
