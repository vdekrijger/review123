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
import { setAiProvider } from '../lib/settings/settings'
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
    props: { title: 'Summary', state: { status: 'no-key' as const }, onretry: vi.fn() },
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
