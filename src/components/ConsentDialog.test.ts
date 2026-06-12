import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import ConsentDialog from './ConsentDialog.svelte'
import { setAiProvider } from '../lib/settings/settings'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'

beforeEach(() => {
  localStorage.clear()
  _resetSettingsStateForTest()
})

describe('ConsentDialog', () => {
  it('renders dialog with repo name and explanation', () => {
    render(ConsentDialog, { props: { repo: 'owner/private', onresult: vi.fn() } })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/owner\/private/)).toBeInTheDocument()
    expect(screen.getByText(/sent to DeepSeek/i)).toBeInTheDocument()
  })

  it('accept button calls onresult(true)', async () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/private', onresult } })
    await userEvent.click(screen.getByRole('button', { name: /Send code to/i }))
    expect(onresult).toHaveBeenCalledWith(true)
  })

  it('decline button ("Not now") calls onresult(false)', async () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/private', onresult } })
    await userEvent.click(screen.getByRole('button', { name: /Not now/i }))
    expect(onresult).toHaveBeenCalledWith(false)
  })

  it('Esc key (native cancel event) calls onresult(false)', async () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/private', onresult } })
    const dialog = screen.getByRole('dialog')
    // Real modal dialogs fire a 'cancel' event (not keydown) when Esc is pressed
    dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }))
    expect(onresult).toHaveBeenCalledWith(false)
  })

  it('mentions the repo name in the explanation text', () => {
    render(ConsentDialog, { props: { repo: 'acme/secret-app', onresult: vi.fn() } })
    expect(screen.getByText(/acme\/secret-app/)).toBeInTheDocument()
  })

  describe('provider-aware copy', () => {
    it('defaults to DeepSeek: names DeepSeek in copy, accept button, and direct-from-browser privacy bullet', () => {
      render(ConsentDialog, { props: { repo: 'owner/private', onresult: vi.fn() } })
      expect(screen.getByText(/sent to DeepSeek/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Send code to DeepSeek/i })).toBeInTheDocument()
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toMatch(/directly from your browser to DeepSeek/i)
      expect(dialog.textContent).not.toMatch(/proxy/i)
    })

    it('OpenAI active: names OpenAI and the privacy bullet mentions the serverless proxy hop (never stored/logged)', () => {
      setAiProvider('openai')
      render(ConsentDialog, { props: { repo: 'owner/private', onresult: vi.fn() } })
      expect(screen.getByText(/sent to OpenAI/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Send code to OpenAI/i })).toBeInTheDocument()
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toMatch(/serverless proxy/i)
      expect(dialog.textContent).toMatch(/never stored or logged/i)
      expect(dialog.textContent).not.toMatch(/directly from your browser/i)
    })

    it('Anthropic active: names Anthropic with direct-from-browser bullet, no proxy mention', () => {
      setAiProvider('anthropic')
      render(ConsentDialog, { props: { repo: 'owner/private', onresult: vi.fn() } })
      expect(screen.getByText(/sent to Anthropic/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Send code to Anthropic/i })).toBeInTheDocument()
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toMatch(/directly from your browser to Anthropic/i)
      expect(dialog.textContent).not.toMatch(/proxy/i)
    })

    it('Gemini active: names Gemini in copy and accept button', () => {
      setAiProvider('gemini')
      render(ConsentDialog, { props: { repo: 'owner/private', onresult: vi.fn() } })
      expect(screen.getByText(/sent to Gemini/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Send code to Gemini/i })).toBeInTheDocument()
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toMatch(/directly from your browser to Gemini/i)
    })

    it('no provider is hardcoded: switching provider changes every DeepSeek mention', () => {
      setAiProvider('openai')
      render(ConsentDialog, { props: { repo: 'owner/private', onresult: vi.fn() } })
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).not.toMatch(/DeepSeek/i)
    })
  })
})
