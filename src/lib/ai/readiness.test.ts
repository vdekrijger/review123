/**
 * readiness — the computed readiness basis (src/lib/ai/readiness.ts).
 *
 * What this pins:
 *   - the RICH case (eleven reviewers, a panel that can vote, green tests, the
 *     whole diff, a local checkout, a human sign-off) reaches the top band;
 *   - the POOR case (one model, no verifier, no test run, half the diff in the
 *     tail, no sign-off) lands in the bottom band AND SAYS WHY — every weakness
 *     appears as a named shortfall and a named "did not check" line, not just as
 *     a lower number;
 *   - the DEGENERATE single-verifier panel (crossVerify's `V <= R` zone) never
 *     counts as corroboration;
 *   - silence from a panel that never ran is never scored as a clean bill;
 *   - a pass where nothing executed the code cannot reach the top band;
 *   - REPRODUCIBILITY: same facts, same report, byte for byte, every time.
 */

import { describe, it, expect } from 'vitest'
import {
  collectReadinessFacts,
  gradeReadiness,
  bandFor,
  notCheckedLines,
  READINESS_BAND_LABEL,
  READINESS_CHECK_IDS,
  READINESS_CHECK_WEIGHT,
  READINESS_DISCLAIMER,
  READINESS_MAX_SCORE,
  CHECK_MAX_POINTS,
  NOT_CHECKED_NAME_LIMIT,
  type ReadinessCheckId,
  type ReadinessFacts,
  type ReadinessReport,
  type ReviewerOutcome,
} from './readiness'
import type { FindingVerification } from './schemas'
import type { RankableFinding } from './findingRank'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ELEVEN = [
  'Correctness',
  'Resiliency & SRE',
  'Security',
  'Performance',
  'API design',
  'Data & migrations',
  'Observability',
  'Accessibility',
  'Test quality',
  'Docs & naming',
  'Dependencies',
]

/** A verification poll: `verifiers` verifiers against ONE raiser, all confirming. */
function poll(verifiers: number, confirms = verifiers): FindingVerification {
  return {
    confirmedBy: 1 + confirms,
    polledModels: 1 + verifiers,
    surfaced: true,
    worthFlagging: true,
    perModel: [
      { provider: 'anthropic', verdict: 'confirm', reason: '', raised: true },
      ...Array.from({ length: verifiers }, (_, i) => ({
        provider: `verifier-${i}`,
        verdict: (i < confirms ? 'confirm' : 'refute') as 'confirm' | 'refute',
        reason: '',
        worth: true,
      })),
    ],
  }
}

function finding(over: Partial<RankableFinding> = {}): RankableFinding {
  return { path: 'src/a.ts', line: 10, severity: 'medium', ...over }
}

function reviewer(name: string, findings: RankableFinding[] = []): ReviewerOutcome {
  return { name, done: true, errored: false, findings }
}

/** The rich case: everything this app can check, checked. */
function richFacts(): ReadinessFacts {
  return collectReadinessFacts({
    reviewers: ELEVEN.map((n) => reviewer(n)),
    configuredReviewerNames: ELEVEN,
    configuredVerifiers: 2,
    changedFilePaths: ['src/a.ts', 'src/b.ts', 'src/a.test.ts', 'src/c.ts'],
    filesNotSent: [],
    grounding: {
      local: true,
      dirty: false,
      description: 'Reading code from your local checkout — no rate limit, and the whole repo rather than just the diff.',
    },
    approval: { approved: true, stale: false, phase: 'tests', approvedAtSha: 'abcdef1234567' },
    tests: { status: 'passed', command: 'pnpm test' },
  })
}

