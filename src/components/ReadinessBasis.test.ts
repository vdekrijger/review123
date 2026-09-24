/**
 * ReadinessBasis component tests.
 *
 * The component's contract is auditability, so that is what these assert: the
 * band is a WORD (never a letter), every computed check gets a row carrying its
 * own arithmetic and its counted fact, the "what this did not check" list
 * renders every line the computation produced, and the disclaimer is always
 * present — including on the review that scored full marks, where it is the
 * only thing standing between the grade and a reader skipping step 4.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import ReadinessBasis from './ReadinessBasis.svelte'
import {
  collectReadinessFacts,
  gradeReadiness,
  READINESS_DISCLAIMER,
  type ReadinessReport,
  type ReviewerOutcome,
} from '../lib/ai/readiness'

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

function reviewer(name: string): ReviewerOutcome {
  return { name, done: true, errored: false, findings: [] }
}

function richReport(): ReadinessReport {
  return gradeReadiness(
    collectReadinessFacts({
      reviewers: ELEVEN.map(reviewer),
      configuredReviewerNames: ELEVEN,
      configuredVerifiers: 2,
      changedFilePaths: ['src/a.ts', 'src/b.ts'],
      filesNotSent: [],
      grounding: { local: true, dirty: false, description: 'Reading code from your local checkout.' },
      approval: { approved: true, stale: false, phase: 'tests', approvedAtSha: 'abcdef1234' },
      tests: { status: 'passed', command: 'pnpm test' },
    }),
  )
}

function poorReport(): ReadinessReport {
  return gradeReadiness(
    collectReadinessFacts({
      reviewers: [
        {
          name: 'Correctness',
          done: true,
          errored: false,
          findings: [{ path: 'src/a.ts', line: 4, severity: 'high' }],
        },
      ],
      configuredReviewerNames: ELEVEN,
      configuredVerifiers: 0,
      changedFilePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      filesNotSent: ['src/c.ts', 'src/d.ts'],
      grounding: { local: false, dirty: false, description: 'Reading code from GitHub.' },
      approval: { approved: false, stale: false, phase: 'implementation' },
      tests: { status: 'not-run' },
    }),
  )
}

describe('ReadinessBasis', () => {
  it('renders nothing without a report (demo mounts, no AI run)', () => {
    const { container } = render(ReadinessBasis, { props: { report: null } })
    expect(container.querySelector('[data-testid="readiness-basis"]')).toBeNull()
  })

  it('leads with the band as a WORD, not a letter grade', () => {
    render(ReadinessBasis, { props: { report: poorReport() } })
    const headline = screen.getByTestId('readiness-headline')
    expect(headline.textContent).toContain('Barely checked')
    expect(headline.textContent).not.toMatch(/\b[A-F][+-]?\b\s*—/)
  })

  it('says out loud that no model produced the grade', () => {
    render(ReadinessBasis, { props: { report: richReport() } })
    expect(screen.getByTestId('readiness-provenance').textContent).toContain('No model produced this grade')
  })

  it('gives every computed check its own auditable row', () => {
    const report = richReport()
    render(ReadinessBasis, { props: { report } })
    const rows = screen.getAllByTestId('readiness-check')
    expect(rows).toHaveLength(report.checks.length)
    for (const check of report.checks) {
      const row = rows.find((r) => r.getAttribute('data-check') === check.id)
      expect(row, check.id).toBeTruthy()
      expect(row?.textContent).toContain(`${check.points}/${check.max}`)
      expect(row?.textContent).toContain(check.detail)
    }
  })

  it('marks each row with its state so the weak inputs are visible at a glance', () => {
    render(ReadinessBasis, { props: { report: poorReport() } })
    const states = screen.getAllByTestId('readiness-check').map((r) => r.getAttribute('data-state'))
    expect(states).toContain('unmet')
    expect(states).toContain('partial')
  })

  it('renders every "did not check" line the computation produced', () => {
    const report = poorReport()
    render(ReadinessBasis, { props: { report } })
    const list = screen.getByTestId('readiness-notchecked')
    expect(list.querySelectorAll('li')).toHaveLength(report.notChecked.length)
    for (const line of report.notChecked) expect(list.textContent).toContain(line)
  })

  it('shows the disclaimer even on a full-marks review', () => {
    const report = richReport()
    expect(report.band).toBe('broad')
    render(ReadinessBasis, { props: { report } })
    expect(screen.getByTestId('readiness-disclaimer').textContent).toBe(READINESS_DISCLAIMER)
    // The one line that must never be buried: this only ever saw a diff.
    expect(screen.getByTestId('readiness-disclaimer').textContent).toContain('only ever saw a diff')
  })

  it('tints the panel edge by band without making colour the only signal', () => {
    const { container } = render(ReadinessBasis, { props: { report: poorReport() } })
    const section = container.querySelector('[data-testid="readiness-basis"]')
    expect(section?.getAttribute('data-band')).toBe('minimal')
    // The word is still there, so a reader who sees no colour loses nothing.
    expect(section?.textContent).toContain('Barely checked')
  })
})
