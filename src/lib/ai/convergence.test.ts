/**
 * Tests for src/lib/ai/convergence.ts — the pure cross-reviewer convergence
 * logic: enumeration/fingerprint, validator, applied-cluster transform, the
 * merge itself, and the reviewer-credit label.
 */

import { describe, it, expect } from 'vitest'
import {
  enumerateFindings,
  enumerateDrafts,
  validateConvergence,
  toAppliedClusters,
  applyConvergence,
  mergedReviewerLabel,
  type ReviewerFindings,
  type ConvergenceValue,
} from './convergence'
import type { SkillFinding, FindingVerification } from './schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function finding(overrides: Partial<SkillFinding> = {}): SkillFinding {
  return { path: 'src/a.ts', line: 10, severity: 'medium', body: 'naive datetime compared to aware', ...overrides }
}

function verification(confirmedBy: number, polledModels: number): FindingVerification {
  return { confirmedBy, polledModels, surfaced: true, perModel: [] }
}

/** Two reviewers, three findings: f0/f1 (UX), f2 (SRE) — f0 & f2 are the same issue. */
function twoReviewers(): ReviewerFindings[] {
  return [
    {
      skillId: 'ux',
      name: 'UX & Interaction',
      findings: [
        finding({ line: 10, body: 'TypeError: naive vs aware datetime', severity: 'medium' }),
        finding({ line: 40, body: 'button label truncates', severity: 'low' }),
      ],
    },
    {
      skillId: 'sre',
      name: 'Resiliency & SRE',
      findings: [finding({ line: 12, body: 'comparing naive datetime raises TypeError', severity: 'high' })],
    },
  ]
}

const NO_DRAFTS = new Set<string>()

// ---------------------------------------------------------------------------
// enumerateFindings / enumerateDrafts
// ---------------------------------------------------------------------------

describe('enumerateFindings', () => {
  it('assigns positional ids f0..fN across reviewers in order', () => {
    const { inputs } = enumerateFindings(twoReviewers())
    expect(inputs.map((i) => i.id)).toEqual(['f0', 'f1', 'f2'])
    expect(inputs[0].reviewer).toBe('UX & Interaction')
    expect(inputs[2].reviewer).toBe('Resiliency & SRE')
    expect(inputs[2].line).toBe(12)
  })

  it('fingerprint is stable for identical input and changes when a finding changes', () => {
    const a = enumerateFindings(twoReviewers()).fingerprint
    const b = enumerateFindings(twoReviewers()).fingerprint
    expect(a).toBe(b)
    const changed = twoReviewers()
    changed[1].findings[0] = finding({ line: 99, body: 'different issue' })
    expect(enumerateFindings(changed).fingerprint).not.toBe(a)
  })

  it('skips nothing and handles reviewers with zero findings', () => {
    const { inputs } = enumerateFindings([
      { skillId: 'empty', name: 'Empty', findings: [] },
      ...twoReviewers(),
    ])
    expect(inputs).toHaveLength(3)
    expect(inputs[0].id).toBe('f0')
  })
})

describe('enumerateDrafts', () => {
  it('assigns draft-N ids', () => {
    const { inputs } = enumerateDrafts([{ path: 'src/a.ts', line: 11, body: 'same naive datetime bug' }])
    expect(inputs).toEqual([{ id: 'draft-0', path: 'src/a.ts', line: 11, body: 'same naive datetime bug' }])
  })
})

// ---------------------------------------------------------------------------
// validateConvergence
// ---------------------------------------------------------------------------