/** The poor case: one model, no verifier, no tests, half the diff never sent. */
function poorFacts(): ReadinessFacts {
  return collectReadinessFacts({
    reviewers: [
      reviewer('Correctness', [
        finding({ severity: 'high', line: 4 }),
        finding({ severity: 'medium', line: 9, path: 'src/b.ts' }),
      ]),
    ],
    configuredReviewerNames: ELEVEN,
    configuredVerifiers: 0,
    changedFilePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
    filesNotSent: ['src/c.ts', 'src/d.ts'],
    grounding: {
      local: false,
      dirty: false,
      description: 'Reading code from GitHub. Pair a local bridge to read your own checkout instead.',
    },
    approval: { approved: false, stale: false, phase: 'implementation' },
    tests: { status: 'not-run' },
  })
}

function checkOf(report: ReadinessReport, id: ReadinessCheckId) {
  const hit = report.checks.find((c) => c.id === id)
  if (!hit) throw new Error(`no check ${id}`)
  return hit
}

// ---------------------------------------------------------------------------
// The scale itself
// ---------------------------------------------------------------------------

describe('the scale', () => {
  it('every check is weighted and the maximum is the sum of those weights', () => {
    const expected = READINESS_CHECK_IDS.reduce(
      (sum, id) => sum + READINESS_CHECK_WEIGHT[id] * CHECK_MAX_POINTS,
      0,
    )
    expect(READINESS_MAX_SCORE).toBe(expected)
    expect(READINESS_CHECK_IDS.length).toBe(7)
  })

  it('the executed-code check outweighs every opinion-derived one', () => {
    // The whole point of the weights: a pass where nothing ran the code must
    // not be able to out-score one where something did, on model output alone.
    expect(READINESS_CHECK_WEIGHT.tests).toBeGreaterThan(READINESS_CHECK_WEIGHT.reviewers)
    expect(READINESS_CHECK_WEIGHT.tests).toBeGreaterThan(READINESS_CHECK_WEIGHT.findings)
    expect(READINESS_CHECK_WEIGHT.tests).toBeGreaterThan(READINESS_CHECK_WEIGHT.verification)
  })

  it('bandFor is decided on the exact ratio, never on a rounded percentage', () => {
    expect(bandFor(0, 28)).toBe('none')
    expect(bandFor(1, 28)).toBe('minimal')
    expect(bandFor(10, 28)).toBe('thin')
    expect(bandFor(17, 28)).toBe('partial')
    expect(bandFor(23, 28)).toBe('broad')
    // 22/28 rounds to 79%, which is below the 80% floor — and 79 is exactly the
    // kind of boundary a float comparison gets wrong.
    expect(bandFor(22, 28)).toBe('partial')
  })

  it('a zero score is "not checked", never "barely checked"', () => {
    expect(bandFor(0, READINESS_MAX_SCORE)).toBe('none')
    expect(READINESS_BAND_LABEL.none).toBe('Not checked')
  })
})

// ---------------------------------------------------------------------------
// Rich vs poor
// ---------------------------------------------------------------------------

describe('a richly checked review', () => {
  const report = gradeReadiness(richFacts())

  it('reaches the top band with a full score', () => {
    expect(report.band).toBe('broad')
    expect(report.label).toBe('Broadly checked')
    expect(report.score).toBe(READINESS_MAX_SCORE)
    expect(report.percent).toBe(100)
  })

  it('has no shortfall to report', () => {
    expect(report.checks.filter((c) => c.shortfall)).toEqual([])
    expect(report.headline).toBe('Broadly checked — every check this app can make came back positive.')
  })

  it('still names nothing it did not check only because there is nothing to name', () => {
    // The disclaimer is unconditional; only the CASE-SPECIFIC list empties out.
    expect(report.notChecked).toEqual([])
    expect(READINESS_DISCLAIMER).toContain('only ever saw a diff')
  })

  it('counts the reviewers as eleven of eleven', () => {
    expect(checkOf(report, 'reviewers').detail).toContain('11 of 11 configured reviewers')
  })
})

