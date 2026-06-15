/**
 * Tests for the multi-generator fusion path of the eval harness (Plan O).
 * Two generators each catch a DIFFERENT real bug; the merged union catches BOTH,
 * raising recall above what either single generator achieves. This is the recall
 * win the harness is meant to validate.
 */
import { describe, it, expect } from 'vitest'
import { runCase, mergeProducedUnion, type GoldenCase, type CompleteFn } from './harness'
import type { ProducedFinding } from './scorer'
import { mockComplete } from './mock'

const goldenCase: GoldenCase = {
  name: 'fusion-case',
  fixture: {
    name: 'fusion-case',
    files: [{ path: 'src/pay.ts', patch: '@@ -1 +1 @@', contentAfter: 'x' }],
    skills: [{ name: 'bug-hunter', content: 'Find bugs.' }],
  },
  expected: {
    // TWO known-real bugs; a single generator catches one each.
    real: [
      { file: 'src/pay.ts', line: 10, description: 'off-by-one reads items[length]' },
      { file: 'src/pay.ts', line: 42, description: 'unhandled null in refund path' },
    ],
    noise: [],
  },
}

/** Generator A catches the off-by-one only. */
const genA: Record<string, string> = {
  'skill:bug-hunter': JSON.stringify({
    skillName: 'bug-hunter',
    findings: [
      { path: 'src/pay.ts', line: 10, severity: 'high', body: 'off-by-one reads items[length] which is undefined' },
    ],
  }),
}

/** Generator B catches the null-in-refund only. */
const genB: Record<string, string> = {
  'skill:bug-hunter': JSON.stringify({
    skillName: 'bug-hunter',
    findings: [
      { path: 'src/pay.ts', line: 42, severity: 'high', body: 'unhandled null in the refund path crashes' },
    ],
  }),
}

describe('runCase — multi-generator fusion (Plan O recall)', () => {
  it('single generator A catches only 1 of 2 real bugs → recall 0.5', async () => {
    const r = await runCase(goldenCase, mockComplete(genA))
    expect(r.score.realCaught).toBe(1)
    expect(r.score.recall).toBe(0.5)
  })

  it('--fusion generate merges A+B → catches BOTH bugs → recall 1 (the win)', async () => {
    const generators: { name: string; complete: CompleteFn }[] = [
      { name: 'gen-a', complete: mockComplete(genA) },
      { name: 'gen-b', complete: mockComplete(genB) },
    ]
    const r = await runCase(goldenCase, mockComplete(genA), null, {
      fusionGenerate: true,
      generators,
    })
    expect(r.score.realCaught).toBe(2)
    expect(r.score.recall).toBe(1)
    // Recall strictly improved over the single-generator baseline.
    expect(r.score.recall).toBeGreaterThan(0.5)
  })

  it('falls back to single-generator when <2 generators provided', async () => {
    const r = await runCase(goldenCase, mockComplete(genA), null, {
      fusionGenerate: true,
      generators: [{ name: 'only', complete: mockComplete(genA) }],
    })
    expect(r.score.recall).toBe(0.5) // no fusion → A alone
  })
})

describe('mergeProducedUnion', () => {
  const f = (line: number | null, description: string): ProducedFinding => ({ file: 'src/x.ts', line, description })

  it('dedups overlapping findings, keeps distinct ones', () => {
    const union = mergeProducedUnion([
      [f(10, 'off-by-one in the pagination loop')],
      [f(11, 'off-by-one error in pagination loop'), f(42, 'unhandled null in refund')],
    ])
    expect(union.length).toBe(2) // the two off-by-ones merge; the null stays
  })
})
