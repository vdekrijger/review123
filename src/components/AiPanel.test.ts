/**
 * AiPanel.test.ts — no-key hint (Plan F Task F3)
 *
 * The no-key hint must name the ACTIVE provider from settings and navigate
 * to the /settings page (not the retired modal anchor).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import AiPanel from './AiPanel.svelte'
import { setAiProvider, setAiModel, setShowTokenCost } from '../lib/settings/settings'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'
import { navigate } from '../lib/router/router.svelte'

vi.mock('../lib/router/router.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/router/router.svelte')>()
  return { ...actual, navigate: vi.fn() }
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  _resetSettingsStateForTest()
  vi.clearAllMocks()
})

function renderNoKey() {
  return render(AiPanel, {
    props: { title: 'Summary', task: 'summary', state: { status: 'no-key' as const }, onretry: vi.fn() },
  })
}

describe('AiPanel — no-key hint names the ACTIVE provider', () => {
  it('names DeepSeek by default', () => {
    renderNoKey()
    expect(screen.getByText(/add a deepseek key/i)).toBeInTheDocument()
  })

  it('names Anthropic when aiProvider=anthropic', () => {
    setAiProvider('anthropic')
    renderNoKey()
    expect(screen.getByText(/add an? anthropic key/i)).toBeInTheDocument()
    expect(screen.queryByText(/deepseek/i)).not.toBeInTheDocument()
  })

  it('names Gemini when aiProvider=gemini', () => {
    setAiProvider('gemini')
    renderNoKey()
    expect(screen.getByText(/add a gemini key/i)).toBeInTheDocument()
  })

  it('links to the /settings page', () => {
    renderNoKey()
    const link = screen.getByRole('link', { name: /settings/i })
    expect(link).toHaveAttribute('href', '/settings')
  })

  it('clicking the Settings link navigates to /settings and remembers returnTo', async () => {
    renderNoKey()
    await userEvent.click(screen.getByRole('link', { name: /settings/i }))
    expect(vi.mocked(navigate)).toHaveBeenCalledWith('/settings')
    expect(sessionStorage.getItem('review123:settingsReturnTo')).not.toBeNull()
  })
})

describe('AiPanel — pending skeleton from the FIRST render (no blank gap)', () => {
  it('renders the skeleton when status is idle (run not yet signalled loading)', () => {
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: { status: 'idle' as const }, onretry: vi.fn() },
    })
    expect(container.querySelector('.ai-panel-loading .skeleton-block')).not.toBeNull()
    // No spinner — content-shaped skeleton only
    expect(container.querySelector('.spinner')).toBeNull()
  })

  it('renders the skeleton when status is loading', () => {
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: { status: 'loading' as const }, onretry: vi.fn() },
    })
    expect(container.querySelector('.ai-panel-loading .skeleton-block')).not.toBeNull()
  })

  it('respects skeletonVariant="block" (diagrams shape)', () => {
    const { container } = render(AiPanel, {
      props: {
        title: 'Diagrams',
        task: 'diagrams' as const,
        state: { status: 'idle' as const },
        onretry: vi.fn(),
        skeletonVariant: 'block' as const,
      },
    })
    expect(container.querySelector('.ai-panel-loading .skeleton-rect')).not.toBeNull()
  })

  it('respects skeletonVariant="cards" (test coverage / alternatives shape)', () => {
    const { container } = render(AiPanel, {
      props: {
        title: 'Test coverage (AI-inferred)',
        task: 'tests' as const,
        state: { status: 'loading' as const },
        onretry: vi.fn(),
        skeletonVariant: 'cards' as const,
      },
    })
    expect(container.querySelectorAll('.ai-panel-loading .skeleton-card')).toHaveLength(2)
  })
})

describe('AiPanel — token usage footer (opt-in: settings.showTokenCost)', () => {
  const doneWithUsage = {
    status: 'done' as const,
    usage: { prompt_tokens: 8000, completion_tokens: 200, total_tokens: 8200 },
  }

  it('renders NOTHING when showTokenCost is off (default)', () => {
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: doneWithUsage, onretry: vi.fn() },
    })
    expect(container.querySelector('.ai-usage-footer')).toBeNull()
  })

  it('renders the $ then tokens (dollar-first) when on and the model has pricing', () => {
    setShowTokenCost(true)
    setAiProvider('anthropic')
    setAiModel('claude-sonnet-4-6') // $3/$15 per MTok → 8000*3/1e6 + 200*15/1e6 ≈ $0.027
    _resetSettingsStateForTest()
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: doneWithUsage, onretry: vi.fn() },
    })
    const footer = container.querySelector('.ai-usage-footer')
    expect(footer).not.toBeNull()
    expect(footer!.textContent).toContain('8.2k tokens')
    expect(footer!.textContent).toContain('$0.03')
    // Dollar-first: the $ value appears BEFORE the token count in the footer.
    const text = footer!.textContent!
    expect(text.indexOf('$0.03')).toBeLessThan(text.indexOf('8.2k tokens'))
  })

  it('still leads with the $ for a model with multi-cent cost (dollar-first)', () => {
    setShowTokenCost(true)
    setAiProvider('anthropic')
    // claude-opus-4-8 is priced ($5/$25 per MTok after the 2026-06-16 backfill):
    // 8000*5/1e6 + 200*25/1e6 = 0.04 + 0.005 = $0.045 → "$0.04".
    setAiModel('claude-opus-4-8')
    _resetSettingsStateForTest()
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: doneWithUsage, onretry: vi.fn() },
    })
    const footer = container.querySelector('.ai-usage-footer')
    expect(footer).not.toBeNull()
    const text = footer!.textContent!
    expect(text).toContain('8.2k tokens')
    expect(text).toContain('$0.04')
    expect(text.indexOf('$0.04')).toBeLessThan(text.indexOf('8.2k tokens'))
  })

  it('renders NOTHING for a cached task with no captured usage (graceful)', () => {
    setShowTokenCost(true)
    _resetSettingsStateForTest()
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: { status: 'done' as const }, onretry: vi.fn() },
    })
    expect(container.querySelector('.ai-usage-footer')).toBeNull()
  })

  it('does not show the footer for non-done states even with usage', () => {
    setShowTokenCost(true)
    _resetSettingsStateForTest()
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: { status: 'loading' as const, usage: doneWithUsage.usage }, onretry: vi.fn() },
    })
    expect(container.querySelector('.ai-usage-footer')).toBeNull()
  })
})

describe('AiPanel — disabled state (Plan J)', () => {
  it('renders a compact "Disabled — enable in AI settings" link, NOT a skeleton', () => {
    const { container } = render(AiPanel, {
      props: { title: 'Diagrams', task: 'diagrams', state: { status: 'disabled' as const }, onretry: vi.fn() },
    })
    expect(screen.getByText(/disabled/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /enable in ai settings/i })).toBeInTheDocument()
    // No skeleton / spinner / loading affordance.
    expect(container.querySelector('.ai-panel-loading')).toBeNull()
    expect(container.querySelector('.skeleton')).toBeNull()
  })

  it('the settings link navigates to /settings (preserving return-to)', async () => {
    render(AiPanel, {
      props: { title: 'Diagrams', task: 'diagrams', state: { status: 'disabled' as const }, onretry: vi.fn() },
    })
    await userEvent.click(screen.getByRole('link', { name: /enable in ai settings/i }))
    expect(vi.mocked(navigate)).toHaveBeenCalledWith('/settings')
    expect(sessionStorage.getItem('review123:settingsReturnTo')).not.toBeNull()
  })
})

describe('AiPanel — error state shows the concrete detail under the canned line', () => {
  const ERROR_STATE = {
    status: 'error' as const,
    error: 'DeepSeek server error. Please try again later.',
    errorDetail: 'Server error (503): upstream model overloaded',
  }

  it('renders the detail muted+small when present', () => {
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: ERROR_STATE, onretry: vi.fn() },
    })
    expect(screen.getByText('DeepSeek server error. Please try again later.')).toBeInTheDocument()
    const detail = container.querySelector('.error-detail')
    expect(detail?.textContent).toBe('Server error (503): upstream model overloaded')
    // Retry stays available.
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('renders NO detail line when errorDetail is absent (unchanged legacy error UI)', () => {
    const { container } = render(AiPanel, {
      props: {
        title: 'Summary',
        task: 'summary',
        state: { status: 'error' as const, error: 'DeepSeek server error. Please try again later.' },
        onretry: vi.fn(),
      },
    })
    expect(container.querySelector('.error-detail')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cancelled state (fix/abort-handling)
//
// The reported bug rendered an internal cancellation as the ERROR state: a
// role="alert" block, the browser's "The user aborted a request." as the detail
// line, and a Retry button — i.e. "the user aborted the request, please click
// to try again", for a user who aborted nothing. 'cancelled' is the calm state
// that replaces it.
// ---------------------------------------------------------------------------

describe('AiPanel — cancelled state is calm, not an error', () => {
  const CANCELLED = { status: 'cancelled' as const }

  it('renders a muted cancelled line with NO alert role and NO error styling', () => {
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: CANCELLED, onretry: vi.fn() },
    })
    expect(container.querySelector('.ai-panel-cancelled')).not.toBeNull()
    expect(container.querySelector('.ai-panel-error')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('.error-msg')).toBeNull()
    expect(container.querySelector('.error-detail')).toBeNull()
  })

  it('offers no error-styled Retry button — a plain "run again" link instead', () => {
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: CANCELLED, onretry: vi.fn() },
    })
    expect(container.querySelector('.retry-btn')).toBeNull()
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /run again/i })).toBeInTheDocument()
  })

  it('never shows the spinner/skeleton (the task is not running)', () => {
    const { container } = render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: CANCELLED, onretry: vi.fn() },
    })
    expect(container.querySelector('.ai-panel-loading')).toBeNull()
  })

  it('"run again" re-runs the task through the normal retry path', async () => {
    const onretry = vi.fn()
    render(AiPanel, {
      props: { title: 'Summary', task: 'summary', state: CANCELLED, onretry },
    })
    await userEvent.click(screen.getByRole('button', { name: /run again/i }))
    expect(onretry).toHaveBeenCalledOnce()
  })
})
