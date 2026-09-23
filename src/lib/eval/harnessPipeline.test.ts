/**
 * harnessPipeline.test.ts — the harness wiring added so the post-June review
 * pipeline is measurable at all: the separate tests pass (#237), verification
 * results carried WHOLE rather than reduced to a surface bit, the simplify pass
 * (#220), and per-variant scoring.
 *
 * The point of each test is that a pipeline stage's data actually REACHES the
 * scorer. Before this, severity was discarded at normalization and verification
 * was reduced to a boolean — which silently made triage (#226) and the mootness
 * gate (#228) unmeasurable while the harness still printed confident numbers.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  runCase,
  type CompleteFn,
  type ConvergeFn,
  type GoldenCase,
  type SimplifyFn,
  type VerifyFn,
} from './harness'
import { mockComplete, emptyResponseFor } from './mock'
import { PIPELINE_VARIANTS, TESTS_TASK_PREFIX } from './surface'

const goldenCase: GoldenCase = {
  name: 'pipeline-case',
  fixture: {
    name: 'pipeline-case',
    files: [{ path: 'src/pay.ts', patch: '@@ -1 +1 @@', contentAfter: 'x' }],
    skills: [{ name: 'bug-hunter', content: 'Find bugs.' }],
  },
  expected: {
    real: [{ file: 'src/pay.ts', line: 10, description: 'off-by-one reads items[length]' }],
    noise: [{ file: 'src/pay.ts', line: 9, description: 'prefer const over let' }],
  },
}

const implFindings = {
  'skill:bug-hunter': JSON.stringify({
    skillName: 'bug-hunter',
    findings: [
      { path: 'src/pay.ts', line: 10, severity: 'high', body: 'off-by-one reads items[length] which is undefined' },
      { path: 'src/pay.ts', line: 9, severity: 'low', body: 'prefer const over let here' },
    ],
  }),
}

describe('emptyResponseFor — the tests pass', () => {
  it('answers a tests: task with a valid SkillReviewResult, not "{}"', () => {
    const parsed = JSON.parse(emptyResponseFor(`${TESTS_TASK_PREFIX}bug-hunter`))
    expect(parsed).toEqual({ skillName: 'bug-hunter', findings: [] })
  })
})

describe('runCase — the separate tests pass (#237)', () => {
  it('is off by default: no tests: task is ever requested', async () => {
    const seen: string[] = []
    const spy: CompleteFn = async (a) => {
      seen.push(a.taskKey)
      return mockComplete(implFindings)(a)
    }
    await runCase(goldenCase, spy)
    expect(seen.some((k) => k.startsWith(TESTS_TASK_PREFIX))).toBe(false)
  })

  it('runs a second pass per persona and tags its findings', async () => {
    const responses = {
      ...implFindings,
      [`${TESTS_TASK_PREFIX}bug-hunter`]: JSON.stringify({
        skillName: 'bug-hunter',
        findings: [{ path: 'src/pay.ts', line: 10, severity: 'medium', body: 'no test pins the boundary behavior' }],
      }),
    }
    const r = await runCase(goldenCase, mockComplete(responses), null, { testsPass: true })
    const tagged = r.findings.filter((f) => f.taskKey === `${TESTS_TASK_PREFIX}bug-hunter`)
    expect(tagged).toHaveLength(1)
    expect(tagged[0]?.description).toContain('no test pins')
  })

  it('sends the tests pass a DIFFERENT system prompt from the impl pass', async () => {
    const systems = new Map<string, string>()
    const spy: CompleteFn = async (a) => {
      systems.set(a.taskKey, a.system)
      return mockComplete(implFindings)(a)
    }
    await runCase(goldenCase, spy, null, { testsPass: true })
    const impl = systems.get('skill:bug-hunter')
    const tests = systems.get(`${TESTS_TASK_PREFIX}bug-hunter`)
    expect(impl).toBeDefined()
    expect(tests).toBeDefined()
    expect(tests).not.toBe(impl)
  })
})

describe('runCase — severity survives normalization', () => {
  it('carries the reviewer’s severity and persona onto every finding', async () => {
    const r = await runCase(goldenCase, mockComplete(implFindings))
    const high = r.findings.find((f) => f.line === 10)
    const low = r.findings.find((f) => f.line === 9)
    expect(high?.severity).toBe('high')
    expect(low?.severity).toBe('low')
    expect(high?.reviewerName).toBe('bug-hunter')
  })
})

describe('runCase — verification is carried whole', () => {
  it('attaches the full FindingVerification when the verify fn returns one', async () => {
    const verify: VerifyFn = async (findings) => ({
      surfaced: findings.map(() => true),
      verifications: findings.map(() => ({
        confirmedBy: 1,
        polledModels: 3,
        surfaced: true,
        worthFlagging: false,
        perModel: [],
      })),
    })
    const r = await runCase(goldenCase, mockComplete(implFindings), null, { verify })
    expect(r.findings[0]?.verification?.worthFlagging).toBe(false)
    expect(r.findings[0]?.verification?.polledModels).toBe(3)
  })

  it('still honors a legacy verify fn that returns only `surfaced`', async () => {
    const verify: VerifyFn = async (findings) => ({
      surfaced: findings.map((f) => !/prefer const/.test(f.description)),
    })
    const r = await runCase(goldenCase, mockComplete(implFindings), null, { crossVerify: true, verify })
    expect(r.produced).toHaveLength(1)
    expect(r.produced[0]?.line).toBe(10)
  })
})

describe('runCase — the simplify pass (#220)', () => {
  it('attaches rewrites as simpleBody without touching the original body', async () => {
    const simplify: SimplifyFn = async (findings) => findings.map(() => 'Page drops its last item.')
    const r = await runCase(goldenCase, mockComplete(implFindings), null, { simplify })
    expect(r.findings[0]?.simpleBody).toBe('Page drops its last item.')
    expect(r.findings[0]?.description).toContain('items[length]')
  })

  it('leaves simpleBody absent when the rewrite equals the body', async () => {
    const simplify: SimplifyFn = async (findings) => findings.map((f) => f.description)
    const r = await runCase(goldenCase, mockComplete(implFindings), null, { simplify })
    expect(r.findings[0]?.simpleBody).toBeUndefined()
  })

  it('is not called at all when the option is absent', async () => {
    const simplify = vi.fn<SimplifyFn>(async (f) => f.map(() => undefined))
    await runCase(goldenCase, mockComplete(implFindings))
    expect(simplify).not.toHaveBeenCalled()
  })
})

describe('runCase — cross-reviewer convergence (#206)', () => {
  // Two personas describing ONE issue a few lines apart — the case the
  // convergence pass exists for, and the case no fixture could produce before
  // the multi-persona golden case existed.
  const twoPersonaCase: GoldenCase = {
    name: 'converge-case',
    fixture: {
      name: 'converge-case',
      files: [{ path: 'src/draft.ts', patch: '@@ -1 +1 @@', contentAfter: 'x' }],
      skills: [
        { name: 'bug-hunter', content: 'Find bugs.' },
        { name: 'reliability-reviewer', content: 'Find reliability problems.' },
      ],
    },
    expected: {
      real: [{ file: 'src/draft.ts', line: 10, description: 'store.put is not awaited' }],
      noise: [],
    },
  }

  const twoPersonaFindings = {
    'skill:bug-hunter': JSON.stringify({
      skillName: 'bug-hunter',
      findings: [
        { path: 'src/draft.ts', line: 10, severity: 'medium', body: 'store.put returns a promise that is not awaited' },
      ],
    }),
    'skill:reliability-reviewer': JSON.stringify({
      skillName: 'reliability-reviewer',
      findings: [
        { path: 'src/draft.ts', line: 12, severity: 'medium', body: 'the metric counts a save whose put is not awaited' },
      ],
    }),
  }

  const clusterBoth: ConvergeFn = async () => ({
    clusters: [{ members: ['f0', 'f1'], primary: 'f0', reason: 'same un-awaited put' }],
  })

  it('attaches mergedFrom to the primary and marks the absorbed sibling', async () => {
    const r = await runCase(twoPersonaCase, mockComplete(twoPersonaFindings), null, { converge: clusterBoth })
    const primary = r.findings.find((f) => f.line === 10)
    const absorbed = r.findings.find((f) => f.line === 12)
    expect(primary?.mergedFrom).toHaveLength(1)
    expect(primary?.mergedFrom?.[0]?.reviewer).toBe('reliability-reviewer')
    expect(absorbed?.absorbedBy).toBe('f0')
    // Loss-proof: the absorbed finding is still THERE, just marked.
    expect(absorbed?.description).toContain('metric counts a save')
  })

  it('is inert on a single-persona case — there is nothing to converge across', async () => {
    const converge = vi.fn<ConvergeFn>(async () => ({
      clusters: [{ members: ['f0', 'f1'], primary: 'f0', reason: 'x' }],
    }))
    const r = await runCase(goldenCase, mockComplete(implFindings), null, { converge })
    expect(converge).not.toHaveBeenCalled()
    expect(r.findings.some((f) => f.mergedFrom || f.absorbedBy)).toBe(false)
  })

  it('is a NO-OP when the pass fails — originals stand, nothing is lost', async () => {
    const failing: ConvergeFn = async () => {
      throw new Error('verifier down')
    }
    const r = await runCase(twoPersonaCase, mockComplete(twoPersonaFindings), null, { converge: failing })
    expect(r.findings.some((f) => f.absorbedBy !== undefined)).toBe(false)
    expect(r.findings.filter((f) => f.taskKey.startsWith('skill:'))).toHaveLength(2)
  })

  it('rescues a weakly-verified MEDIUM from triage — the effect worth measuring', async () => {
    // Both personas' findings get a 1-of-3 confirm: alone, findingTier buries a
    // MEDIUM the verifiers would not back. Converged, two DISTINCT reviewers
    // agreeing keeps it inline. The two variants must therefore disagree.
    const verify: VerifyFn = async (findings) => ({
      surfaced: findings.map(() => true),
      verifications: findings.map(() => ({ confirmedBy: 1, polledModels: 3, surfaced: true, perModel: [] })),
    })
    const r = await runCase(twoPersonaCase, mockComplete(twoPersonaFindings), null, {
      converge: clusterBoth,
      verify,
      crossVerify: true,
      variants: PIPELINE_VARIANTS,
    })
    expect(r.variantScores['app-default']?.realCaught).toBe(1)
    expect(r.variantScores['app-default/convergence-off']?.realCaught).toBe(0)
  })
})

describe('runCase — variant scoring', () => {
  it('scores one generation under every requested variant', async () => {
    const r = await runCase(goldenCase, mockComplete(implFindings), null, { variants: PIPELINE_VARIANTS })
    for (const v of PIPELINE_VARIANTS) expect(r.variantScores[v.key]).toBeDefined()
  })

  it('triage buries the lone LOW nit while keeping the HIGH real finding', async () => {
    // This is the whole reason the comparison exists: the same generation
    // scores differently depending on which stages are on.
    const r = await runCase(goldenCase, mockComplete(implFindings), null, { variants: PIPELINE_VARIANTS })
    const raw = r.variantScores['generate-only']
    const triaged = r.variantScores['+triage']
    expect(raw?.noiseFlagged).toBe(1)
    expect(raw?.recall).toBe(1)
    expect(triaged?.noiseFlagged).toBe(0) // the low nit is collapsed
    expect(triaged?.recall).toBe(1) // ...and the real high is NOT
  })

  it('returns an empty variantScores map when no variants are asked for', async () => {
    const r = await runCase(goldenCase, mockComplete(implFindings))
    expect(r.variantScores).toEqual({})
  })
})
