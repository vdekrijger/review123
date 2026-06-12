import { describe, it, expect } from 'vitest'
import { patchLineNumbers } from './patchLines'

const PATCH = '@@ -1,3 +1,4 @@\n unchanged line\n-removed line\n+added line\n+another added line\n trailing context'

describe('patchLineNumbers', () => {
  it('RIGHT side: contains context and added line numbers', () => {
    const right = patchLineNumbers(PATCH, 'RIGHT')
    // new file: 1 unchanged, 2 added, 3 another added, 4 trailing context
    expect([...right].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('LEFT side: contains context and removed line numbers', () => {
    const left = patchLineNumbers(PATCH, 'LEFT')
    // old file: 1 unchanged, 2 removed, 3 trailing context
    expect([...left].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('line outside any hunk is not in the set', () => {
    const right = patchLineNumbers(PATCH, 'RIGHT')
    expect(right.has(999)).toBe(false)
    expect(right.has(5)).toBe(false)
  })

  it('multi-hunk patch maps each hunk independently', () => {
    const patch = '@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -10,2 +10,3 @@\n c\n+d\n e'
    const right = patchLineNumbers(patch, 'RIGHT')
    expect([...right].sort((a, b) => a - b)).toEqual([1, 2, 10, 11, 12])
    const left = patchLineNumbers(patch, 'LEFT')
    expect([...left].sort((a, b) => a - b)).toEqual([1, 2, 10, 11])
  })

  it('empty / undefined patch yields an empty set', () => {
    expect(patchLineNumbers('', 'RIGHT').size).toBe(0)
    expect(patchLineNumbers(undefined, 'LEFT').size).toBe(0)
  })

  it('ignores the no-newline marker', () => {
    const patch = '@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file'
    expect([...patchLineNumbers(patch, 'RIGHT')]).toEqual([1])
    expect([...patchLineNumbers(patch, 'LEFT')]).toEqual([1])
  })
})
