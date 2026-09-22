/**
 * Per-hunk attention classifier (src/lib/guide/hunkAttention.ts).
 *
 * Covers every mechanical kind, the when-in-doubt-decision bias, the
 * finding/draft/heuristic overrides, multi-kind hunks, summary generation,
 * determinism/tie-breaks, and the file-card "what changed" strip.
 */

import { describe, it, expect } from 'vitest'
import {
  parseHunks,
  classifyHunk,
  classifyFileHunks,
  buildChangeStrip,
  hunkAnchor,
  hunkContainsAnchor,
  hunkHeuristicHit,
  isFormattingOnly,
  isFixturePath,
  renamePairs,
  tokenStream,
  churnSummary,
  MAX_STRIP_DECISIONS,
  type DiffHunk,
} from './hunkAttention'
import type { PrFile } from '../github/types'

function hunk(patch: string, index = 0): DiffHunk {
  const parsed = parseHunks(patch)
  return parsed[index]
}

function classify(patch: string, filename = 'src/sample.ts', ctx = {}) {
  return classifyHunk(hunk(patch), { filename, ...ctx })
}

// ---------------------------------------------------------------------------
// parseHunks
// ---------------------------------------------------------------------------

describe('parseHunks', () => {
  it('returns [] for an absent or headerless patch', () => {
    expect(parseHunks(undefined)).toEqual([])
    expect(parseHunks('')).toEqual([])
    expect(parseHunks('no header here\n+added')).toEqual([])
  })

  it('assigns per-side line numbers exactly like patchLineNumbers', () => {
    const h = hunk('@@ -10,3 +20,4 @@ function outer()\n ctx\n-gone\n+added\n+more\n tail')
    expect(h.oldStart).toBe(10)
    expect(h.newStart).toBe(20)
    expect(h.context).toBe('function outer()')
    expect(h.lines.map((l) => [l.marker, l.oldNum, l.newNum])).toEqual([
      [' ', 10, 20],
      ['-', 11, 0],
      ['+', 0, 21],
      ['+', 0, 22],
      [' ', 12, 23],
    ])
  })

  it('ignores the "\\ No newline" marker and a trailing blank row', () => {
    const h = hunk('@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file\n')
    expect(h.lines.map((l) => l.marker)).toEqual(['-', '+'])
  })

  it('parses multiple hunks with increasing indices', () => {
    const hunks = parseHunks('@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d')
    expect(hunks.map((h) => h.index)).toEqual([0, 1])
    expect(hunks[1].oldStart).toBe(9)
  })

  it('defaults an absent count to 1', () => {
    const h = hunk('@@ -5 +5 @@\n-a\n+b')
    expect(h.oldCount).toBe(1)
    expect(h.newCount).toBe(1)
  })
})

