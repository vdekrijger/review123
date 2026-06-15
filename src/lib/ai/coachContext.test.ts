/**
 * Tests for src/lib/ai/coachContext.ts — buildCoachCodeContext.
 */

import { describe, it, expect } from 'vitest'
import { buildCoachCodeContext, COACH_CONTEXT_MAX_DRAFTS } from './coachContext'
import type { PrFile } from '../github/types'
import type { Draft } from '../drafts/drafts.svelte'

const PATCH = [
  '@@ -1,3 +1,4 @@',
  ' line one',
  '+const added = 1',
  ' line two',
  ' line three',
].join('\n')

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    filename: 'src/a.ts',
    status: 'modified',
    patch: PATCH,
    additions: 1,
    deletions: 0,
    ...overrides,
  }
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    prKey: 'o/r#1',
    path: 'src/a.ts',
    line: 2,
    side: 'RIGHT',
    body: 'comment',
    updatedAt: 0,
    ...overrides,
  }
}

describe('buildCoachCodeContext', () => {
  it('attaches a hunk excerpt around the commented line', () => {
    const out = buildCoachCodeContext([draft({ line: 2 })], [file()], null)
    expect(out).toHaveLength(1)
    expect(out[0].index).toBe(0)
    expect(out[0].path).toBe('src/a.ts')
    expect(out[0].excerpt).toContain('const added = 1')
  })

  it('includes a numbered fileWindow from the RIGHT-side (after) contents', () => {
    const after = Array.from({ length: 10 }, (_, i) => `lineRIGHT${i + 1}`).join('\n')
    const contents = new Map([['src/a.ts', { before: null, after }]])
    const out = buildCoachCodeContext([draft({ line: 3, side: 'RIGHT' })], [file()], contents)
    expect(out[0].fileWindow).toBeDefined()
    expect(out[0].fileWindow).toContain('3: lineRIGHT3')
  })

  it('uses the LEFT-side (before) contents for a LEFT comment', () => {
    const before = Array.from({ length: 10 }, (_, i) => `lineLEFT${i + 1}`).join('\n')
    const contents = new Map([['src/a.ts', { before, after: null }]])
    const out = buildCoachCodeContext([draft({ line: 2, side: 'LEFT' })], [file()], contents)
    expect(out[0].fileWindow).toContain('2: lineLEFT2')
  })

  it('omits fileWindow when no contents are available for the file', () => {
    const out = buildCoachCodeContext([draft()], [file()], new Map())
    expect(out[0].fileWindow).toBeUndefined()
  })

  it('returns empty excerpt when the file has no patch', () => {
    const out = buildCoachCodeContext([draft()], [file({ patch: undefined })], null)
    expect(out[0].excerpt).toBe('')
  })

  it('returns empty excerpt when the file is missing entirely', () => {
    const out = buildCoachCodeContext([draft({ path: 'src/missing.ts' })], [file()], null)
    expect(out[0].excerpt).toBe('')
  })

  it('caps the number of drafts that receive context', () => {
    const many: Draft[] = Array.from({ length: COACH_CONTEXT_MAX_DRAFTS + 5 }, (_, i) =>
      draft({ line: i + 1 }),
    )
    const out = buildCoachCodeContext(many, [file()], null)
    expect(out).toHaveLength(COACH_CONTEXT_MAX_DRAFTS)
  })

  it('bounds the fileWindow to ±40 lines around the line', () => {
    const after = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join('\n')
    const contents = new Map([['src/a.ts', { before: null, after }]])
    const out = buildCoachCodeContext([draft({ line: 100, side: 'RIGHT' })], [file()], contents)
    const win = out[0].fileWindow!
    expect(win).toContain('100: L100')
    // ±40 → lines 60..140; line 59 and 141 excluded.
    expect(win).toContain('60: L60')
    expect(win).toContain('140: L140')
    expect(win).not.toContain('59: L59')
    expect(win).not.toContain('141: L141')
  })
})
