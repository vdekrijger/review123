import { describe, it, expect } from 'vitest'
import { goldenTreeReadme, planGoldenTree } from './goldenTree'
import type { GoldenCase } from './harness'

const kase = (name: string, files: { path: string; contentAfter: string | null }[]): GoldenCase =>
  ({
    name,
    fixture: { name, files: files.map((f) => ({ ...f, patch: '@@' })) },
    expected: { real: [], noise: [] },
  }) as unknown as GoldenCase

describe('planGoldenTree', () => {
  it('writes each fixture path with the POST-change bytes the reviewer was shown', () => {
    const plan = planGoldenTree([kase('01', [{ path: 'src/lib/range.ts', contentAfter: 'export const a = 1\n' }])])
    expect(plan.files).toEqual([{ path: 'src/lib/range.ts', content: 'export const a = 1\n', from: '01' }])
    expect(plan.collisions).toEqual([])
    expect(plan.deleted).toEqual([])
  })

  it('does NOT write a deleted file — the head state has none, and inventing one is not grounding', () => {
    const plan = planGoldenTree([kase('01', [{ path: 'src/gone.ts', contentAfter: null }])])
    expect(plan.files).toEqual([])
    expect(plan.deleted).toEqual([{ path: 'src/gone.ts', from: '01' }])
  })

  it('merges the whole set into ONE tree, sorted, because every path is distinct', () => {
    const plan = planGoldenTree([
      kase('02', [{ path: 'src/b.ts', contentAfter: 'b' }]),
      kase('01', [{ path: 'src/a.ts', contentAfter: 'a' }]),
    ])
    expect(plan.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('REPORTS a path two fixtures disagree about instead of silently letting one win', () => {
    const plan = planGoldenTree([
      kase('01', [{ path: 'src/dup.ts', contentAfter: 'first' }]),
      kase('02', [{ path: 'src/dup.ts', contentAfter: 'second' }]),
    ])
    expect(plan.collisions).toEqual([{ path: 'src/dup.ts', cases: ['01', '02'] }])
    // Last write wins, and the manifest says so.
    expect(plan.files).toEqual([{ path: 'src/dup.ts', content: 'second', from: '02' }])
  })
})

describe('goldenTreeReadme', () => {
  it('states the tree is generated and lists provenance per file', () => {
    const plan = planGoldenTree([kase('01-real-bug', [{ path: 'src/lib/paginate.ts', contentAfter: 'x' }])])
    const md = goldenTreeReadme(plan, '2026-09-23T00:00:00.000Z')
    expect(md).toContain('GENERATED, NOT A PROJECT')
    expect(md).toContain('`src/lib/paginate.ts`')
    expect(md).toContain('`01-real-bug`')
  })

  it('surfaces collisions and deletions in the README, not only in the plan', () => {
    const plan = planGoldenTree([
      kase('01', [
        { path: 'src/dup.ts', contentAfter: 'a' },
        { path: 'src/gone.ts', contentAfter: null },
      ]),
      kase('02', [{ path: 'src/dup.ts', contentAfter: 'b' }]),
    ])
    const md = goldenTreeReadme(plan, 'now')
    expect(md).toContain('Path collisions')
    expect(md).toContain('Not written (deleted in the fixture)')
    expect(md).toContain('`src/gone.ts`')
  })
})
