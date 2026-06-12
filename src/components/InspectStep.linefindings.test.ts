/**
 * Tests for Fix 2: Skill findings anchored at their lines.
 *
 * - Findings with a numeric `line` are passed to FileDiff as a new `skillFindings` prop
 *   and rendered inside FileDiff's annotation area (NOT above the file in InspectStep).
 * - Findings with line=null keep the above-file placement in InspectStep.
 * - FileDiff renders line-bearing findings with dashed-accent style, severity chip, persona,
 *   Add-as-draft / Dismiss buttons — same visual style as before, now at the line.
 * - Add-as-draft from within FileDiff still calls draftStore.upsert via InspectStep handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import type { createDraftStore } from '../lib/drafts/drafts.svelte'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2new\n line3'

function makeFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 1, patch: PATCH }
}

function makeDraftStore(): ReturnType<typeof createDraftStore> {
  const upsert = vi.fn().mockResolvedValue(undefined)
  return {
    get drafts() { return [] },
    get count() { return 0 },
    get persistent() { return false },
    upsert,
    remove: vi.fn(),
    clearAll: vi.fn(),
    load: vi.fn(),
    draftsAt: vi.fn().mockReturnValue([]),
  }
}

function makeLineReview(line: number | null, body = 'Line-level finding here'): SkillReviewEntry {
  return {
    skillId: 'skill-line',
    name: 'Security',
    state: {
      status: 'done',
      value: {
        skillName: 'Security',
        findings: [{ path: 'src/foo.ts', line, severity: 'high', body }],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Fix 2: Line findings passed to FileDiff — InspectStep level
// ---------------------------------------------------------------------------

describe('InspectStep — line-bearing findings routed to FileDiff (Fix 2)', () => {
  it('line finding is NOT rendered above the file in InspectStep', () => {
    const files = [makeFile('src/foo.ts')]
    const review = makeLineReview(2, 'Should be inside diff, not above')
    const { container } = render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    // The above-file findings container (skill-finding) should NOT be in the diff-column
    // ABOVE the FileDiff component. The finding body should appear (inside FileDiff) but
    // the stacked-above .skill-finding div should not be a sibling of FileDiff.
    const diffColumn = container.querySelector('.diff-column')
    // The .skill-finding (above-file) should not appear as a direct-child element of the file wrapper
    // before the FileDiff article — the line finding should be inside the FileDiff article
    const fileArticle = container.querySelector('article.file-diff')
    expect(fileArticle).toBeInTheDocument()

    // The skill-finding div should NOT appear as a sibling BEFORE the article
    // (it should be inside the article or not at all at the top level)
    // We'll check: no .skill-finding is a previous sibling of the file-diff article
    const fileWrapper = fileArticle?.parentElement
    const skillFindingBeforeFile = fileWrapper
      ? Array.from(fileWrapper.children).filter(
          child => child.classList.contains('skill-finding')
        )
      : []
    expect(skillFindingBeforeFile.length).toBe(0)
  })

  it('file-level (null-line) finding IS still rendered above the FileDiff as .skill-finding', () => {
    const files = [makeFile('src/foo.ts')]
    const review = makeLineReview(null, 'File-level concern stays above')
    const { container } = render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    // null-line findings remain as .skill-finding elements above the FileDiff
    const fileArticle = container.querySelector('article.file-diff')
    const fileWrapper = fileArticle?.parentElement
    const aboveFileFinding = fileWrapper
      ? Array.from(fileWrapper.children).find(
          child => child.classList.contains('skill-finding')
        )
      : undefined
    expect(aboveFileFinding).toBeTruthy()
    expect(aboveFileFinding?.textContent).toContain('File-level concern stays above')
  })

  it('line finding body text appears in the rendered output (inside FileDiff area)', () => {
    const files = [makeFile('src/foo.ts')]
    const review = makeLineReview(2, 'Unique line finding text XYZ')
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    expect(screen.getByText('Unique line finding text XYZ')).toBeInTheDocument()
  })

  it('Add-as-draft from line finding (inside FileDiff) still calls draftStore.upsert', async () => {
    const files = [makeFile('src/foo.ts')]
    const draftStore = makeDraftStore()
    const review = makeLineReview(2, 'Add this line finding as draft')
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore,
        skillReviews: [review],
      },
    })
    const addBtn = screen.getByRole('button', { name: /add as draft/i })
    await userEvent.click(addBtn)
    expect(draftStore.upsert).toHaveBeenCalledOnce()
    const arg = (draftStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.body).toBe('Add this line finding as draft')
    expect(arg.path).toBe('src/foo.ts')
    expect(arg.line).toBe(2)
    expect(arg.side).toBe('RIGHT')
  })

  it('Dismiss from line finding (inside FileDiff) hides the finding', async () => {
    const files = [makeFile('src/foo.ts')]
    const review = makeLineReview(2, 'Finding to dismiss from inside diff')
    render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    expect(screen.getByText('Finding to dismiss from inside diff')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => {
      expect(screen.queryByText('Finding to dismiss from inside diff')).not.toBeInTheDocument()
    })
  })

  it('multiple findings: line-bearing ones are NOT in above-file area', () => {
    const files = [makeFile('src/foo.ts')]
    const review: SkillReviewEntry = {
      skillId: 'multi',
      name: 'Reviewer',
      state: {
        status: 'done',
        value: {
          skillName: 'Reviewer',
          findings: [
            { path: 'src/foo.ts', line: 3, severity: 'medium', body: 'Line 3 finding' },
            { path: 'src/foo.ts', line: null, severity: 'low', body: 'File level concern' },
          ],
        },
      },
    }
    const { container } = render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null,
        skillReviews: [review],
      },
    })
    const fileArticle = container.querySelector('article.file-diff')
    const fileWrapper = fileArticle?.parentElement
    const aboveFileFindings = fileWrapper
      ? Array.from(fileWrapper.children).filter(
          child => child.classList.contains('skill-finding')
        )
      : []
    // Only file-level (null-line) findings should appear above
    expect(aboveFileFindings.length).toBe(1)
    expect(aboveFileFindings[0].textContent).toContain('File level concern')
  })
})

// ---------------------------------------------------------------------------
// Fix 2: FileDiff receives and renders skill findings at lines
// ---------------------------------------------------------------------------

describe('FileDiff — skillFindings prop (Fix 2)', () => {
  const file = makeFile('src/foo.ts')

  it('renders a skill finding when skillFindings prop has a line-bearing entry', () => {
    const skillFindings = [{
      skillName: 'Security',
      line: 2,
      severity: 'high' as const,
      body: 'XSS risk detected',
      key: 'key1',
    }]
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings },
    })
    expect(screen.getByText('XSS risk detected')).toBeInTheDocument()
  })

  it('renders severity chip for skill finding', () => {
    const skillFindings = [{
      skillName: 'Perf',
      line: 2,
      severity: 'medium' as const,
      body: 'N+1 query detected',
      key: 'key2',
    }]
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings },
    })
    expect(screen.getByText('medium')).toBeInTheDocument()
  })

  it('renders persona label for skill finding', () => {
    const skillFindings = [{
      skillName: 'Perf Reviewer',
      line: 2,
      severity: 'low' as const,
      body: 'Consider caching',
      key: 'key3',
    }]
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings },
    })
    const labels = screen.getAllByText(/Perf Reviewer/i)
    expect(labels.length).toBeGreaterThan(0)
  })

  it('renders Add-as-draft and Dismiss buttons for skill finding', () => {
    const skillFindings = [{
      skillName: 'Security',
      line: 2,
      severity: 'high' as const,
      body: 'Finding with actions',
      key: 'key4',
    }]
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings },
    })
    expect(screen.getByRole('button', { name: /add as draft/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
  })

  it('no skill findings: no Add-as-draft button rendered', () => {
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [] },
    })
    expect(screen.queryByRole('button', { name: /add as draft/i })).not.toBeInTheDocument()
  })

  it('skill finding has dashed-border style (skill-finding class)', () => {
    const skillFindings = [{
      skillName: 'Security',
      line: 2,
      severity: 'high' as const,
      body: 'Needs fix',
      key: 'key5',
    }]
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', skillFindings },
    })
    expect(container.querySelector('.skill-finding')).toBeInTheDocument()
  })

  it('Dismiss button hides the finding within FileDiff', async () => {
    const skillFindings = [{
      skillName: 'Security',
      line: 2,
      severity: 'high' as const,
      body: 'Dismiss me in FileDiff',
      key: 'dismiss-key',
    }]
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings },
    })
    expect(screen.getByText('Dismiss me in FileDiff')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => {
      expect(screen.queryByText('Dismiss me in FileDiff')).not.toBeInTheDocument()
    })
  })

  it('Add-as-draft calls onAddSkillFindingDraft callback', async () => {
    const onAddSkillFindingDraft = vi.fn().mockResolvedValue(undefined)
    const skillFindings = [{
      skillName: 'Security',
      line: 2,
      severity: 'high' as const,
      body: 'Draft from FileDiff',
      key: 'draft-key',
    }]
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings, onAddSkillFindingDraft },
    })
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAddSkillFindingDraft).toHaveBeenCalledOnce()
    const arg = (onAddSkillFindingDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.body).toBe('Draft from FileDiff')
    expect(arg.line).toBe(2)
  })
})
