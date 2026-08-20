/**
 * Multi-drafts-per-line regression tests (user report: "if there are 2 comments
 * on the same line, adding the second one just removes the first").
 *
 * Root cause: the draft store ALREADY supports multiple drafts per line via the
 * ordinal `n` in the draftKey (`prKey|path|line|side|n`) and the `n=-1` append
 * sentinel in `upsert()` — but the UI callers never passed it:
 *   - InspectStep.handleAddDraft / addFindingAsDraft called
 *     `upsert({ path, line, side, body })` with no `n`, which defaults to the
 *     n=0 slot → last-write-wins → the second comment CLOBBERED the first.
 *   - FileDiff's extendData held ONE `draft` per line (`entry.draft = d`
 *     overwrites in the loop), so even coexisting drafts rendered as one.
 *
 * These tests reproduce the clobber at the user-visible level:
 *   1. store-level through InspectStep: a manual draft exists at a line; the
 *      user clicks "Add as draft" on an AI finding at the SAME line → both
 *      drafts must survive.
 *   2. render-level through FileDiff: two drafts at the same line must BOTH be
 *      visible in the inline annotation row, ordered by n, each independently
 *      removable.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import FileDiff from './FileDiff.svelte'
import { createDraftStore } from '../lib/drafts/drafts.svelte'
import type { Draft } from '../lib/drafts/drafts.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import 'fake-indexeddb/auto'

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
    writable: true,
  })
})

// New-file (RIGHT) lines: 1 "line1" (context), 2 "line2new" (+), 3 "line3" (context)
const PATCH = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2new\n line3'

function makeFile(filename = 'src/foo.ts'): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 1, patch: PATCH }
}

function makeLineReview(line: number, body: string): SkillReviewEntry {
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

let dbCounter = 0
function realStore(prKey: string) {
  return createDraftStore(prKey, `review123-drafts-multidraft-${Date.now()}-${++dbCounter}`)
}

// ---------------------------------------------------------------------------
// 1. Adding never clobbers — "Add as draft" on a line that already has a draft
// ---------------------------------------------------------------------------

describe('multi-drafts per line — adding never clobbers (InspectStep)', () => {
  it('Add-as-draft on a line with an existing manual draft APPENDS — the manual draft survives', async () => {
    const prKey = 'testorg/testrepo#7'
    const store = realStore(prKey)
    await store.load()

    // The user's FIRST comment at line 2 — saved exactly as the UI saves a new
    // manual comment (first draft at a location lands at n=0).
    await store.upsert({ path: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'Manual first comment' })
    expect(store.count).toBe(1)

    render(InspectStep, {
      props: {
        files: [makeFile()],
        changedFiles: 1,
        mode: 'unified' as const,
        onmode: () => {},
        draftStore: store,
        skillReviews: [makeLineReview(2, 'AI finding at the same line')],
      },
    })

    // The user clicks "Add as draft" on the AI finding anchored at the SAME line.
    const addBtn = screen.getByRole('button', { name: /add as draft/i })
    await userEvent.click(addBtn)

    // BOTH comments must now exist as drafts — the second ADD must never
    // overwrite the first (the reported bug: count stayed 1, manual body gone).
    await waitFor(() => {
      expect(store.count).toBe(2)
    })
    const bodies = store.drafts.map((d) => d.body)
    expect(bodies).toContain('Manual first comment')
    expect(bodies).toContain('AI finding at the same line')

    // The two drafts occupy distinct ordinals at the same anchor.
    const at = store.draftsAt('src/foo.ts', 2, 'RIGHT')
    expect(at).toHaveLength(2)
    expect(at[0].n ?? 0).toBe(0)
    expect(at[1].n ?? 0).toBe(1)
    // AI attribution is per-draft: manual stays clean, finding-draft is flagged.
    expect(at[0].aiAuthored ?? false).toBe(false)
    expect(at[1].aiAuthored).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Rendering — the extend row stacks EVERY draft at a line
// ---------------------------------------------------------------------------

describe('multi-drafts per line — FileDiff renders the whole stack', () => {
  const twoDrafts: Draft[] = [
    { prKey: 'o/r#1', path: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'FIRST draft body', n: 0 },
    { prKey: 'o/r#1', path: 'src/foo.ts', line: 2, side: 'RIGHT', body: 'SECOND draft body', n: 1 },
  ]

  it('both drafts at the same line are visible inline (ordered by n)', async () => {
    const { container } = render(FileDiff, {
      props: { file: makeFile(), mode: 'unified', drafts: twoDrafts },
    })

    await waitFor(() => {
      const threads = container.querySelectorAll('[data-testid="inline-annotations"] [data-testid="draft-thread"]')
      expect(threads.length).toBe(2)
    })
    const text = container.textContent ?? ''
    expect(text).toContain('FIRST draft body')
    expect(text).toContain('SECOND draft body')
    // Ordered by n: first before second
    expect(text.indexOf('FIRST draft body')).toBeLessThan(text.indexOf('SECOND draft body'))
  })

  it('each stacked draft is independently removable (delete passes the draft ordinal)', async () => {
    const onRemoveDraft = vi.fn()
    const { container } = render(FileDiff, {
      props: { file: makeFile(), mode: 'unified', drafts: twoDrafts, onRemoveDraft },
    })

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="inline-annotations"] [data-testid="draft-thread"]').length).toBe(2)
    })

    // Delete the SECOND draft (n=1) — the callback must identify it by ordinal
    // so the parent removes exactly that draft, not the first at the line.
    const threads = [...container.querySelectorAll('[data-testid="inline-annotations"] [data-testid="draft-thread"]')]
    const second = threads.find((t) => t.textContent?.includes('SECOND draft body'))!
    const deleteBtn = [...second.querySelectorAll('button')].find((b) => /delete/i.test(b.textContent ?? ''))!
    await userEvent.click(deleteBtn)

    expect(onRemoveDraft).toHaveBeenCalledTimes(1)
    expect(onRemoveDraft.mock.calls[0][0]).toBe(2) // line
    expect(onRemoveDraft.mock.calls[0][1]).toBe('RIGHT') // side
    expect(onRemoveDraft.mock.calls[0][2]).toBe(1) // n — the SECOND draft's ordinal
  })
})
