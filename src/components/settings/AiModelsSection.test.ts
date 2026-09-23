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
import { _resetBridgeForTest } from '../../lib/bridge/bridge.svelte'
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
  // The bridge's paired/unpaired state lives in module state, so clearing
  // localStorage alone does not undo it: without this, a test that pairs a
  // bridge leaves every LATER test in the file believing one is connected.
  _resetBridgeForTest()
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

/**
 * The API providers. The LOCAL BRIDGE is excluded from every key-field loop
 * because it HAS no API key — its credential is the bridge pairing token, and
 * its card is asserted separately in its own describe block below.
 */
const API_PROVIDERS = PROVIDERS.filter((p) => p.id !== 'bridge')

describe('AiModelsSection — provider context cards (layout)', () => {
  it('renders one card per API provider, each containing its radio, model dropdown, key field and Save & test button', () => {
    render(AiModelsSection)
    for (const p of API_PROVIDERS) {
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
    // the searchable combobox instead (asserted separately). The bridge's
    // two-CLI list is a <select> too.
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
  it('renders a masked key input per API provider with the provider keyHint placeholder', () => {
    render(AiModelsSection)
    for (const p of API_PROVIDERS) {
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
  it('renders a Save & test button per API provider', () => {
    render(AiModelsSection)
    for (const p of API_PROVIDERS) {
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
    // Story + risk judge + simplify are extras too — minimal tokens means off.
    expect(m.story).toBe('off')
    expect(m.riskJudge).toBe('off')
    expect(m.simplify).toBe('off')
  })

  it('renders a Story walkthrough row with all three modes (deep-capable)', () => {
    render(AiModelsSection)
    const storyGroup = within(screen.getByRole('radiogroup', { name: /Story walkthrough mode/i }))
    expect(storyGroup.getByRole('radio', { name: /Off/i })).toBeInTheDocument()
    expect(storyGroup.getByRole('radio', { name: /Standard/i })).toBeInTheDocument()
    expect(storyGroup.getByRole('radio', { name: /Deep/i })).toBeInTheDocument()
  })

  it('renders a Risk judge row with Off + Standard but NO Deep (single-pass by design)', () => {
    render(AiModelsSection)
    const judgeGroup = within(screen.getByRole('radiogroup', { name: /Risk judge/i }))
    expect(judgeGroup.getByRole('radio', { name: /Off/i })).toBeInTheDocument()
    expect(judgeGroup.getByRole('radio', { name: /Standard/i })).toBeInTheDocument()
    expect(judgeGroup.queryByRole('radio', { name: /Deep/i })).toBeNull()
  })

  it('turning the Story walkthrough / Risk judge rows off persists immediately', async () => {
    render(AiModelsSection)
    const storyGroup = within(screen.getByRole('radiogroup', { name: /Story walkthrough mode/i }))
    await userEvent.click(storyGroup.getByRole('radio', { name: /Off/i }))
    expect(getSettings().aiTaskModes.story).toBe('off')
    const judgeGroup = within(screen.getByRole('radiogroup', { name: /Risk judge/i }))
    await userEvent.click(judgeGroup.getByRole('radio', { name: /Off/i }))
    expect(getSettings().aiTaskModes.riskJudge).toBe('off')
  })

  it('quick-set All → story deep, riskJudge stays standard (never deep)', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /^All$/i }))
    const m = getSettings().aiTaskModes
    expect(m.story).toBe('deep')
    expect(m.riskJudge).toBe('standard')
  })

  it('renders a Simplify findings row with Off + Standard but NO Deep (pure text rewrite)', () => {
    render(AiModelsSection)
    const simplifyGroup = within(screen.getByRole('radiogroup', { name: /Simplify findings/i }))
    expect(simplifyGroup.getByRole('radio', { name: /Off/i })).toBeInTheDocument()
    expect(simplifyGroup.getByRole('radio', { name: /Standard/i })).toBeInTheDocument()
    expect(simplifyGroup.queryByRole('radio', { name: /Deep/i })).toBeNull()
  })

  it('the Simplify row defaults to Standard (always-on) and persists Off immediately', async () => {
    render(AiModelsSection)
    const simplifyGroup = within(screen.getByRole('radiogroup', { name: /Simplify findings/i }))
    expect(simplifyGroup.getByRole('radio', { name: /Standard/i })).toBeChecked()
    await userEvent.click(simplifyGroup.getByRole('radio', { name: /Off/i }))
    expect(getSettings().aiTaskModes.simplify).toBe('off')
  })

  it('quick-set All (deep) keeps simplify standard — never deep', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /^All$/i }))
    expect(getSettings().aiTaskModes.simplify).toBe('standard')
  })

  it('quick-set None returns simplify to standard (still on) after it was off', async () => {
    localStorage.setItem('review123:settings', JSON.stringify({ aiTaskModes: { simplify: 'off' } }))
    _resetSettingsStateForTest()
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /^None$/i }))
    expect(getSettings().aiTaskModes.simplify).toBe('standard')
  })

  it('renders an Intent check row with Off + Standard but NO Deep (off|standard only in v1)', () => {
    render(AiModelsSection)
    const intentGroup = within(screen.getByRole('radiogroup', { name: /Intent check/i }))
    expect(intentGroup.getByRole('radio', { name: /Off/i })).toBeInTheDocument()
    expect(intentGroup.getByRole('radio', { name: /Standard/i })).toBeInTheDocument()
    expect(intentGroup.queryByRole('radio', { name: /Deep/i })).toBeNull()
  })

  it('the Intent check row defaults to Standard and persists Off immediately', async () => {
    render(AiModelsSection)
    const intentGroup = within(screen.getByRole('radiogroup', { name: /Intent check/i }))
    expect(intentGroup.getByRole('radio', { name: /Standard/i })).toBeChecked()
    await userEvent.click(intentGroup.getByRole('radio', { name: /Off/i }))
    expect(getSettings().aiTaskModes.intent).toBe('off')
  })

  it('quick-set All (deep) keeps intent standard — never deep', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /^All$/i }))
    expect(getSettings().aiTaskModes.intent).toBe('standard')
  })

  it('quick-set Off-all-extras turns intent off (an extra, not summary/verdict)', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /Off-all-extras/i }))
    expect(getSettings().aiTaskModes.intent).toBe('off')
  })

  it('renders an Expected outcomes row with Off + Standard but NO Deep (off|standard only in v1)', () => {
    render(AiModelsSection)
    const outcomesGroup = within(screen.getByRole('radiogroup', { name: /Expected outcomes/i }))
    expect(outcomesGroup.getByRole('radio', { name: /Off/i })).toBeInTheDocument()
    expect(outcomesGroup.getByRole('radio', { name: /Standard/i })).toBeInTheDocument()
    expect(outcomesGroup.queryByRole('radio', { name: /Deep/i })).toBeNull()
  })

  it('the Expected outcomes row defaults to Standard and persists Off immediately', async () => {
    render(AiModelsSection)
    const outcomesGroup = within(screen.getByRole('radiogroup', { name: /Expected outcomes/i }))
    expect(outcomesGroup.getByRole('radio', { name: /Standard/i })).toBeChecked()
    await userEvent.click(outcomesGroup.getByRole('radio', { name: /Off/i }))
    expect(getSettings().aiTaskModes.outcomes).toBe('off')
  })

  it('quick-set All (deep) keeps outcomes standard — never deep', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /^All$/i }))
    expect(getSettings().aiTaskModes.outcomes).toBe('standard')
  })

  it('quick-set Off-all-extras turns outcomes off (an extra, not summary/verdict)', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('button', { name: /Off-all-extras/i }))
    expect(getSettings().aiTaskModes.outcomes).toBe('off')
  })
})

