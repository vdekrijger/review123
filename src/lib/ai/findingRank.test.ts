/**
 * findingRank — deterministic finding triage (inline vs collapsed tier).
 *
 * Tier rules under test:
 *   - high severity → always primary (even demoted; never spilled by budget)
 *   - majority-verified (confirmedBy/polled ≥ 0.5, surfaced) medium → primary
 *   - convergent (≥2 distinct reviewers) medium → primary
 *   - low → primary only with convergence AND non-negative verification
 *   - weak/failed verification (below majority / demoted) without convergence → secondary
 *   - verification never ran (polled=0 / absent) → severity is the signal (medium+ inline)
 *   - coveredByDraft → always secondary, regardless of strength
 *   - budget: at most INLINE_PRIMARY_BUDGET inline; spill weakest non-highs; never a high
 *   - determinism: stable orders, path/line tie-breaks
 */

import { describe, it, expect } from 'vitest'
import {
  rankFindings,
  findingTier,
  isMajorityVerified,
  isConvergent,
  convergedReviewerCount,
  rankWeight,
  getFindingsShowAll,
  setFindingsShowAll,
  INLINE_PRIMARY_BUDGET,
  type RankableFinding,
} from './findingRank'
import type { FindingVerification } from './schemas'

function verification(confirmedBy: number, polledModels: number, surfaced: boolean): FindingVerification {
  return { confirmedBy, polledModels, surfaced, perModel: [] }
}

