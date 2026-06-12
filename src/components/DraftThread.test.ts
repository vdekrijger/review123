import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import DraftThread from './DraftThread.svelte'
import type { Draft } from '../lib/drafts/drafts.svelte'

const baseDraft: Draft = {
  prKey: 'owner/repo#1@sha',
  path: 'src/a.ts',
  line: 5,
  side: 'RIGHT',
  body: 'This looks wrong',
  updatedAt: Date.now(),
}

describe('DraftThread', () => {
  let onsave: (body: string) => void
  let ondelete: () => void
  let oncancel: () => void

  beforeEach(() => {
    onsave = vi.fn<(body: string) => void>()
    ondelete = vi.fn<() => void>()
    oncancel = vi.fn<() => void>()
  })

  it('new draft: shows CommentEditor in write mode (no existing body)', () => {
    render(DraftThread, {
      props: {
        draft: null,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    // Should show the textarea for writing
    expect(screen.getByRole('textbox', { name: /comment body/i })).toBeInTheDocument()
    // Save button should be visible
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
  })

  it('new draft: typing body and clicking Save calls onsave with body', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: {
        draft: null,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'Great catch!')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onsave).toHaveBeenCalledOnce()
    expect(onsave).toHaveBeenCalledWith('Great catch!')
  })

  it('new draft: Cancel calls oncancel', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: {
        draft: null,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(oncancel).toHaveBeenCalledOnce()
    expect(onsave).not.toHaveBeenCalled()
  })

  it('new draft: Save button is disabled when body is empty', () => {
    render(DraftThread, {
      props: {
        draft: null,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('existing draft: renders markdown body in view mode', () => {
    const { container } = render(DraftThread, {
      props: {
        draft: baseDraft,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    // View mode: body should be rendered (as paragraph element inside .draft-body)
    expect(container.querySelector('.draft-body')).toBeInTheDocument()
    expect(container.querySelector('.draft-body')!.textContent).toContain('This looks wrong')
    // Should show Edit and Delete buttons
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
    // No textarea in view mode
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('existing draft: clicking Edit switches to editor with existing body', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: {
        draft: baseDraft,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    await user.click(screen.getByRole('button', { name: /edit/i }))
    // Now editor should be visible with existing body
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    expect(textarea).toBeInTheDocument()
    expect((textarea as HTMLTextAreaElement).value).toBe(baseDraft.body)
  })

  it('existing draft: clicking Delete calls ondelete', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: {
        draft: baseDraft,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    await user.click(screen.getByRole('button', { name: /delete/i }))
    expect(ondelete).toHaveBeenCalledOnce()
  })

  it('existing draft: editing and saving calls onsave with new body', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: {
        draft: baseDraft,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    await user.click(screen.getByRole('button', { name: /edit/i }))
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.clear(textarea)
    await user.type(textarea, 'Updated comment')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onsave).toHaveBeenCalledOnce()
    expect(onsave).toHaveBeenCalledWith('Updated comment')
  })

  it('existing draft: Cancel in edit mode goes back to view mode (no oncancel call)', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: {
        draft: baseDraft,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    await user.click(screen.getByRole('button', { name: /edit/i }))
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    // Should be back to view mode with Edit/Delete
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    // oncancel should NOT be called (it's for new draft cancellation)
    expect(oncancel).not.toHaveBeenCalled()
  })

  it('shows the line number in the header', () => {
    render(DraftThread, {
      props: {
        draft: null,
        path: 'src/a.ts',
        line: 42,
        side: 'LEFT',
        onsave,
        ondelete,
        oncancel,
      },
    })
    expect(screen.getByText(/line 42/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Fix-B: widget stays open with saved draft view (EC-FIX-B-01)
// ---------------------------------------------------------------------------

describe('DraftThread — Fix-B widget stays open after save (EC-FIX-B-01)', () => {
  it('when draft prop changes from null to a saved draft, shows read view without re-editing', async () => {
    const savedDraft: Draft = {
      prKey: 'owner/repo#1@sha',
      path: 'src/a.ts',
      line: 5,
      side: 'RIGHT',
      body: 'My saved comment',
      n: 0,
      updatedAt: Date.now(),
    }

    // First render with draft=null (new comment mode)
    const result = render(DraftThread, {
      props: {
        draft: null,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave: vi.fn(),
        ondelete: vi.fn(),
        oncancel: vi.fn(),
      },
    })

    // Simulate parent setting draft after save (widget-stays-open behavior)
    await result.rerender({
      draft: savedDraft,
      path: 'src/a.ts',
      line: 5,
      side: 'RIGHT',
      onsave: vi.fn(),
      ondelete: vi.fn(),
      oncancel: vi.fn(),
    })

    // Should show the saved draft body (read view)
    const draftBody = result.container.querySelector('.draft-body')
    expect(draftBody).toBeInTheDocument()
    expect(draftBody!.textContent).toContain('My saved comment')
    // Edit and Delete buttons should be present
    expect(result.container.querySelector('[data-testid="draft-thread"]')).toBeInTheDocument()
  })
})
