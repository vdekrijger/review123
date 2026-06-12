/**
 * AiModelsSection.test.ts
 *
 * Tests for the AI models settings section component (Plan F Task F3 +
 * per-provider context blocks):
 *   - one card per provider, each containing the provider radio, that
 *     provider's model dropdown, its key field and its Save & test button
 *   - provider radio applies immediately (PR #74 semantics)
 *   - per-card model dropdown (own models only, default = defaultModel)
 *   - per-provider masked key fields with atomic save + dirty tracking
 *   - active provider's card emphasized (data-active)
 *   - per-provider "Save & test" connection button (saves, then pings through
 *     the real transport — mocked here)
 *   - per-card "what's sent where" privacy line + global localStorage note
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import AiModelsSection from './AiModelsSection.svelte'
import { getSettings, saveTokens, setAiProvider, setAiModel } from '../../lib/settings/settings'
import { _resetSettingsStateForTest } from '../../lib/settings/settingsState.svelte'
import { PROVIDERS, getProvider } from '../../lib/llm/providers'
import { llmTestConnection, LlmError } from '../../lib/llm/llm'

vi.mock('../../lib/llm/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/llm/llm')>()
  return { ...actual, llmTestConnection: vi.fn() }
})

const llmTestConnectionMock = vi.mocked(llmTestConnection)

beforeEach(() => {
  localStorage.clear()
  _resetSettingsStateForTest()
  vi.clearAllMocks()
  llmTestConnectionMock.mockResolvedValue(undefined)
})

/** The provider's context card (closest .provider-card around its radio). */
function providerCard(displayName: string): HTMLElement {
  const radio = screen.getByRole('radio', { name: displayName })
  const card = radio.closest('.provider-card')
  expect(card).not.toBeNull()
  return card as HTMLElement
}

describe('AiModelsSection — provider context cards (layout)', () => {
  it('renders one card per provider, each containing its radio, model dropdown, key field and Save & test button', () => {
    render(AiModelsSection)
    for (const p of PROVIDERS) {
      const card = within(providerCard(p.displayName))
      expect(card.getByRole('radio', { name: p.displayName })).toBeInTheDocument()
      expect(card.getByLabelText(new RegExp(`${p.displayName} model`, 'i'))).toBeInTheDocument()
      expect(card.getByLabelText(new RegExp(`${p.displayName} API key`, 'i'))).toBeInTheDocument()
      expect(
        card.getByRole('button', { name: new RegExp(`save & test ${p.displayName}`, 'i') }),
      ).toBeInTheDocument()
    }
  })

  it('each card dropdown lists ONLY that provider models with the provider default selected', () => {
    render(AiModelsSection)
    for (const p of PROVIDERS) {
      const select = screen.getByLabelText(new RegExp(`${p.displayName} model`, 'i')) as HTMLSelectElement
      expect(select.value).toBe(p.defaultModel)
      const optionValues = Array.from(select.options).map((o) => o.value)
      expect(optionValues).toEqual(p.models.map((m) => m.id))
    }
  })

  it('the ACTIVE provider card is emphasized (data-active) and inactive cards are not', () => {
    setAiProvider('anthropic')
    render(AiModelsSection)
    expect(providerCard('Anthropic').dataset.active).toBe('true')
    expect(providerCard('DeepSeek').dataset.active).toBe('false')
    expect(providerCard('Gemini').dataset.active).toBe('false')
  })

  it('inactive cards stay fully editable: typing a key in a non-active card works', async () => {
    render(AiModelsSection) // active = deepseek
    const geminiKey = screen.getByLabelText(/gemini api key/i) as HTMLInputElement
    await userEvent.type(geminiKey, 'AIza-inactive-edit')
    expect(geminiKey.value).toBe('AIza-inactive-edit')
  })
})

