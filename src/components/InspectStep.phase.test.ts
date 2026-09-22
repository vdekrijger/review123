/**
 * InspectStep — review phases (Implementation → Tests), Files mode only.
 *
 * Covers:
 *   - the phase selector renders only on a PR that ACTUALLY splits (impl +
 *     test files), never in Story mode
 *   - Implementation hides test files from the list AND the tree, and states
 *     how many are deferred
 *   - the explicit, reversible approve action; re-open puts you back
 *   - the Tests phase is reachable BEFORE approval as a labelled preview (the
 *     quiet override) and says so
 *   - the progress line, the sort control and the mechanical tail keep working
 *     WITHIN a phase (and a test file reaches the Tests-phase tail)
 *   - findings follow their file's phase — a finding on a test file is counted
 *     in the Tests phase, never silently lost
 *   - a head-sha change after approval surfaces honestly with a re-open action
 *   - per-PR persistence across a remount
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import { tick } from 'svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import { createViewedStore } from '../lib/viewed/viewed.svelte'
import { approveImplementation, getPhaseRecord, setReviewPhase } from '../lib/guide/phase.svelte'
import { TESTS_PASS_ID_SUFFIX } from '../lib/ai/run.svelte'
import { addSkill, listSkills, removeSkill } from '../lib/skills/skills'
import { setAiTaskMode, setShowTokenCost } from '../lib/settings/settings'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
  // settingsState caches the parsed settings; a raw localStorage write is
  // invisible to it without this reset (the repo-wide idiom).
  _resetSettingsStateForTest()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

/** Standalone renders fall into the 'local' phase bucket (currentPrKey()). */
const PR_KEY = 'local'

function makeFile(filename: string, overrides: Partial<PrFile> = {}): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH, ...overrides }
}

/**
 * Fixture: 2 implementation files + 2 test files.
 *   src/auth/big.ts       added +400, sensitive path → HIGH (novel)
 *   src/app.ts            modified +5                → LOW  (novel)
 *   src/app.test.ts       tests-only                 → Tests phase
 *   src/__tests__/auth.ts tests-only (dir pattern)   → Tests phase
 */
function makeMixedFiles(): PrFile[] {
  return [
    makeFile('src/app.ts', { additions: 5 }),
    makeFile('src/app.test.ts', { additions: 12 }),
    makeFile('src/auth/big.ts', { status: 'added', additions: 400 }),
    makeFile('src/__tests__/auth.ts', { additions: 9 }),
  ]
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    files: makeMixedFiles(),
    changedFiles: 4,
    mode: 'unified' as const,
    onmode: () => {},
    draftStore: null,
    ...overrides,
  }
}

/** Ids of every rendered file card (main list + tail). */
function cardIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[id^="file-"]')].map((el) => el.id)
}

function mainCardIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.diff-column > [id^="file-"]')].map((el) => el.id)
}

function tailCardIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.attention-tail [id^="file-"]')].map((el) => el.id)
}

// ---------------------------------------------------------------------------
// When the selector engages
// ---------------------------------------------------------------------------