describe('a poorly checked review', () => {
  const report = gradeReadiness(poorFacts())
  const rich = gradeReadiness(richFacts())

  it('lands in the bottom band, far below the rich case', () => {
    expect(report.band).toBe('minimal')
    expect(report.label).toBe('Barely checked')
    expect(report.score).toBeLessThan(rich.score)
  })

  it('SAYS WHY rather than only scoring lower — the headline names the weakest links', () => {
    expect(report.headline).toMatch(/^Barely checked — /)
    expect(report.headline).toContain('nothing could disagree with the model that looked')
    expect(report.headline).toContain('high-severity finding is still standing')
  })

  it('names each weak input as its own shortfall', () => {
    const shortfalls = report.checks.filter((c) => c.shortfall).map((c) => c.id)
    expect(shortfalls).toContain('reviewers')
    expect(shortfalls).toContain('verification')
    expect(shortfalls).toContain('findings')
    expect(shortfalls).toContain('tests')
    expect(shortfalls).toContain('coverage')
    expect(shortfalls).toContain('grounding')
    expect(shortfalls).toContain('approval')
  })

  it('names the ten reviewers that never ran', () => {
    const line = report.notChecked.find((l) => l.includes('did not run'))
    expect(line).toBeDefined()
    expect(line).toContain('10 configured reviewers did not run')
    expect(line).toContain('Resiliency & SRE')
  })

  it('says the single model checked its own work', () => {
    expect(report.notChecked).toContain(
      'Only one model looked, and it checked its own work. A single-model panel’s agreement is not agreement.',
    )
  })

  it('says no passing test run is recorded', () => {
    expect(checkOf(report, 'tests').detail).toBe(
      'No test run is recorded for this change. Nothing here executed the code.',
    )
    expect(report.notChecked.some((l) => l.includes('nothing here observed the code actually working'))).toBe(true)
  })

  it('names the files nobody was given', () => {
    const line = report.notChecked.find((l) => l.includes('never put in front of a reviewer'))
    expect(line).toContain('src/c.ts')
    expect(line).toContain('src/d.ts')
  })

  it('says no human has read it', () => {
    expect(report.notChecked).toContain('No human has read and approved this implementation here yet.')
  })
})

// ---------------------------------------------------------------------------
// The degenerate poll — crossVerify's V <= R zone
// ---------------------------------------------------------------------------