describe('validateConvergence', () => {
  const IDS = new Set(['f0', 'f1', 'f2'])
  const DRAFTS = new Set(['draft-0'])

  it('accepts a valid cluster set (and an empty one)', () => {
    const v = validateConvergence(
      { clusters: [{ members: ['f0', 'f2'], primary: 'f0', reason: 'same TypeError' }] },
      IDS,
      DRAFTS,
    )
    expect(v).toEqual({ clusters: [{ members: ['f0', 'f2'], primary: 'f0', reason: 'same TypeError' }] })
    expect(validateConvergence({ clusters: [] }, IDS, DRAFTS)).toEqual({ clusters: [] })
  })

  it('rejects overlapping clusters (an id in two clusters)', () => {
    const v = validateConvergence(
      {
        clusters: [
          { members: ['f0', 'f2'], primary: 'f0', reason: 'x' },
          { members: ['f2', 'f1'], primary: 'f1', reason: 'y' },
        ],
      },
      IDS,
      DRAFTS,
    )
    expect(v).toBeNull()
  })

  it('rejects unknown ids', () => {
    expect(validateConvergence({ clusters: [{ members: ['f0', 'f9'], primary: 'f0', reason: '' }] }, IDS, DRAFTS)).toBeNull()
  })

  it('rejects clusters with fewer than 2 distinct members', () => {
    expect(validateConvergence({ clusters: [{ members: ['f0'], primary: 'f0', reason: '' }] }, IDS, DRAFTS)).toBeNull()
    // Duplicated single id collapses to 1 member → invalid too.
    expect(validateConvergence({ clusters: [{ members: ['f0', 'f0'], primary: 'f0', reason: '' }] }, IDS, DRAFTS)).toBeNull()
  })

  it('rejects a primary outside the members', () => {
    expect(validateConvergence({ clusters: [{ members: ['f0', 'f2'], primary: 'f1', reason: '' }] }, IDS, DRAFTS)).toBeNull()
  })

  it('rejects draft-only clusters (no finding member)', () => {
    expect(validateConvergence({ clusters: [{ members: ['draft-0', 'draft-0'], primary: 'draft-0', reason: '' }] }, IDS, DRAFTS)).toBeNull()
  })

  it('rejects garbage shapes wholesale', () => {
    expect(validateConvergence(null, IDS, DRAFTS)).toBeNull()
    expect(validateConvergence('clusters', IDS, DRAFTS)).toBeNull()
    expect(validateConvergence({ readingOrder: [] }, IDS, DRAFTS)).toBeNull()
    expect(validateConvergence({ clusters: 'f0,f2' }, IDS, DRAFTS)).toBeNull()
    expect(validateConvergence({ clusters: [{ members: 'f0' }] }, IDS, DRAFTS)).toBeNull()
    expect(validateConvergence({ clusters: [{ members: [true, 'f0'], primary: 'f0' }] }, IDS, DRAFTS)).toBeNull()
  })

  it('normalizes bare integer members to fN and truncates reason to 100 chars', () => {
    const v = validateConvergence({ clusters: [{ members: [0, 2], primary: 0, reason: 'r'.repeat(150) }] }, IDS, DRAFTS)
    expect(v?.clusters[0].members).toEqual(['f0', 'f2'])
    expect(v?.clusters[0].primary).toBe('f0')
    expect(v?.clusters[0].reason).toHaveLength(100)
  })

  it('accepts a mixed finding+draft cluster with the draft as primary', () => {
    const v = validateConvergence({ clusters: [{ members: ['f0', 'draft-0'], primary: 'draft-0', reason: 'covered' }] }, IDS, DRAFTS)
    expect(v?.clusters[0].members).toEqual(['f0', 'draft-0'])
  })
})

// ---------------------------------------------------------------------------
// toAppliedClusters
// ---------------------------------------------------------------------------

describe('toAppliedClusters', () => {
  const draftById = new Map([['draft-0', { path: 'src/a.ts', line: 11 }]])

  it('resolves draft members into coveredBy and keeps finding members', () => {
    const applied = toAppliedClusters(
      { clusters: [{ members: ['f0', 'draft-0'], primary: 'draft-0', reason: 'covered' }] },
      draftById,
    )
    expect(applied).toEqual([
      { members: ['f0'], primary: 'f0', reason: 'covered', coveredBy: { path: 'src/a.ts', line: 11 } },
    ])
  })

  it('keeps pure finding clusters as merges', () => {
    const applied = toAppliedClusters({ clusters: [{ members: ['f0', 'f2'], primary: 'f2', reason: 'same' }] }, draftById)
    expect(applied).toEqual([{ members: ['f0', 'f2'], primary: 'f2', reason: 'same' }])
  })
})

// ---------------------------------------------------------------------------
// applyConvergence
// ---------------------------------------------------------------------------