describe('InspectStep — when phases engage', () => {
  it('renders the selector on a mixed PR, Implementation active by default', () => {
    render(InspectStep, { props: baseProps() })
    expect(screen.getByRole('group', { name: 'Review phase' })).toBeInTheDocument()
    expect(screen.getByTestId('phase-btn-implementation').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('phase-btn-tests').getAttribute('aria-pressed')).toBe('false')
  })

  it('does NOT render on a PR with no test files (nothing to split)', () => {
    const files = [makeFile('src/app.ts'), makeFile('src/auth/big.ts')]
    render(InspectStep, { props: baseProps({ files, changedFiles: 2 }) })
    expect(screen.queryByTestId('phase-bar')).not.toBeInTheDocument()
  })

  it('does NOT render on a tests-only PR (an empty Implementation phase helps nobody)', () => {
    const files = [makeFile('src/app.test.ts'), makeFile('src/__tests__/auth.ts')]
    const { container } = render(InspectStep, { props: baseProps({ files, changedFiles: 2 }) })
    expect(screen.queryByTestId('phase-bar')).not.toBeInTheDocument()
    // …and every file still renders.
    expect(cardIds(container)).toHaveLength(2)
  })

  it('does NOT render in Story mode — a story walks the WHOLE change', () => {
    render(InspectStep, {
      props: baseProps({
        storyAvailable: true,
        storyMode: true,
        storyStatus: 'done',
        story: { steps: [{ index: 0, files: ['src/app.ts'], caption: 'App.', layer: 'ui', relatedTests: [] }] },
      }),
    })
    expect(screen.queryByTestId('phase-bar')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Implementation phase
// ---------------------------------------------------------------------------

describe('InspectStep — Implementation phase', () => {
  it('hides test files from the list and states how many are deferred', () => {
    const { container } = render(InspectStep, { props: baseProps() })
    expect(cardIds(container)).toEqual(['file-src-app-ts', 'file-src-auth-big-ts'])
    expect(screen.getByTestId('phase-deferred-note').textContent).toContain(
      '2 test files — reviewed in the Tests phase',
    )
  })

  it('singularizes the deferred note for a single test file', () => {
    const files = [makeFile('src/app.ts'), makeFile('src/app.test.ts')]
    render(InspectStep, { props: baseProps({ files, changedFiles: 2 }) })
    expect(screen.getByTestId('phase-deferred-note').textContent).toContain(
      '1 test file — reviewed in the Tests phase',
    )
  })

  it('hides test files from the file tree too (no dead click targets)', async () => {
    const { container } = render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: 'Open file tree' }))
    const tree = container.querySelector('.file-tree-nav') as HTMLElement
    expect(tree).not.toBeNull()
    expect(tree.textContent).toContain('app.ts')
    expect(tree.textContent).not.toContain('app.test.ts')
    expect(tree.textContent).not.toContain('__tests__')
  })

  it('shows the phase-file counts on the two tabs', () => {
    render(InspectStep, { props: baseProps() })
    expect(screen.getByTestId('phase-btn-implementation').textContent).toContain('2')
    expect(screen.getByTestId('phase-btn-tests').textContent).toContain('2')
  })
})

// ---------------------------------------------------------------------------
// Approval — explicit, reversible, never automatic
// ---------------------------------------------------------------------------

describe('InspectStep — approving the implementation', () => {
  it('never auto-approves: the Tests tab renders locked until the user acts', () => {
    render(InspectStep, { props: baseProps() })
    expect(getPhaseRecord(PR_KEY).implApprovedAt).toBeUndefined()
    expect(screen.getByTestId('phase-btn-tests').textContent).toContain('🔒')
  })

  it('"Implementation looks good" records the approval, pins the head sha and moves to Tests', async () => {
    const { container } = render(InspectStep, { props: baseProps({ currentHeadSha: 'abc1234def' }) })
    await fireEvent.click(screen.getByTestId('phase-approve'))

    const record = getPhaseRecord(PR_KEY)
    expect(record.phase).toBe('tests')
    expect(record.implApprovedAt).toEqual(expect.any(Number))
    expect(record.headShaAtApproval).toBe('abc1234def')

    // Only the test files remain on screen, framed against the approval.
    expect(cardIds(container)).toEqual(['file-src-app-test-ts', 'file-src---tests---auth-ts'])
    expect(screen.getByTestId('phase-tests-lead').textContent).toMatch(
      /against the implementation you approved at abc1234/i,
    )
    expect(screen.getByTestId('phase-btn-tests').textContent).not.toContain('🔒')
  })

  it('"Re-open implementation" is always available and clears the approval', async () => {
    const { container } = render(InspectStep, { props: baseProps({ currentHeadSha: 'abc1234def' }) })
    await fireEvent.click(screen.getByTestId('phase-approve'))
    await fireEvent.click(screen.getByTestId('phase-reopen'))

    expect(getPhaseRecord(PR_KEY)).toEqual({ phase: 'implementation' })
    expect(cardIds(container)).toEqual(['file-src-app-ts', 'file-src-auth-big-ts'])
  })

  it('re-entering Implementation after approval does NOT re-litigate the sign-off', async () => {
    approveImplementation(PR_KEY, 'abc1234def')
    render(InspectStep, { props: baseProps({ currentHeadSha: 'abc1234def' }) })

    // Land in Tests (the stored phase), step back to Implementation…
    expect(screen.getByTestId('phase-btn-tests').getAttribute('aria-pressed')).toBe('true')
    await fireEvent.click(screen.getByTestId('phase-btn-implementation'))

    // …the approval survives: the note still reports it and Tests stays unlocked.
    expect(getPhaseRecord(PR_KEY).implApprovedAt).toEqual(expect.any(Number))
    expect(screen.getByTestId('phase-approved-note').textContent).toMatch(/Implementation approved .* at abc1234\./)
    expect(screen.getByTestId('phase-btn-tests').textContent).not.toContain('🔒')
    expect(screen.getByTestId('phase-approve').textContent).toContain('Re-approve implementation')
  })
})

// ---------------------------------------------------------------------------
// The quiet override — previewing tests before approval
// ---------------------------------------------------------------------------

describe('InspectStep — previewing the Tests phase before approval', () => {
  it('lets the user in, labels it a preview, and does NOT record an approval', async () => {
    const { container } = render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))

    expect(cardIds(container)).toEqual(['file-src-app-test-ts', 'file-src---tests---auth-ts'])
    expect(screen.getByTestId('phase-tests-lead').textContent).toContain(
      "Previewing the tests — the implementation isn't approved yet.",
    )
    expect(getPhaseRecord(PR_KEY)).toEqual({ phase: 'tests' })
    expect(screen.getByTestId('phase-btn-tests').textContent).toContain('🔒')
  })

  it('states how many implementation files are hidden in the Tests phase', async () => {
    render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    expect(screen.getByTestId('phase-tests-deferred-note').textContent).toContain(
      '2 implementation files hidden here',
    )
  })
})

