import { describe, it, expect } from 'vitest'
import type { PrFile } from '../github/types'
import type { ChangeImpact } from '../diagram/types'
import type { CiSummary } from '../github/checks'
import { computePrRisk, computeFileRisk, findingWeight, type RiskFinding } from './risk'
import type { RiskJudgeResult } from '../ai/schemas'

function file(overrides: Partial<PrFile> & { filename: string }): PrFile {
  return { status: 'modified', additions: 0, deletions: 0, ...overrides }
}

function factor(risk: ReturnType<typeof computePrRisk>, id: string) {
  const f = risk.factors.find((f) => f.id === id)
  if (!f) throw new Error(`missing factor ${id}`)
  return f
}

const smallFiles: PrFile[] = [
  file({ filename: 'src/a.ts', additions: 10, deletions: 5 }),
  file({ filename: 'src/a.test.ts', additions: 8, deletions: 0 }),
]

const verified = (confirmedBy: number, polledModels: number, surfaced = true) => ({
  confirmedBy,
  polledModels,
  surfaced,
  perModel: [],
})

// ---------------------------------------------------------------------------
// Factor: size & spread
// ---------------------------------------------------------------------------

describe('size & spread factor', () => {
  it('scores 0 for a tiny PR', () => {
    const f = factor(computePrRisk({ files: smallFiles }), 'size-spread')
    expect(f.score).toBe(0)
    expect(f.detail).toContain('2 files')
  })

  it('scores by total churn thresholds', () => {
    const churn = (n: number) => factor(computePrRisk({ files: [file({ filename: 'a.ts', additions: n })] }), 'size-spread').score
    expect(churn(99)).toBe(0)
    expect(churn(100)).toBe(1)
    expect(churn(400)).toBe(2)
    expect(churn(1000)).toBe(3)
  })

  it('bumps the score for wide spread (many files/directories)', () => {
    const many = Array.from({ length: 20 }, (_, i) => file({ filename: `src/mod${i}/f.ts`, additions: 10 }))
    const f = factor(computePrRisk({ files: many }), 'size-spread')
    expect(f.score).toBe(2) // churn 200 → 1, +1 spread
  })
})

// ---------------------------------------------------------------------------
// Factor: blast radius
// ---------------------------------------------------------------------------

describe('blast radius factor', () => {
  const impact = (callers: number, callees = 0): ChangeImpact => ({
    changed: [{ symbol: 'f', kind: 'changed' }],
    callers: Array.from({ length: callers }, (_, i) => ({ symbol: `c${i}` })),
    callees: Array.from({ length: callees }, (_, i) => ({ symbol: `d${i}` })),
  })

  it('scores by upstream caller count', () => {
    const score = (c: number) => factor(computePrRisk({ files: smallFiles, impact: impact(c) }), 'blast-radius').score
    expect(score(0)).toBe(0)
    expect(score(2)).toBe(1)
    expect(score(5)).toBe(2)
    expect(score(9)).toBe(3)
  })

  it('a large callee count bumps the score by one', () => {
    const f = factor(computePrRisk({ files: smallFiles, impact: impact(2, 9) }), 'blast-radius')
    expect(f.score).toBe(2)
  })

  it('missing impact while pending → factor pending, not zero-risk', () => {
    const f = factor(computePrRisk({ files: smallFiles, impactPending: true }), 'blast-radius')
    expect(f.pending).toBe(true)
    expect(f.unavailable).toBeUndefined()
  })

  it('missing impact when settled → factor unavailable (unknown, not zero)', () => {
    const f = factor(computePrRisk({ files: smallFiles }), 'blast-radius')
    expect(f.unavailable).toBe(true)
    expect(f.detail).toMatch(/not zero/i)
  })
})

// ---------------------------------------------------------------------------
// Factor: verified findings
// ---------------------------------------------------------------------------