describe('AiModelsSection — provider radio', () => {
  it('renders a radio per provider from PROVIDERS defs', () => {
    render(AiModelsSection)
    for (const p of PROVIDERS) {
      expect(screen.getByRole('radio', { name: p.displayName })).toBeInTheDocument()
    }
  })

  it('DeepSeek radio is checked by default', () => {
    render(AiModelsSection)
    const radio = screen.getByRole('radio', { name: 'DeepSeek' }) as HTMLInputElement
    expect(radio.checked).toBe(true)
  })

  it('selecting Anthropic persists aiProvider immediately and resets aiModel to default', async () => {
    setAiModel('deepseek-reasoner')
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('radio', { name: 'Anthropic' }))
    expect(getSettings().aiProvider).toBe('anthropic')
    // empty aiModel means "use the provider default"
    expect(getSettings().aiModel).toBe('')
  })

  it('selecting a provider moves the active emphasis to its card', async () => {
    render(AiModelsSection)
    expect(providerCard('DeepSeek').dataset.active).toBe('true')
    await userEvent.click(screen.getByRole('radio', { name: 'OpenAI' }))
    expect(providerCard('OpenAI').dataset.active).toBe('true')
    expect(providerCard('DeepSeek').dataset.active).toBe('false')
  })

  it('pre-selects the stored provider', () => {
    setAiProvider('gemini')
    render(AiModelsSection)
    const radio = screen.getByRole('radio', { name: 'Gemini' }) as HTMLInputElement
    expect(radio.checked).toBe(true)
  })
})

describe('AiModelsSection — per-card model dropdown', () => {
  it('active card (DeepSeek) starts on the provider default', () => {
    render(AiModelsSection)
    const select = screen.getByLabelText(/deepseek model/i) as HTMLSelectElement
    expect(select.value).toBe('deepseek-v4-flash')
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'])
  })

  it('the Anthropic card dropdown holds claude models only, default selected', () => {
    render(AiModelsSection)
    const select = screen.getByLabelText(/anthropic model/i) as HTMLSelectElement
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toContain('claude-sonnet-4-6')
    expect(optionValues).not.toContain('deepseek-v4-flash')
    expect(select.value).toBe('claude-sonnet-4-6') // provider default
  })

  it('choosing a model in the ACTIVE card persists aiModel', async () => {
    render(AiModelsSection)
    const select = screen.getByLabelText(/deepseek model/i)
    await userEvent.selectOptions(select, 'deepseek-v4-pro')
    expect(getSettings().aiModel).toBe('deepseek-v4-pro')
  })

  it('choosing a model in an INACTIVE card does NOT change the persisted aiModel', async () => {
    render(AiModelsSection) // active = deepseek
    await userEvent.selectOptions(screen.getByLabelText(/anthropic model/i), 'claude-opus-4-8')
    expect(getSettings().aiModel).toBe('')
    expect(getSettings().aiProvider).toBe('deepseek')
  })

  it('selecting a provider applies that card staged model immediately', async () => {
    render(AiModelsSection) // active = deepseek
    await userEvent.selectOptions(screen.getByLabelText(/anthropic model/i), 'claude-opus-4-8')
    await userEvent.click(screen.getByRole('radio', { name: 'Anthropic' }))
    expect(getSettings().aiProvider).toBe('anthropic')
    expect(getSettings().aiModel).toBe('claude-opus-4-8')
  })

  it('pre-selects a stored aiModel that belongs to the active provider', () => {
    setAiModel('deepseek-reasoner')
    render(AiModelsSection)
    const select = screen.getByLabelText(/deepseek model/i) as HTMLSelectElement
    expect(select.value).toBe('deepseek-reasoner')
  })

  it('a stored aiModel that no longer exists falls back to the provider default in the dropdown', () => {
    setAiModel('o4-mini') // removed from the OpenAI lineup
    setAiProvider('openai')
    render(AiModelsSection)
    const select = screen.getByLabelText(/openai model/i) as HTMLSelectElement
    expect(select.value).toBe(getProvider('openai')!.defaultModel)
  })
})

