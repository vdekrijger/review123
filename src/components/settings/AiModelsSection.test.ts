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
import { getSettings, saveTokens, setAiProvider, setAiModel, setAiPanel, type PanelParticipant } from '../../lib/settings/settings'
import { _resetSettingsStateForTest } from '../../lib/settings/settingsState.svelte'
import { PROVIDERS, getProvider } from '../../lib/llm/providers'
import { llmTestConnection, LlmError } from '../../lib/llm/llm'
import { fetchProviderBalance } from '../../lib/llm/balance'

vi.mock('../../lib/llm/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/llm/llm')>()
  return { ...actual, llmTestConnection: vi.fn() }
})

// Mock only the network fetch; keep the real capability gate + formatter so the
// "only DeepSeek shows the line" behaviour is exercised end-to-end.
vi.mock('../../lib/llm/balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/llm/balance')>()
  return { ...actual, fetchProviderBalance: vi.fn() }
})

const llmTestConnectionMock = vi.mocked(llmTestConnection)
const fetchProviderBalanceMock = vi.mocked(fetchProviderBalance)

beforeEach(() => {
  localStorage.clear()
  _resetSettingsStateForTest()
  vi.clearAllMocks()
  llmTestConnectionMock.mockResolvedValue(undefined)
  fetchProviderBalanceMock.mockResolvedValue(null)
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

  it('each SMALL-list card dropdown is a <select> listing ONLY that provider models with the default selected', () => {
    render(AiModelsSection)
    // The four curated providers keep the plain <select>; OpenRouter (300+) uses
    // the searchable combobox instead (asserted separately).
    for (const p of PROVIDERS.filter((pr) => pr.id !== 'openrouter')) {
      const select = screen.getByLabelText(new RegExp(`${p.displayName} model`, 'i')) as HTMLSelectElement
      expect(select.tagName).toBe('SELECT')
      expect(select.value).toBe(p.defaultModel)
      const optionValues = Array.from(select.options).map((o) => o.value)
      expect(optionValues).toEqual(p.models.map((m) => m.id))
    }
  })

  it('renders an OpenRouter card whose model picker is the two-column combobox (not a flat select)', () => {
    render(AiModelsSection)
    const card = within(providerCard('OpenRouter'))
    expect(card.getByRole('radio', { name: 'OpenRouter' })).toBeInTheDocument()
    expect(card.getByLabelText(/openrouter api key/i)).toBeInTheDocument()
    // The OpenRouter model control is a <button> trigger, NOT a <select> or text input.
    const trigger = card.getByRole('button', { name: /openrouter model/i }) as HTMLButtonElement
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    // Its label reflects the current (default) selection — once, no overlay duplication.
    const or = getProvider('openrouter')!
    const def = or.models.find((m) => m.id === or.defaultModel)!
    expect(trigger).toHaveTextContent(def.label)
    expect(card.getAllByText(def.label)).toHaveLength(1)
    // The panel is closed by default — no listbox or search field on screen.
    expect(card.queryByRole('listbox')).toBeNull()
    expect(card.queryByRole('searchbox')).toBeNull()
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

describe('AiModelsSection — OpenRouter searchable combobox (adaptive picker)', () => {
  it('selecting an OpenRouter model via the combobox persists aiModel when OpenRouter is active', async () => {
    setAiProvider('openrouter')
    render(AiModelsSection)
    const trigger = within(providerCard('OpenRouter')).getByRole('button', { name: /openrouter model/i })
    await userEvent.click(trigger)
    // Reach a specific featured model by searching its slug (works regardless of
    // the default lab). Pick one whose label isn't a prefix of another model's
    // label (e.g. "…Opus 4.8" is a prefix of "…Opus 4.8 (Fast)") so the search
    // yields exactly one option.
    const or = getProvider('openrouter')!
    const featured = or.models.find(
      (m) => m.featured && !or.models.some((o) => o.id !== m.id && o.label.startsWith(m.label)),
    )!
    await userEvent.type(screen.getByRole('searchbox', { name: /search all/i }), featured.id)
    const option = await screen.findByRole('option', { name: new RegExp(featured.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    await userEvent.click(option)
    expect(getSettings().aiModel).toBe(featured.id)
  })

  it('typing filters the OpenRouter list and selecting the match updates aiModel', async () => {
    setAiProvider('openrouter')
    render(AiModelsSection)
    const trigger = within(providerCard('OpenRouter')).getByRole('button', { name: /openrouter model/i })
    const or = getProvider('openrouter')!
    // Find a model whose slug contains a distinctive token AND whose label isn't
    // a prefix of a sibling's (so searching it yields exactly one option).
    const target = or.models.find(
      (m) => m.id.includes('gpt-5') && !or.models.some((o) => o.id !== m.id && o.label.startsWith(m.label)),
    )
    if (target) {
      await userEvent.click(trigger)
      await userEvent.type(screen.getByRole('searchbox', { name: /search all/i }), target.id)
      const option = await screen.findByRole('option', { name: new RegExp(target.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      await userEvent.click(option)
      expect(getSettings().aiModel).toBe(target.id)
    }
  })

  it('keeps a plain <select> (no combobox) for the small-list providers', () => {
    render(AiModelsSection)
    for (const name of ['DeepSeek', 'OpenAI', 'Anthropic', 'Gemini']) {
      const card = within(providerCard(name))
      const select = card.getByLabelText(new RegExp(`${name} model`, 'i'))
      expect(select.tagName).toBe('SELECT')
    }
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

  it('shows a per-card privacy line: direct-from-browser for DeepSeek/Anthropic/Gemini/OpenRouter, proxy for OpenAI', () => {
    render(AiModelsSection)
    // Four direct-from-browser cards…
    expect(screen.getAllByText(/sent directly from your browser/i)).toHaveLength(4)
    for (const name of ['DeepSeek', 'Anthropic', 'Gemini', 'OpenRouter']) {
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

describe('AiModelsSection — per-task modes (Plan J)', () => {
  it('renders a 3-way control per task; Deep omitted for summary', () => {
    render(AiModelsSection)
    // Summary's group has Off + Standard but NOT Deep.
    const summaryGroup = within(screen.getByRole('radiogroup', { name: /Summary mode/i }))
    expect(summaryGroup.getByRole('radio', { name: /Off/i })).toBeInTheDocument()
    expect(summaryGroup.getByRole('radio', { name: /Standard/i })).toBeInTheDocument()
    expect(summaryGroup.queryByRole('radio', { name: /Deep/i })).toBeNull()

    // Verdict (deep-capable) has all three.
    const verdictGroup = within(screen.getByRole('radiogroup', { name: /Verdict mode/i }))
    expect(verdictGroup.getByRole('radio', { name: /Off/i })).toBeInTheDocument()
    expect(verdictGroup.getByRole('radio', { name: /Standard/i })).toBeInTheDocument()
    expect(verdictGroup.getByRole('radio', { name: /Deep/i })).toBeInTheDocument()
  })

  it('defaults every task to Standard', () => {
    render(AiModelsSection)
    const verdictGroup = within(screen.getByRole('radiogroup', { name: /Verdict mode/i }))
    expect(verdictGroup.getByRole('radio', { name: /Standard/i })).toBeChecked()
  })

  it('changing a task control persists the mode immediately', async () => {
    render(AiModelsSection)
    const diagramsGroup = within(screen.getByRole('radiogroup', { name: /Diagrams mode/i }))
    await userEvent.click(diagramsGroup.getByRole('radio', { name: /Off/i }))
    expect(getSettings().aiTaskModes.diagrams).toBe('off')
    await userEvent.click(diagramsGroup.getByRole('radio', { name: /Deep/i }))
    expect(getSettings().aiTaskModes.diagrams).toBe('deep')
  })

  it('quick-set All → every deep-capable task deep, summary standard', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /^All$/i }))
    const m = getSettings().aiTaskModes
    expect(m.summary).toBe('standard')
    expect(m.verdict).toBe('deep')
    expect(m.diagrams).toBe('deep')
  })

  it('quick-set None → every task standard', async () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiDeepReview: true }))
    _resetSettingsStateForTest()
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /^None$/i }))
    const m = getSettings().aiTaskModes
    for (const v of Object.values(m)) expect(v).toBe('standard')
  })

  it('quick-set Off-all-extras → summary+verdict standard, the rest off', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /Off-all-extras/i }))
    const m = getSettings().aiTaskModes
    expect(m.summary).toBe('standard')
    expect(m.verdict).toBe('standard')
    expect(m.diagrams).toBe('off')
    expect(m.skills).toBe('off')
  })
})

describe('AiModelsSection — show/hide key toggle', () => {
  function keyInput(name: RegExp): HTMLInputElement {
    return screen.getByLabelText(name) as HTMLInputElement
  }

  it('every provider key field has a "Show key" eye toggle (aria-pressed=false, masked input)', () => {
    render(AiModelsSection)
    for (const p of PROVIDERS) {
      const card = within(providerCard(p.displayName))
      const toggle = card.getByRole('button', { name: 'Show key' })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      expect((card.getByLabelText(new RegExp(`${p.displayName} API key`, 'i')) as HTMLInputElement).type).toBe('password')
    }
  })

  it('clicking the toggle reveals the key as plain text and flips to "Hide key" (aria-pressed=true)', async () => {
    saveTokens({ deepseekKey: 'sk-visible-check' })
    render(AiModelsSection)
    const card = within(providerCard('DeepSeek'))
    await userEvent.click(card.getByRole('button', { name: 'Show key' }))
    const input = keyInput(/deepseek api key/i)
    expect(input.type).toBe('text')
    expect(input.value).toBe('sk-visible-check')
    const hideToggle = card.getByRole('button', { name: 'Hide key' })
    expect(hideToggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking again re-masks the input', async () => {
    render(AiModelsSection)
    const card = within(providerCard('Anthropic'))
    await userEvent.click(card.getByRole('button', { name: 'Show key' }))
    expect(keyInput(/anthropic api key/i).type).toBe('text')
    await userEvent.click(card.getByRole('button', { name: 'Hide key' }))
    expect(keyInput(/anthropic api key/i).type).toBe('password')
  })

  it('the toggle is per-card: revealing DeepSeek leaves the other key fields masked', async () => {
    render(AiModelsSection)
    await userEvent.click(within(providerCard('DeepSeek')).getByRole('button', { name: 'Show key' }))
    expect(keyInput(/deepseek api key/i).type).toBe('text')
    expect(keyInput(/openai api key/i).type).toBe('password')
    expect(keyInput(/anthropic api key/i).type).toBe('password')
    expect(keyInput(/gemini api key/i).type).toBe('password')
  })

  it('typing while revealed still saves through Save & test (value binding survives the type flip)', async () => {
    render(AiModelsSection)
    const card = within(providerCard('Gemini'))
    await userEvent.click(card.getByRole('button', { name: 'Show key' }))
    await userEvent.type(keyInput(/gemini api key/i), 'AIza-revealed-typing')
    await userEvent.click(card.getByRole('button', { name: /save & test gemini/i }))
    expect(getSettings().geminiKey).toBe('AIza-revealed-typing')
  })

  it('the eye toggle does NOT trigger Save & test or any persistence', async () => {
    render(AiModelsSection)
    await userEvent.type(keyInput(/deepseek api key/i), 'sk-unsaved')
    await userEvent.click(within(providerCard('DeepSeek')).getByRole('button', { name: 'Show key' }))
    expect(getSettings().deepseekKey).toBeNull()
    expect(llmTestConnectionMock).not.toHaveBeenCalled()
  })
})

describe('AiModelsSection — invalid key characters rejected at save', () => {
  it('an em dash (copy-paste artifact) in the key shows the friendly inline error and saves nothing', async () => {
    render(AiModelsSection)
    await userEvent.type(screen.getByLabelText(/deepseek api key/i), 'sk-bad—key')
    await userEvent.click(screen.getByRole('button', { name: /save & test deepseek/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/invalid character/i)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/re-copy it from the provider/i)
    expect(getSettings().deepseekKey).toBeNull()
    // The connection test never runs on a key that failed validation
    expect(llmTestConnectionMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Story mode toggle (Plan H) — requires an LLM key to be enabled
// ---------------------------------------------------------------------------

describe('AiModelsSection — story mode toggle', () => {
  it('is disabled when no LLM key is configured (no-key gating)', () => {
    render(AiModelsSection)
    const toggle = screen.getByRole('checkbox', { name: /Story mode/i }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/Add an LLM API key above to enable it/i)).toBeInTheDocument()
  })

  it('is enabled once the active provider has a key', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiProvider: 'deepseek', deepseekKey: 'sk-test' }))
    _resetSettingsStateForTest()
    render(AiModelsSection)
    const toggle = screen.getByRole('checkbox', { name: /Story mode/i }) as HTMLInputElement
    expect(toggle.disabled).toBe(false)
  })

  it('persists the toggle change to settings', async () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiProvider: 'deepseek', deepseekKey: 'sk-test', storyMode: true }))
    _resetSettingsStateForTest()
    render(AiModelsSection)
    const toggle = screen.getByRole('checkbox', { name: /Story mode/i }) as HTMLInputElement
    await userEvent.click(toggle)
    expect(getSettings().storyMode).toBe(false)
  })
})

