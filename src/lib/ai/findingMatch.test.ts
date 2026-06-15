import { describe, it, expect } from 'vitest'
import { findingsMatch, descOverlap, tokenize, type AnchoredFinding } from './findingMatch'

const f = (file: string, line: number | null, description: string): AnchoredFinding => ({
  file,
  line,
  description,
})

describe('tokenize / descOverlap', () => {
  it('drops stop words and short tokens', () => {
    expect(tokenize('the off-by-one error in loop')).toEqual(['off', 'one', 'error', 'loop'])
  })

  it('Jaccard overlap is 1 for identical, 0 for disjoint', () => {
    expect(descOverlap('null pointer dereference', 'null pointer dereference')).toBe(1)
    expect(descOverlap('null pointer', 'race condition deadlock')).toBe(0)
  })
})

describe('findingsMatch', () => {
  it('same file + near line + overlapping description → match', () => {
    expect(
      findingsMatch(
        f('src/a.ts', 10, 'off-by-one in the pagination loop'),
        f('src/a.ts', 12, 'off-by-one error in pagination loop'),
      ),
    ).toBe(true)
  })

  it('different file → no match even with identical text', () => {
    expect(
      findingsMatch(f('src/a.ts', 10, 'null deref'), f('src/b.ts', 10, 'null deref')),
    ).toBe(false)
  })

  it('line out of tolerance → no match', () => {
    expect(
      findingsMatch(
        f('src/a.ts', 10, 'unbounded loop allocation'),
        f('src/a.ts', 50, 'unbounded loop allocation'),
      ),
    ).toBe(false)
  })

  it('file-level (null line) matches any line on the same file', () => {
    expect(
      findingsMatch(
        f('src/a.ts', null, 'missing input validation boundary'),
        f('src/a.ts', 99, 'missing input validation at boundary'),
      ),
    ).toBe(true)
  })

  it('same line but unrelated concern → no match (description gate)', () => {
    expect(
      findingsMatch(
        f('src/a.ts', 10, 'SQL injection in the query builder'),
        f('src/a.ts', 10, 'variable name is confusing here'),
      ),
    ).toBe(false)
  })
})
