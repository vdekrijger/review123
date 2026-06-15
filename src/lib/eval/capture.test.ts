/**
 * Tests for src/lib/eval/capture.ts — the pure scaffolding for the capture tool.
 *
 * Covers (the IO lives in eval/capture-case.mts; this is the shaping logic):
 * - scaffoldCase given a fetched PR + a findings list writes the three correct
 *   shapes: fixture (GoldenFixture), expected (findings[] all UNLABELED), and
 *   mock responses keyed by task with the right per-task projection.
 * - UNLABELED: every expected entry starts UNLABELED; duplicates are collapsed.
 * - mock responses round-trip back through the harness validators.
 */

import { describe, it, expect } from 'vitest'
import {
  scaffoldCase,
  buildExpected,
  buildMockResponses,
  type CapturedFinding,
  type CapturedPr,
} from './capture'
import { runCase, type GoldenCase } from './harness'
import { mockComplete } from './mock'
import { decisionLabelsByTail, findingMatchTail, type DecisionRecord, type DecisionVerificationContext } from './decisions'

const pr: CapturedPr = {
  name: '07-captured',
  files: [
    {
      path: 'src/api/users.ts',
      patch: '@@ -1,3 +1,4 @@\n+const q = `SELECT * FROM u WHERE id = ${id}`\n',
      contentBefore: null,
      contentAfter: 'const q = `SELECT * FROM u WHERE id = ${id}`\n',
    },
  ],
  skills: [{ name: 'bug-hunter', content: 'Find correctness and security bugs.' }],
}

const findings: CapturedFinding[] = [
  {
    taskKey: 'skill:bug-hunter',
    file: 'src/api/users.ts',
    line: 1,
    description: 'SQL injection: id is interpolated directly into the query string.',
    severity: 'high',
  },
  {
    taskKey: 'attention',
    file: 'src/api/users.ts',
    line: null,
    description: 'Raw string-built SQL — review for injection.',
  },
  {
    taskKey: 'verdict',
    file: 'src/api/users.ts',
    line: null,
    description: 'Adds a raw SQL query built from user input.',
  },
]

describe('scaffoldCase', () => {
  it('builds a fixture that preserves files and skills', () => {
    const { fixture } = scaffoldCase(pr, findings)
    expect(fixture.name).toBe('07-captured')
    expect(fixture.files).toEqual(pr.files)
    expect(fixture.skills).toEqual(pr.skills)
  })

  it('pre-labels every expected finding UNLABELED', () => {
    const { expected } = scaffoldCase(pr, findings)
    expect(expected.findings).toHaveLength(3)
    for (const f of expected.findings) {
      expect(f.label).toBe('UNLABELED')
      expect(f).toHaveProperty('file')
      expect(f).toHaveProperty('line')
      expect(f).toHaveProperty('description')
    }
  })

  it('de-duplicates identical findings in expected', () => {
    const dup = buildExpected([findings[0], findings[0]])
    expect(dup.findings).toHaveLength(1)
  })

  it('projects findings into the right mock task responses', () => {
    const { mockResponses } = scaffoldCase(pr, findings)
    const skill = mockResponses['skill:bug-hunter'] as {
      skillName: string
      findings: { path: string; line: number; severity: string; body: string }[]
    }
    expect(skill.skillName).toBe('bug-hunter')
    expect(skill.findings).toHaveLength(1)
    expect(skill.findings[0]).toMatchObject({ path: 'src/api/users.ts', line: 1, severity: 'high' })

    const attention = mockResponses.attention as { hotspots: { path: string }[] }
    expect(attention.hotspots).toHaveLength(1)
    expect(attention.hotspots[0].path).toBe('src/api/users.ts')

    const verdict = mockResponses.verdict as { level: string; evidence: string[] }
    expect(verdict.level).toBe('significant-changes')
    expect(verdict.evidence).toHaveLength(1)
  })

  it('emits a behavior-preserved verdict when there are no findings', () => {
    const empty = buildMockResponses([])
    expect((empty.verdict as { level: string }).level).toBe('behavior-preserved')
    expect((empty.attention as { hotspots: unknown[] }).hotspots).toHaveLength(0)
  })
})