// ---------------------------------------------------------------------------
// Existing controls keep working inside a phase
// ---------------------------------------------------------------------------

describe('InspectStep — sort, tail and progress inside a phase', () => {
  it('scopes the attention-progress line to the active phase', async () => {
    const viewedStore = createViewedStore('o/r#1')
    render(InspectStep, { props: baseProps({ viewedStore }) })

    // Implementation: 2 attention files (app.ts, auth/big.ts).
    expect(screen.getByTestId('attention-progress').textContent).toContain('0 of 2 attention files reviewed')
    viewedStore.toggle('src/app.ts', PATCH)
    await tick()
    expect(screen.getByTestId('attention-progress').textContent).toContain('1 of 2 attention files reviewed')

    // Viewing a TEST file does not move the Implementation numerator.
    viewedStore.toggle('src/app.test.ts', PATCH)
    await tick()
    expect(screen.getByTestId('attention-progress').textContent).toContain('1 of 2 attention files reviewed')
  })

  it('keeps the Narrative | Risk first sort working within the Implementation phase', async () => {
    const { container } = render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: 'Risk first' }))
    // Highest risk first, and the two test files are still absent.
    expect(mainCardIds(container)).toEqual(['file-src-auth-big-ts', 'file-src-app-ts'])
    expect(container.querySelector('.attention-tail')).toBeNull()
  })

  it('puts the Tests phase\'s mechanical test files in ITS tail under Risk first', async () => {
    const { container } = render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    await fireEvent.click(screen.getByRole('button', { name: 'Risk first' }))

    // Both test files are mechanical ("tests only") → the whole phase is tail.
    const tail = container.querySelector('details.attention-tail') as HTMLDetailsElement
    expect(tail).not.toBeNull()
    expect(tail.textContent).toContain('2 low-attention files')
    expect(tail.textContent).toContain('2 tests only')
    expect(tailCardIds(container)).toEqual(['file-src---tests---auth-ts', 'file-src-app-test-ts'])
  })
})

// ---------------------------------------------------------------------------
// Findings follow their file's phase
// ---------------------------------------------------------------------------

/** A reviewer with one finding on an impl file and one on a test file. */
function makeSkillReviews(): SkillReviewEntry[] {
  return [
    {
      skillId: 'skill-sec',
      name: 'Security Reviewer',
      state: {
        status: 'done',
        value: {
          skillName: 'Security Reviewer',
          findings: [
            { path: 'src/app.ts', line: 1, severity: 'high', body: 'Impl finding: unchecked input' },
            { path: 'src/app.test.ts', line: 1, severity: 'high', body: 'Test finding: assertion never runs' },
          ],
        },
      },
    } as SkillReviewEntry,
  ]
}