describe('AiModelsSection — show/hide key toggle', () => {
  function keyInput(name: RegExp): HTMLInputElement {
    return screen.getByLabelText(name) as HTMLInputElement
  }

  it('every API provider key field has a "Show key" eye toggle (aria-pressed=false, masked input)', () => {
    render(AiModelsSection)
    for (const p of API_PROVIDERS) {
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

  // -------------------------------------------------------------------------
  // The local bridge is credentialed by its PAIRING TOKEN, not an API key.
  // `providerKeyed` used to be an open-coded five-way chain ending
  // `: s.openrouterKey`, so 'bridge' fell off the end onto OpenRouter's empty
  // key: every bridge row read "no key", usablePanelCount was 0, and the
  // cross-check toggle stayed greyed out — with bridge rows configured.
  // -------------------------------------------------------------------------
  const BRIDGE_PAIRING = JSON.stringify({ token: 'pair-tok-000000000000000000', port: 7321 })

  it('a PAIRED bridge row is usable — no "no key" hint, controls enabled', () => {
    localStorage.setItem('review123:bridge', BRIDGE_PAIRING)
    _resetBridgeForTest()
    setupAnthropic()
    setAiPanel({ participants: [gen('bridge', 'claude'), ver('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    expect(screen.queryByText(/No .* key — add it above/i)).toBeNull()
    expect(screen.queryByText(/Bridge not paired/i)).toBeNull()
    const genRadios = screen.getAllByRole('radio', { name: /generator/i }) as HTMLInputElement[]
    expect(genRadios[0].disabled).toBe(false)
  })

  it('an UNPAIRED bridge row says so — and says PAIR, not "add a key"', () => {
    _resetBridgeForTest()
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('bridge', 'claude')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    // The bridge has no key field anywhere, so "add it above" would send the
    // user looking for a control that does not exist.
    expect(screen.getByText(/Bridge not paired — set one up in Local bridge below/i)).toBeInTheDocument()
    expect(screen.queryByText(/No Local bridge key/i)).toBeNull()
  })

  it('a paired bridge + a second model ENABLES the cross-check toggle', () => {
    localStorage.setItem('review123:bridge', BRIDGE_PAIRING)
    _resetBridgeForTest()
    setupAnthropic()
    setAiPanel({ participants: [gen('bridge', 'claude'), ver('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    const toggle = screen.getByRole('checkbox', { name: /Cross-check findings/i }) as HTMLInputElement
    expect(toggle.disabled).toBe(false)
    expect(screen.queryByText(/Add a second model/i)).toBeNull()
  })

  it('an unpaired bridge leaves the cross-check toggle disabled (one usable model)', () => {
    _resetBridgeForTest()
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('bridge', 'claude')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    const toggle = screen.getByRole('checkbox', { name: /Cross-check findings/i }) as HTMLInputElement
    expect(toggle.disabled).toBe(true)
  })

  // -------------------------------------------------------------------------
  // PER-ROW BRIDGE MODELS. The row's provider select picks Local bridge and
  // its model select picks the CLI — a process name, not a model. Without a
  // third control every bridge row ran whatever the ONE global bridgeModel
  // said, so "Fable generates, Opus verifies on one subscription" could not be
  // expressed at all. Free text, not a dropdown: neither CLI publishes a stable
  // list of model ids, so a baked-in one would be stale within weeks (#253).
  // -------------------------------------------------------------------------
  function bridgePanel(rows: PanelParticipant[]) {
    localStorage.setItem('review123:bridge', BRIDGE_PAIRING)
    _resetBridgeForTest()
    setupAnthropic()
    setAiPanel({ participants: rows })
    _resetSettingsStateForTest()
    render(AiModelsSection)
  }
  const bridgeRow = (
    cli: string,
    role: 'generator' | 'verifier',
    bridgeModel?: string,
  ): PanelParticipant => ({
    provider: 'bridge' as PanelParticipant['provider'],
    model: cli,
    role,
    ...(bridgeModel ? { bridgeModel } : {}),
  })

  it('gives a bridge row its OWN model box, and shows what each row runs', () => {
    bridgePanel([bridgeRow('claude', 'generator', 'fable'), bridgeRow('claude', 'verifier', 'opus')])
    expect((screen.getByTestId('panel-bridge-model-0') as HTMLInputElement).value).toBe('fable')
    expect((screen.getByTestId('panel-bridge-model-1') as HTMLInputElement).value).toBe('opus')
  })

  it('gives a NON-bridge row no model box — its model select already is the model', () => {
    bridgePanel([gen('anthropic', 'claude-opus-4-8'), bridgeRow('claude', 'verifier')])
    expect(screen.queryByTestId('panel-bridge-model-0')).toBeNull()
    expect(screen.getByTestId('panel-bridge-model-1')).toBeInTheDocument()
  })

  it('typing a model persists it to THAT ROW only', async () => {
    bridgePanel([bridgeRow('claude', 'generator'), bridgeRow('claude', 'verifier')])
    await userEvent.type(screen.getByTestId('panel-bridge-model-0'), 'fable')
    await userEvent.type(screen.getByTestId('panel-bridge-model-1'), 'opus')
    const rows = getSettings().aiPanel!.participants
    expect(rows.map((r) => r.bridgeModel)).toEqual(['fable', 'opus'])
    // Same CLI on both — one subscription, two models.
    expect(rows.map((r) => r.model)).toEqual(['claude', 'claude'])
  })

  it('ACCEPTS any model id — the suggestions are a datalist, not an allowlist', async () => {
    // Neither CLI publishes a stable enumeration, so a closed dropdown would go
    // stale. An unknown id is the CLI's to reject, with the CLI's own error.
    bridgePanel([bridgeRow('claude', 'generator')])
    await userEvent.type(screen.getByTestId('panel-bridge-model-0'), 'claude-some-unreleased-model-9')
    expect(getSettings().aiPanel!.participants[0].bridgeModel).toBe('claude-some-unreleased-model-9')
  })

  it('says what a blank row will inherit rather than leaving it a mystery', () => {
    localStorage.setItem('review123:settings', JSON.stringify({
      aiProvider: 'anthropic', anthropicKey: 'sk-ant-test', bridgeModel: 'opus',
    }))
    localStorage.setItem('review123:bridge', BRIDGE_PAIRING)
    _resetBridgeForTest()
    setAiPanel({ participants: [bridgeRow('claude', 'generator')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    expect((screen.getByTestId('panel-bridge-model-0') as HTMLInputElement).placeholder).toMatch(/inherits opus/i)
  })

  it('refuses a flag-shaped id: says so, and persists nothing', async () => {
    // The only caller-supplied string that reaches the bridge's argv.
    bridgePanel([bridgeRow('claude', 'generator')])
    await userEvent.type(screen.getByTestId('panel-bridge-model-0'), '--dangerously-skip-permissions')
    expect(screen.getByTestId('panel-bridge-model-invalid-0')).toBeInTheDocument()
    expect(getSettings().aiPanel!.participants[0].bridgeModel).toBeUndefined()
    // The typed text stays visible so the user can fix it rather than watching
    // the field silently erase itself under the cursor.
    expect((screen.getByTestId('panel-bridge-model-0') as HTMLInputElement).value)
      .toBe('--dangerously-skip-permissions')
  })

  it('drops a row\'s model when its CLI changes — a claude alias means nothing to codex', async () => {
    bridgePanel([bridgeRow('claude', 'generator', 'fable')])
    const modelSelects = screen.getAllByLabelText('Model') as HTMLSelectElement[]
    await userEvent.selectOptions(modelSelects[0], 'codex')
    const row = getSettings().aiPanel!.participants[0]
    expect(row.model).toBe('codex')
    expect(row.bridgeModel).toBeUndefined()
  })

  it('states the seat cost once several rows share one subscription', () => {
    bridgePanel([bridgeRow('claude', 'generator', 'fable'), bridgeRow('claude', 'verifier', 'opus')])
    const note = screen.getByTestId('panel-bridge-seat-note')
    expect(note).toBeInTheDocument()
    expect(note.textContent).toMatch(/at least 2\s+CLI calls against that one subscription/i)
  })

  it('says nothing about seats when only one row uses the bridge', () => {
    bridgePanel([bridgeRow('claude', 'generator', 'fable'), ver('anthropic', 'claude-haiku-4-5')])
    expect(screen.queryByTestId('panel-bridge-seat-note')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Single-verifier honesty: with one raiser and one verifier the vote cannot
  // change any outcome (1 >= 2/2 always holds), so the panel must say so
  // rather than let the user believe a vote is deciding something.
  // -------------------------------------------------------------------------
  it('warns that a two-model panel cannot outvote itself', () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8'), ver('anthropic', 'claude-haiku-4-5')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    const note = screen.getByTestId('ensemble-thin-poll')
    expect(note).toHaveTextContent(/cannot outvote each other/i)
    expect(note).toHaveTextContent(/Add a third model/i)
  })

  it('drops the warning once a third usable model can break the tie', () => {
    setupAnthropic()
    setAiPanel({ participants: [
      gen('anthropic', 'claude-opus-4-8'),
      ver('anthropic', 'claude-haiku-4-5'),
      ver('anthropic', 'claude-sonnet-4-6'),
    ] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    expect(screen.queryByTestId('ensemble-thin-poll')).toBeNull()
  })

  it('does not warn when cross-verification is not available at all', () => {
    setupAnthropic()
    setAiPanel({ participants: [gen('anthropic', 'claude-opus-4-8')] })
    _resetSettingsStateForTest()
    render(AiModelsSection)
    // One model is not a thin poll, it is no poll — the existing "add a second
    // model" hint already covers it and two messages would contradict.
    expect(screen.queryByTestId('ensemble-thin-poll')).toBeNull()
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

// ===========================================================================
// The LOCAL BRIDGE as an inference source
//
// It is a provider in the picker like any other, but it is NOT a vendor API:
// no key field, no credits row, and a status line instead. These tests pin the
// differences that a user would actually notice.
// ===========================================================================

describe('AiModelsSection — the local bridge source', () => {
  it('renders a radio for it alongside the API providers', () => {
    render(AiModelsSection)
    expect(screen.getByRole('radio', { name: 'Local bridge' })).toBeInTheDocument()
  })

  it('offers the two CLIs as its "models"', () => {
    render(AiModelsSection)
    const select = screen.getByLabelText(/local bridge model/i) as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['claude', 'codex'])
    expect(select.value).toBe('claude')
  })

  it('shows NO API key field — there is no key to paste', () => {
    render(AiModelsSection)
    const card = within(providerCard('Local bridge'))
    expect(card.queryByLabelText(/local bridge api key/i)).toBeNull()
    expect(card.queryByRole('button', { name: 'Show key' })).toBeNull()
  })

  it('shows NO credits row — a subscription has no per-key balance to read', () => {
    render(AiModelsSection)
    expect(screen.queryByTestId('balance-bridge')).toBeNull()
  })

  it('says it is not paired when no bridge has ever been connected', () => {
    render(AiModelsSection)
    expect(screen.getByTestId('bridge-source-status')).toHaveTextContent(/no bridge paired yet/i)
  })

  it('its button says Test, not Save & test — nothing is being saved', () => {
    render(AiModelsSection)
    const card = within(providerCard('Local bridge'))
    expect(card.getByRole('button', { name: /^test local bridge connection$/i })).toBeInTheDocument()
    expect(card.queryByRole('button', { name: /save & test/i })).toBeNull()
  })

  it('states that deep review is not available over it', () => {
    render(AiModelsSection)
    const card = providerCard('Local bridge')
    expect(card.textContent).toMatch(/deep \(agentic\) review is not\s+available over the bridge/i)
  })

  it('selecting it persists aiProvider — no key needed to choose it', async () => {
    render(AiModelsSection)
    await userEvent.click(screen.getByRole('radio', { name: 'Local bridge' }))
    expect(getSettings().aiProvider).toBe('bridge')
  })
})
