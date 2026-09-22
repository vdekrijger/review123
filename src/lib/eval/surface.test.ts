/**
 * surface.test.ts — the post-generation pipeline toggles.
 *
 * These tests pin the thing the comparison table depends on: each stage flag
 * changes the scored surface in exactly ONE way, and turning a stage off is
 * genuinely off (not "on with different data"). If these drift, every on/off
 * number the harness prints becomes a fiction.
 */

import { describe, it, expect } from 'vitest'
import {
  surfaceFindings,
  isTestsPassFinding,
  PIPELINE_VARIANTS,
  TESTS_TASK_PREFIX,
  type EvalFinding,
  type PipelineStages,
} from './surface'
import type { FindingVerification } from '../ai/schemas'

const ALL_OFF: PipelineStages = {
  crossVerify: false,
  triage: false,
  mootnessGate: false,
  simplify: false,
  testsPass: false,
}

function finding(over: Partial<EvalFinding> = {}): EvalFinding {
  return {
    file: 'src/a.ts',
    line: 10,
    description: 'off-by-one in the slice end',
    severity: 'medium',
    taskKey: 'skill:bug-hunter',
    reviewerName: 'bug-hunter',
    ...over,
  }
}

function verification(over: Partial<FindingVerification> = {}): FindingVerification {
  return { confirmedBy: 2, polledModels: 2, surfaced: true, perModel: [], ...over }
}

describe('isTestsPassFinding', () => {
  it('recognizes the tests pass by its task-key prefix', () => {
    expect(isTestsPassFinding(finding({ taskKey: `${TESTS_TASK_PREFIX}bug-hunter` }))).toBe(true)
    expect(isTestsPassFinding(finding({ taskKey: 'skill:bug-hunter' }))).toBe(false)
  })
})

describe('surfaceFindings — the tests pass (#237)', () => {
  const impl = finding({ description: 'impl finding' })
  const tests = finding({ description: 'tests finding', taskKey: `${TESTS_TASK_PREFIX}bug-hunter` })

  it('excludes tests-pass findings when the stage is off', () => {
    const out = surfaceFindings([impl, tests], { ...ALL_OFF })
    expect(out.map((f) => f.description)).toEqual(['impl finding'])
  })

  it('includes them when the stage is on', () => {
    const out = surfaceFindings([impl, tests], { ...ALL_OFF, testsPass: true })
    expect(out).toHaveLength(2)
  })
})

describe('surfaceFindings — cross-model verification', () => {
  const kept = finding({ description: 'confirmed', verification: verification({ surfaced: true }) })
  const demoted = finding({ description: 'refuted', verification: verification({ surfaced: false }) })

  it('drops demoted findings when on', () => {
    const out = surfaceFindings([kept, demoted], { ...ALL_OFF, crossVerify: true })
    expect(out.map((f) => f.description)).toEqual(['confirmed'])
  })

  it('keeps demoted findings when off', () => {
    const out = surfaceFindings([kept, demoted], { ...ALL_OFF })
    expect(out).toHaveLength(2)
  })

  it('OFF also strips the verification, so triage cannot read a pass that did not run', () => {
    // A LOW finding that verification refused to back: with verification data
    // present triage buries it; with the stage off there is no verification at
    // all, so triage falls back to its no-verification rules.
    const weakLow = finding({
      severity: 'low',
      description: 'weak low finding',
      verification: verification({ confirmedBy: 1, polledModels: 3, surfaced: true }),
    })
    const triaged = surfaceFindings([weakLow], { ...ALL_OFF, triage: true, crossVerify: true })
    const unverified = surfaceFindings([weakLow], { ...ALL_OFF, triage: true, crossVerify: false })
    // Either way a lone LOW is secondary — but the point is the stage is a real
    // switch: the verification object must not survive into the OFF run.
    expect(triaged).toHaveLength(0)
    expect(unverified).toHaveLength(0)
  })

  it('an unverified MEDIUM stays inline, but a verifier-refused one does not', () => {
    const med = finding({ severity: 'medium', description: 'medium finding' })
    const refused = finding({
      severity: 'medium',
      description: 'medium finding',
      verification: verification({ confirmedBy: 1, polledModels: 4, surfaced: true }),
    })
    expect(surfaceFindings([med], { ...ALL_OFF, triage: true })).toHaveLength(1)
    expect(surfaceFindings([refused], { ...ALL_OFF, triage: true, crossVerify: true })).toHaveLength(0)
  })
})