function finding(over: Partial<RankableFinding> = {}): RankableFinding {
  return { path: 'src/a.ts', line: 10, severity: 'medium', ...over }
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

describe('isMajorityVerified — quorum math', () => {
  it('true at exactly half the polled models (2/4)', () => {
    expect(isMajorityVerified(verification(2, 4, true))).toBe(true)
  })

  it('true above half (3/4)', () => {
    expect(isMajorityVerified(verification(3, 4, true))).toBe(true)
  })

  it('false below half (1/3)', () => {
    expect(isMajorityVerified(verification(1, 3, true))).toBe(false)
  })

  it('false when demoted (surfaced=false), even with majority confirms — the engine decided', () => {
    expect(isMajorityVerified(verification(3, 4, false))).toBe(false)
  })

  it('false when verification never ran (absent or polled=0) — never divides by zero', () => {
    expect(isMajorityVerified(undefined)).toBe(false)
    expect(isMajorityVerified(verification(0, 0, true))).toBe(false)
  })
})

describe('convergence counting — distinct reviewers', () => {
  const absorbed = (reviewer: string) => ({ reviewer, path: 'src/a.ts', line: 11 as number | null, severity: 'medium' as const, body: 'sibling' })

  it('no mergedFrom → 1 reviewer, not convergent', () => {
    const f = finding()
    expect(convergedReviewerCount(f)).toBe(1)
    expect(isConvergent(f)).toBe(false)
  })

  it('one absorbed OTHER reviewer → 2 reviewers, convergent', () => {
    const f = finding({ reviewerName: 'Security', mergedFrom: [absorbed('Performance')] })
    expect(convergedReviewerCount(f)).toBe(2)
    expect(isConvergent(f)).toBe(true)
  })

  it('a same-reviewer merge (dedup, not agreement) is NOT convergent', () => {
    const f = finding({ reviewerName: 'Security', mergedFrom: [absorbed('Security')] })
    expect(convergedReviewerCount(f)).toBe(1)
    expect(isConvergent(f)).toBe(false)
  })

  it('duplicate absorbed reviewers count once', () => {
    const f = finding({ reviewerName: 'Security', mergedFrom: [absorbed('Perf'), absorbed('Perf')] })
    expect(convergedReviewerCount(f)).toBe(2)
  })

  it('without reviewerName, absorbed reviewers count as distinct (upper bound)', () => {
    const f = finding({ mergedFrom: [absorbed('Perf')] })
    expect(convergedReviewerCount(f)).toBe(2)
    expect(isConvergent(f)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tier rules
// ---------------------------------------------------------------------------

describe('findingTier — high severity', () => {
  it('high is always primary — unverified', () => {
    expect(findingTier(finding({ severity: 'high' }))).toBe('primary')
  })

  it('high is primary even when DEMOTED by verification (never hide a high)', () => {
    expect(findingTier(finding({ severity: 'high', verification: verification(1, 4, false) }))).toBe('primary')
  })
})

describe('findingTier — medium severity', () => {
  it('majority-verified medium → primary', () => {
    expect(findingTier(finding({ verification: verification(2, 3, true) }))).toBe('primary')
  })

  it('convergent medium → primary even with weak verification', () => {
    const f = finding({
      reviewerName: 'Security',
      mergedFrom: [{ reviewer: 'Perf', path: 'src/a.ts', line: 11, severity: 'medium', body: 's' }],
      verification: verification(1, 3, true),
    })
    expect(findingTier(f)).toBe('primary')
  })

  it('unverified medium (verification never ran) → primary — single-model setups are not punished', () => {
    expect(findingTier(finding())).toBe('primary')
    expect(findingTier(finding({ verification: verification(0, 0, true) }))).toBe('primary')
  })

  it('below-majority (weak) verified medium without convergence → secondary', () => {
    // 1 confirm of 3 polled, surfaced by the vote threshold but no real majority.
    expect(findingTier(finding({ verification: verification(1, 3, true) }))).toBe('secondary')
  })

  it('DEMOTED medium (surfaced=false) → secondary', () => {
    expect(findingTier(finding({ verification: verification(1, 3, false) }))).toBe('secondary')
  })
})

describe('findingTier — low severity', () => {
  const converged = {
    reviewerName: 'Security',
    mergedFrom: [{ reviewer: 'Perf', path: 'src/a.ts', line: 11 as number | null, severity: 'low' as const, body: 's' }],
  }

  it('lone low (no convergence, no verification) → secondary', () => {
    expect(findingTier(finding({ severity: 'low' }))).toBe('secondary')
  })

  it('majority-verified low WITHOUT convergence → secondary (low needs something else)', () => {
    expect(findingTier(finding({ severity: 'low', verification: verification(3, 3, true) }))).toBe('secondary')
  })

  it('convergent low with majority verification → primary', () => {
    expect(findingTier(finding({ severity: 'low', verification: verification(2, 3, true), ...converged }))).toBe('primary')
  })

  it('convergent low, verification never ran → primary (two reviewers agreed, no verifier dissented)', () => {
    expect(findingTier(finding({ severity: 'low', ...converged }))).toBe('primary')
  })

  it('convergent low the verifiers DEMOTED → secondary', () => {
    expect(findingTier(finding({ severity: 'low', verification: verification(1, 4, false), ...converged }))).toBe('secondary')
  })
})

describe('findingTier — coveredByDraft is always secondary', () => {
  const covered = { coveredByDraft: { path: 'src/a.ts', line: 9 } }

  it('covered high → secondary (the user already made the point)', () => {
    expect(findingTier(finding({ severity: 'high', ...covered }))).toBe('secondary')
  })

  it('covered majority-verified medium → secondary', () => {
    expect(findingTier(finding({ verification: verification(3, 3, true), ...covered }))).toBe('secondary')
  })

  it('covered convergent finding → secondary', () => {
    const f = finding({
      reviewerName: 'Security',
      mergedFrom: [{ reviewer: 'Perf', path: 'src/a.ts', line: 11, severity: 'medium', body: 's' }],
      ...covered,
    })
    expect(findingTier(f)).toBe('secondary')
  })
})

// ---------------------------------------------------------------------------
// rankFindings — tiers, budget, determinism
// ---------------------------------------------------------------------------

describe('rankFindings — tier split', () => {
  it('splits a mixed set into the documented tiers', () => {
    const high = finding({ severity: 'high', path: 'src/a.ts', line: 1 })
    const verifiedMedium = finding({ path: 'src/a.ts', line: 2, verification: verification(3, 3, true) })
    const weakLow = finding({ severity: 'low', path: 'src/a.ts', line: 3, verification: verification(1, 3, false) })
    const covered = finding({ path: 'src/b.ts', line: 4, coveredByDraft: { path: 'src/b.ts', line: 4 } })
    const { primary, secondary } = rankFindings([high, verifiedMedium, weakLow, covered])
    expect(primary).toContain(high)
    expect(primary).toContain(verifiedMedium)
    expect(secondary).toContain(weakLow)
    expect(secondary).toContain(covered)
    expect(primary.length + secondary.length).toBe(4)
  })

  it('preserves the input objects (generic pass-through, no copies)', () => {
    const withExtra = { ...finding({ severity: 'high' }), key: 'k-1', body: 'text' }
    const { primary } = rankFindings([withExtra])
    expect(primary[0]).toBe(withExtra)
    expect((primary[0] as typeof withExtra).key).toBe('k-1')
  })

  it('empty input → empty tiers', () => {
    expect(rankFindings([])).toEqual({ primary: [], secondary: [] })
  })
})

describe('rankFindings — inline budget', () => {
  it('spills the weakest non-high primaries past the budget', () => {
    // 2 highs + 9 unverified mediums = 11 primaries by rule; budget 8 keeps the
    // 2 highs + 6 mediums, spilling 3 mediums.
    const highs = [1, 2].map((n) => finding({ severity: 'high', path: 'src/h.ts', line: n }))
    const mediums = Array.from({ length: 9 }, (_, i) => finding({ path: 'src/m.ts', line: i + 1 }))
    const { primary, secondary } = rankFindings([...highs, ...mediums])
    expect(primary.length).toBe(INLINE_PRIMARY_BUDGET)
    expect(primary.filter((f) => f.severity === 'high').length).toBe(2)
    expect(secondary.length).toBe(3)
    expect(secondary.every((f) => f.severity === 'medium')).toBe(true)
  })

  it('never spills a high — more highs than the budget ALL stay inline', () => {
    const highs = Array.from({ length: INLINE_PRIMARY_BUDGET + 3 }, (_, i) =>
      finding({ severity: 'high', path: 'src/h.ts', line: i + 1 }),
    )
    const { primary, secondary } = rankFindings(highs)
    expect(primary.length).toBe(INLINE_PRIMARY_BUDGET + 3)
    expect(secondary.length).toBe(0)
  })

  it('highs consume the budget first: with 8 highs, every qualifying medium spills', () => {
    const highs = Array.from({ length: INLINE_PRIMARY_BUDGET }, (_, i) =>
      finding({ severity: 'high', path: 'src/h.ts', line: i + 1 }),
    )
    const mediums = [finding({ path: 'src/m.ts', line: 1 }), finding({ path: 'src/m.ts', line: 2 })]
    const { primary, secondary } = rankFindings([...highs, ...mediums])
    expect(primary.length).toBe(INLINE_PRIMARY_BUDGET)
    expect(primary.every((f) => f.severity === 'high')).toBe(true)
    expect(secondary.length).toBe(2)
  })

  it('spill keeps the STRONGEST non-highs inline (majority-verified beats weak-unverified-low bonus)', () => {
    // 7 highs leave ONE slot. Two candidates: a majority-verified medium and a
    // plain unverified medium — the verified one (higher findingWeight) keeps it.
    const highs = Array.from({ length: INLINE_PRIMARY_BUDGET - 1 }, (_, i) =>
      finding({ severity: 'high', path: 'src/h.ts', line: i + 1 }),
    )
    const verified = finding({ path: 'src/m.ts', line: 1, verification: verification(3, 3, true) })
    const plain = finding({ path: 'src/m.ts', line: 2 })
    const { primary, secondary } = rankFindings([...highs, plain, verified])
    expect(primary).toContain(verified)
    expect(secondary).toContain(plain)
  })
})

describe('rankFindings — determinism and tie-breaks', () => {
  it('identical inputs in any order produce the same tier memberships', () => {
    const a = finding({ path: 'src/a.ts', line: 5 })
    const b = finding({ path: 'src/b.ts', line: 3 })
    const c = finding({ severity: 'high', path: 'src/c.ts', line: 1 })
    const first = rankFindings([a, b, c])
    const second = rankFindings([c, b, a])
    expect(new Set(first.primary)).toEqual(new Set(second.primary))
    expect(new Set(first.secondary)).toEqual(new Set(second.secondary))
  })

  it('equal-weight primaries order by path then line', () => {
    const p2 = finding({ path: 'src/b.ts', line: 2 })
    const p1 = finding({ path: 'src/a.ts', line: 9 })
    const p3 = finding({ path: 'src/b.ts', line: 7 })
    const { primary } = rankFindings([p3, p2, p1])
    expect(primary).toEqual([p1, p2, p3])
  })

  it('secondary lists in file/line reading order; null line sorts last within a file', () => {
    const l5 = finding({ severity: 'low', path: 'src/a.ts', line: 5 })
    const lNull = finding({ severity: 'low', path: 'src/a.ts', line: null })
    const l2 = finding({ severity: 'low', path: 'src/a.ts', line: 2 })
    const other = finding({ severity: 'low', path: 'src/b.ts', line: 1 })
    const { secondary } = rankFindings([other, lNull, l5, l2])
    expect(secondary).toEqual([l2, l5, lNull, other])
  })

  it('budget spill is deterministic under input reordering', () => {
    const mediums = Array.from({ length: 12 }, (_, i) => finding({ path: 'src/m.ts', line: i + 1 }))
    const shuffled = [...mediums].reverse()
    const first = rankFindings(mediums)
    const second = rankFindings(shuffled)
    expect(first.primary.map((f) => f.line)).toEqual(second.primary.map((f) => f.line))
    expect(first.secondary.map((f) => f.line)).toEqual(second.secondary.map((f) => f.line))
  })
})

describe('rankWeight — consistent with findingWeight philosophy', () => {
  it('a demoted finding weighs far less than an unverified one of the same severity', () => {
    expect(rankWeight(finding({ verification: verification(1, 3, false) }))).toBeLessThan(rankWeight(finding()))
  })

  it('a majority-verified finding weighs more than an unverified one', () => {
    expect(rankWeight(finding({ verification: verification(3, 3, true) }))).toBeGreaterThan(rankWeight(finding()))
  })

  it('convergence adds a bounded bonus', () => {
    const base = finding()
    const converged = finding({
      reviewerName: 'A',
      mergedFrom: [{ reviewer: 'B', path: 'p', line: 1, severity: 'medium', body: 's' }],
    })
    expect(rankWeight(converged)).toBeCloseTo(rankWeight(base) + 0.5)
    const many = finding({
      reviewerName: 'A',
      mergedFrom: ['B', 'C', 'D', 'E', 'F'].map((r) => ({ reviewer: r, path: 'p', line: 1, severity: 'medium' as const, body: 's' })),
    })
    expect(rankWeight(many)).toBeCloseTo(rankWeight(base) + 1.5) // capped
  })
})

// ---------------------------------------------------------------------------
// Show-all persistence
// ---------------------------------------------------------------------------

describe('findings show-all persistence', () => {
  it('defaults to false, persists true, and round-trips', () => {
    localStorage.removeItem('review123:findings-show-all')
    expect(getFindingsShowAll()).toBe(false)
    setFindingsShowAll(true)
    expect(getFindingsShowAll()).toBe(true)
    setFindingsShowAll(false)
    expect(getFindingsShowAll()).toBe(false)
  })

  it('garbage in storage reads as false', () => {
    localStorage.setItem('review123:findings-show-all', 'not json {')
    expect(getFindingsShowAll()).toBe(false)
    localStorage.setItem('review123:findings-show-all', JSON.stringify(['showAll']))
    expect(getFindingsShowAll()).toBe(false)
    localStorage.removeItem('review123:findings-show-all')
  })
})