describe('AiModelsSection — unified model panel (Plan P)', () => {
  function setupAnthropic() {
    localStorage.setItem('review123:settings', JSON.stringify({ aiProvider: 'anthropic', anthropicKey: 'sk-ant-test' }))
    _resetSettingsStateForTest()
  }
  const gen = (provider: string, model: string): PanelParticipant =>
    ({ provider: provider as PanelParticipant['provider'], model, role: 'generator' })
  const ver = (provider: string, model: string): PanelParticipant =>
    ({ provider: provider as PanelParticipant['provider'], model, role: 'verifier' })

  it('renders ONE Model panel section with a generator row by default and no verify/generate radio', () => {
    setupAnthropic()
    render(AiModelsSection)
    expect(screen.getByText(/^Model panel$/i)).toBeInTheDocument()
    expect(screen.getByTestId('model-panel')).toBeInTheDocument()
    // The old verify/generate "How models combine" radio is gone.
    expect(screen.queryByText(/How models combine/i)).toBeNull()
    expect(screen.queryByText(/Ensemble \/ verification panel/i)).toBeNull()
    // The default row shows a Generator role.
    expect(screen.getAllByRole('radio', { name: /generator/i }).length).toBeGreaterThan(0)
  })

  it('renders the One generator / All generate presets', () => {
    setupAnthropic()
    render(AiModelsSection)
    expect(screen.getByRole('button', { name: /One generator/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /All generate/i })).toBeInTheDocument()
  })

  it('adding a same-provider model writes a verifier participant (single-key multi-model)', async () => {
    setupAnthropic()
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /Add a model/i }))
    const panel = getSettings().aiPanel
    expect(panel).not.toBeNull()
    expect(panel!.participants[0].role).toBe('generator')
    expect(panel!.participants.length).toBe(2)
    expect(panel!.participants[1].role).toBe('verifier')
    expect(panel!.participants[1].provider).toBe('anthropic')
  })

  it('toggling a verifier row to Generator updates its role (emergent generate)', async () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    // The second row's Generator radio.
    const genRadios = screen.getAllByRole('radio', { name: /generator/i }) as HTMLInputElement[]
    await userEvent.click(genRadios[1])
    const panel = getSettings().aiPanel!
    expect(panel.participants.every((p) => p.role === 'generator')).toBe(true)
  })

  it('"All generate" preset sets every row to generator', async () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /All generate/i }))
    expect(getSettings().aiPanel!.participants.every((p) => p.role === 'generator')).toBe(true)
  })

  it('"One generator" preset leaves only the first row a generator', async () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), gen('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /One generator/i }))
    const roles = getSettings().aiPanel!.participants.map((p) => p.role)
    expect(roles).toEqual(['generator', 'verifier'])
  })

  it('the last generator cannot be toggled to verifier (≥1 constraint)', async () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    // The sole generator's Verifier radio is disabled.
    const verRadios = screen.getAllByRole('radio', { name: /verifier/i }) as HTMLInputElement[]
    expect(verRadios[0].disabled).toBe(true)
  })

  it('disables a row whose provider has no key and shows the add-key hint', () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('openai', 'gpt-5.4')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    expect(screen.getByText(/No OpenAI key — add it above/i)).toBeInTheDocument()
  })

  it('removing a participant updates the panel', async () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    const removeButtons = screen.getAllByRole('button', { name: /Remove participant/i })
    await userEvent.click(removeButtons[removeButtons.length - 1])
    expect(getSettings().aiPanel!.participants.length).toBe(1)
  })

  it('keeps the Add control available beyond 8 participants (no hard block)', async () => {
    setupAnthropic()
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ...Array.from({ length: 8 }, () => ver('anthropic', 'claude-haiku-4-5')),
    ] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    const addBtn = screen.getByRole('button', { name: /Add a model/i })
    expect(addBtn).toBeInTheDocument()
    expect(addBtn).not.toBeDisabled()
    expect(screen.queryByText(/Maximum of \d+ models/i)).toBeNull()
    await userEvent.click(addBtn)
    expect(getSettings().aiPanel!.participants.length).toBe(10)
  })

  it('shows the soft scale/cost note once the panel reaches 4+ participants', () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    const two = render(AiModelsSection)
    expect(two.queryByTestId('ensemble-scale-note')).toBeNull()
    two.unmount()

    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ...Array.from({ length: 3 }, () => ver('anthropic', 'claude-haiku-4-5')),
    ] })
    _resetSettingsStateForTest()
    const four = render(AiModelsSection)
    const note = four.getByTestId('ensemble-scale-note')
    expect(note).toBeInTheDocument()
    expect(note.textContent).toMatch(/more models means more tokens/i)
    expect(note.textContent).toMatch(/per-model impact/i)
  })
})

