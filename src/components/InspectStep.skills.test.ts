/**
 * Tests for InspectStep skill suggestion annotations and run button
 *
 * Covers:
 *   - "Run my reviewers (N)" button shows when skills exist + key present
 *   - Clicking run calls runSkillReviewsFn prop
 *   - Skill suggestion annotations rendered (dashed border, persona label, severity chip)
 *   - "Add as draft" action calls draftStore.upsert
 *   - "Dismiss" hides the finding (session-only)
 *   - Findings for unknown paths are ignored
 *   - No button shown when no skills or no key
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import type { createDraftStore } from '../lib/drafts/drafts.svelte'
import { addSkill, listSkills, removeSkill } from '../lib/skills/skills'

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFiles(names: string[]): PrFile[] {
  return names.map(filename => ({
    filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH,
  }))
}

function makeDraftStore(): ReturnType<typeof createDraftStore> {
  const upsert = vi.fn().mockResolvedValue(undefined)
  const remove = vi.fn()
  const clearAll = vi.fn()
  const load = vi.fn()
  const draftsAt = vi.fn().mockReturnValue([])
  return {
    get drafts() { return [] },
    get count() { return 0 },
    get persistent() { return false },
    upsert,
    remove,
    clearAll,
    load,
    draftsAt,
  }
}

function makeSkillReview(overrides: Partial<SkillReviewEntry> = {}): SkillReviewEntry {
  return {
    skillId: 'skill-123',
    name: 'Security Reviewer',
    state: {
      status: 'done',
      value: {
        skillName: 'Security Reviewer',
        findings: [
          { path: 'src/foo.ts', line: 2, severity: 'high', body: 'Potential XSS vulnerability here' },
        ],
      },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Run button
// ---------------------------------------------------------------------------

describe('InspectStep — "Run my reviewers" button', () => {
  it('shows run button when skills exist and API key present', () => {
    addSkill('Security', 'check for XSS')
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        runSkillReviewsFn: vi.fn(),
        skillReviews: [],
      },
    })
    expect(screen.getByRole('button', { name: /run my reviewers/i })).toBeInTheDocument()
    removeSkill(listSkills()[0]?.id)
  })

  it('shows (N) count in the button matching skill count', () => {
    addSkill('Security', 'check for XSS')
    addSkill('Perf', 'check for N+1')
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        runSkillReviewsFn: vi.fn(),
        skillReviews: [],
      },
    })
    expect(screen.getByRole('button', { name: /run my reviewers \(2\)/i })).toBeInTheDocument()
    listSkills().forEach(s => removeSkill(s.id))
  })

  it('does not show run button when no skills', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        runSkillReviewsFn: vi.fn(),
        skillReviews: [],
      },
    })
    expect(screen.queryByRole('button', { name: /run my reviewers/i })).not.toBeInTheDocument()
  })

  it('does not show run button when no API key', () => {
    addSkill('Security', 'check for XSS')
    // No deepseekKey
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        runSkillReviewsFn: vi.fn(),
        skillReviews: [],
      },
    })
    expect(screen.queryByRole('button', { name: /run my reviewers/i })).not.toBeInTheDocument()
    removeSkill(listSkills()[0]?.id)
  })

  it('clicking run calls runSkillReviewsFn', async () => {
    addSkill('Security', 'check for XSS')
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
    const runFn = vi.fn()
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        runSkillReviewsFn: runFn,
        skillReviews: [],
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /run my reviewers/i }))
    expect(runFn).toHaveBeenCalledOnce()
    removeSkill(listSkills()[0]?.id)
  })
})

// ---------------------------------------------------------------------------
// Skill suggestion annotations
// ---------------------------------------------------------------------------

describe('InspectStep — skill suggestion annotations', () => {
  it('renders skill finding body text', () => {
    const files = makeFiles(['src/foo.ts'])
    const review = makeSkillReview()
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    expect(screen.getByText('Potential XSS vulnerability here')).toBeInTheDocument()
  })

  it('renders severity chip', () => {
    const files = makeFiles(['src/foo.ts'])
    const review = makeSkillReview()
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    expect(screen.getByText('high')).toBeInTheDocument()
  })

  it('renders persona name label on the finding', () => {
    const files = makeFiles(['src/foo.ts'])
    const review = makeSkillReview()
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    // The persona name should appear as a label on the finding card
    const labels = screen.getAllByText(/Security Reviewer/i)
    expect(labels.length).toBeGreaterThan(0)
  })

  it('ignores findings for paths not in the PR', () => {
    const files = makeFiles(['src/foo.ts'])
    const review = makeSkillReview({
      state: {
        status: 'done',
        value: {
          skillName: 'Security Reviewer',
          findings: [
            { path: 'src/ghost.ts', line: 1, severity: 'high', body: 'should not render' },
          ],
        },
      },
    })
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    expect(screen.queryByText('should not render')).not.toBeInTheDocument()
  })

  it('"Add as draft" calls draftStore.upsert with finding body', async () => {
    const files = makeFiles(['src/foo.ts'])
    const draftStore = makeDraftStore()
    const review = makeSkillReview()
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore,
        skillReviews: [review],
      },
    })
    const addBtn = screen.getByRole('button', { name: /add as draft/i })
    await userEvent.click(addBtn)
    expect(draftStore.upsert).toHaveBeenCalledOnce()
    const callArg = (draftStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArg.body).toBe('Potential XSS vulnerability here')
    expect(callArg.path).toBe('src/foo.ts')
    expect(callArg.line).toBe(2)
    expect(callArg.side).toBe('RIGHT')
  })

  it('"Add as draft" with null line uses line 1 (file-level)', async () => {
    const files = makeFiles(['src/foo.ts'])
    const draftStore = makeDraftStore()
    const review = makeSkillReview({
      state: {
        status: 'done',
        value: {
          skillName: 'Security Reviewer',
          findings: [
            { path: 'src/foo.ts', line: null, severity: 'low', body: 'file-level concern' },
          ],
        },
      },
    })
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore,
        skillReviews: [review],
      },
    })
    // A null-line (file-level) finding now lives ONLY in the reviewer-chip
    // popover (no separate "bottom" card). Open it, then Add as draft.
    await userEvent.click(screen.getByRole('button', { name: /Show 1 finding from Security Reviewer/i }))
    const addBtn = screen.getByRole('button', { name: /add as draft/i })
    await userEvent.click(addBtn)
    expect(draftStore.upsert).toHaveBeenCalledOnce()
    const callArg = (draftStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArg.line).toBe(1)
  })

  it('"Dismiss" hides the finding', async () => {
    const files = makeFiles(['src/foo.ts'])
    const review = makeSkillReview()
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    expect(screen.getByText('Potential XSS vulnerability here')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => {
      expect(screen.queryByText('Potential XSS vulnerability here')).not.toBeInTheDocument()
    })
  })

  it('does not render annotations when skillReviews is empty', () => {
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [],
      },
    })
    expect(screen.queryByRole('button', { name: /add as draft/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// "No findings" all-clear state (v10 anti-fatigue) — fixture-based
// A calibrated reviewer returning zero findings must render a one-line
// all-clear chip, with no finding cards and no awkward empty blocks.
// ---------------------------------------------------------------------------

describe('InspectStep — no-findings all-clear state (v10)', () => {
  /** Raw model output fixture, exactly as a calibrated persona emits it. */
  const NO_FINDINGS_FIXTURE = '{"skillName":"Security Reviewer","findings":[]}'

  function makeAllClearReview(): SkillReviewEntry {
    return {
      skillId: 'skill-clean',
      name: 'Security Reviewer',
      state: { status: 'done', value: JSON.parse(NO_FINDINGS_FIXTURE) },
    }
  }

  it('renders the one-line "no significant issues" chip for an empty findings array', () => {
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [makeAllClearReview()],
      },
    })
    expect(screen.getByText(/no significant issues/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Done, no significant issues')).toBeInTheDocument()
  })

  it('does not render the "0 findings" wording', () => {
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [makeAllClearReview()],
      },
    })
    expect(screen.queryByText(/0 findings/i)).not.toBeInTheDocument()
  })

  it('renders no finding cards or action buttons for a clean run', () => {
    const files = makeFiles(['src/foo.ts'])
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [makeAllClearReview()],
      },
    })
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add as draft/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument()
    // Guard: the removed gray "{persona}: N suggestions" summary chip stays gone.
    expect(screen.queryByText(/suggestion/i)).not.toBeInTheDocument()
  })

  it('counted chip still appears for personas WITH findings alongside an all-clear persona', () => {
    const files = makeFiles(['src/foo.ts'])
    const withFindings = makeSkillReview() // 1 high finding on src/foo.ts
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [makeAllClearReview(), { ...withFindings, name: 'Performance Reviewer', state: { status: 'done', value: { skillName: 'Performance Reviewer', findings: [{ path: 'src/foo.ts', line: 2, severity: 'low', body: 'Minor allocation in loop' }] } } }],
      },
    })
    expect(screen.getByText(/no significant issues/i)).toBeInTheDocument()
    expect(screen.getByText(/1 finding/i)).toBeInTheDocument()
  })

  it('findings outside the PR collapse to the all-clear chip too (filtered count is 0)', () => {
    const files = makeFiles(['src/foo.ts'])
    const ghostReview = makeSkillReview({
      state: {
        status: 'done',
        value: {
          skillName: 'Security Reviewer',
          findings: [{ path: 'src/ghost.ts', line: 1, severity: 'high', body: 'not in this PR' }],
        },
      },
    })
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [ghostReview],
      },
    })
    expect(screen.getByText(/no significant issues/i)).toBeInTheDocument()
    expect(screen.queryByText('not in this PR')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Ask AI on popover (file-level) findings
// ---------------------------------------------------------------------------

describe('InspectStep — Ask AI on popover findings', () => {
  function fileLevelReview(): SkillReviewEntry {
    return makeSkillReview({
      state: {
        status: 'done',
        value: {
          skillName: 'Security Reviewer',
          findings: [{ path: 'src/foo.ts', line: null, severity: 'low', body: 'file-level concern' }],
        },
      },
    })
  }

  it('no Ask AI button in the popover when askFn is absent', async () => {
    render(InspectStep, {
      props: {
        files: makeFiles(['src/foo.ts']), changedFiles: 1, mode: 'unified', onmode: () => {},
        draftStore: null, skillReviews: [fileLevelReview()],
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /Show 1 finding from Security Reviewer/i }))
    expect(screen.queryByTestId('popover-ask-btn')).not.toBeInTheDocument()
  })

  it('shows an Ask AI button in the popover when askFn is provided, and submits a focus grounded with the finding text', async () => {
    const askFn = vi.fn(async (_q: string, onDelta: (t: string) => void) => {
      onDelta('answer')
      return { ok: true as const, answer: 'Grounded answer.' }
    })
    render(InspectStep, {
      props: {
        files: makeFiles(['src/foo.ts']), changedFiles: 1, mode: 'unified', onmode: () => {},
        draftStore: null, skillReviews: [fileLevelReview()], askFn,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /Show 1 finding from Security Reviewer/i }))
    await userEvent.click(screen.getByTestId('popover-ask-btn'))
    await userEvent.type(screen.getByTestId('ask-box-input'), 'why does it matter?')
    await userEvent.click(screen.getByTestId('ask-box-send'))

    expect(askFn).toHaveBeenCalledOnce()
    const [q, , focus] = askFn.mock.calls[0]
    expect(q).toBe('why does it matter?')
    expect(focus).toMatchObject({ path: 'src/foo.ts', line: 1, finding: 'file-level concern' })
    expect(await screen.findByTestId('ask-box-answer')).toBeInTheDocument()
  })
})
