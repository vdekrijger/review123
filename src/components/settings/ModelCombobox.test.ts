/**
 * ModelCombobox.test.ts — the two-column lab/model picker.
 *
 * Covers: the closed <button> trigger shows the selected label exactly once
 * (no overlay/placeholder duplication); opening shows the left lab column
 * (Featured + labs with counts) and the active lab's models on the right;
 * default active lab = the selected model's lab; selecting fires onselect +
 * closes; search collapses to a flat result list across all labs (and a
 * no-match message); clearing search returns to two-column browse; keyboard
 * (Arrow/Enter/Esc) + outside-click/focusout close.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import ModelCombobox from './ModelCombobox.svelte'
import type { LlmModelDef } from '../../lib/llm/providers'

const MODELS: LlmModelDef[] = [
  { id: 'openai/gpt-5.5', label: 'OpenAI: GPT-5.5', contextWindowTokens: 400_000, pricing: { inputPer1M: 5, outputPer1M: 30 }, featured: true },
  { id: 'openai/gpt-5-mini', label: 'OpenAI: GPT-5 Mini', contextWindowTokens: 400_000, pricing: { inputPer1M: 0.5, outputPer1M: 2 } },
  { id: 'anthropic/claude-opus-4.8', label: 'Anthropic: Claude Opus 4.8', contextWindowTokens: 1_000_000, pricing: { inputPer1M: 5, outputPer1M: 25 }, featured: true },
  { id: 'anthropic/claude-haiku-4.5', label: 'Anthropic: Claude Haiku 4.5', contextWindowTokens: 200_000, pricing: { inputPer1M: 1, outputPer1M: 5 } },
  { id: 'google/gemini-3.5-flash', label: 'Google: Gemini 3.5 Flash', contextWindowTokens: 1_048_576, pricing: { inputPer1M: 1.5, outputPer1M: 9 } },
  { id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek: DeepSeek V3.1', contextWindowTokens: 163_840, pricing: { inputPer1M: 0.21, outputPer1M: 0.79 }, featured: true },
]

function renderCombobox(value = 'openai/gpt-5.5') {
  const onselect = vi.fn()
  const utils = render(ModelCombobox, { props: { models: MODELS, value, onselect, label: 'OpenRouter model' } })
  // The closed trigger is a button labelled by `label`.
  const trigger = screen.getByRole('button', { name: /openrouter model/i }) as HTMLButtonElement
  return { ...utils, onselect, trigger }
}

const search = () => screen.getByRole('searchbox', { name: /search all/i }) as HTMLInputElement

describe('ModelCombobox — closed state (no duplicate label)', () => {
  it('renders a button trigger, not a text input', () => {
    const { trigger } = renderCombobox()
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // No text input exists while closed (the old garbled-overlay shape is gone).
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('shows the selected model label EXACTLY ONCE (no overlay duplication)', () => {
    renderCombobox('anthropic/claude-opus-4.8')
    const matches = screen.getAllByText('Anthropic: Claude Opus 4.8')
    expect(matches).toHaveLength(1)
  })

  it('reflects the current value', () => {
    const { trigger } = renderCombobox('deepseek/deepseek-chat-v3.1')
    expect(trigger).toHaveTextContent('DeepSeek: DeepSeek V3.1')
  })
})

describe('ModelCombobox — opening + two columns', () => {
  it('clicking the trigger opens the panel and focuses the search field', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(search()).toBeInTheDocument()
    expect(search()).toHaveFocus()
  })

  it('left column lists "Featured" plus the labs with counts', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    const labList = screen.getByRole('listbox', { name: /model labs/i })
    const labs = within(labList).getAllByRole('option').map((o) => o.textContent)
    expect(labs.join(' ')).toMatch(/Featured/)
    expect(labs.join(' ')).toMatch(/OpenAI/)
    expect(labs.join(' ')).toMatch(/Anthropic/)
    expect(labs.join(' ')).toMatch(/Google/)
    expect(labs.join(' ')).toMatch(/DeepSeek/)
    // Anthropic has two models in the fixture → count badge of 2.
    const anthropic = within(labList).getByRole('option', { name: /Anthropic/ })
    expect(anthropic).toHaveTextContent('2')
  })

  it('default active lab = the selected model’s lab; its models show on the right', async () => {
    const { trigger } = renderCombobox('anthropic/claude-haiku-4.5')
    await userEvent.click(trigger)
    const labList = screen.getByRole('listbox', { name: /model labs/i })
    expect(within(labList).getByRole('option', { name: /Anthropic/ })).toHaveAttribute('aria-selected', 'true')
    const modelList = screen.getByRole('listbox', { name: /Anthropic models/i })
    const models = within(modelList).getAllByRole('option')
    expect(models).toHaveLength(2)
    expect(modelList).toHaveTextContent('Claude Opus 4.8')
    expect(modelList).toHaveTextContent('Claude Haiku 4.5')
  })

  it('hovering a lab updates the right column live', async () => {
    const { trigger } = renderCombobox('openai/gpt-5.5')
    await userEvent.click(trigger)
    const labList = screen.getByRole('listbox', { name: /model labs/i })
    await userEvent.hover(within(labList).getByRole('option', { name: /Google/ }))
    expect(screen.getByRole('listbox', { name: /Google models/i })).toHaveTextContent('Gemini 3.5 Flash')
  })
})

describe('ModelCombobox — selection', () => {
  it('clicking a model in the right column fires onselect and closes', async () => {
    const { trigger, onselect } = renderCombobox('anthropic/claude-opus-4.8')
    await userEvent.click(trigger)
    const modelList = screen.getByRole('listbox', { name: /Anthropic models/i })
    await userEvent.click(within(modelList).getByRole('option', { name: /Claude Haiku 4.5/ }))
    expect(onselect).toHaveBeenCalledWith('anthropic/claude-haiku-4.5')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks the currently-selected model as selected', async () => {
    const { trigger } = renderCombobox('anthropic/claude-opus-4.8')
    await userEvent.click(trigger)
    const modelList = screen.getByRole('listbox', { name: /Anthropic models/i })
    expect(within(modelList).getByRole('option', { name: /Claude Opus 4.8/ })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('ModelCombobox — search mode', () => {
  it('typing filters to matching models across all labs (flat list)', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    await userEvent.type(search(), 'claude')
    // No lab column while searching.
    expect(screen.queryByRole('listbox', { name: /model labs/i })).toBeNull()
    const results = screen.getByRole('listbox', { name: /openrouter model/i })
    const options = within(results).getAllByRole('option')
    expect(options).toHaveLength(2)
    options.forEach((o) => expect(o).toHaveTextContent(/Claude/))
  })

  it('filters by slug as well as label (case-insensitive)', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    await userEvent.type(search(), 'gemini')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent(/Gemini 3.5 Flash/)
  })

  it('groups search results under friendly lab headers', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    await userEvent.type(search(), 'claude')
    const group = screen.getByRole('group', { name: 'Anthropic' })
    expect(within(group).getAllByRole('option')).toHaveLength(2)
  })

  it('shows a no-match message when nothing matches', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    await userEvent.type(search(), 'zzz-nope')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/No models match/i)).toBeInTheDocument()
  })

  it('clearing the search returns to the two-column browse view', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    await userEvent.type(search(), 'claude')
    expect(screen.queryByRole('listbox', { name: /model labs/i })).toBeNull()
    await userEvent.clear(search())
    expect(screen.getByRole('listbox', { name: /model labs/i })).toBeInTheDocument()
  })
})

describe('ModelCombobox — keyboard + a11y', () => {
  it('ArrowDown then Enter selects the active model in search mode', async () => {
    const { trigger, onselect } = renderCombobox()
    await userEvent.click(trigger)
    await userEvent.type(search(), 'gpt')
    // First match active; Enter selects it.
    await userEvent.keyboard('{Enter}')
    expect(onselect).toHaveBeenCalledWith('openai/gpt-5.5')
  })

  it('ArrowDown moves the active descendant', async () => {
    const { trigger } = renderCombobox('anthropic/claude-opus-4.8')
    await userEvent.click(trigger)
    const list = screen.getByRole('listbox', { name: /Anthropic models/i })
    const first = list.getAttribute('aria-activedescendant')
    await userEvent.keyboard('{ArrowDown}')
    const second = list.getAttribute('aria-activedescendant')
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
  })

  it('Escape closes the panel and returns focus to the trigger', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    expect(search()).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('clicking outside closes the panel', async () => {
    const { trigger } = renderCombobox()
    await userEvent.click(trigger)
    expect(search()).toBeInTheDocument()
    await userEvent.click(document.body)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})