describe('a degenerate panel is never corroboration', () => {
  it('ONE configured verifier scores partial and says the vote cannot bite', () => {
    const facts = { ...poorFacts() }
    facts.verification = { configuredVerifiers: 1, pollsHeld: 0, pollsThatCouldDemote: 0 }
    const check = checkOf(gradeReadiness(facts), 'verification')
    expect(check.points).toBe(1)
    expect(check.state).toBe('partial')
    expect(check.detail).toContain('cannot change any outcome')
    expect(check.shortfall).toBe('the single verifier could not have changed any outcome')
  })

  it('polls HELD with one verifier are counted as decorative, not as agreement', () => {
    const facts = collectReadinessFacts({
      reviewers: [reviewer('Correctness', [finding({ verification: poll(1) })])],
      configuredReviewerNames: ['Correctness'],
      configuredVerifiers: 1,
      changedFilePaths: ['src/a.ts'],
      filesNotSent: [],
      grounding: { local: false, dirty: false, description: 'x' },
      approval: { approved: false, stale: false, phase: 'implementation' },
      tests: { status: 'not-run' },
    })
    // One raiser, one verifier → verifierVotesCanDemote(1, 1) is false.
    expect(facts.verification.pollsHeld).toBe(1)
    expect(facts.verification.pollsThatCouldDemote).toBe(0)
    // …and a "unanimous" 2/2 tally on such a poll is NOT counted as backing.
    expect(facts.findings.unanimouslyBacked).toBe(0)

    const check = checkOf(gradeReadiness(facts), 'verification')
    expect(check.points).toBe(1)
    expect(check.shortfall).toBe('every verification poll was decorative')
  })

  it('TWO verifiers can vote, so a unanimous poll counts as backing', () => {
    const facts = collectReadinessFacts({
      reviewers: [reviewer('Correctness', [finding({ verification: poll(2) })])],
      configuredReviewerNames: ['Correctness'],
      configuredVerifiers: 2,
      changedFilePaths: ['src/a.ts'],
      filesNotSent: [],
      grounding: { local: false, dirty: false, description: 'x' },
      approval: { approved: false, stale: false, phase: 'implementation' },
      tests: { status: 'not-run' },
    })
    expect(facts.verification.pollsThatCouldDemote).toBe(1)
    expect(facts.findings.unanimouslyBacked).toBe(1)
    expect(checkOf(gradeReadiness(facts), 'verification').points).toBe(2)
  })

  it('the same review grades WORSE on a single-model panel than on a verified one', () => {
    const base = {
      reviewers: [reviewer('Correctness')],
      configuredReviewerNames: ['Correctness'],
      changedFilePaths: ['src/a.ts'],
      filesNotSent: [],
      grounding: { local: false, dirty: false, description: 'x' },
      approval: { approved: false, stale: false, phase: 'implementation' as const },
      tests: { status: 'not-run' as const },
    }
    const single = gradeReadiness(collectReadinessFacts({ ...base, configuredVerifiers: 0 }))
    const degenerate = gradeReadiness(collectReadinessFacts({ ...base, configuredVerifiers: 1 }))
    const verified = gradeReadiness(collectReadinessFacts({ ...base, configuredVerifiers: 2 }))
    expect(single.score).toBeLessThan(degenerate.score)
    expect(degenerate.score).toBeLessThan(verified.score)
  })
})

// ---------------------------------------------------------------------------
// Silence is not evidence
// ---------------------------------------------------------------------------

describe('silence is not evidence', () => {
  it('no reviewer produced a result → the findings check scores ZERO, not full marks', () => {
    const facts = collectReadinessFacts({
      reviewers: [{ name: 'Correctness', done: false, errored: false, findings: [] }],
      configuredReviewerNames: ['Correctness'],
      configuredVerifiers: 2,
      changedFilePaths: ['src/a.ts'],
      filesNotSent: [],
      grounding: { local: true, dirty: false, description: 'x' },
      approval: { approved: true, stale: false, phase: 'tests' },
      tests: { status: 'passed' },
    })
    const check = checkOf(gradeReadiness(facts), 'findings')
    expect(check.points).toBe(0)
    expect(check.detail).toBe('No reviewer produced a result, so "no findings" is not evidence of anything.')
  })

  it('a failed reviewer is reported as failed, not as quiet', () => {
    const facts = collectReadinessFacts({
      reviewers: [{ name: 'Security', done: false, errored: true, findings: [] }, reviewer('Correctness')],
      configuredReviewerNames: ['Security', 'Correctness'],
      configuredVerifiers: 2,
      changedFilePaths: ['src/a.ts'],
      filesNotSent: [],
      grounding: { local: true, dirty: false, description: 'x' },
      approval: { approved: true, stale: false, phase: 'tests' },
      tests: { status: 'passed' },
    })
    const report = gradeReadiness(facts)
    expect(report.notChecked.some((l) => l.includes('failed rather than finishing: Security'))).toBe(true)
  })

  it('a pass with no test run cannot reach the top band, however good everything else is', () => {
    const facts = richFacts()
    facts.tests = { status: 'not-run' }
    const report = gradeReadiness(facts)
    expect(report.band).not.toBe('broad')
    expect(report.headline).toContain('no test run is recorded')
  })

  it('a FAILED test run is reported as failed, not merely absent', () => {
    const facts = richFacts()
    facts.tests = { status: 'failed', command: 'pnpm test', detail: '3 specs red.' }
    const check = checkOf(gradeReadiness(facts), 'tests')
    expect(check.detail).toContain('FAILED')
    expect(check.detail).toContain('pnpm test')
    expect(check.detail).toContain('3 specs red.')
  })
})