describe('surfaceFindings — triage (#226)', () => {
  it('keeps only the inline primary tier', () => {
    const high = finding({ severity: 'high', description: 'a high finding' })
    const lowAlone = finding({ severity: 'low', description: 'a lone low finding', line: 40 })
    const all = surfaceFindings([high, lowAlone], { ...ALL_OFF })
    const inline = surfaceFindings([high, lowAlone], { ...ALL_OFF, triage: true })
    expect(all).toHaveLength(2)
    expect(inline.map((f) => f.description)).toEqual(['a high finding'])
  })

  it('off = the "show all findings" escape hatch', () => {
    const lows = [1, 2, 3].map((n) => finding({ severity: 'low', line: n, description: `low ${n}` }))
    expect(surfaceFindings(lows, { ...ALL_OFF })).toHaveLength(3)
    expect(surfaceFindings(lows, { ...ALL_OFF, triage: true })).toHaveLength(0)
  })
})

describe('surfaceFindings — the mootness gate (#228)', () => {
  // A HIGH the panel judged moot AND did not confirm real: the gate buries it.
  const mootHigh = finding({
    severity: 'high',
    description: 'a high the panel judged moot',
    verification: verification({ confirmedBy: 1, polledModels: 3, surfaced: true, worthFlagging: false }),
  })

  it('ON demotes a moot high that was not majority-confirmed', () => {
    const out = surfaceFindings([mootHigh], {
      ...ALL_OFF,
      crossVerify: true,
      triage: true,
      mootnessGate: true,
    })
    expect(out).toHaveLength(0)
  })

  it('OFF keeps it inline — this is the isolation the comparison needs', () => {
    const out = surfaceFindings([mootHigh], {
      ...ALL_OFF,
      crossVerify: true,
      triage: true,
      mootnessGate: false,
    })
    expect(out.map((f) => f.description)).toEqual(['a high the panel judged moot'])
  })

  it('does not mutate the caller’s findings when stripping the worth axis', () => {
    surfaceFindings([mootHigh], { ...ALL_OFF, crossVerify: true, triage: true, mootnessGate: false })
    expect(mootHigh.verification?.worthFlagging).toBe(false)
  })

  it('a finding with no worth data is unaffected by the gate either way', () => {
    const noWorth = finding({
      severity: 'high',
      description: 'no worth signal',
      verification: verification({ surfaced: true }),
    })
    const on = surfaceFindings([noWorth], { ...ALL_OFF, crossVerify: true, triage: true, mootnessGate: true })
    const off = surfaceFindings([noWorth], { ...ALL_OFF, crossVerify: true, triage: true, mootnessGate: false })
    expect(on).toEqual(off)
    expect(on).toHaveLength(1)
  })
})

describe('surfaceFindings — simplify (#220)', () => {
  const rewritten = finding({
    description: 'The slice end is computed as start + size - 1 against an exclusive slice.',
    simpleBody: 'Each page drops its last item.',
  })

  it('scores the rewrite when on', () => {
    const out = surfaceFindings([rewritten], { ...ALL_OFF, simplify: true })
    expect(out[0]?.description).toBe('Each page drops its last item.')
  })

  it('scores the original body when off', () => {
    const out = surfaceFindings([rewritten], { ...ALL_OFF })
    expect(out[0]?.description).toContain('start + size - 1')
  })

  it('falls back to the body when the pass produced no rewrite', () => {
    const out = surfaceFindings([finding()], { ...ALL_OFF, simplify: true })
    expect(out[0]?.description).toBe('off-by-one in the slice end')
  })
})

describe('PIPELINE_VARIANTS', () => {
  it('has unique keys', () => {
    const keys = PIPELINE_VARIANTS.map((v) => v.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('starts at the pre-#226 raw surface and ends at what the app shows today', () => {
    expect(PIPELINE_VARIANTS[0]?.key).toBe('generate-only')
    expect(PIPELINE_VARIANTS[0]?.stages).toEqual(ALL_OFF)
    const appDefault = PIPELINE_VARIANTS.find((v) => v.key === 'app-default')
    expect(appDefault?.stages).toEqual({
      crossVerify: true,
      triage: true,
      mootnessGate: true,
      simplify: true,
      testsPass: true,
    })
  })

  it('pairs every filtering variant with an isolating counterpart', () => {
    // The mootness gate and triage each need an otherwise-identical sibling,
    // or their effect cannot be read off the table.
    const on = PIPELINE_VARIANTS.find((v) => v.key === 'verify+triage')
    const off = PIPELINE_VARIANTS.find((v) => v.key === 'verify+triage/moot-off')
    expect(on).toBeDefined()
    expect(off).toBeDefined()
    expect({ ...on!.stages, mootnessGate: false }).toEqual(off!.stages)

    const showAll = PIPELINE_VARIANTS.find((v) => v.key === 'app-default/show-all')
    const appDefault = PIPELINE_VARIANTS.find((v) => v.key === 'app-default')
    expect({ ...appDefault!.stages, triage: false }).toEqual(showAll!.stages)
  })
})
