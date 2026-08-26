/**
 * Finding-triage wiring tests (InspectStep + FileDiff):
 *
 *   - secondary-tier findings never enter the inline extendData; they render as
 *     full cards inside ONE collapsed per-file "N more findings" group
 *   - cards inside the group are fully functional (Add as draft, Dismiss)
 *   - the review-level "Showing K of M findings" line + Show-all escape hatch
 *     (persisted per-browser, review123:findings-show-all)
 *   - Show all restores the pre-triage inline rendering
 *   - the inline budget spills the weakest primaries into the group
 *   - the reviewer-chip popover still lists ALL findings (navigation surface)
 *   - the simplify toggle works on secondary-tier cards too
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import type { SkillFinding as SchemaSkillFinding, FindingVerification } from '../lib/ai/schemas'
import type { createDraftStore } from '../lib/drafts/drafts.svelte'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

// New-file lines 1-12 exist in the hunk (10 added lines + 2 context).
const PATCH = '@@ -1,2 +1,12 @@\n line1\n+l2\n+l3\n+l4\n+l5\n+l6\n+l7\n+l8\n+l9\n+l10\n+l11\n line12'

function makeFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 10, deletions: 0, patch: PATCH }
}

function verification(confirmedBy: number, polledModels: number, surfaced: boolean): FindingVerification {
  return { confirmedBy, polledModels, surfaced, perModel: [] }
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

function review(findings: SchemaSkillFinding[], skillId = 'triage-rev', name = 'Mixed Reviewer'): SkillReviewEntry {
  return { skillId, name, state: { status: 'done', value: { skillName: name, findings } } }
}

function renderInspect(reviews: SkillReviewEntry[], opts: { draftStore?: ReturnType<typeof createDraftStore> | null } = {}) {
  return render(InspectStep, {
    props: {
      files: [makeFile('src/foo.ts')],
      changedFiles: 1,
      mode: 'unified',
      onmode: () => {},
      draftStore: opts.draftStore ?? null,
      skillReviews: reviews,
    },
  })
}

// A canonical mixed set: high unverified (inline), medium majority-verified
// (inline), low weakly-verified (collapsed), lone low unverified (collapsed).
const MIXED: SchemaSkillFinding[] = [
  { path: 'src/foo.ts', line: 2, severity: 'high', body: 'High severity real bug' },
  { path: 'src/foo.ts', line: 3, severity: 'medium', body: 'Verified medium issue', verification: verification(3, 3, true) },
  { path: 'src/foo.ts', line: 4, severity: 'low', body: 'Weak low nit', verification: verification(1, 3, false) },
  { path: 'src/foo.ts', line: 5, severity: 'low', body: 'Lone low note' },
]

describe('InspectStep triage — inline/collapsed split', () => {
  it('primary findings render inline; secondaries only in the collapsed group', () => {
    const { container } = renderInspect([review(MIXED)])

    // Inline extend rows carry EXACTLY the two primaries.
    const inline = [...container.querySelectorAll('.line-findings .skill-finding')]
    expect(inline.length).toBe(2)
    expect(inline.some((el) => el.textContent?.includes('High severity real bug'))).toBe(true)
    expect(inline.some((el) => el.textContent?.includes('Verified medium issue'))).toBe(true)

    // ONE collapsed group with the two secondaries, count in the summary.
    const groups = container.querySelectorAll('[data-testid="secondary-findings"]')
    expect(groups.length).toBe(1)
    expect(groups[0].querySelector('summary')?.textContent).toContain('2 more findings — low confidence or minor')
    expect(groups[0].textContent).toContain('Weak low nit')
    expect(groups[0].textContent).toContain('Lone low note')

    // Never both: each secondary body appears in exactly one card.
    for (const body of ['Weak low nit', 'Lone low note']) {
      const cards = [...container.querySelectorAll('.skill-finding')].filter((el) => el.textContent?.includes(body))
      expect(cards.length).toBe(1)
      expect(cards[0].closest('[data-testid="secondary-findings"]')).not.toBeNull()
    }
  })

  it('no secondaries → no group and no triage line', () => {
    const { container } = renderInspect([review(MIXED.slice(0, 2))])
    expect(container.querySelector('[data-testid="secondary-findings"]')).toBeNull()
    expect(container.querySelector('[data-testid="findings-triage-line"]')).toBeNull()
  })

  it('a covered-by-draft finding is always secondary, composing the #206 collapsed treatment inside the group', () => {
    const covered: SchemaSkillFinding = {
      path: 'src/foo.ts', line: 6, severity: 'high', body: 'Covered point',
      coveredByDraft: { path: 'src/foo.ts', line: 6 },
    }
    const { container } = renderInspect([review([covered])])
    const group = container.querySelector('[data-testid="secondary-findings"]')
    expect(group).not.toBeNull()
    // Inside the group the card still renders its covered-collapsed state.
    expect(group!.querySelector('.skill-finding.covered-collapsed')).not.toBeNull()
    expect(group!.textContent).toContain('covered by your comment on src/foo.ts:6')
    expect(container.querySelector('.line-findings')).toBeNull()
  })

  it('the reviewer-chip popover still lists ALL findings (navigation surface)', () => {
    renderInspect([review(MIXED)])
    expect(screen.getByRole('button', { name: /Show 4 findings from Mixed Reviewer/i })).toBeInTheDocument()
  })
})

describe('InspectStep triage — review-level line + Show all', () => {
  it('reports "Showing K of M findings · N minor or low-confidence collapsed"', () => {
    const { container } = renderInspect([review(MIXED)])
    const line = container.querySelector('[data-testid="findings-triage-line"]')
    expect(line?.textContent).toContain('Showing 2 of 4 findings')
    expect(line?.textContent).toContain('2 minor or low-confidence collapsed')
  })

  it('Show all renders every finding inline again and persists the choice', async () => {
    const { container } = renderInspect([review(MIXED)])
    const toggle = screen.getByTestId('findings-show-all')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(toggle)

    // Everything inline, no collapsed group.
    await waitFor(() => {
      expect(container.querySelectorAll('.line-findings .skill-finding').length).toBe(4)
    })
    expect(container.querySelector('[data-testid="secondary-findings"]')).toBeNull()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    // The line flips to the all-shown phrasing (still present as the way back).
    expect(container.querySelector('[data-testid="findings-triage-line"]')?.textContent).toContain('Showing all 4 findings')
    // Persisted per-browser.
    expect(JSON.parse(localStorage.getItem('review123:findings-show-all')!)).toEqual({ showAll: true })

    // Toggle back → triage returns.
    await userEvent.click(toggle)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="secondary-findings"]')).not.toBeNull()
    })
    expect(JSON.parse(localStorage.getItem('review123:findings-show-all')!)).toEqual({ showAll: false })
  })

  it('a persisted show-all=true renders everything inline from mount', () => {
    localStorage.setItem('review123:findings-show-all', JSON.stringify({ showAll: true }))
    const { container } = renderInspect([review(MIXED)])
    expect(container.querySelectorAll('.line-findings .skill-finding').length).toBe(4)
    expect(container.querySelector('[data-testid="secondary-findings"]')).toBeNull()
    expect(screen.getByTestId('findings-show-all').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('InspectStep triage — inline budget across the review', () => {
  it('spills unverified mediums past the budget of 8; the group and line report the spill', () => {
    const findings: SchemaSkillFinding[] = Array.from({ length: 10 }, (_, i) => ({
      path: 'src/foo.ts', line: i + 2, severity: 'medium' as const, body: `Medium finding ${i + 2}`,
    }))
    const { container } = renderInspect([review(findings)])
    expect(container.querySelectorAll('.line-findings .skill-finding').length).toBe(8)
    const group = container.querySelector('[data-testid="secondary-findings"]')
    expect(group?.querySelector('summary')?.textContent).toContain('2 more findings')
    const line = container.querySelector('[data-testid="findings-triage-line"]')
    expect(line?.textContent).toContain('Showing 8 of 10 findings')
  })

  it('never spills a high: 10 highs all render inline, no group', () => {
    const findings: SchemaSkillFinding[] = Array.from({ length: 10 }, (_, i) => ({
      path: 'src/foo.ts', line: i + 2, severity: 'high' as const, body: `High finding ${i + 2}`,
    }))
    const { container } = renderInspect([review(findings)])
    expect(container.querySelectorAll('.line-findings .skill-finding').length).toBe(10)
    expect(container.querySelector('[data-testid="secondary-findings"]')).toBeNull()
    expect(container.querySelector('[data-testid="findings-triage-line"]')).toBeNull()
  })

  it('dismissing an inline finding promotes a budget-spilled one back inline', async () => {
    const findings: SchemaSkillFinding[] = Array.from({ length: 9 }, (_, i) => ({
      path: 'src/foo.ts', line: i + 2, severity: 'medium' as const, body: `Medium finding ${i + 2}`,
    }))
    const { container } = renderInspect([review(findings)])
    expect(container.querySelectorAll('.line-findings .skill-finding').length).toBe(8)
    expect(container.querySelector('[data-testid="secondary-findings"]')).not.toBeNull()

    // Dismiss one inline card → 8 findings remain → all fit the budget.
    const firstInline = container.querySelector('.line-findings .skill-finding')!
    const dismiss = [...firstInline.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!
    await userEvent.click(dismiss)
    // Two-step dismiss (dismissal calibration): the reveal shows the plain Dismiss.
    const plainDismiss = [...firstInline.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!
    await userEvent.click(plainDismiss)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="secondary-findings"]')).toBeNull()
    })
    expect(container.querySelectorAll('.line-findings .skill-finding').length).toBe(8)
  })
})

describe('InspectStep triage — actions inside the collapsed group', () => {
  it('Add as draft from a group card upserts at the finding line and hides the card', async () => {
    const draftStore = makeDraftStore()
    const { container } = renderInspect([review(MIXED)], { draftStore })
    const group = container.querySelector('[data-testid="secondary-findings"]')!
    const card = [...group.querySelectorAll('.skill-finding')].find((el) => el.textContent?.includes('Weak low nit'))!
    const addBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Add as draft')!
    await userEvent.click(addBtn)
    expect(draftStore.upsert).toHaveBeenCalledOnce()
    const arg = (draftStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.body).toBe('Weak low nit')
    expect(arg.path).toBe('src/foo.ts')
    expect(arg.line).toBe(4)
    await waitFor(() => {
      expect(screen.queryByText('Weak low nit')).not.toBeInTheDocument()
    })
  })

  it('Dismiss from a group card hides it and updates the group count', async () => {
    const { container } = renderInspect([review(MIXED)])
    const group = container.querySelector('[data-testid="secondary-findings"]')!
    const card = [...group.querySelectorAll('.skill-finding')].find((el) => el.textContent?.includes('Lone low note'))!
    const dismiss = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!
    await userEvent.click(dismiss)
    // Two-step dismiss (dismissal calibration): the reveal shows the plain Dismiss.
    const plainDismiss = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!
    await userEvent.click(plainDismiss)
    await waitFor(() => {
      expect(screen.queryByText('Lone low note')).not.toBeInTheDocument()
    })
    expect(container.querySelector('[data-testid="secondary-findings"] summary')?.textContent)
      .toContain('1 more finding — low confidence or minor')
  })

  it('the simplify toggle works on a secondary-tier card', async () => {
    const withSimple: SchemaSkillFinding = {
      path: 'src/foo.ts', line: 4, severity: 'low', body: 'It is perhaps worth noting the original verbose text',
      simpleBody: 'Short plain rewrite.',
    }
    const { container } = renderInspect([review([withSimple])])
    const group = container.querySelector('[data-testid="secondary-findings"]')!
    expect(group.textContent).toContain('Short plain rewrite.')
    expect(group.textContent).not.toContain('original verbose text')
    await userEvent.click(screen.getByTestId('finding-simple-toggle'))
    expect(group.textContent).toContain('original verbose text')
  })
})

// ---------------------------------------------------------------------------
// FileDiff-level: the tier prop drives placement directly
// ---------------------------------------------------------------------------

describe('FileDiff — tier prop placement', () => {
  const file = makeFile('src/foo.ts')

  function finding(line: number, body: string, tier?: 'primary' | 'secondary') {
    return { skillName: 'Reviewer', line, severity: 'low' as const, body, key: `k:${line}:${body}`, ...(tier ? { tier } : {}) }
  }

  it('tier absent → classic inline placement (backward compatible)', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [finding(2, 'Untiered inline')] },
    })
    expect(container.querySelector('.line-findings .skill-finding')).toBeTruthy()
    expect(container.querySelector('[data-testid="secondary-findings"]')).toBeNull()
  })

  it('tier secondary → never in extendData, only in the collapsed group', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [finding(2, 'Collapsed one', 'secondary')] },
    })
    expect(container.querySelector('.line-findings')).toBeNull()
    const group = container.querySelector('[data-testid="secondary-findings"]')
    expect(group).not.toBeNull()
    expect(group!.textContent).toContain('Collapsed one')
    // A secondary anchored at a real diff line shows NO misleading off-diff note.
    expect(group!.textContent).not.toContain('not in this diff')
  })

  it('an OFF-DIFF secondary keeps its honest "not in this diff" note inside the group', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [finding(999, 'Off-diff collapsed', 'secondary')] },
    })
    const group = container.querySelector('[data-testid="secondary-findings"]')!
    expect(group.textContent).toContain('line 999 — not in this diff')
    // And the classic fallback block is NOT used for secondaries.
    expect(container.querySelector('.skill-findings-annotations')).toBeNull()
  })

  it('a secondary card keeps its drag handle (re-anchor works from the group)', () => {
    const { container } = render(FileDiff, {
      props: { file, mode: 'unified', skillFindings: [finding(2, 'Draggable secondary', 'secondary')] },
    })
    const group = container.querySelector('[data-testid="secondary-findings"]')!
    expect(group.querySelector('[data-testid="finding-drag-handle"]')).toBeTruthy()
    expect(group.querySelector('[data-testid="finding-move-btn"]')).toBeTruthy()
  })

  it('mixed tiers split correctly within one file', () => {
    const { container } = render(FileDiff, {
      props: {
        file,
        mode: 'unified',
        skillFindings: [finding(2, 'Primary card', 'primary'), finding(3, 'Secondary card', 'secondary')],
      },
    })
    expect(container.querySelector('.line-findings')?.textContent).toContain('Primary card')
    expect(container.querySelector('.line-findings')?.textContent).not.toContain('Secondary card')
    expect(container.querySelector('[data-testid="secondary-findings"]')?.textContent).toContain('Secondary card')
  })
})