// ---------------------------------------------------------------------------
// Phase scope (#275) — a tests-phase pass runs three of eleven
// ---------------------------------------------------------------------------

describe('phase scope is never hidden', () => {
  it('three reviewers out of eleven is reported as three out of eleven', () => {
    const facts = collectReadinessFacts({
      reviewers: ELEVEN.slice(0, 3).map((n) => reviewer(n)),
      configuredReviewerNames: ELEVEN,
      configuredVerifiers: 2,
      changedFilePaths: ['src/a.test.ts'],
      filesNotSent: [],
      grounding: { local: true, dirty: false, description: 'x' },
      approval: { approved: true, stale: false, phase: 'tests' },
      tests: { status: 'passed' },
    })
    const report = gradeReadiness(facts)
    expect(checkOf(report, 'reviewers').detail).toContain('3 of 11 configured reviewers')
    expect(checkOf(report, 'reviewers').shortfall).toBe('8 of 11 reviewers did not run')
    expect(report.notChecked[0]).toContain('8 configured reviewers did not run')
  })

  it('caps the named reviewers and says how many are left', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Reviewer ${i + 1}`)
    const lines = notCheckedLines(
      collectReadinessFacts({
        reviewers: [],
        configuredReviewerNames: many,
        configuredVerifiers: 2,
        changedFilePaths: ['src/a.ts'],
        filesNotSent: [],
        grounding: { local: true, dirty: false, description: 'x' },
        approval: { approved: true, stale: false, phase: 'tests' },
        tests: { status: 'passed' },
      }),
    )
    expect(lines[0]).toContain(`and ${20 - NOT_CHECKED_NAME_LIMIT} more`)
  })
})

// ---------------------------------------------------------------------------
// Coverage + grounding + approval
// ---------------------------------------------------------------------------

describe('coverage', () => {
  it('half the diff never sent scores partial and names the gap', () => {
    const report = gradeReadiness(poorFacts())
    const check = checkOf(report, 'coverage')
    expect(check.detail).toBe('2 of 4 changed files were put in front of a reviewer; 2 were not.')
    expect(check.points).toBe(1)
  })

  it('a path that is not in the diff cannot shrink coverage', () => {
    const facts = collectReadinessFacts({
      reviewers: [reviewer('Correctness')],
      configuredReviewerNames: ['Correctness'],
      configuredVerifiers: 2,
      changedFilePaths: ['src/a.ts'],
      filesNotSent: ['ci: build log', 'src/not-in-this-pr.ts'],
      grounding: { local: true, dirty: false, description: 'x' },
      approval: { approved: true, stale: false, phase: 'tests' },
      tests: { status: 'passed' },
    })
    expect(facts.coverage.reviewedFiles).toBe(1)
    expect(facts.coverage.notSent).toEqual([])
  })
})

describe('grounding', () => {
  it('a local clean checkout is the only full-credit reading', () => {
    const facts = richFacts()
    expect(checkOf(gradeReadiness(facts), 'grounding').points).toBe(2)
  })

  it('a dirty checkout keeps the sentence and loses a point', () => {
    const facts = richFacts()
    facts.grounding = { local: true, dirty: true, description: 'uncommitted changes' }
    const check = checkOf(gradeReadiness(facts), 'grounding')
    expect(check.points).toBe(1)
    expect(check.detail).toBe('uncommitted changes')
    expect(check.shortfall).toBe('the checkout that was read has uncommitted changes')
  })

  it('reading from the provider API says nothing outside the diff was opened', () => {
    const report = gradeReadiness(poorFacts())
    expect(
      report.notChecked.some((l) => l.includes('rather than a checkout at this PR’s head')),
    ).toBe(true)
  })
})

describe('human sign-off', () => {
  it('an approval pinned to this head is full credit and names the sha', () => {
    const check = checkOf(gradeReadiness(richFacts()), 'approval')
    expect(check.points).toBe(2)
    expect(check.detail).toBe('You approved the implementation at abcdef1.')
  })

  it('a stale approval is half credit and says it covers older code', () => {
    const facts = richFacts()
    facts.approval = { approved: true, stale: true, phase: 'tests', approvedAtSha: 'abcdef1234567' }
    const check = checkOf(gradeReadiness(facts), 'approval')
    expect(check.points).toBe(1)
    expect(check.detail).toContain('commits have landed since')
  })
})

// ---------------------------------------------------------------------------
// Reproducibility — the property the whole feature rests on
// ---------------------------------------------------------------------------

describe('reproducibility', () => {
  it('the same facts produce a byte-identical report, every time', () => {
    const facts = richFacts()
    const first = JSON.stringify(gradeReadiness(facts))
    for (let i = 0; i < 50; i++) {
      expect(JSON.stringify(gradeReadiness(facts))).toBe(first)
    }
  })

  it('structurally equal but distinct fact objects produce the same report', () => {
    expect(JSON.stringify(gradeReadiness(poorFacts()))).toBe(JSON.stringify(gradeReadiness(poorFacts())))
    expect(JSON.stringify(gradeReadiness(richFacts()))).toBe(JSON.stringify(gradeReadiness(richFacts())))
  })

  it('collection is deterministic too — the same inputs count the same facts', () => {
    const build = (): ReadinessFacts =>
      collectReadinessFacts({
        reviewers: [
          reviewer('A', [finding({ verification: poll(2), severity: 'low' })]),
          reviewer('B', [finding({ path: 'src/b.ts', line: null, severity: 'high' })]),
        ],
        configuredReviewerNames: ['A', 'B', 'C'],
        configuredVerifiers: 2,
        changedFilePaths: ['src/a.ts', 'src/b.ts'],
        filesNotSent: ['src/b.ts', 'src/b.ts'],
        grounding: { local: true, dirty: false, description: 'x' },
        approval: { approved: true, stale: false, phase: 'tests', approvedAtSha: 'deadbee' },
        tests: { status: 'passed', command: 'pnpm test' },
      })
    const first = JSON.stringify(build())
    for (let i = 0; i < 25; i++) expect(JSON.stringify(build())).toBe(first)
  })

  it('no wall-clock, randomness or locale collation enters the module', async () => {
    // Reproducibility is a property of the CODE, so this reads the code. It
    // strips comments first (prose about `Date.now()` is prose); the module has
    // no `//` or `/*` inside a string literal, which is what makes that safe.
    const raw = (await import('./readiness.ts?raw')).default as string
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(source).not.toMatch(/Date\.now/)
    expect(source).not.toMatch(/Math\.random/)
    expect(source).not.toMatch(/localeCompare|toLocaleString|Intl\./)
  })
})

// ---------------------------------------------------------------------------
// The disclaimer itself
// ---------------------------------------------------------------------------

describe('the disclaimer', () => {
  it('names every structural limit it must name', () => {
    expect(READINESS_DISCLAIMER).toContain('Nothing here ran the code')
    expect(READINESS_DISCLAIMER).toContain('No runtime behaviour was observed')
    expect(READINESS_DISCLAIMER).toContain('no integration, migration or deploy was exercised')
    expect(READINESS_DISCLAIMER).toContain('nothing outside this diff was read')
    expect(READINESS_DISCLAIMER).toContain(
      '“Production ready” is a claim about a system; this pass only ever saw a diff',
    )
    expect(READINESS_DISCLAIMER).toContain('not whether the change is safe to ship')
  })

  it('no band label is a letter grade', () => {
    for (const label of Object.values(READINESS_BAND_LABEL)) {
      expect(label).toMatch(/checked$/)
      expect(label).not.toMatch(/^[A-F][+-]?$/)
    }
  })
})
