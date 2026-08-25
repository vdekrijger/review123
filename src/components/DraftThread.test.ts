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

// ---------------------------------------------------------------------------
// Expand — terse-note expander (preview with Use / Keep my note)
// ---------------------------------------------------------------------------

describe('DraftThread — Expand (terse-note expander)', () => {
  type ExpandResult = { ok: true; comment: string } | { ok: false; error: string; errorDetail?: string }

  /** A resolved expandFn stub that streams then returns an expanded comment. */
  function makeExpandFn(comment = 'This arrow-chain is hard to follow — extract a named helper.') {
    return vi.fn(async (_note: string, onDelta: (t: string) => void, _focus: { path: string; line: number; side: 'LEFT' | 'RIGHT' }): Promise<ExpandResult> => {
      onDelta(comment)
      return { ok: true as const, comment }
    })
  }

  /** An expandFn stub that stays pending until `resolve` is called. */
  function makeDeferredExpandFn() {
    let resolveFn: ((r: ExpandResult) => void) | null = null
    const fn = vi.fn(
      (_note: string, _onDelta: (t: string) => void, _focus: unknown) =>
        new Promise<ExpandResult>((resolve) => { resolveFn = resolve }),
    )
    return { fn, resolve: (r: ExpandResult) => resolveFn?.(r) }
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

  it('without expandFn: no Expand button', async () => {
    const user = userEvent.setup()
    render(DraftThread, { props: baseProps })
    await user.type(screen.getByRole('textbox', { name: /comment body/i }), 'note')
    expect(screen.queryByTestId('expand-btn')).not.toBeInTheDocument()
  })

  it('with expandFn but EMPTY composer: Expand is hidden (visible only with text)', () => {
    render(DraftThread, { props: { ...baseProps, expandFn: makeExpandFn() } })
    expect(screen.queryByTestId('expand-btn')).not.toBeInTheDocument()
  })

  it('with expandFn and text: Expand is visible and enabled', async () => {
    const user = userEvent.setup()
    render(DraftThread, { props: { ...baseProps, expandFn: makeExpandFn() } })
    await user.type(screen.getByRole('textbox', { name: /comment body/i }), 'too clever')
    const btn = screen.getByTestId('expand-btn')
    expect(btn).toBeInTheDocument()
    expect(btn).toBeEnabled()
  })

  it('askDisabledReason (keyless): Expand is shown with text but disabled — same gating as Ask AI', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: { ...baseProps, expandFn: makeExpandFn(), askDisabledReason: 'No API key configured.' },
    })
    await user.type(screen.getByRole('textbox', { name: /comment body/i }), 'too clever')
    expect(screen.getByTestId('expand-btn')).toBeDisabled()
  })

  it('click Expand → calls expandFn with the note and the {path,line,side} focus', async () => {
    const user = userEvent.setup()
    const expandFn = makeExpandFn()
    render(DraftThread, {
      props: { ...baseProps, path: 'src/b.ts', line: 55, side: 'LEFT' as const, expandFn },
    })
    await user.type(screen.getByRole('textbox', { name: /comment body/i }), 'too clever, simplify')
    await user.click(screen.getByTestId('expand-btn'))
    expect(expandFn).toHaveBeenCalledOnce()
    expect(expandFn.mock.calls[0][0]).toBe('too clever, simplify')
    expect(expandFn.mock.calls[0][2]).toEqual({ path: 'src/b.ts', line: 55, side: 'LEFT' })
  })

  it('loading: composer text is PRESERVED and the button is disabled while running', async () => {
    const user = userEvent.setup()
    const { fn, resolve } = makeDeferredExpandFn()
    render(DraftThread, { props: { ...baseProps, expandFn: fn } })
    const textarea = screen.getByRole('textbox', { name: /comment body/i }) as HTMLTextAreaElement
    await user.type(textarea, 'too clever')
    await user.click(screen.getByTestId('expand-btn'))

    // In-flight: loading panel visible, composer untouched, button disabled
    expect(screen.getByTestId('expand-preview')).toBeInTheDocument()
    expect(textarea.value).toBe('too clever')
    expect(screen.getByTestId('expand-btn')).toBeDisabled()

    resolve({ ok: true, comment: 'Expanded.' })
    await vi.waitFor(() => expect(screen.getByTestId('expand-preview-body')).toBeInTheDocument())
  })

  it('success → preview shows the expanded comment (markdown-rendered) with Use and Keep my note', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: { ...baseProps, expandFn: makeExpandFn('Extract `parseRange` into a **named helper**.') },
    })
    await user.type(screen.getByRole('textbox', { name: /comment body/i }), 'too clever')
    await user.click(screen.getByTestId('expand-btn'))

    await vi.waitFor(() => expect(screen.getByTestId('expand-preview-body')).toBeInTheDocument())
    const body = screen.getByTestId('expand-preview-body')
    expect(body.textContent).toContain('Extract')
    // markdown rendered: `parseRange` became a <code> element, ** became <strong>
    expect(body.querySelector('code')).toBeTruthy()
    expect(body.querySelector('strong')).toBeTruthy()
    expect(screen.getByTestId('expand-use')).toBeInTheDocument()
    expect(screen.getByTestId('expand-keep')).toBeInTheDocument()
  })

  it('Use → expanded text replaces the composer content, preview closes, still editable (NOT saved)', async () => {
    const user = userEvent.setup()
    const onsave = vi.fn()
    render(DraftThread, {
      props: { ...baseProps, onsave, expandFn: makeExpandFn('The expanded comment.') },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i }) as HTMLTextAreaElement
    await user.type(textarea, 'too clever')
    await user.click(screen.getByTestId('expand-btn'))
    await vi.waitFor(() => expect(screen.getByTestId('expand-use')).toBeInTheDocument())

    await user.click(screen.getByTestId('expand-use'))

    expect(textarea.value).toBe('The expanded comment.')
    expect(screen.queryByTestId('expand-preview')).not.toBeInTheDocument()
    // Still editable before Save — nothing was saved yet.
    expect(onsave).not.toHaveBeenCalled()

    // Saving now saves the expanded text.
    await user.click(screen.getByRole('button', { name: /leave comment/i }))
    expect(onsave).toHaveBeenCalledWith('The expanded comment.')
  })

  it('Keep my note → preview dismissed, composer untouched', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: { ...baseProps, expandFn: makeExpandFn('The expanded comment.') },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i }) as HTMLTextAreaElement
    await user.type(textarea, 'my terse note')
    await user.click(screen.getByTestId('expand-btn'))
    await vi.waitFor(() => expect(screen.getByTestId('expand-keep')).toBeInTheDocument())

    await user.click(screen.getByTestId('expand-keep'))

    expect(screen.queryByTestId('expand-preview')).not.toBeInTheDocument()
    expect(textarea.value).toBe('my terse note')
  })

  it('Esc with the preview open = Keep my note', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: { ...baseProps, expandFn: makeExpandFn('The expanded comment.') },
    })
    const textarea = screen.getByRole('textbox', { name: /comment body/i }) as HTMLTextAreaElement
    await user.type(textarea, 'my terse note')
    await user.click(screen.getByTestId('expand-btn'))
    await vi.waitFor(() => expect(screen.getByTestId('expand-preview-body')).toBeInTheDocument())

    await user.keyboard('{Escape}')

    expect(screen.queryByTestId('expand-preview')).not.toBeInTheDocument()
    expect(textarea.value).toBe('my terse note')
  })

  it('error → calm inline error with errorDetail on hover (title), composer untouched, Retry re-runs', async () => {
    const user = userEvent.setup()
    const expandFn = vi.fn(async (): Promise<ExpandResult> => ({
      ok: false as const,
      error: 'Rate limited by DeepSeek. Please try again in a moment.',
      errorDetail: 'HTTP 429: too many requests',
    }))
    render(DraftThread, { props: { ...baseProps, expandFn } })
    const textarea = screen.getByRole('textbox', { name: /comment body/i }) as HTMLTextAreaElement
    await user.type(textarea, 'my note')
    await user.click(screen.getByTestId('expand-btn'))

    await vi.waitFor(() => expect(screen.getByTestId('expand-error')).toBeInTheDocument())
    const errorEl = screen.getByTestId('expand-error')
    expect(errorEl.textContent).toContain('Rate limited')
    expect(errorEl).toHaveAttribute('title', 'HTTP 429: too many requests')
    expect(textarea.value).toBe('my note')

    // Retry calls expandFn again with the same note
    await user.click(screen.getByTestId('expand-retry'))
    await vi.waitFor(() => expect(expandFn).toHaveBeenCalledTimes(2))
  })

  it('saving while an expansion is in flight discards the late result (no stale preview)', async () => {
    const user = userEvent.setup()
    const onsave = vi.fn()
    const { fn, resolve } = makeDeferredExpandFn()
    render(DraftThread, { props: { ...baseProps, onsave, expandFn: fn } })
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await user.type(textarea, 'my note')
    await user.click(screen.getByTestId('expand-btn'))
    expect(screen.getByTestId('expand-preview')).toBeInTheDocument()

    // Save the note while the expansion is still pending
    await user.click(screen.getByRole('button', { name: /leave comment/i }))
    expect(onsave).toHaveBeenCalledWith('my note')

    // The late resolution must NOT resurrect a preview
    resolve({ ok: true, comment: 'Too late.' })
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('expand-preview')).not.toBeInTheDocument()
  })

  it('a second Expand after Use expands the (edited) composer text, not the stale note', async () => {
    const user = userEvent.setup()
    const expandFn = makeExpandFn('First expansion.')
    render(DraftThread, { props: { ...baseProps, expandFn } })
    const textarea = screen.getByRole('textbox', { name: /comment body/i }) as HTMLTextAreaElement
    await user.type(textarea, 'note one')
    await user.click(screen.getByTestId('expand-btn'))
    await vi.waitFor(() => expect(screen.getByTestId('expand-use')).toBeInTheDocument())
    await user.click(screen.getByTestId('expand-use'))

    await user.click(screen.getByTestId('expand-btn'))
    expect(expandFn).toHaveBeenCalledTimes(2)
    expect(expandFn.mock.calls[1][0]).toBe('First expansion.')
  })
})