describe('hunkAnchor / hunkContainsAnchor', () => {
  it('anchors on the context line just above the first change', () => {
    const h = hunk('@@ -1,4 +1,4 @@\n one\n two\n-three\n+THREE\n four')
    expect(hunkAnchor(h)).toEqual({ line: 2, side: 'RIGHT' })
  })

  it('anchors on the first line when the hunk opens with a change', () => {
    const h = hunk('@@ -1,2 +1,2 @@\n-one\n+ONE\n two')
    expect(hunkAnchor(h)).toEqual({ line: 1, side: 'LEFT' })
  })

  it('knows which lines it contains, per side', () => {
    const h = hunk('@@ -10,2 +20,2 @@\n ctx\n-gone\n+added')
    expect(hunkContainsAnchor(h, 20, 'RIGHT')).toBe(true)
    expect(hunkContainsAnchor(h, 21, 'RIGHT')).toBe(true)
    expect(hunkContainsAnchor(h, 99, 'RIGHT')).toBe(false)
    expect(hunkContainsAnchor(h, 11, 'LEFT')).toBe(true)
    expect(hunkContainsAnchor(h, 11, 'RIGHT')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Token normalisation
// ---------------------------------------------------------------------------

describe('tokenStream', () => {
  it('drops whitespace, line breaks, commas and semicolons', () => {
    expect(tokenStream(['f(a,  b);'])).toEqual(tokenStream(['f(', 'a', 'b', ')']))
  })

  it('normalises quote style but keeps string content', () => {
    expect(tokenStream(["const a = 'x'"])).toEqual(tokenStream(['const a = "x"']))
    expect(tokenStream(["const a = 'x'"])).not.toEqual(tokenStream(['const a = "y"']))
  })

  it('does NOT merge two identifiers separated only by a space', () => {
    expect(tokenStream(['foo bar'])).not.toEqual(tokenStream(['foobar']))
  })
})

// ---------------------------------------------------------------------------
// formatting-only
// ---------------------------------------------------------------------------

describe('formatting-only hunks', () => {
  it('detects pure re-indentation', () => {
    const c = classify('@@ -1,2 +1,2 @@\n-  const a = 1\n+    const a = 1')
    expect(c.attention).toBe('mechanical')
    expect(c.kinds).toEqual(['formatting'])
    expect(c.summary).toBe('formatting only')
  })

  it('detects a line-break reflow across several lines', () => {
    const c = classify(
      '@@ -1,4 +1,2 @@\n-callSomething(\n-  first,\n-  second\n-)\n+callSomething(first, second)',
    )
    expect(c.attention).toBe('mechanical')
    expect(c.kinds).toEqual(['formatting'])
  })

  it('detects trailing-comma and semicolon churn', () => {
    expect(isFormattingOnly(['const a = [1, 2,];'], ['const a = [1, 2]'])).toBe(true)
  })

  it('detects quote-style churn', () => {
    expect(isFormattingOnly(['import x from "y"'], ["import x from 'y'"])).toBe(true)
  })

  it('treats blank-line churn as formatting even one-sided', () => {
    const c = classify('@@ -1,2 +1,3 @@\n ctx\n+\n tail')
    expect(c.attention).toBe('mechanical')
    expect(c.kinds).toEqual(['formatting'])
  })

  it('is NOT formatting when a real token changes', () => {
    expect(isFormattingOnly(['const a = 2'], ['const a = 1'])).toBe(false)
  })

  it('is NOT formatting for a pure addition or pure deletion', () => {
    expect(isFormattingOnly(['const a = 1'], [])).toBe(false)
    expect(isFormattingOnly([], ['const a = 1'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// imports / comments
// ---------------------------------------------------------------------------

describe('imports-only and comments-only hunks', () => {
  it('classifies an import-only hunk as mechanical', () => {
    const c = classify("@@ -1,2 +1,3 @@\n import a from './a'\n+import b from './b'\n const keep = 1")
    expect(c.attention).toBe('mechanical')
    expect(c.kinds).toEqual(['imports'])
    expect(c.summary).toBe('imports only')
  })

  it('classifies a multi-line import block via the span-aware detector', () => {
    const c = classify(
      "@@ -1,1 +1,5 @@\n+import {\n+  alpha,\n+  beta,\n+} from './mod'\n const keep = 1",
    )
    expect(c.attention).toBe('mechanical')
    expect(c.kinds).toEqual(['imports'])
  })

  it('classifies a comment-only hunk as mechanical', () => {
    const c = classify('@@ -1,2 +1,3 @@\n const keep = 1\n+// explain the thing\n const tail = 2')
    expect(c.kinds).toEqual(['comments'])
    expect(c.summary).toBe('comments only')
  })

  it('classifies a multi-line block comment as mechanical', () => {
    const c = classify('@@ -1,1 +1,4 @@\n+/**\n+ * docs\n+ */\n const keep = 1')
    expect(c.kinds).toEqual(['comments'])
  })

  it('reports BOTH kinds for a mixed imports+comments hunk', () => {
    const c = classify("@@ -1,1 +1,3 @@\n+// why\n+import b from './b'\n const keep = 1")
    expect(c.kinds).toEqual(['imports', 'comments'])
    expect(c.summary).toBe('imports only · comments only')
    expect(c.attention).toBe('mechanical')
  })

  it('handles Python imports (a non-JS language)', () => {
    const c = classify('@@ -1,2 +1,3 @@\n import os\n+from pathlib import Path\n x = 1', 'app/main.py')
    expect(c.kinds).toEqual(['imports'])
  })

  it('handles Go import blocks', () => {
    const c = classify('@@ -1,1 +1,4 @@\n+import (\n+\t"fmt"\n+)\n func main() {}', 'cmd/main.go')
    expect(c.kinds).toEqual(['imports'])
  })

  it('is a DECISION when one changed line is real code', () => {
    const c = classify("@@ -1,1 +1,3 @@\n+import b from './b'\n+const added = 2\n const keep = 1")
    expect(c.attention).toBe('decision')
    expect(c.kinds).toEqual([])
  })

  it('is a DECISION when the language is unknown (when in doubt)', () => {
    const c = classify('@@ -1,1 +1,2 @@\n+# a comment in an unknown language\n keep', 'Makefile.unknownext')
    expect(c.attention).toBe('decision')
  })
})

// ---------------------------------------------------------------------------
// rename-only
// ---------------------------------------------------------------------------

describe('rename-only hunks', () => {
  const RENAME_PATCH = [
    '@@ -1,6 +1,6 @@',
    ' function outer() {',
    '-  const total = compute()',
    '-  log(total)',
    '-  return total',
    '+  const sum = compute()',
    '+  log(sum)',
    '+  return sum',
    ' }',
  ].join('\n')

  it('detects a consistent identifier substitution', () => {
    const c = classify(RENAME_PATCH)
    expect(c.attention).toBe('mechanical')
    expect(c.kinds).toEqual(['rename'])
    expect(c.summary).toBe('renamed total → sum')
  })

  it('reports the pairs deterministically', () => {
    const pairs = renamePairs(
      ['const sum = compute()', 'log(sum)', 'return sum'],
      ['const total = compute()', 'log(total)', 'return total'],
    )
    expect(pairs).toEqual([{ from: 'total', to: 'sum' }])
  })

  it('is NOT a rename when the identifier occurs only once (logic change)', () => {
    // `if (a > b)` → `if (a > c)` is indistinguishable from a real fix.
    expect(renamePairs(['if (a > c) {'], ['if (a > b) {'])).toBeNull()
  })

  it('is NOT a rename when the new name already existed in the hunk', () => {
    // Swapping to an EXISTING variable is a real change, not a rename.
    const pairs = renamePairs(
      ['use(other)', 'use(other)', 'const other = 1'],
      ['use(value)', 'use(value)', 'const other = 1'],
    )
    expect(pairs).toBeNull()
  })

  it('is NOT a rename when a keyword changed', () => {
    expect(renamePairs(['let x = 1', 'let y = x'], ['const x = 1', 'const y = x'])).toBeNull()
  })

  it('is NOT a rename when the token shapes differ', () => {
    expect(renamePairs(['f(a, b)', 'f(a, b)'], ['f(a)', 'f(a)'])).toBeNull()
  })

  it('is NOT a rename when a literal changed', () => {
    expect(renamePairs(['x = 2', 'y = 2'], ['x = 1', 'y = 1'])).toBeNull()
  })

  it('refuses more than MAX_RENAME_PAIRS substitutions', () => {
    const before = ['a1 a2 a3 a4', 'a1 a2 a3 a4']
    const after = ['b1 b2 b3 b4', 'b1 b2 b3 b4']
    expect(renamePairs(after, before)).toBeNull()
  })

  it('summarises multiple renames without naming them all', () => {
    const patch = [
      '@@ -1,4 +1,4 @@',
      ' start',
      '-const aa = 1; const bb = 2; use(aa, bb)',
      '-use(aa, bb)',
      '+const cc = 1; const dd = 2; use(cc, dd)',
      '+use(cc, dd)',
      ' end',
    ].join('\n')
    const c = classify(patch)
    expect(c.kinds).toEqual(['rename'])
    expect(c.summary).toBe('renamed identifiers')
  })
})

// ---------------------------------------------------------------------------
// fixture / snapshot data
// ---------------------------------------------------------------------------

describe('fixture and snapshot data', () => {
  it('reuses the generated/snapshot detectors', () => {
    expect(isFixturePath('src/__snapshots__/App.test.ts.snap')).toBe(true)
    expect(isFixturePath('pnpm-lock.yaml')).toBe(true)
    expect(isFixturePath('src/generated/api.ts')).toBe(true)
  })

  it('treats data files in a fixture directory as fixtures', () => {
    expect(isFixturePath('tests/fixtures/pr.json')).toBe(true)
    expect(isFixturePath('internal/testdata/golden.yaml')).toBe(true)
  })

  it('does NOT treat CODE in a fixture directory as fixture data', () => {
    expect(isFixturePath('tests/fixtures/server.ts')).toBe(false)
  })

  it('does NOT treat a data file outside a fixture directory as a fixture', () => {
    expect(isFixturePath('src/config/app.json')).toBe(false)
  })

  it('classifies a hunk in a fixture file as mechanical', () => {
    const c = classify('@@ -1,2 +1,2 @@\n {\n-  "a": 1\n+  "a": 2\n }', 'tests/fixtures/pr.json')
    expect(c.attention).toBe('mechanical')
    expect(c.kinds).toContain('fixture')
    expect(c.summary).toContain('fixture data')
  })
})

// ---------------------------------------------------------------------------
// The when-in-doubt bias
// ---------------------------------------------------------------------------

describe('when in doubt → decision', () => {
  it('classifies ordinary code churn as a decision with a churn summary', () => {
    const c = classify('@@ -1,3 +1,3 @@\n ctx\n-const a = 1\n+const a = compute(2)\n tail')
    expect(c.attention).toBe('decision')
    expect(c.kinds).toEqual([])
    expect(c.summary).toBe('+1 −1')
  })

  it('classifies a pure addition as a decision', () => {
    const c = classify('@@ -1,1 +1,3 @@\n ctx\n+const a = 1\n+const b = 2')
    expect(c.attention).toBe('decision')
    expect(c.summary).toBe('+2')
  })

  it('classifies a pure deletion as a decision', () => {
    const c = classify('@@ -1,3 +1,1 @@\n ctx\n-const a = 1\n-const b = 2')
    expect(c.attention).toBe('decision')
    expect(c.summary).toBe('−2')
  })

  it('classifies a hunk with no changed rows as a decision', () => {
    const c = classify('@@ -1,1 +1,1 @@\n ctx')
    expect(c.attention).toBe('decision')
    expect(c.summary).toBe('no changes')
  })

  it('churnSummary covers every shape', () => {
    expect(churnSummary(0, 0)).toBe('no changes')
    expect(churnSummary(3, 0)).toBe('+3')
    expect(churnSummary(0, 3)).toBe('−3')
    expect(churnSummary(3, 2)).toBe('+3 −2')
  })
})

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

describe('overrides — a flagged hunk is NEVER receded', () => {
  const FORMATTING = '@@ -1,2 +1,2 @@\n-  const a = 1\n+    const a = 1'

  it('a finding in the hunk forces decision but keeps the kinds', () => {
    const c = classify(FORMATTING, 'src/sample.ts', { hasFinding: true })
    expect(c.attention).toBe('decision')
    expect(c.kinds).toEqual(['formatting'])
    expect(c.overrides).toEqual(['finding'])
  })

  it('a draft comment in the hunk forces decision', () => {
    const c = classify(FORMATTING, 'src/sample.ts', { hasDraft: true })
    expect(c.attention).toBe('decision')
    expect(c.overrides).toEqual(['draft'])
  })

  it('a risk-heuristic hit in the hunk forces decision', () => {
    // An empty catch block is the error-masking detector's signature. The
    // added lines are real code, so the shape is a decision anyway — what we
    // assert is that the heuristic fired and is reported.
    const patch = '@@ -1,1 +1,4 @@\n try {\n+} catch (e) {\n+}\n tail'
    const c = classify(patch)
    expect(c.overrides).toContain('heuristic')
    expect(c.attention).toBe('decision')
  })

  it('a new dependency in an otherwise mechanical manifest hunk overrides', () => {
    const patch = '@@ -1,3 +1,4 @@\n   "dependencies": {\n+    "leftpad": "^1.0.0",\n     "svelte": "^5.0.0"\n   }'
    expect(hunkHeuristicHit(hunk(patch), 'package.json')).toBe(true)
  })

  it('does NOT fire the PR-level untested-bulk heuristic per hunk', () => {
    const body = Array.from({ length: 200 }, (_, i) => `+  const v${i} = ${i}`).join('\n')
    const patch = `@@ -1,1 +1,201 @@\n ctx\n${body}`
    expect(hunkHeuristicHit(hunk(patch), 'src/big.ts')).toBe(false)
  })

  it('does NOT treat a security-sensitive PATH as a per-hunk override', () => {
    const c = classify('@@ -1,2 +1,2 @@\n-  const a = 1\n+    const a = 1', 'src/auth/session.ts')
    expect(c.attention).toBe('mechanical')
    expect(c.overrides).toEqual([])
  })

  it('reports every override that applies', () => {
    const c = classify(FORMATTING, 'src/sample.ts', { hasFinding: true, hasDraft: true })
    expect(c.overrides).toEqual(['finding', 'draft'])
  })
})

// ---------------------------------------------------------------------------
// classifyFileHunks — anchor resolution
// ---------------------------------------------------------------------------

describe('classifyFileHunks', () => {
  const PATCH = [
    '@@ -1,2 +1,2 @@',
    '-  const a = 1',
    '+    const a = 1',
    ' keep',
    '@@ -20,2 +20,3 @@ function real()',
    ' ctx',
    '+  doSomethingNew()',
  ].join('\n')

  it('classifies each hunk independently', () => {
    const { hunks, classifications } = classifyFileHunks({ filename: 'src/a.ts', patch: PATCH })
    expect(hunks).toHaveLength(2)
    expect(classifications[0].attention).toBe('mechanical')
    expect(classifications[1].attention).toBe('decision')
  })

  it('applies a finding override to the hunk that contains it, and only that one', () => {
    const { classifications } = classifyFileHunks({
      filename: 'src/a.ts',
      patch: PATCH,
      findings: [{ line: 1, side: 'RIGHT' }],
    })
    expect(classifications[0].attention).toBe('decision')
    expect(classifications[0].overrides).toEqual(['finding'])
  })

  it('ignores an anchor that falls outside every hunk', () => {
    const { classifications } = classifyFileHunks({
      filename: 'src/a.ts',
      patch: PATCH,
      findings: [{ line: 900, side: 'RIGHT' }],
    })
    expect(classifications[0].attention).toBe('mechanical')
  })

  it('applies a draft override by side', () => {
    const { classifications } = classifyFileHunks({
      filename: 'src/a.ts',
      patch: PATCH,
      drafts: [{ line: 1, side: 'LEFT' }],
    })
    expect(classifications[0].overrides).toEqual(['draft'])
  })

  it('is deterministic — the same input yields the same output', () => {
    const a = classifyFileHunks({ filename: 'src/a.ts', patch: PATCH })
    const b = classifyFileHunks({ filename: 'src/a.ts', patch: PATCH })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

// ---------------------------------------------------------------------------
// The "what changed" strip
// ---------------------------------------------------------------------------

function fileOf(patch: string, filename = 'src/a.ts'): PrFile {
  return { filename, status: 'modified', additions: 0, deletions: 0, patch }
}

describe('buildChangeStrip', () => {
  const MIXED = [
    '@@ -1,2 +1,2 @@',
    '-  const a = 1',
    '+    const a = 1',
    ' keep',
    '@@ -20,3 +20,4 @@ export function resolveCompactor() {',
    ' ctx',
    '+  if (mode === "wide") return wide',
    ' tail',
    '@@ -40,2 +41,2 @@',
    "-import x from './x'",
    "+import x from './y'",
  ].join('\n')

  it('names the decision hunk by its changed symbol and jumps to it', () => {
    const file = fileOf(MIXED)
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch: file.patch }))
    const decision = strip.entries.filter((e) => e.attention === 'decision')
    expect(decision).toHaveLength(1)
    expect(decision[0].label).toBe('resolveCompactor')
    expect(decision[0].detail).toBe('+1')
    expect(decision[0].hunkIndex).toBe(1)
    expect(decision[0].line).toBe(20)
    expect(decision[0].side).toBe('RIGHT')
  })

  it('folds the mechanical hunks into one entry per kind', () => {
    const file = fileOf(MIXED)
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch: file.patch }))
    const mech = strip.entries.filter((e) => e.attention === 'mechanical')
    expect(mech.map((e) => e.label)).toEqual(['1 formatting hunk', '1 import hunk'])
    expect(mech[0].hunkIndex).toBe(0)
    expect(mech[1].hunkIndex).toBe(2)
    expect(strip.mechanicalCount).toBe(2)
  })

  it('pluralises a group of several hunks', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '-  const a = 1',
      '+    const a = 1',
      '@@ -10,2 +10,2 @@',
      '-  const b = 2',
      '+    const b = 2',
    ].join('\n')
    const file = fileOf(patch)
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch }))
    expect(strip.entries[0].label).toBe('2 formatting hunks')
    expect(strip.entries[0].count).toBe(2)
  })

  it('flags "nothing substantive" when no hunk is a decision', () => {
    const patch = '@@ -1,2 +1,2 @@\n-  const a = 1\n+    const a = 1'
    const file = fileOf(patch)
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch }))
    expect(strip.nothingSubstantive).toBe(true)
    expect(strip.decisionCount).toBe(0)
  })

  it('is not "nothing substantive" when there are no hunks at all', () => {
    const strip = buildChangeStrip(fileOf(''), classifyFileHunks({ filename: 'src/a.ts', patch: '' }))
    expect(strip.nothingSubstantive).toBe(false)
    expect(strip.entries).toEqual([])
  })

  it('falls back to a line range when no symbol is known', () => {
    const patch = '@@ -1,2 +1,3 @@\n ctx\n+  doThing()\n tail'
    const file = fileOf(patch, 'config/values.ts')
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch }))
    expect(strip.entries[0].label).toBe('Lines 1–3')
  })

  it('caps the decision list and folds the rest into one overflow entry', () => {
    const hunks: string[] = []
    for (let i = 0; i < MAX_STRIP_DECISIONS + 3; i++) {
      const start = 1 + i * 20
      hunks.push(`@@ -${start},2 +${start},3 @@\n ctx\n+  doThing${i}()\n tail`)
    }
    const patch = hunks.join('\n')
    const file = fileOf(patch)
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch }))
    const decision = strip.entries.filter((e) => e.attention === 'decision')
    expect(decision).toHaveLength(MAX_STRIP_DECISIONS + 1)
    expect(decision[MAX_STRIP_DECISIONS].label).toBe('3 more sections')
    expect(decision[MAX_STRIP_DECISIONS].count).toBe(3)
    expect(strip.decisionCount).toBe(MAX_STRIP_DECISIONS + 3)
  })

  it('is not informative for a single unnamed change — the file IS its own summary', () => {
    const patch = '@@ -1,2 +1,3 @@\n ctx\n+  doThing()\n tail'
    const file = fileOf(patch, 'config/values.ts')
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch }))
    expect(strip.entries).toHaveLength(1)
    expect(strip.informative).toBe(false)
  })

  it('is informative as soon as a symbol names the change', () => {
    const patch = '@@ -1,2 +1,3 @@ export function doThing() {\n ctx\n+  return 1\n tail'
    const file = fileOf(patch)
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch }))
    expect(strip.entries).toHaveLength(1)
    expect(strip.entries[0].isSymbol).toBe(true)
    expect(strip.informative).toBe(true)
  })

  it('is informative when nothing substantive changed', () => {
    const patch = '@@ -1,2 +1,2 @@\n-  const a = 1\n+    const a = 1'
    const file = fileOf(patch)
    const strip = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch }))
    expect(strip.informative).toBe(true)
  })

  it('is deterministic across repeated builds', () => {
    const file = fileOf(MIXED)
    const one = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch: file.patch }))
    const two = buildChangeStrip(file, classifyFileHunks({ filename: file.filename, patch: file.patch }))
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
  })
})