describe('AiModelsSection — credits remaining (capability-gated balance)', () => {
  /** The credits row inside a provider's card, or null when absent. */
  function balanceRow(displayName: string): HTMLElement | null {
    return providerCard(displayName).querySelector('.balance-row')
  }

  it('renders the credits line for DeepSeek when a key is set', async () => {
    saveTokens({ deepseekKey: 'sk-deepseek-test' })
    _resetSettingsStateForTest()
    fetchProviderBalanceMock.mockResolvedValue({ currency: 'USD', total: 110, granted: 10, toppedUp: 100 })
    render(AiModelsSection)
    await waitFor(() => expect(screen.getByText(/credits:\s*\$110\.00/i)).toBeInTheDocument())
    expect(fetchProviderBalanceMock).toHaveBeenCalledWith('deepseek', 'sk-deepseek-test')
  })

  it('renders the credits line for OpenRouter when a key is set', async () => {
    saveTokens({ openrouterKey: 'sk-or-test' })
    _resetSettingsStateForTest()
    fetchProviderBalanceMock.mockResolvedValue({ currency: 'USD', total: 37.5 })
    render(AiModelsSection)
    await waitFor(() => expect(within(providerCard('OpenRouter')).getByText(/credits:\s*\$37\.50/i)).toBeInTheDocument())
    expect(fetchProviderBalanceMock).toHaveBeenCalledWith('openrouter', 'sk-or-test')
  })

  it('does NOT render a credits line for OpenAI / Anthropic / Gemini even with keys set', async () => {
    saveTokens({ openaiKey: 'sk-o', anthropicKey: 'sk-ant', geminiKey: 'AIza-g' })
    _resetSettingsStateForTest()
    fetchProviderBalanceMock.mockResolvedValue({ currency: 'USD', total: 50 })
    render(AiModelsSection)
    // The unsupported providers are never even queried…
    expect(fetchProviderBalanceMock).not.toHaveBeenCalledWith('openai', expect.anything())
    expect(fetchProviderBalanceMock).not.toHaveBeenCalledWith('anthropic', expect.anything())
    expect(fetchProviderBalanceMock).not.toHaveBeenCalledWith('gemini', expect.anything())
    // …and their cards carry no credits row.
    expect(balanceRow('OpenAI')).toBeNull()
    expect(balanceRow('Anthropic')).toBeNull()
    expect(balanceRow('Gemini')).toBeNull()
  })

  it('does NOT render the DeepSeek credits line when no DeepSeek key is set', async () => {
    render(AiModelsSection)
    expect(fetchProviderBalanceMock).not.toHaveBeenCalled()
    expect(balanceRow('DeepSeek')).toBeNull()
  })

  it('shows an unobtrusive "—" (not an error) when the balance fetch yields nothing', async () => {
    saveTokens({ deepseekKey: 'sk-deepseek-test' })
    _resetSettingsStateForTest()
    fetchProviderBalanceMock.mockResolvedValue(null)
    render(AiModelsSection)
    await waitFor(() => expect(screen.getByText(/credits:\s*—/i)).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the Refresh control re-invokes the fetch and shows the in-flight state', async () => {
    saveTokens({ deepseekKey: 'sk-deepseek-test' })
    _resetSettingsStateForTest()
    fetchProviderBalanceMock.mockResolvedValue({ currency: 'USD', total: 110 })
    render(AiModelsSection)
    await waitFor(() => expect(screen.getByText(/credits:\s*\$110\.00/i)).toBeInTheDocument())
    const initialCalls = fetchProviderBalanceMock.mock.calls.length

    // Gate the next fetch so the loading state is observable.
    let resolveFetch: (v: { currency: string; total: number } | null) => void = () => {}
    fetchProviderBalanceMock.mockImplementationOnce(
      () => new Promise((r) => { resolveFetch = r }),
    )
    await userEvent.click(screen.getByRole('button', { name: /refresh deepseek credits/i }))
    expect(fetchProviderBalanceMock.mock.calls.length).toBe(initialCalls + 1)
    expect(screen.getByText(/credits:\s*loading…/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /refresh deepseek credits/i })).toBeDisabled()

    resolveFetch({ currency: 'USD', total: 95 })
    await waitFor(() => expect(screen.getByText(/credits:\s*\$95\.00/i)).toBeInTheDocument())
  })
})
