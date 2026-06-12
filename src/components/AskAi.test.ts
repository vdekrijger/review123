/**
 * Tests for src/components/AskAi.svelte
 *
 * Covers:
 *  - submit flow with streaming stub
 *  - history renders (Q right-aligned, A rendered via MarkdownView)
 *  - Ctrl+Enter submits
 *  - no-key hint shown when disabledReason present
 *  - error + retry flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import AskAi from './AskAi.svelte'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../lib/analytics/analytics', () => ({
  track: vi.fn(),
  initAnalytics: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

vi.mock('../lib/settings/settings', () => ({
  getSettings: () => ({ railCollapsed: false }),
  setRailCollapsed: vi.fn(),
}))

// ---------------------------------------------------------------------------
// ask function stub factory
// ---------------------------------------------------------------------------

function makeAskStub(
  answer: string,
  delayMs = 0,
): (q: string, onDelta: (t: string) => void) => Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  return async (_q: string, onDelta: (t: string) => void) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    onDelta(answer)
    return { ok: true as const, answer }
  }
}

function makeErrorAskStub(
  errorMsg: string,
): (q: string, onDelta: (t: string) => void) => Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  return async (_q: string, _onDelta: (t: string) => void) => {
    return { ok: false as const, error: errorMsg }
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

describe('AskAi rendering', () => {
  it('renders the "Ask AI about this PR" section heading', () => {
    render(AskAi, { props: { ask: makeAskStub('answer') } })
    expect(screen.getByText(/ask ai about this pr/i)).toBeInTheDocument()
  })

  it('renders the textarea for entering a question', () => {
    render(AskAi, { props: { ask: makeAskStub('answer') } })
    // Section should be expandable; we need to find the textarea
    // It might be inside a collapsed <details> — click to open
    const details = document.querySelector('details.ask-ai-section')
    if (details) {
      ;(details as HTMLDetailsElement).open = true
    }
    const textarea = screen.getByRole('textbox')
    expect(textarea).toBeInTheDocument()
  })

  it('renders Ask button', () => {
    render(AskAi, { props: { ask: makeAskStub('answer') } })
    const details = document.querySelector('details.ask-ai-section')
    if (details) {
      ;(details as HTMLDetailsElement).open = true
    }
    const askBtn = screen.getByRole('button', { name: /ask/i })
    expect(askBtn).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Submit flow with streaming
// ---------------------------------------------------------------------------

describe('AskAi submit flow', () => {
  it('typing a question and clicking Ask calls ask prop with question', async () => {
    const user = userEvent.setup()
    const askSpy = vi.fn().mockImplementation(makeAskStub('The answer is here'))

    render(AskAi, { props: { ask: askSpy } })

    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    const textarea = screen.getByRole('textbox')
    await user.type(textarea, 'Why is this coded here?')

    const askBtn = screen.getByRole('button', { name: /ask/i })
    await user.click(askBtn)

    await waitFor(() => {
      expect(askSpy).toHaveBeenCalledWith(
        'Why is this coded here?',
        expect.any(Function),
      )
    })
  })

  it('answer text appears after ask completes', async () => {
    const user = userEvent.setup()

    render(AskAi, { props: { ask: makeAskStub('The answer is here') } })

    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    const textarea = screen.getByRole('textbox')
    await user.type(textarea, 'What does this do?')
    await user.click(screen.getByRole('button', { name: /ask/i }))

    await waitFor(() => {
      expect(screen.getByText(/the answer is here/i)).toBeInTheDocument()
    })
  })

  it('question appears in conversation list as plain text', async () => {
    const user = userEvent.setup()

    render(AskAi, { props: { ask: makeAskStub('Some answer') } })

    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    await user.type(screen.getByRole('textbox'), 'My specific question text')
    await user.click(screen.getByRole('button', { name: /ask/i }))

    await waitFor(() => {
      expect(screen.getByText('My specific question text')).toBeInTheDocument()
    })
  })

  it('textarea clears after submit', async () => {
    const user = userEvent.setup()

    render(AskAi, { props: { ask: makeAskStub('answer') } })

    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.type(textarea, 'What is this?')
    await user.click(screen.getByRole('button', { name: /ask/i }))

    await waitFor(() => {
      expect(textarea.value).toBe('')
    })
  })
})

// ---------------------------------------------------------------------------
// History renders (multiple Q/A pairs in view)
// ---------------------------------------------------------------------------

describe('AskAi conversation history', () => {
  it('shows multiple Q&A pairs after multiple questions', async () => {
    const user = userEvent.setup()

    let callCount = 0
    const ask = vi.fn().mockImplementation(async (q: string, onDelta: (t: string) => void) => {
      callCount++
      const answer = `Answer ${callCount}`
      onDelta(answer)
      return { ok: true as const, answer }
    })

    render(AskAi, { props: { ask } })

    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    const textarea = screen.getByRole('textbox')

    // First question
    await user.type(textarea, 'Question one')
    await user.click(screen.getByRole('button', { name: /ask/i }))
    await waitFor(() => expect(screen.getByText('Answer 1')).toBeInTheDocument())

    // Second question
    await user.type(screen.getByRole('textbox'), 'Question two')
    await user.click(screen.getByRole('button', { name: /ask/i }))
    await waitFor(() => expect(screen.getByText('Answer 2')).toBeInTheDocument())

    // Both questions should be visible
    expect(screen.getByText('Question one')).toBeInTheDocument()
    expect(screen.getByText('Question two')).toBeInTheDocument()
    expect(screen.getByText('Answer 1')).toBeInTheDocument()
    expect(screen.getByText('Answer 2')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Ctrl+Enter / Cmd+Enter keyboard shortcut
// ---------------------------------------------------------------------------

describe('AskAi Ctrl+Enter submits', () => {
  it('Ctrl+Enter triggers ask', async () => {
    const user = userEvent.setup()
    const askSpy = vi.fn().mockImplementation(makeAskStub('keyboard answer'))

    render(AskAi, { props: { ask: askSpy } })

    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    const textarea = screen.getByRole('textbox')
    await user.type(textarea, 'My keyboard question')
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => {
      expect(askSpy).toHaveBeenCalledWith('My keyboard question', expect.any(Function))
    })
  })
})

// ---------------------------------------------------------------------------
// disabledReason — no-key hint
// ---------------------------------------------------------------------------

describe('AskAi disabledReason / no-key hint', () => {
  it('shows disabledReason hint text when provided', () => {
    render(AskAi, { props: { ask: makeAskStub('answer'), disabledReason: 'No API key configured' } })
    expect(screen.getByText(/no api key configured/i)).toBeInTheDocument()
  })

  it('Ask button is disabled when disabledReason is set', () => {
    render(AskAi, { props: { ask: makeAskStub('answer'), disabledReason: 'No API key configured' } })
    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    const askBtn = screen.queryByRole('button', { name: /ask/i })
    // Either button is absent or is disabled
    if (askBtn) {
      expect(askBtn).toBeDisabled()
    } else {
      // Button not shown is also acceptable when disabled
      expect(askBtn).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// Error + retry
// ---------------------------------------------------------------------------

describe('AskAi error and retry', () => {
  it('shows error message when ask returns {ok:false}', async () => {
    const user = userEvent.setup()

    render(AskAi, { props: { ask: makeErrorAskStub('Something went wrong') } })

    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    await user.type(screen.getByRole('textbox'), 'a question')
    await user.click(screen.getByRole('button', { name: /ask/i }))

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
    })
  })

  it('retry button appears after error and re-submits the same question', async () => {
    const user = userEvent.setup()

    let callCount = 0
    const ask = vi.fn().mockImplementation(async (_q: string, onDelta: (t: string) => void) => {
      callCount++
      if (callCount === 1) return { ok: false as const, error: 'Network error' }
      onDelta('Retry answer')
      return { ok: true as const, answer: 'Retry answer' }
    })

    render(AskAi, { props: { ask } })

    const details = document.querySelector('details.ask-ai-section')
    if (details) (details as HTMLDetailsElement).open = true

    await user.type(screen.getByRole('textbox'), 'Retry question')
    await user.click(screen.getByRole('button', { name: /ask/i }))

    // Error shown
    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeInTheDocument()
    })

    // Retry button should appear
    const retryBtn = screen.getByRole('button', { name: /retry/i })
    await user.click(retryBtn)

    // After retry, answer should appear
    await waitFor(() => {
      expect(screen.getByText(/retry answer/i)).toBeInTheDocument()
    })
  })
})