describe('AiModelsSection — key fields', () => {
  it('renders a masked key input per provider with the provider keyHint placeholder', () => {
    render(AiModelsSection)
    for (const p of PROVIDERS) {
      const input = screen.getByLabelText(new RegExp(`${p.displayName} API key`, 'i')) as HTMLInputElement
      expect(input.type).toBe('password')
      expect(input.placeholder).toBe(p.keyHint)
    }
  })

  it('the ACTIVE provider key field lives in the emphasized card (data-active)', () => {
    setAiProvider('anthropic')
    render(AiModelsSection)
    const anthropicInput = screen.getByLabelText(/anthropic api key/i)
    const deepseekInput = screen.getByLabelText(/deepseek api key/i)
    expect(anthropicInput.closest('[data-active="true"]')).not.toBeNull()
    expect(deepseekInput.closest('[data-active="true"]')).toBeNull()
  })

  it('typing a DeepSeek key and clicking its Save & test stores it', async () => {
    render(AiModelsSection)
    await userEvent.type(screen.getByLabelText(/deepseek api key/i), 'sk-test123')
    await userEvent.click(screen.getByRole('button', { name: /save & test deepseek/i }))
    expect(getSettings().deepseekKey).toBe('sk-test123')
  })

  it('per-key save is SCOPED: saving Anthropic does not persist a pending Gemini edit', async () => {
    render(AiModelsSection)
    await userEvent.type(screen.getByLabelText(/anthropic api key/i), 'sk-ant-1')
    await userEvent.type(screen.getByLabelText(/gemini api key/i), 'AIza-1')
    await userEvent.click(screen.getByRole('button', { name: /save & test anthropic/i }))
    const s = getSettings()
    expect(s.anthropicKey).toBe('sk-ant-1')
    expect(s.geminiKey).toBeNull() // still only in the field — its own Save & test persists it
  })

  it('clearing the DeepSeek key and clicking its Save & test saves null', async () => {
    saveTokens({ deepseekKey: 'sk-existing' })
    render(AiModelsSection)
    await userEvent.clear(screen.getByLabelText(/deepseek api key/i))
    await userEvent.click(screen.getByRole('button', { name: /save & test deepseek/i }))
    expect(getSettings().deepseekKey).toBeNull()
  })

  it('pre-fills keys from stored settings', () => {
    saveTokens({ deepseekKey: 'sk-prefilled', anthropicKey: 'sk-ant-prefilled' })
    render(AiModelsSection)
    expect((screen.getByLabelText(/deepseek api key/i) as HTMLInputElement).value).toBe('sk-prefilled')
    expect((screen.getByLabelText(/anthropic api key/i) as HTMLInputElement).value).toBe('sk-ant-prefilled')
  })

  it('shows a per-card privacy line: direct-from-browser for DeepSeek/Anthropic/Gemini, proxy for OpenAI', () => {
    render(AiModelsSection)
    // Three direct-from-browser cards…
    expect(screen.getAllByText(/sent directly from your browser/i)).toHaveLength(3)
    for (const name of ['DeepSeek', 'Anthropic', 'Gemini']) {
      expect(
        within(providerCard(name)).getByText(/sent directly from your browser/i),
      ).toBeInTheDocument()
    }
    // …and the OpenAI card carries the proxy line instead.
    const openaiCard = within(providerCard('OpenAI'))
    expect(openaiCard.getByText(/serverless proxy/i)).toBeInTheDocument()
    expect(openaiCard.getByText(/never stored or logged/i)).toBeInTheDocument()
    expect(openaiCard.queryByText(/sent directly from your browser/i)).toBeNull()
  })

  it('keeps the global "keys stored in localStorage" note', () => {
    render(AiModelsSection)
    expect(screen.getByText(/stored only in this browser \(localStorage\)/i)).toBeInTheDocument()
  })
})

describe('AiModelsSection — Save & test connection button', () => {
  it('renders a Save & test button per provider', () => {
    render(AiModelsSection)
    for (const p of PROVIDERS) {
      expect(
        screen.getByRole('button', { name: new RegExp(`save & test ${p.displayName}`, 'i') }),
      ).toBeInTheDocument()
    }
  })

  it('saves the entered key FIRST, then pings that provider through the transport', async () => {
    render(AiModelsSection)
    await userEvent.type(screen.getByLabelText(/anthropic api key/i), 'sk-ant-new')
    await userEvent.click(screen.getByRole('button', { name: /save & test anthropic/i }))
    // Key was saved before the ping (test-what-you-typed via save-then-test)
    expect(getSettings().anthropicKey).toBe('sk-ant-new')
    expect(llmTestConnectionMock).toHaveBeenCalledWith('anthropic', undefined)
  })

  it('passes the selected model when testing the ACTIVE provider', async () => {
    saveTokens({ deepseekKey: 'sk-ds' })
    setAiModel('deepseek-reasoner')
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /save & test deepseek/i }))
    expect(llmTestConnectionMock).toHaveBeenCalledWith('deepseek', 'deepseek-reasoner')
  })

  it('shows ok state on success', async () => {
    saveTokens({ geminiKey: 'AIza-x' })
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /save & test gemini/i }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/connected/i)
    })
  })

  it('shows the error message inline on failure', async () => {
    llmTestConnectionMock.mockRejectedValue(new LlmError('auth', 'Unauthorized (401)'))
    saveTokens({ deepseekKey: 'sk-bad' })
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /save & test deepseek/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/unauthorized/i)
    })
  })

  it('testing with an empty key field shows a no-key error (saved null, transport throws)', async () => {
    llmTestConnectionMock.mockRejectedValue(new LlmError('no-key', 'No DeepSeek API key configured'))
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /save & test deepseek/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/no deepseek api key/i)
    })
    expect(getSettings().deepseekKey).toBeNull()
  })

  it('disables the button while the test is in flight', async () => {
    let resolvePing: () => void = () => {}
    llmTestConnectionMock.mockImplementation(
      () => new Promise<void>((resolve) => { resolvePing = resolve }),
    )
    saveTokens({ deepseekKey: 'sk-ds' })
    render(AiModelsSection)
    const btn = screen.getByRole('button', { name: /save & test deepseek/i })
    await userEvent.click(btn)
    expect(btn).toBeDisabled()
    resolvePing()
    await waitFor(() => expect(btn).not.toBeDisabled())
  })
})

