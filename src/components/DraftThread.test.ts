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
    // Leave comment button should be visible
    expect(screen.getByRole('button', { name: /leave comment/i })).toBeInTheDocument()
  })

  it('new draft: typing body and clicking Leave comment saves as draft', async () => {
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
    await user.click(screen.getByRole('button', { name: /leave comment/i }))
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

  it('new draft: Leave comment button is disabled when body is empty', () => {
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
    expect(screen.getByRole('button', { name: /leave comment/i })).toBeDisabled()
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
    await user.click(screen.getByRole('button', { name: /leave comment/i }))
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
// Multi-line: startLine / range label in header
// ---------------------------------------------------------------------------

describe('DraftThread — multi-line startLine', () => {
  it('shows "Lines {start}–{end}" when draft has startLine < line', () => {
    const draft: Draft = {
      ...baseDraft,
      line: 10,
      startLine: 7,
    }
    render(DraftThread, {
      props: {
        draft,
        path: 'src/a.ts',
        line: 10,
        side: 'RIGHT',
        onsave: vi.fn(),
        ondelete: vi.fn(),
        oncancel: vi.fn(),
      },
    })
    expect(screen.getByText(/lines 7.{1,3}10/i)).toBeInTheDocument()
  })

  it('shows "Comment at line {n}" when no startLine (single-line)', () => {
    render(DraftThread, {
      props: {
        draft: baseDraft,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave: vi.fn(),
        ondelete: vi.fn(),
        oncancel: vi.fn(),
      },
    })
    expect(screen.getByText(/comment at line 5/i)).toBeInTheDocument()
  })

  it('startLine prop passed to new draft mode shows from-line input', () => {
    render(DraftThread, {
      props: {
        draft: null,
        path: 'src/a.ts',
        line: 10,
        side: 'RIGHT',
        startLine: 7,
        onsave: vi.fn(),
        ondelete: vi.fn(),
        oncancel: vi.fn(),
      },
    })
    // Should display a range label in the header
    expect(screen.getByText(/lines 7.{1,3}10/i)).toBeInTheDocument()
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

// ---------------------------------------------------------------------------
// DraftThread — Action row buttons (Feature 1: replaces tab UI)
// ---------------------------------------------------------------------------

describe('DraftThread — action row (Leave comment / Ask AI / Cancel buttons)', () => {
  /** A resolved askFn stub that returns a successful answer */
  function makeAskFn(answer = 'Test answer from AI') {
    return vi.fn(async (_q: string, onDelta: (t: string) => void, _focus?: unknown) => {
      onDelta(answer)
      return { ok: true as const, answer }
    })
  }

  const baseProps = {
    draft: null as Draft | null,
    path: 'src/a.ts',
    line: 10,
    side: 'RIGHT' as const,
    onsave: vi.fn(),
    ondelete: vi.fn(),
    oncancel: vi.fn(),
  }

  // --- No tab bar anymore ---

  it('without askFn: no tab bar rendered (no Comment/Ask AI tabs)', () => {
    render(DraftThread, { props: baseProps })
    expect(screen.queryByRole('tab', { name: /comment/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /ask ai/i })).not.toBeInTheDocument()
  })

  it('with askFn: no tab bar rendered (tabs replaced by action row buttons)', () => {
    render(DraftThread, {
      props: { ...baseProps, askFn: makeAskFn() },
    })
    // Tabs must NOT be present — this is the key change from PR #24
    expect(screen.queryByRole('tab', { name: /comment/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /ask ai/i })).not.toBeInTheDocument()
  })

  // --- Single editor surface with action buttons at the bottom ---

  it('without askFn: shows Leave comment + Cancel buttons (no Ask AI button)', () => {
    render(DraftThread, { props: baseProps })
    expect(screen.getByRole('button', { name: /leave comment/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument()
  })

  it('with askFn: shows Leave comment + Ask AI + Cancel buttons in the action row', () => {
    render(DraftThread, {
      props: { ...baseProps, askFn: makeAskFn() },
    })
    expect(screen.getByRole('button', { name: /leave comment/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ask ai/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('Leave comment button is disabled when textarea is empty', () => {
    render(DraftThread, {
      props: { ...baseProps, askFn: makeAskFn() },
    })
    expect(screen.getByRole('button', { name: /leave comment/i })).toBeDisabled()
  })

  it('Ask AI button is disabled when textarea is empty', () => {
    render(DraftThread, {
      props: { ...baseProps, askFn: makeAskFn() },
    })
    expect(screen.getByRole('button', { name: /ask ai/i })).toBeDisabled()
  })

  it('typing then clicking Leave comment calls onsave with the textarea text', async () => {
    const user = userEvent.setup()
    const onsave = vi.fn()
    render(DraftThread, {
      props: { ...baseProps, onsave, askFn: makeAskFn() },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'My review comment')
    await user.click(screen.getByRole('button', { name: /leave comment/i }))
    expect(onsave).toHaveBeenCalledOnce()
    expect(onsave).toHaveBeenCalledWith('My review comment')
  })

  it('typing then clicking Ask AI sends the same textarea text as a question', async () => {
    const user = userEvent.setup()
    const askFn = makeAskFn('The answer is 42.')
    render(DraftThread, {
      props: { ...baseProps, askFn },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'Why is this here?')
    await user.click(screen.getByRole('button', { name: /ask ai/i }))
    expect(askFn).toHaveBeenCalledOnce()
    expect(askFn.mock.calls[0][0]).toBe('Why is this here?')
  })

  it('Ask AI streams answer below the textarea', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: { ...baseProps, askFn: makeAskFn('AI says: hello') },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'My question')
    await user.click(screen.getByRole('button', { name: /ask ai/i }))
    await vi.waitFor(() => {
      expect(screen.getByTestId('ask-answer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('ask-answer').textContent).toContain('AI says: hello')
  })

  it('textarea stays filled after Ask AI so user can leave a follow-up comment', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: { ...baseProps, askFn: makeAskFn('The reason is XYZ.') },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'Why is this here?')
    await user.click(screen.getByRole('button', { name: /ask ai/i }))
    // Wait for the answer
    await vi.waitFor(() => {
      expect(screen.getByTestId('ask-answer')).toBeInTheDocument()
    })
    // Textarea should still have the text (not cleared)
    expect((textarea as HTMLTextAreaElement).value).toBe('Why is this here?')
  })

  it('Ctrl+Enter triggers Leave comment (saves draft)', async () => {
    const user = userEvent.setup()
    const onsave = vi.fn()
    render(DraftThread, {
      props: { ...baseProps, onsave, askFn: makeAskFn() },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'Quick comment')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(onsave).toHaveBeenCalledWith('Quick comment')
  })

  it('Cancel closes the widget (calls oncancel)', async () => {
    const user = userEvent.setup()
    const oncancel = vi.fn()
    render(DraftThread, {
      props: { ...baseProps, oncancel, askFn: makeAskFn() },
    })
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(oncancel).toHaveBeenCalledOnce()
  })

  it('askFn receives focus with correct path, line, and excerpt', async () => {
    const user = userEvent.setup()
    const askFn = makeAskFn()
    render(DraftThread, {
      props: { ...baseProps, path: 'src/b.ts', line: 55, askFn, excerpt: '-old\n+new' },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'question')
    await user.click(screen.getByRole('button', { name: /ask ai/i }))
    expect(askFn.mock.calls[0][2]).toEqual({
      path: 'src/b.ts',
      line: 55,
      excerpt: '-old\n+new',
    })
  })

  it('copy answer button is shown after answer completes', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: { ...baseProps, askFn: makeAskFn('Finished answer') },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'q')
    await user.click(screen.getByRole('button', { name: /ask ai/i }))
    await vi.waitFor(() => {
      expect(screen.getByTestId('copy-answer-btn')).toBeInTheDocument()
    })
  })

  it('askDisabledReason: Ask AI button is disabled and reason is shown', async () => {
    render(DraftThread, {
      props: {
        ...baseProps,
        askFn: makeAskFn(),
        askDisabledReason: 'No API key configured.',
      },
    })
    // Ask AI button should be disabled
    expect(screen.getByRole('button', { name: /ask ai/i })).toBeDisabled()
    // Disabled hint text should be shown
    expect(screen.getByTestId('ask-disabled-hint')).toHaveTextContent('No API key configured.')
  })

  it('existing draft view (read mode with Edit/Delete) shows no action row buttons', () => {
    render(DraftThread, {
      props: {
        draft: baseDraft,
        path: 'src/a.ts',
        line: 5,
        side: 'RIGHT',
        onsave: vi.fn(),
        ondelete: vi.fn(),
        oncancel: vi.fn(),
        askFn: makeAskFn(),
      },
    })
    // In read mode, the action row buttons should NOT be present
    expect(screen.queryByRole('button', { name: /leave comment/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument()
    // Only Edit and Delete should be present (the existing view mode buttons)
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Ask-flow integration: the TYPED comment text lands in the constructed
// ask prompt (via the askFn DI seam + the real askPrompt builder), and the
// concision instruction is present in the system prompt.
// ---------------------------------------------------------------------------

import { askPrompt } from '../lib/ai/tasks'
import type { AskFocus } from '../lib/ai/tasks'
import type { PackedContext } from '../lib/context/pack'

describe('DraftThread — typed text flows into the ask prompt (DI seam)', () => {
  const ctx: PackedContext = { text: 'packed PR context', notAnalyzed: [], includedFiles: [] }

  it('clicking Ask AI builds a prompt containing the typed text and the concision instruction', async () => {
    const user = userEvent.setup()
    let captured: { system: string; user: string } | null = null

    // askFn DI seam wired through the REAL prompt builder, like run.ask does.
    const askFn = vi.fn(async (q: string, onDelta: (t: string) => void, focus?: AskFocus) => {
      captured = askPrompt(ctx, [], q, focus)
      onDelta('answer')
      return { ok: true as const, answer: 'answer' }
    })

    render(DraftThread, {
      props: {
        draft: null,
        path: 'src/a.ts',
        line: 7,
        side: 'RIGHT' as const,
        onsave: vi.fn(),
        ondelete: vi.fn(),
        oncancel: vi.fn(),
        askFn,
        excerpt: '-removed\n+added',
      },
    })

    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'Does this handle the empty case?')
    await user.click(screen.getByRole('button', { name: /ask ai/i }))

    await vi.waitFor(() => expect(askFn).toHaveBeenCalledOnce())
    expect(captured).not.toBeNull()
    // The typed text IS the question in the prompt
    expect(captured!.user).toContain('Does this handle the empty case?')
    // Line/hunk-excerpt grounding is retained
    expect(captured!.system).toContain('src/a.ts:7')
    expect(captured!.user).toContain('-removed\n+added')
    // Concision instruction is present
    expect(captured!.system).toMatch(/very concise/i)
    expect(captured!.system).toMatch(/2[-–]4 sentences/i)
  })
})

// ---------------------------------------------------------------------------
// AI-authored 🤖 badge
// ---------------------------------------------------------------------------
describe('DraftThread — AI-authored badge', () => {
  it('renders the 🤖 badge with the reviewer name for an AI-authored draft', () => {
    const draft: Draft = { ...baseDraft, aiAuthored: true, aiReviewer: 'Security' }
    render(DraftThread, {
      props: { draft, path: 'src/a.ts', line: 5, side: 'RIGHT', onsave: vi.fn(), ondelete: vi.fn(), oncancel: vi.fn() },
    })
    const badge = screen.getByTestId('draft-ai-badge')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute('aria-label', expect.stringContaining('Security'))
  })

  it('does NOT render the badge for a hand-written draft', () => {
    render(DraftThread, {
      props: { draft: baseDraft, path: 'src/a.ts', line: 5, side: 'RIGHT', onsave: vi.fn(), ondelete: vi.fn(), oncancel: vi.fn() },
    })
    expect(screen.queryByTestId('draft-ai-badge')).not.toBeInTheDocument()
  })
})