describe('applyConvergence', () => {
  function valueFor(reviewers: ReviewerFindings[], clusters: ConvergenceValue['clusters']): ConvergenceValue {
    return { fingerprint: enumerateFindings(reviewers).fingerprint, clusters }
  }

  it('merges a cluster into the primary: path/line/body win, severity max, mergedFrom preserved', () => {
    const reviewers = twoReviewers()
    const out = applyConvergence(reviewers, valueFor(reviewers, [{ members: ['f0', 'f2'], primary: 'f0', reason: 'same TypeError' }]))

    // Primary (UX f0) keeps its anchor/body but takes the cluster's max severity (high from SRE).
    const merged = out[0].findings[0]
    expect(merged.path).toBe('src/a.ts')
    expect(merged.line).toBe(10)
    expect(merged.body).toBe('TypeError: naive vs aware datetime')
    expect(merged.severity).toBe('high')
    expect(merged.mergedReason).toBe('same TypeError')
    expect(merged.mergedFrom).toEqual([
      { reviewer: 'Resiliency & SRE', path: 'src/a.ts', line: 12, severity: 'high', body: 'comparing naive datetime raises TypeError' },
    ])
    // Absorbed finding removed from its own reviewer; unrelated finding untouched.
    expect(out[1].findings).toHaveLength(0)
    expect(out[0].findings).toHaveLength(2)
    expect(out[0].findings[1].body).toBe('button label truncates')
  })

  it('unions raisedBy and takes the strongest verification', () => {
    const reviewers = twoReviewers()
    reviewers[0].findings[0].raisedBy = ['DeepSeek']
    reviewers[0].findings[0].verification = verification(1, 3)
    reviewers[1].findings[0].raisedBy = ['GPT', 'DeepSeek']
    reviewers[1].findings[0].verification = verification(3, 3)

    const out = applyConvergence(reviewers, valueFor(reviewers, [{ members: ['f0', 'f2'], primary: 'f0', reason: '' }]))
    const merged = out[0].findings[0]
    expect(merged.raisedBy).toEqual(['DeepSeek', 'GPT'])
    expect(merged.verification).toEqual(verification(3, 3))
  })

  it('keeps the primary verification on ties and when others are absent', () => {
    const reviewers = twoReviewers()
    reviewers[0].findings[0].verification = verification(2, 3)
    const out = applyConvergence(reviewers, valueFor(reviewers, [{ members: ['f0', 'f2'], primary: 'f0', reason: '' }]))
    expect(out[0].findings[0].verification).toEqual(verification(2, 3))
  })

  it('marks draft-covered clusters coveredByDraft instead of deleting', () => {
    const reviewers = twoReviewers()
    const out = applyConvergence(reviewers, valueFor(reviewers, [
      { members: ['f0', 'f2'], primary: 'f0', reason: 'covered', coveredBy: { path: 'src/a.ts', line: 11 } },
    ]))
    // BOTH findings stay, each marked covered — nothing merged away.
    expect(out[0].findings).toHaveLength(2)
    expect(out[1].findings).toHaveLength(1)
    expect(out[0].findings[0].coveredByDraft).toEqual({ path: 'src/a.ts', line: 11 })
    expect(out[1].findings[0].coveredByDraft).toEqual({ path: 'src/a.ts', line: 11 })
    expect(out[0].findings[0].mergedFrom).toBeUndefined()
    expect(out[0].findings[1].coveredByDraft).toBeUndefined()
  })

  it('returns the input UNCHANGED on fingerprint mismatch (stale clusters never apply)', () => {
    const reviewers = twoReviewers()
    const out = applyConvergence(reviewers, { fingerprint: 'stale', clusters: [{ members: ['f0', 'f2'], primary: 'f0', reason: '' }] })
    expect(out).toBe(reviewers)
  })

  it('returns the input unchanged for an empty cluster list', () => {
    const reviewers = twoReviewers()
    expect(applyConvergence(reviewers, valueFor(reviewers, []))).toBe(reviewers)
  })

  it('never mutates the input reviewers or findings', () => {
    const reviewers = twoReviewers()
    const snapshot = JSON.parse(JSON.stringify(reviewers))
    applyConvergence(reviewers, valueFor(reviewers, [{ members: ['f0', 'f2'], primary: 'f0', reason: 'same' }]))
    expect(reviewers).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// mergedReviewerLabel
// ---------------------------------------------------------------------------

describe('mergedReviewerLabel', () => {
  it('joins primary + absorbed reviewers with " · ", deduped', () => {
    expect(mergedReviewerLabel('UX & Interaction', [{ reviewer: 'Resiliency & SRE' }])).toBe('UX & Interaction · Resiliency & SRE')
    expect(mergedReviewerLabel('UX', [{ reviewer: 'UX' }])).toBe('UX')
    expect(mergedReviewerLabel('UX', undefined)).toBe('UX')
  })

  it('falls back to "N reviewers" for >3 names or over-long labels', () => {
    expect(mergedReviewerLabel('A', [{ reviewer: 'B' }, { reviewer: 'C' }, { reviewer: 'D' }])).toBe('4 reviewers')
    expect(
      mergedReviewerLabel('A very long reviewer persona name', [{ reviewer: 'Another quite long reviewer persona' }]),
    ).toBe('2 reviewers')
  })
})

// ---------------------------------------------------------------------------
// applyConvergence — suggestedFix (solutions-required pass)
// ---------------------------------------------------------------------------

describe('applyConvergence — suggestedFix handling', () => {
  function valueFor(reviewers: ReviewerFindings[], clusters: ConvergenceValue['clusters']): ConvergenceValue {
    return { fingerprint: enumerateFindings(reviewers).fingerprint, clusters }
  }

  it("the primary's suggestedFix wins; the absorbed fix is preserved verbatim in mergedFrom", () => {
    const reviewers = twoReviewers()
    reviewers[0].findings[0].suggestedFix = 'Use timezone-aware datetimes everywhere.'
    reviewers[1].findings[0].suggestedFix = 'Convert both sides with `astimezone(utc)`.'

    const out = applyConvergence(reviewers, valueFor(reviewers, [{ members: ['f0', 'f2'], primary: 'f0', reason: '' }]))
    const merged = out[0].findings[0]
    expect(merged.suggestedFix).toBe('Use timezone-aware datetimes everywhere.')
    expect(merged.mergedFrom).toEqual([
      {
        reviewer: 'Resiliency & SRE',
        path: 'src/a.ts',
        line: 12,
        severity: 'high',
        body: 'comparing naive datetime raises TypeError',
        suggestedFix: 'Convert both sides with `astimezone(utc)`.',
      },
    ])
  })

  it("a primary WITHOUT a fix adopts the first member's fix (the merged card still shows one)", () => {
    const reviewers = twoReviewers()
    reviewers[1].findings[0].suggestedFix = 'Convert both sides with `astimezone(utc)`.'

    const out = applyConvergence(reviewers, valueFor(reviewers, [{ members: ['f0', 'f2'], primary: 'f0', reason: '' }]))
    expect(out[0].findings[0].suggestedFix).toBe('Convert both sides with `astimezone(utc)`.')
  })

  it('no member carries a fix → the merged finding carries none (absence-graceful)', () => {
    const reviewers = twoReviewers()
    const out = applyConvergence(reviewers, valueFor(reviewers, [{ members: ['f0', 'f2'], primary: 'f0', reason: '' }]))
    expect('suggestedFix' in out[0].findings[0]).toBe(false)
    expect(out[0].findings[0].mergedFrom![0]).not.toHaveProperty('suggestedFix')
  })

  it('a covered-by-draft cluster keeps each finding intact, fix included', () => {
    const reviewers = twoReviewers()
    reviewers[0].findings[0].suggestedFix = 'Use timezone-aware datetimes everywhere.'
    const value: ConvergenceValue = {
      fingerprint: enumerateFindings(reviewers).fingerprint,
      clusters: [{ members: ['f0'], primary: 'f0', reason: '', coveredBy: { path: 'src/a.ts', line: 10 } }],
    }
    const out = applyConvergence(reviewers, value)
    expect(out[0].findings[0].coveredByDraft).toEqual({ path: 'src/a.ts', line: 10 })
    expect(out[0].findings[0].suggestedFix).toBe('Use timezone-aware datetimes everywhere.')
  })
})