describe('AiModelsSection — save UX (zero ambiguous buttons)', () => {
  it('has NO section-level Save button — keys persist only via per-key Save & test', () => {
    render(AiModelsSection)
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()
  })

  it('labels provider & model selection as applying immediately', () => {
    render(AiModelsSection)
    expect(screen.getByText(/applies immediately/i)).toBeInTheDocument()
  })

  it('typing in a key field shows an "unsaved" hint in THAT card only', async () => {
    render(AiModelsSection)
    expect(screen.queryByText(/unsaved/i)).toBeNull()
    await userEvent.type(screen.getByLabelText(/anthropic api key/i), 'sk-ant-dirty')
    const hints = screen.getAllByText(/unsaved/i)
    expect(hints).toHaveLength(1)
    const anthropicCard = screen.getByLabelText(/anthropic api key/i).closest('.provider-card')
    expect(anthropicCard?.contains(hints[0])).toBe(true)
  })

  it('the unsaved hint clears after Save & test persists the key', async () => {
    render(AiModelsSection)
    await userEvent.type(screen.getByLabelText(/gemini api key/i), 'AIza-dirty')
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /save & test gemini/i }))
    expect(screen.queryByText(/unsaved/i)).toBeNull()
  })

  it('shows a transient "Saved ✓" (aria-live polite) after Save & test persists a changed key', async () => {
    render(AiModelsSection)
    await userEvent.type(screen.getByLabelText(/deepseek api key/i), 'sk-new')
    await userEvent.click(screen.getByRole('button', { name: /save & test deepseek/i }))
    const saved = screen.getByText(/saved ✓/i)
    expect(saved).toBeInTheDocument()
    expect(saved.closest('[aria-live="polite"]')).not.toBeNull()
    await waitFor(() => expect(screen.queryByText(/saved ✓/i)).toBeNull(), { timeout: 3500 })
  })

  it('does NOT show "Saved ✓" when Save & test runs on an unchanged key (pure re-test)', async () => {
    saveTokens({ deepseekKey: 'sk-unchanged' })
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /save & test deepseek/i }))
    expect(screen.queryByText(/saved ✓/i)).toBeNull()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/connected/i))
  })

  it('a dirty key field marks its Save & test button as prominent (data-dirty)', async () => {
    render(AiModelsSection)
    const btn = screen.getByRole('button', { name: /save & test openai/i })
    expect(btn).not.toHaveAttribute('data-dirty', 'true')
    await userEvent.type(screen.getByLabelText(/openai api key/i), 'sk-oa-dirty')
    expect(btn).toHaveAttribute('data-dirty', 'true')
  })
})

// ---------------------------------------------------------------------------
// Deep review (agentic) toggle — Plan G part 2
// ---------------------------------------------------------------------------

describe('AiModelsSection — deep review toggle', () => {
  it('renders the toggle unchecked by default with honest cost copy', () => {
    render(AiModelsSection)
    const toggle = screen.getByRole('checkbox', { name: /deep review \(agentic\)/i })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/slower, uses more tokens/i)).toBeInTheDocument()
  })

  it('checking the toggle persists aiDeepReview immediately', async () => {
    render(AiModelsSection)
    const toggle = screen.getByRole('checkbox', { name: /deep review \(agentic\)/i })
    await userEvent.click(toggle)
    expect(getSettings().aiDeepReview).toBe(true)
    await userEvent.click(toggle)
    expect(getSettings().aiDeepReview).toBe(false)
  })

  it('reflects a previously saved aiDeepReview=true on render', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiDeepReview: true }))
    render(AiModelsSection)
    expect(screen.getByRole('checkbox', { name: /deep review \(agentic\)/i })).toBeChecked()
  })
})