describe('verified findings factor', () => {
  it('a high-severity finding confirmed by most polled models dominates (score 3)', () => {
    const findings: RiskFinding[] = [{ severity: 'high', verification: verified(3, 4) }]
    const risk = computePrRisk({ files: smallFiles, findings })
    expect(factor(risk, 'verified-findings').score).toBe(3)
    expect(risk.level).toBe('high')
  })

  it('an unverified high-severity finding scores 2, not 3', () => {
    const findings: RiskFinding[] = [{ severity: 'high' }]
    expect(factor(computePrRisk({ files: smallFiles, findings }), 'verified-findings').score).toBe(2)
  })

  it('a demoted finding (surfaced: false) counts much less', () => {
    const demoted: RiskFinding = { severity: 'high', verification: verified(1, 4, false) }
    expect(findingWeight(demoted)).toBeLessThan(1)
    expect(factor(computePrRisk({ files: smallFiles, findings: [demoted] }), 'verified-findings').score).toBe(1)
  })

  it('a single low-severity finding scores 1', () => {
    expect(factor(computePrRisk({ files: smallFiles, findings: [{ severity: 'low' }] }), 'verified-findings').score).toBe(1)
  })

  it('no findings while reviewers run → pending', () => {
    const f = factor(computePrRisk({ files: smallFiles, findingsPending: true }), 'verified-findings')
    expect(f.pending).toBe(true)
  })

  it('no findings once reviewers settle → score 0, not pending', () => {
    const f = factor(computePrRisk({ files: smallFiles, findings: [] }), 'verified-findings')
    expect(f.score).toBe(0)
    expect(f.pending).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Factor: CI & verdict signals
// ---------------------------------------------------------------------------

describe('signals factor', () => {
  const ciFail: CiSummary = { total: 3, passed: 2, failed: 1, pending: 0, failures: [{ name: 'build', annotations: [] }] }
  const ciPass: CiSummary = { total: 3, passed: 3, failed: 0, pending: 0, failures: [] }

  it('failing CI scores 2 and names the count', () => {
    const f = factor(computePrRisk({ files: smallFiles, ci: ciFail }), 'signals')
    expect(f.score).toBe(2)
    expect(f.detail).toContain('1 CI check failing')
  })

  it('verdict significant-changes scores 2; combined with failing CI caps at 3', () => {
    const f = factor(computePrRisk({ files: smallFiles, ci: ciFail, verdictLevel: 'significant-changes' }), 'signals')
    expect(f.score).toBe(3)
  })

  it('green CI + behavior-preserved verdict scores 0', () => {
    const f = factor(computePrRisk({ files: smallFiles, ci: ciPass, verdictLevel: 'behavior-preserved' }), 'signals')
    expect(f.score).toBe(0)
    expect(f.detail).toContain('CI green')
  })

  it('verdict still loading → factor pending', () => {
    const f = factor(computePrRisk({ files: smallFiles, verdictPending: true }), 'signals')
    expect(f.pending).toBe(true)
  })

  it('high-attention hotspots contribute: 1 hotspot → +1, 3+ → +2', () => {
    const attention = (high: number) => ({
      readingOrder: [],
      hotspots: Array.from({ length: high }, (_, i) => ({ path: `f${i}.ts`, reason: 'r', level: 'high' as const })),
      testFlags: [],
    })
    expect(factor(computePrRisk({ files: smallFiles, attention: attention(1) }), 'signals').score).toBe(1)
    expect(factor(computePrRisk({ files: smallFiles, attention: attention(3) }), 'signals').score).toBe(2)
  })

  it('medium/low hotspots alone do not move the signals score', () => {
    const attention = {
      readingOrder: [],
      hotspots: [
        { path: 'a.ts', reason: 'r', level: 'medium' as const },
        { path: 'b.ts', reason: 'r', level: 'low' as const },
      ],
      testFlags: [],
    }
    expect(factor(computePrRisk({ files: smallFiles, attention }), 'signals').score).toBe(0)
  })

  it('attention still loading → factor pending', () => {
    const f = factor(computePrRisk({ files: smallFiles, attentionPending: true }), 'signals')
    expect(f.pending).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Factor: AI-pattern heuristics (wired through)
// ---------------------------------------------------------------------------

describe('AI-pattern factor', () => {
  it('scores 0 with no flags on a benign PR', () => {
    const risk = computePrRisk({ files: smallFiles })
    expect(factor(risk, 'ai-patterns').score).toBe(0)
    expect(risk.heuristics).toHaveLength(0)
  })

  it('carries heuristic flags and scores by their count', () => {
    const files = [
      file({ filename: 'package.json', patch: '@@ -1 +1 @@\n+    "leftpad": "^1.3.0",' }),
      file({ filename: 'src/auth/login.ts', additions: 10 }),
    ]
    const risk = computePrRisk({ files })
    expect(risk.heuristics.map((h) => h.id)).toEqual(
      expect.arrayContaining(['new-dependency', 'sensitive-path']),
    )
    expect(factor(risk, 'ai-patterns').score).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Factor: AI judgment (LLM risk judge)
// ---------------------------------------------------------------------------

describe('AI judgment factor (LLM risk judge)', () => {
  const judge = (score: number, rationale = 'Subtle async ordering in the cleanup path.'): RiskJudgeResult => ({
    score,
    rationale,
    snippets: [],
  })

  it('is unavailable (not zero-risk) when no judgment exists', () => {
    const f = factor(computePrRisk({ files: smallFiles }), 'ai-judge')
    expect(f.unavailable).toBe(true)
    expect(f.pending).toBeUndefined()
    expect(f.detail).toMatch(/unknown, not zero/i)
    expect(f.label).toBe('AI judgment')
  })

  it('is pending while the judge task runs', () => {
    const f = factor(computePrRisk({ files: smallFiles, riskJudgePending: true }), 'ai-judge')
    expect(f.pending).toBe(true)
    expect(f.unavailable).toBeUndefined()
    expect(f.detail).toMatch(/still running/i)
  })

  it('carries the judge score with the rationale as the detail when present', () => {
    const f = factor(
      computePrRisk({ files: smallFiles, riskJudge: judge(2, 'Concurrency-sensitive change.') }),
      'ai-judge',
    )
    expect(f.score).toBe(2)
    expect(f.detail).toBe('Concurrency-sensitive change.')
    expect(f.pending).toBeUndefined()
    expect(f.unavailable).toBeUndefined()
  })

  it('defensively clamps an out-of-range judge score into 0-3', () => {
    expect(factor(computePrRisk({ files: smallFiles, riskJudge: judge(9) }), 'ai-judge').score).toBe(3)
    expect(factor(computePrRisk({ files: smallFiles, riskJudge: judge(-1) }), 'ai-judge').score).toBe(0)
  })

  it('a maximal judge score alone drives the overall level to high', () => {
    const risk = computePrRisk({ files: smallFiles, riskJudge: judge(3) })
    expect(risk.level).toBe('high')
  })

  it('a judge score of 2 alone drives the overall level to medium', () => {
    const risk = computePrRisk({ files: smallFiles, riskJudge: judge(2) })
    expect(risk.level).toBe('medium')
  })

  it('pending judge is excluded from the level (deterministic score never blocks on it)', () => {
    const risk = computePrRisk({ files: smallFiles, riskJudgePending: true })
    expect(risk.level).toBe('low')
    expect(risk.pending).toBe(true)
  })

  it('unavailable judge (failed task) is excluded from the level and not pending', () => {
    const risk = computePrRisk({ files: smallFiles })
    expect(risk.level).toBe('low')
    expect(risk.pending).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Overall level + graceful degradation
// ---------------------------------------------------------------------------

describe('computePrRisk overall level', () => {
  it('is low for a tiny benign PR with no other inputs', () => {
    const risk = computePrRisk({ files: smallFiles })
    expect(risk.level).toBe('low')
  })

  it('any factor at 3 → high', () => {
    const big = [file({ filename: 'src/huge.ts', additions: 1200, deletions: 300 })]
    // untested-bulk fires too, but size alone is already 3
    expect(computePrRisk({ files: big }).level).toBe('high')
  })

  it('a single medium factor → medium', () => {
    const files = [
      file({ filename: 'src/mid.ts', additions: 300, deletions: 150 }),
      file({ filename: 'src/mid.test.ts', additions: 20 }),
    ]
    const risk = computePrRisk({ files })
    expect(factor(risk, 'size-spread').score).toBe(2)
    expect(risk.level).toBe('medium')
  })

  it('pending factors are excluded from the level and set the pending flag', () => {
    const risk = computePrRisk({
      files: smallFiles,
      impactPending: true,
      findingsPending: true,
      verdictPending: true,
    })
    expect(risk.pending).toBe(true)
    expect(risk.level).toBe('low') // computed from what's available
  })

  it('score refines as async data lands (reactive contract)', () => {
    const before = computePrRisk({ files: smallFiles, findingsPending: true })
    const after = computePrRisk({
      files: smallFiles,
      findings: [{ severity: 'high', verification: verified(4, 4) }],
    })
    expect(before.level).toBe('low')
    expect(after.level).toBe('high')
    expect(before.pending).toBe(true)
    expect(after.pending).toBe(false)
  })

  it('always returns all six named factors', () => {
    const risk = computePrRisk({ files: smallFiles })
    expect(risk.factors.map((f) => f.id)).toEqual([
      'size-spread',
      'blast-radius',
      'verified-findings',
      'signals',
      'ai-patterns',
      'ai-judge',
    ])
    for (const f of risk.factors) {
      expect(f.label).toBeTruthy()
      expect(f.detail).toBeTruthy()
      expect(f.score).toBeGreaterThanOrEqual(0)
      expect(f.score).toBeLessThanOrEqual(3)
    }
  })
})

// ---------------------------------------------------------------------------
// computeFileRisk
// ---------------------------------------------------------------------------

describe('computeFileRisk', () => {
  it('small modified file with no signals → low', () => {
    expect(computeFileRisk({ file: file({ filename: 'src/a.ts', additions: 20, deletions: 5 }) })).toBe('low')
  })

  it('a high hotspot alone → high', () => {
    expect(
      computeFileRisk({ file: file({ filename: 'src/a.ts', additions: 5 }), hotspotLevel: 'high' }),
    ).toBe('high')
  })

  it('a medium hotspot alone → medium', () => {
    expect(
      computeFileRisk({ file: file({ filename: 'src/a.ts', additions: 5 }), hotspotLevel: 'medium' }),
    ).toBe('medium')
  })

  it('a confirmed high-severity finding alone → high', () => {
    expect(
      computeFileRisk({
        file: file({ filename: 'src/a.ts', additions: 5 }),
        findings: [{ severity: 'high', verification: verified(4, 4) }],
      }),
    ).toBe('high')
  })

  it('a demoted finding does not raise a small file above low', () => {
    expect(
      computeFileRisk({
        file: file({ filename: 'src/a.ts', additions: 5 }),
        findings: [{ severity: 'high', verification: verified(1, 4, false) }],
      }),
    ).toBe('low')
  })

  it('churn thresholds: 100 → medium only with another signal; 300+added → medium', () => {
    expect(computeFileRisk({ file: file({ filename: 'src/a.ts', additions: 120 }) })).toBe('low')
    expect(computeFileRisk({ file: file({ filename: 'src/a.ts', additions: 320, status: 'added' }) })).toBe('medium')
  })

  it('added files weigh more than removed files at the same churn', () => {
    const added = computeFileRisk({
      file: file({ filename: 'src/auth/new.ts', additions: 150, status: 'added' }),
    })
    const removed = computeFileRisk({
      file: file({ filename: 'src/auth/old.ts', deletions: 150, status: 'removed' }),
    })
    expect(added).toBe('medium') // churn 1 + added 1 + sensitive 1 = 3
    expect(removed).toBe('low') // churn 1 − removed 1 + sensitive 1 = 1
  })

  it('security-sensitive path contributes one point', () => {
    const sensitive = computeFileRisk({ file: file({ filename: 'src/auth/session.ts', additions: 120 }) })
    const plain = computeFileRisk({ file: file({ filename: 'src/ui/session-view.ts', additions: 120 }) })
    expect(sensitive).toBe('medium')
    expect(plain).toBe('low')
  })

  it('degrades gracefully with no hotspot/finding inputs (only diff stats)', () => {
    expect(computeFileRisk({ file: file({ filename: 'src/big.ts', additions: 400, deletions: 100 }) })).toBe('medium')
  })
})
