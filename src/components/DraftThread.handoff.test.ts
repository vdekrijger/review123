/**
 * DraftThread — a note's fate, shown where the words are.
 *
 * A reviewer can hand their own drafted note to their coding agent and then
 * withdraw it from the review. The panel where that happens is only on screen
 * while a bridge is paired, so if this widget did not carry the state and the
 * way back, "reversible" would depend on a bridge being plugged in.
 *
 * Two properties, both of them promises rather than details:
 *   - a withdrawn note is VISIBLE. Dimmed and struck through, never hidden:
 *     hiding somebody's words is the one thing a withdrawal must not look like;
 *   - the way back is one click, HERE, and it restores the stored body rather
 *     than anything this widget reconstructed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import DraftThread from './DraftThread.svelte'
import type { Draft } from '../lib/drafts/drafts.svelte'

const baseDraft: Draft = {
  prKey: 'github:o/r#1',
  path: 'src/a.ts',
  line: 5,
  side: 'RIGHT',
  body: 'Use a Map here — this linear scan runs inside the render loop.',
  updatedAt: Date.now(),
}

function commonProps() {
  return {
    path: 'src/a.ts',
    line: 5,
    side: 'RIGHT' as const,
    onsave: vi.fn<(body: string) => void>(),
    ondelete: vi.fn<() => void>(),
    oncancel: vi.fn<() => void>(),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('DraftThread — a note handed to the agent', () => {
  it('says nothing at all about a note that was never sent', () => {
    render(DraftThread, { props: { ...commonProps(), draft: baseDraft } })

    expect(screen.queryByTestId('draft-handoff')).toBeNull()
    expect(screen.queryByTestId('draft-restore')).toBeNull()
    expect(screen.getByTestId('draft-thread')).toHaveAttribute('data-handoff', 'none')
  })

  it('marks a sent note without implying anything happened to the review', () => {
    render(DraftThread, { props: { ...commonProps(), draft: { ...baseDraft, handoff: 'sent' } } })

    const chip = screen.getByTestId('draft-handoff')
    expect(chip.textContent).toBe('sent to your agent')
    expect(chip).toHaveAttribute('data-handoff', 'sent')
    expect(chip.getAttribute('title')).toMatch(/still part of your review/)
    // No "fixed", no "resolved", and no way back offered — there is nothing to
    // come back from.
    expect(screen.queryByTestId('draft-restore')).toBeNull()
    expect(screen.queryByTestId('draft-withdrawn-note')).toBeNull()
  })

  it('shows a withdrawn note struck through, never hidden, with its words intact', () => {
    render(DraftThread, { props: { ...commonProps(), draft: { ...baseDraft, handoff: 'withdrawn' } } })

    expect(screen.getByTestId('draft-thread')).toHaveAttribute('data-handoff', 'withdrawn')
    expect(screen.getByTestId('draft-handoff').textContent).toBe('withdrawn')
    // The words are on screen, exactly as written.
    expect(screen.getByTestId('draft-thread').textContent).toContain('Use a Map here')
    const note = screen.getByTestId('draft-withdrawn-note')
    expect(note.textContent).toMatch(/will not be posted/)
    expect((note.textContent ?? '').replace(/\s+/g, ' ')).toMatch(/kept exactly as you wrote them/)
  })

  it('puts it back by re-saving the STORED body, not anything reconstructed here', async () => {
    const props = { ...commonProps(), draft: { ...baseDraft, handoff: 'withdrawn' as const } }
    render(DraftThread, { props })

    await userEvent.click(screen.getByTestId('draft-restore'))

    // One call, with the body the store holds. The store lifts the withdrawal
    // on any save, so the undo needs no second mechanism to keep in sync.
    expect(props.onsave).toHaveBeenCalledTimes(1)
    expect(props.onsave).toHaveBeenCalledWith(baseDraft.body)
  })

  it('keeps Edit and Delete exactly where they were', async () => {
    const props = { ...commonProps(), draft: { ...baseDraft, handoff: 'withdrawn' as const } }
    render(DraftThread, { props })

    expect(screen.getByText('Edit')).toBeTruthy()
    await userEvent.click(screen.getByText('Delete'))
    expect(props.ondelete).toHaveBeenCalledTimes(1)
  })

  it('shows a kept note as sent — the chip reports the handoff, not the verdict', () => {
    render(DraftThread, { props: { ...commonProps(), draft: { ...baseDraft, handoff: 'kept' } } })

    expect(screen.getByTestId('draft-handoff')).toHaveAttribute('data-handoff', 'kept')
    expect(screen.getByTestId('draft-handoff').textContent).toBe('sent to your agent')
    expect(screen.queryByTestId('draft-withdrawn-note')).toBeNull()
  })
})