describe('InspectStep — findings belong to their file\'s phase', () => {
  it('renders only implementation findings in the Implementation phase, and says the rest are counted elsewhere', () => {
    render(InspectStep, { props: baseProps({ skillReviews: makeSkillReviews() }) })
    expect(screen.getByText(/Impl finding: unchecked input/)).toBeInTheDocument()
    expect(screen.queryByText(/Test finding: assertion never runs/)).not.toBeInTheDocument()
    expect(screen.getByTestId('phase-deferred-note').textContent).toContain(
      '1 finding counted there',
    )
  })

  it('surfaces the test-file finding in the Tests phase — it is deferred, not lost', async () => {
    render(InspectStep, { props: baseProps({ skillReviews: makeSkillReviews() }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    expect(screen.getByText(/Test finding: assertion never runs/)).toBeInTheDocument()
    expect(screen.queryByText(/Impl finding: unchecked input/)).not.toBeInTheDocument()
    expect(screen.getByTestId('phase-tests-deferred-note').textContent).toContain(
      '1 finding counted in the Implementation phase',
    )
  })

  it('a finding on a test file never drags that file into the Implementation phase', () => {
    const { container } = render(InspectStep, { props: baseProps({ skillReviews: makeSkillReviews() }) })
    // Even though triage's findings override marks it 'novel', it is simply not
    // in this phase's file set.
    expect(cardIds(container)).toEqual(['file-src-app-ts', 'file-src-auth-big-ts'])
  })
})

// ---------------------------------------------------------------------------
// Tests-phase cross-reference (src/lib/diff/symbolTests)
// ---------------------------------------------------------------------------

describe('InspectStep — Tests-phase coverage cross-reference', () => {
  /** An impl file adding `buildKey`, plus a test file whose title names it. */
  function pairingProps() {
    const files = [
      makeFile('src/keys.ts', { patch: '@@ -1,2 +1,3 @@\n const a = 1\n+const buildKey = (x) => x + 1' }),
      makeFile('src/keys.test.ts'),
    ]
    const contentsMap = new Map<string, { before: string | null; after: string | null }>([
      [
        'src/keys.test.ts',
        {
          before: null,
          after: ["describe('keys', () => {", "  it('buildKey adds one', () => {", '    expect(1).toBe(1)', '  })', '})'].join('\n'),
        },
      ],
    ])
    return baseProps({ files, changedFiles: 2, contentsMap })
  }

  it('lists which implementation files a test in this PR names, with the caveat', async () => {
    render(InspectStep, { props: pairingProps() })
    // Not shown in the Implementation phase — it answers a Tests-phase question.
    expect(screen.queryByTestId('phase-coverage')).not.toBeInTheDocument()

    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    const coverage = screen.getByTestId('phase-coverage')
    expect(coverage.textContent).toContain(
      'Tests in this PR name changed symbols in 1 of 1 implementation file',
    )
    expect(coverage.textContent).toContain('src/keys.ts')
    expect(coverage.textContent).toContain('src/keys.test.ts')
    expect(coverage.textContent).toContain('may still be covered by tests outside this PR')
  })

  it('renders nothing rather than a misleading "0 of N" when nothing pairs', async () => {
    // No contents fetched for the test file → the matcher cannot resolve anything.
    render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    expect(screen.queryByTestId('phase-coverage')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// New commits after approval
// ---------------------------------------------------------------------------

describe('InspectStep — new commits after approval', () => {
  it('reports the stale approval honestly and offers to re-open Implementation', async () => {
    approveImplementation(PR_KEY, 'oldsha111')
    render(InspectStep, { props: baseProps({ currentHeadSha: 'newsha222' }) })

    const note = screen.getByTestId('phase-stale-note')
    expect(note.textContent).toContain('New commits since you approved the implementation')
    expect(note.textContent).toContain('oldsha1')
    expect(note.textContent).toContain('newsha2')

    await fireEvent.click(screen.getByTestId('phase-stale-reopen'))
    expect(getPhaseRecord(PR_KEY)).toEqual({ phase: 'implementation' })
    expect(screen.queryByTestId('phase-stale-note')).not.toBeInTheDocument()
  })

  it('shows no stale note when the head sha is unchanged', () => {
    approveImplementation(PR_KEY, 'samesha')
    render(InspectStep, { props: baseProps({ currentHeadSha: 'samesha' }) })
    expect(screen.queryByTestId('phase-stale-note')).not.toBeInTheDocument()
  })

  it('shows no stale note when the approval predates head-sha tracking', () => {
    approveImplementation(PR_KEY)
    render(InspectStep, { props: baseProps({ currentHeadSha: 'newsha222' }) })
    expect(screen.queryByTestId('phase-stale-note')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('InspectStep — phase persistence', () => {
  it('restores the stored phase on a fresh mount (survives reload)', async () => {
    const first = render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    first.unmount()

    const { container } = render(InspectStep, { props: baseProps() })
    expect(screen.getByTestId('phase-btn-tests').getAttribute('aria-pressed')).toBe('true')
    expect(cardIds(container)).toEqual(['file-src-app-test-ts', 'file-src---tests---auth-ts'])
  })

  it('a phase stored for a DIFFERENT PR never leaks in', () => {
    setReviewPhase('github:other/repo#9', 'tests')
    const { container } = render(InspectStep, { props: baseProps() })
    expect(screen.getByTestId('phase-btn-implementation').getAttribute('aria-pressed')).toBe('true')
    expect(cardIds(container)).toEqual(['file-src-app-ts', 'file-src-auth-big-ts'])
  })
})

// ---------------------------------------------------------------------------
// The on-demand TESTS reviewer pass (#237)
// ---------------------------------------------------------------------------

/**
 * Tests-pass entries (AiRun.testReviews). Their ids carry the tests-pass
 * suffix, exactly as the run produces them, so the component's identity
 * handling is exercised for real rather than approximated.
 */
function makeTestsPassReviews(): SkillReviewEntry[] {
  return [
    {
      skillId: 'skill-1' + TESTS_PASS_ID_SUFFIX,
      name: 'Security Reviewer',
      state: {
        status: 'done',
        value: {
          skillName: 'Security Reviewer',
          findings: [
            { path: 'src/app.test.ts', line: 1, severity: 'medium', body: 'Tests-pass finding: asserts on the mock' },
          ],
        },
        usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
      },
    } as SkillReviewEntry,
  ]
}

function withKeyAndSkill(): void {
  localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
  addSkill('Security', 'check for XSS')
}

describe('InspectStep — the on-demand tests reviewer pass', () => {
  afterEach(() => {
    listSkills().forEach((s) => removeSkill(s.id))
  })

  it('is NOT offered in the Implementation phase — that pass already ran, scoped', () => {
    withKeyAndSkill()
    render(InspectStep, { props: baseProps({ runTestsReviewFn: () => {} }) })
    expect(screen.queryByTestId('tests-review-run')).not.toBeInTheDocument()
  })

  it('is offered in the Tests phase, with an honest cost hint BEFORE the click', async () => {
    withKeyAndSkill()
    addSkill('Performance', 'check for N+1')
    render(InspectStep, { props: baseProps({ runTestsReviewFn: () => {} }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))

    expect(screen.getByTestId('tests-review-run')).toBeInTheDocument()
    // The click is expensive; say what it costs before it is spent.
    expect(screen.getByTestId('tests-review-hint').textContent).toContain('2 reviewers · agentic · runs on demand')
  })

  it('clicking it calls runTestsReviewFn — it never fires on its own', async () => {
    withKeyAndSkill()
    const runTestsReviewFn = vi.fn()
    render(InspectStep, { props: baseProps({ runTestsReviewFn }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))

    expect(runTestsReviewFn).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByTestId('tests-review-run'))
    expect(runTestsReviewFn).toHaveBeenCalledTimes(1)
  })

  it('is not offered when the skills task mode is off', async () => {
    withKeyAndSkill()
    setAiTaskMode('skills', 'off')
    _resetSettingsStateForTest()
    render(InspectStep, { props: baseProps({ runTestsReviewFn: () => {} }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    expect(screen.queryByTestId('tests-review-run')).not.toBeInTheDocument()
  })

  it('is not offered without an API key', async () => {
    addSkill('Security', 'check for XSS')
    render(InspectStep, { props: baseProps({ runTestsReviewFn: () => {} }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    expect(screen.queryByTestId('tests-review-run')).not.toBeInTheDocument()
  })

  it('renders tests-pass findings in the Tests phase and keeps them out of Implementation', async () => {
    withKeyAndSkill()
    render(InspectStep, { props: baseProps({ testReviews: makeTestsPassReviews() }) })

    // Implementation phase: the tests-pass finding anchors to a test file, so
    // it is counted in the Tests phase — disclosed, never rendered here.
    expect(screen.queryByText(/Tests-pass finding: asserts on the mock/)).not.toBeInTheDocument()
    expect(screen.getByTestId('phase-deferred-note').textContent).toContain('1 finding counted there')

    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    expect(screen.getByText(/Tests-pass finding: asserts on the mock/)).toBeInTheDocument()
  })

  it('shows BOTH passes’ findings, each in its own phase', async () => {
    withKeyAndSkill()
    const props = baseProps({ skillReviews: makeSkillReviews(), testReviews: makeTestsPassReviews() })
    render(InspectStep, { props })

    expect(screen.getByText(/Impl finding: unchecked input/)).toBeInTheDocument()
    expect(screen.queryByText(/Tests-pass finding: asserts on the mock/)).not.toBeInTheDocument()

    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    expect(screen.getByText(/Tests-pass finding: asserts on the mock/)).toBeInTheDocument()
    expect(screen.getByText(/Test finding: assertion never runs/)).toBeInTheDocument()
    expect(screen.queryByText(/Impl finding: unchecked input/)).not.toBeInTheDocument()
  })

  it('gives tests-pass reviewers the same status bar, tagged so the rows are distinguishable', async () => {
    withKeyAndSkill()
    render(InspectStep, { props: baseProps({ skillReviews: makeSkillReviews(), testReviews: makeTestsPassReviews() }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))

    const bar = document.querySelector('.skill-run-status-bar')!
    expect(bar).toBeInTheDocument()
    // Both passes' chips are present — the implementation pass's results are
    // never wiped by the tests pass.
    expect(bar.querySelectorAll('.skill-run-entry').length).toBe(2)
    // …and exactly one of them is tagged as the tests pass.
    expect(bar.querySelectorAll('.skill-pass-tag').length).toBe(1)
  })

  it('shows the actual spend after the run only when showTokenCost is on', async () => {
    withKeyAndSkill()
    setShowTokenCost(true)
    _resetSettingsStateForTest()
    render(InspectStep, { props: baseProps({ runTestsReviewFn: () => {}, testReviews: makeTestsPassReviews() }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    // Uses the repo's shared formatTokens (locale-independent by design).
    expect(screen.getByTestId('tests-review-cost').textContent).toContain('1.0k tokens used')
  })

  it('hides the spend when showTokenCost is off (the default)', async () => {
    withKeyAndSkill()
    render(InspectStep, { props: baseProps({ runTestsReviewFn: () => {}, testReviews: makeTestsPassReviews() }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))
    expect(screen.queryByTestId('tests-review-cost')).not.toBeInTheDocument()
  })

  it('a tests-pass retry hands back the SUFFIXED entry id, so the run re-runs the right pass', async () => {
    withKeyAndSkill()
    const onRetrySkill = vi.fn()
    const errored: SkillReviewEntry[] = [
      {
        skillId: 'skill-1' + TESTS_PASS_ID_SUFFIX,
        name: 'Security Reviewer',
        state: { status: 'error', error: 'Rate limited.' },
      } as SkillReviewEntry,
    ]
    render(InspectStep, { props: baseProps({ testReviews: errored, onRetrySkill }) })
    await fireEvent.click(screen.getByTestId('phase-btn-tests'))

    await fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetrySkill).toHaveBeenCalledWith('skill-1' + TESTS_PASS_ID_SUFFIX)
  })
})
