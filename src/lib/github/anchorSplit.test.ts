import { describe, it, expect } from 'vitest'
import {
  splitDraftsByAnchor,
  offDiffLineLabel,
  offDiffCommentBody,
  foldOffDiffIntoBody,
  OFF_DIFF_SECTION_HEADING,
} from './anchorSplit'
import type { Draft } from '../drafts/drafts.svelte'

// Patch hunks: RIGHT side has lines 1,3,4,5 wait — let's derive precisely.
//   @@ -1,3 +1,4 @@
//    context        → old 1 / new 1
//   -removed        → old 2
//   +added          → new 2
//   +added2         → new 3
//    context        → old 3 / new 4
// LEFT  = {1, 2, 3}
// RIGHT = {1, 2, 3, 4}
const PATCH = '@@ -1,3 +1,4 @@\n context\n-removed\n+added\n+added2\n context'

const FILES = [
  { filename: 'src/foo.ts', patch: PATCH },
  { filename: 'assets/logo.png', patch: undefined }, // binary — no patch
]

function draft(overrides: Partial<Draft>): Draft {
  return {
    prKey: 'alice/widgets#42',
    path: 'src/foo.ts',
    line: 2,
    side: 'RIGHT',
    body: 'note',
    ...overrides,
  }
}

describe('splitDraftsByAnchor', () => {
  it('RIGHT line inside the hunks → inline', () => {
    const d = draft({ line: 4, side: 'RIGHT' })
    expect(splitDraftsByAnchor([d], FILES)).toEqual({ inline: [d], offDiff: [] })
  })

  it('RIGHT line outside the hunks → offDiff', () => {
    const d = draft({ line: 99, side: 'RIGHT' })
    expect(splitDraftsByAnchor([d], FILES)).toEqual({ inline: [], offDiff: [d] })
  })

  it('LEFT side uses old-file numbering (line 2 is the removed line → inline; line 4 is off-diff)', () => {
    const inline = draft({ line: 2, side: 'LEFT' })
    const off = draft({ line: 4, side: 'LEFT' })
    expect(splitDraftsByAnchor([inline, off], FILES)).toEqual({ inline: [inline], offDiff: [off] })
  })

  it('range draft with BOTH endpoints in the diff → inline', () => {
    const d = draft({ startLine: 1, line: 3, side: 'RIGHT' })
    expect(splitDraftsByAnchor([d], FILES).inline).toEqual([d])
  })

  it('range draft with an off-diff START line → offDiff even when the end line is in-diff (conservative)', () => {
    // RIGHT has 1..4; a range 5–8 has neither, a range like startLine outside
    // is exercised with a bigger patchless span: use LEFT {1,2,3}, range 0–2.
    const d = draft({ startLine: 0, line: 2, side: 'LEFT' })
    expect(splitDraftsByAnchor([d], FILES).offDiff).toEqual([d])
  })

  it('range draft with an off-diff END line → offDiff', () => {
    const d = draft({ startLine: 3, line: 99, side: 'RIGHT' })
    expect(splitDraftsByAnchor([d], FILES).offDiff).toEqual([d])
  })

  it('file present but WITHOUT a patch (binary/huge) → offDiff', () => {
    const d = draft({ path: 'assets/logo.png', line: 1, side: 'RIGHT' })
    expect(splitDraftsByAnchor([d], FILES).offDiff).toEqual([d])
  })

  it('path not in the file list at all → offDiff', () => {
    const d = draft({ path: 'src/gone.ts', line: 1, side: 'RIGHT' })
    expect(splitDraftsByAnchor([d], FILES).offDiff).toEqual([d])
  })

  it('EMPTY file list → every draft stays inline (no basis to judge — same rule as isStaleDraft)', () => {
    const d = draft({ line: 99999, side: 'RIGHT' })
    expect(splitDraftsByAnchor([d], [])).toEqual({ inline: [d], offDiff: [] })
  })

  it('empty drafts → both buckets empty', () => {
    expect(splitDraftsByAnchor([], FILES)).toEqual({ inline: [], offDiff: [] })
  })

  it('preserves draft order within each bucket', () => {
    const a = draft({ line: 1, body: 'a' })
    const b = draft({ line: 90, body: 'b' })
    const c = draft({ line: 2, body: 'c' })
    const d = draft({ line: 91, body: 'd' })
    const split = splitDraftsByAnchor([a, b, c, d], FILES)
    expect(split.inline.map((x) => x.body)).toEqual(['a', 'c'])
    expect(split.offDiff.map((x) => x.body)).toEqual(['b', 'd'])
  })
})

describe('off-diff comment bodies', () => {
  it('offDiffLineLabel: single line and range', () => {
    expect(offDiffLineLabel({ line: 7 })).toBe('line 7')
    expect(offDiffLineLabel({ line: 7, startLine: 3 })).toBe('lines 3–7')
    expect(offDiffLineLabel({ line: 7, startLine: 7 })).toBe('line 7')
  })

  it('offDiffCommentBody: line-only prefix (file-level comments carry the path already)', () => {
    expect(offDiffCommentBody({ path: 'src/foo.ts', line: 7 }, 'Check this')).toBe(
      '**Re: line 7** _(line not in the current diff)_ — Check this',
    )
  })

  it('offDiffCommentBody with includePath: path:line prefix for detached notes', () => {
    expect(
      offDiffCommentBody({ path: 'src/foo.ts', line: 7, startLine: 3 }, 'Check this', { includePath: true }),
    ).toBe('**Re: src/foo.ts:3–7** _(line not in the current diff)_ — Check this')
  })

  it('foldOffDiffIntoBody: appends the marked section with path:line entries', () => {
    const folded = foldOffDiffIntoBody('Overall body', [
      { draft: { path: 'a.ts', line: 5 }, outgoingBody: 'First' },
      { draft: { path: 'b.ts', line: 9, startLine: 7 }, outgoingBody: 'Second' },
    ])
    expect(folded).toBe(
      `Overall body\n\n${OFF_DIFF_SECTION_HEADING}\n\n**a.ts:5** — First\n\n**b.ts:7–9** — Second`,
    )
  })

  it('foldOffDiffIntoBody: empty base body starts with the heading; empty entries return base unchanged', () => {
    expect(foldOffDiffIntoBody('', [{ draft: { path: 'a.ts', line: 1 }, outgoingBody: 'X' }])).toBe(
      `${OFF_DIFF_SECTION_HEADING}\n\n**a.ts:1** — X`,
    )
    expect(foldOffDiffIntoBody('Base', [])).toBe('Base')
  })

  it('foldOffDiffIntoBody: a second fold appends without duplicating the heading', () => {
    const once = foldOffDiffIntoBody('Base', [{ draft: { path: 'a.ts', line: 1 }, outgoingBody: 'X' }])
    const twice = foldOffDiffIntoBody(once, [{ draft: { path: 'b.ts', line: 2 }, outgoingBody: 'Y' }])
    expect(twice.match(new RegExp(OFF_DIFF_SECTION_HEADING, 'g'))).toHaveLength(1)
    expect(twice).toContain('**b.ts:2** — Y')
  })
})