describe('auto-labeling from accept/dismiss decisions', () => {
  const vc: DecisionVerificationContext = {
    deep: false, crossVerified: false, confirmedBy: 0, polledModels: 0, raisedByCount: 0,
  }
  function decision(findingKey: string, decision: 'accepted' | 'dismissed'): DecisionRecord {
    return { prKey: 'p', findingKey, decision, severity: 'high', verificationContext: vc, at: 1 }
  }
  // Build a finding key (skillId + content tail) the way the runtime store does.
  function keyFor(skillId: string, f: CapturedFinding): string {
    return `${skillId}:${findingMatchTail(f.file, f.line, f.description)}`
  }

  it('maps accepted → real, dismissed → noise, none → UNLABELED', () => {
    // The skill finding was accepted; the attention finding dismissed; the
    // verdict finding has no decision.
    const labels = decisionLabelsByTail([
      decision(keyFor('bug-hunter', findings[0]), 'accepted'),
      decision(keyFor('builtin:attention', findings[1]), 'dismissed'),
    ])
    const expected = buildExpected(findings, labels)
    const byDesc = new Map(expected.findings.map((e) => [e.description, e.label]))
    expect(byDesc.get(findings[0].description)).toBe('real')
    expect(byDesc.get(findings[1].description)).toBe('noise')
    expect(byDesc.get(findings[2].description)).toBe('UNLABELED')
  })

  it('matches regardless of the recorded skillId (skillId-independent tail)', () => {
    // Decision recorded under a DIFFERENT skillId than the live reviewer name.
    const labels = decisionLabelsByTail([
      decision(`some-other-id:${findingMatchTail(findings[0].file, findings[0].line, findings[0].description)}`, 'accepted'),
    ])
    const expected = buildExpected(findings, labels)
    const entry = expected.findings.find((e) => e.description === findings[0].description)
    expect(entry?.label).toBe('real')
  })

  it('without decisions every finding stays UNLABELED (back-compat)', () => {
    const expected = buildExpected(findings)
    for (const f of expected.findings) expect(f.label).toBe('UNLABELED')
  })

  it('scaffoldCase threads decision labels into expected', () => {
    const labels = decisionLabelsByTail([decision(keyFor('bug-hunter', findings[0]), 'accepted')])
    const { expected } = scaffoldCase(pr, findings, labels)
    const entry = expected.findings.find((e) => e.description === findings[0].description)
    expect(entry?.label).toBe('real')
  })
})

describe('captured case replays under the mock harness', () => {
  it('scores the labeled findings (UNLABELED skipped) deterministically', async () => {
    const { fixture, expected, mockResponses } = scaffoldCase(pr, findings)

    // Simulate the user resolving labels: the skill finding is real, the
    // attention/verdict echoes are noise; (leave none UNLABELED here).
    const labeled = {
      findings: expected.findings.map((f) => ({
        ...f,
        label: f.line === 1 ? ('real' as const) : ('noise' as const),
      })),
    }

    const goldenCase: GoldenCase = { name: pr.name, fixture, expected: labeled }
    const complete = mockComplete(
      Object.fromEntries(
        Object.entries(mockResponses).map(([k, v]) => [k, JSON.stringify(v)]),
      ),
    )
    const result = await runCase(goldenCase, complete)
    // The real SQLi finding is caught.
    expect(result.score.realCaught).toBe(1)
    expect(result.score.recall).toBe(1)
  })

  it('skips UNLABELED entries entirely when scoring', async () => {
    const { fixture, expected, mockResponses } = scaffoldCase(pr, findings)
    // Leave everything UNLABELED → no real, no noise → recall is vacuously 1,
    // noise-rate 0; nothing is scored against.
    const goldenCase: GoldenCase = { name: pr.name, fixture, expected }
    const complete = mockComplete(
      Object.fromEntries(
        Object.entries(mockResponses).map(([k, v]) => [k, JSON.stringify(v)]),
      ),
    )
    const result = await runCase(goldenCase, complete)
    expect(result.score.realTotal).toBe(0)
    expect(result.score.noiseTotal).toBe(0)
    expect(result.score.recall).toBe(1)
    expect(result.score.noiseRate).toBe(0)
  })
})
