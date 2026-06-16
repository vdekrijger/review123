/**
 * Placement tests for skill-reviewer findings (line anchoring contract):
 *
 * - A finding WITH a resolvable line anchor (line present in the patch hunks)
 *   renders INLINE at that line, inside the DiffView extend row
 *   (.diff-line-extend → .line-findings), in both unified and split modes.
 * - A finding with NO anchor (line=null) renders above the file (file-level).
 * - A finding whose anchor is NOT present in the current diff falls back to
 *   the per-file block (.skill-findings-annotations) with a labeled line note.
 * - A finding NEVER renders in both places.
 * - Add-as-draft / Dismiss work from every placement.
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

// New-file lines: 1 "line1" (context), 2 "line2new" (+), 3 "line3" (context)
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

function renderInspect(reviews: SkillReviewEntry[], opts: { draftStore?: ReturnType<typeof createDraftStore> | null; mode?: 'unified' | 'split' } = {}) {
  return render(InspectStep, {
    props: {
      files: [makeFile('src/foo.ts')],
      changedFiles: 1,
      mode: opts.mode ?? 'unified',
      onmode: () => {},
      draftStore: opts.draftStore ?? null,
      skillReviews: reviews,
    },
  })
}

// ---------------------------------------------------------------------------
// Placement: anchored → inline at line; unanchored → per-file block; never both
// ---------------------------------------------------------------------------

describe('Finding placement — anchored findings render inline at their line', () => {
  it('anchored finding (line in diff) renders inside a DiffView extend row in unified mode', () => {
    const { container } = renderInspect([makeLineReview(2, 'Anchored finding body')])
    const inline = container.querySelector('.diff-line-extend .line-findings .skill-finding')
    expect(inline).toBeTruthy()
    expect(inline?.textContent).toContain('Anchored finding body')
  })

  it('anchored finding renders inside a DiffView extend row in split mode', () => {
    const { container } = renderInspect([makeLineReview(2, 'Anchored split body')], { mode: 'split' })
    const inline = container.querySelector('.diff-line-extend .line-findings .skill-finding')
    expect(inline).toBeTruthy()
    expect(inline?.textContent).toContain('Anchored split body')
  })

  it('anchored finding is keyed to its line (data-line-findings attribute)', () => {
    const { container } = renderInspect([makeLineReview(2, 'At line two')])
    const lineFindings = container.querySelector('[data-line-findings="2"]')
    expect(lineFindings).toBeTruthy()
    expect(lineFindings?.textContent).toContain('At line two')
  })

  it('anchored finding does NOT appear in the per-file fallback block', () => {
    const { container } = renderInspect([makeLineReview(2, 'Inline only body')])
    expect(container.querySelector('.skill-findings-annotations')).toBeNull()
  })

  it('anchored finding renders exactly once (never both placements)', () => {
    const { container } = renderInspect([makeLineReview(2, 'Render me once')])
    const cards = [...container.querySelectorAll('.skill-finding')].filter(
      el => el.textContent?.includes('Render me once'),
    )
    expect(cards.length).toBe(1)
  })

  it('anchored finding is NOT rendered above the file', () => {
    const { container } = renderInspect([makeLineReview(2, 'Not above the file')])
    expect(container.querySelector('.file-level-finding')).toBeNull()
  })
})

describe('Finding placement — unanchored findings fall back to the per-file block', () => {
  it('finding with line NOT in the diff renders in .skill-findings-annotations', () => {
    const { container } = renderInspect([makeLineReview(999, 'Unanchored finding body')])
    const block = container.querySelector('.skill-findings-annotations .skill-finding')
    expect(block).toBeTruthy()
    expect(block?.textContent).toContain('Unanchored finding body')
  })

  it('unanchored finding does NOT render inline in any extend row', () => {
    const { container } = renderInspect([makeLineReview(999, 'Block only body')])
    expect(container.querySelector('.line-findings')).toBeNull()
  })

  it('unanchored finding renders exactly once (never both placements)', () => {
    const { container } = renderInspect([makeLineReview(999, 'Fallback once')])
    const cards = [...container.querySelectorAll('.skill-finding')].filter(
      el => el.textContent?.includes('Fallback once'),
    )
    expect(cards.length).toBe(1)
  })

  it('unanchored finding shows a labeled line note ("not in this diff")', () => {
    renderInspect([makeLineReview(999, 'Where does this go')])
    expect(screen.getByText(/line 999 — not in this diff/i)).toBeInTheDocument()
  })

  it('file-level (null-line) finding renders above the FileDiff', () => {
    const { container } = renderInspect([makeLineReview(null, 'File-level concern stays above')])
    const above = container.querySelector('.file-level-finding .skill-finding')
    expect(above).toBeTruthy()
    expect(above?.textContent).toContain('File-level concern stays above')
    // ...and nowhere else
    const cards = [...container.querySelectorAll('.skill-finding')]
    expect(cards.length).toBe(1)
  })

  it('mixed findings split placements: anchored inline, null-line above, off-diff in block', () => {
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
            { path: 'src/foo.ts', line: 500, severity: 'high', body: 'Off-diff finding' },
          ],
        },
      },
    }
    const { container } = renderInspect([review])
    expect(container.querySelector('[data-line-findings="3"]')?.textContent).toContain('Line 3 finding')
    expect(container.querySelector('.file-level-finding')?.textContent).toContain('File level concern')
    expect(container.querySelector('.skill-findings-annotations')?.textContent).toContain('Off-diff finding')
    // each rendered exactly once
    for (const body of ['Line 3 finding', 'File level concern', 'Off-diff finding']) {
      const cards = [...container.querySelectorAll('.skill-finding')].filter(
        el => el.textContent?.includes(body),
      )
      expect(cards.length).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Actions from each placement
// ---------------------------------------------------------------------------

describe('Finding actions — Add as draft / Dismiss', () => {
  it('Add-as-draft from an inline (anchored) finding calls draftStore.upsert with line+side', async () => {
    const draftStore = makeDraftStore()
    renderInspect([makeLineReview(2, 'Add this line finding as draft')], { draftStore })
    const addBtn = screen.getByRole('button', { name: /add as draft/i })
    await userEvent.click(addBtn)
    expect(draftStore.upsert).toHaveBeenCalledOnce()
    const arg = (draftStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.body).toBe('Add this line finding as draft')
    expect(arg.path).toBe('src/foo.ts')
    expect(arg.line).toBe(2)
    expect(arg.side).toBe('RIGHT')
  })

  it('Add-as-draft auto-hides the finding card (cleanup — the draft now lives in the diff)', async () => {
    const draftStore = makeDraftStore()
    renderInspect([makeLineReview(2, 'Auto-hide after add')], { draftStore })
    expect(screen.getByText('Auto-hide after add')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    // Adding records an ACCEPT and creates the draft; the now-redundant finding
    // card is hidden so the reviewer surface stays clean (NOT a dismiss).
    await waitFor(() => {
      expect(screen.queryByText('Auto-hide after add')).not.toBeInTheDocument()
    })
  })

  it('Dismiss from an inline (anchored) finding hides it', async () => {
    renderInspect([makeLineReview(2, 'Finding to dismiss from inside diff')])
    expect(screen.getByText('Finding to dismiss from inside diff')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => {
      expect(screen.queryByText('Finding to dismiss from inside diff')).not.toBeInTheDocument()
    })
  })

  it('Dismiss from a fallback-block (unanchored) finding hides it', async () => {
    renderInspect([makeLineReview(999, 'Dismiss the fallback finding')])
    expect(screen.getByText('Dismiss the fallback finding')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => {
      expect(screen.queryByText('Dismiss the fallback finding')).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// FileDiff-level: skillFindings prop placement
// ---------------------------------------------------------------------------

describe('FileDiff — skillFindings prop placement', () => {
  const file = makeFile('src/foo.ts')

  function finding(line: number, body: string, severity: 'high' | 'medium' | 'low' = 'high') {
    return { skillName: 'Security', line, severity, body, key: `k:${line}:${body}` }
  }

  it('renders an anchored finding inline (extend row), not in the fallback block', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [finding(2, 'XSS risk detected')] },
    })
    expect(container.querySelector('.diff-line-extend .skill-finding')).toBeTruthy()
    expect(container.querySelector('.skill-findings-annotations')).toBeNull()
  })

  it('renders an unanchored finding in the fallback block, not inline', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [finding(999, 'Mystery line')] },
    })
    expect(container.querySelector('.skill-findings-annotations .skill-finding')).toBeTruthy()
    expect(container.querySelector('.line-findings')).toBeNull()
  })

  it('two findings on the same anchored line render in the same extend row', () => {
    const { container } = render(FileDiff, {
      props: {
        file,
        mode: 'unified',
        skillFindings: [finding(2, 'First on line 2'), finding(2, 'Second on line 2', 'low')],
      },
    })
    const row = container.querySelector('[data-line-findings="2"]')
    expect(row?.textContent).toContain('First on line 2')
    expect(row?.textContent).toContain('Second on line 2')
  })

  it('no skill findings: no Add-as-draft button rendered', () => {
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [] },
    })
    expect(screen.queryByRole('button', { name: /add as draft/i })).not.toBeInTheDocument()
  })

  it('Add-as-draft calls onAddSkillFindingDraft callback', async () => {
    const onAddSkillFindingDraft = vi.fn().mockResolvedValue(undefined)
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [finding(2, 'Draft from FileDiff')], onAddSkillFindingDraft },
    })
    await userEvent.click(screen.getByRole('button', { name: /add as draft/i }))
    expect(onAddSkillFindingDraft).toHaveBeenCalledOnce()
    const arg = (onAddSkillFindingDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.body).toBe('Draft from FileDiff')
    expect(arg.line).toBe(2)
  })

  it('Dismiss hides an inline finding within FileDiff', async () => {
    render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [finding(2, 'Dismiss me in FileDiff')] },
    })
    expect(screen.getByText('Dismiss me in FileDiff')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => {
      expect(screen.queryByText('Dismiss me in FileDiff')).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Draft placement parity — anchored drafts inline, unanchored in block
// ---------------------------------------------------------------------------

describe('FileDiff — draft annotation placement parity', () => {
  const file = makeFile('src/foo.ts')

  function draft(line: number, body: string) {
    return { prKey: 'k', path: 'src/foo.ts', line, side: 'RIGHT' as const, body, updatedAt: 1 }
  }

  it('anchored draft renders inline in an extend row, not in the fallback block', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', drafts: [draft(2, 'Inline draft body')] },
    })
    expect(container.querySelector('.diff-line-extend .draft-annotations')).toBeTruthy()
    // No fallback block (the only .draft-annotations is the inline one)
    const blocks = container.querySelectorAll('.draft-annotations')
    expect(blocks.length).toBe(1)
    expect(blocks[0].closest('.diff-line-extend')).toBeTruthy()
  })

  it('unanchored draft renders in the fallback block below the diff', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', drafts: [draft(999, 'Orphan draft body')] },
    })
    const blocks = container.querySelectorAll('.draft-annotations')
    expect(blocks.length).toBe(1)
    expect(blocks[0].closest('.diff-line-extend')).toBeNull()
    expect(blocks[0].textContent).toContain('Orphan draft body')
  })

  it('a draft never renders in both placements', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', drafts: [draft(2, 'Single placement draft')] },
    })
    const threads = [...container.querySelectorAll('[data-testid="draft-thread"]')].filter(
      el => el.textContent?.includes('Single placement draft'),
    )
    expect(threads.length).toBe(1)
  })
})
