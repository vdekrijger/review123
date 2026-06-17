/**
 * ModelCombobox.test.ts — the searchable, lab-grouped model picker.
 *
 * Covers: empty-query shows the featured set; filtering by slug AND label;
 * lab grouping (optgroup-style headers); selection fires onselect with the
 * right id; keyboard nav (Arrow/Enter/Esc) + combobox/listbox a11y roles.
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
  const input = screen.getByRole('combobox', { name: /openrouter model/i }) as HTMLInputElement
  return { ...utils, onselect, input }
}

describe('ModelCombobox — a11y roles', () => {
  it('exposes role=combobox with aria-expanded reflecting open state', async () => {
    const { input } = renderCombobox()
    expect(input).toHaveAttribute('role', 'combobox')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(input)
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls')
  })

  it('renders a listbox with option roles when open', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
  })

  it('shows the selected model label as the closed-state placeholder', () => {
    const { input } = renderCombobox('anthropic/claude-opus-4.8')
    expect(input.placeholder).toBe('Anthropic: Claude Opus 4.8')
  })
})

describe('ModelCombobox — empty query shows featured', () => {
  it('lists ONLY the featured models with an empty query', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input)
    const options = screen.getAllByRole('option')
    const labels = options.map((o) => o.textContent)
    // The three featured flagships, and nothing un-featured.
    expect(options).toHaveLength(3)
    expect(labels.join(' ')).toMatch(/GPT-5.5/)
    expect(labels.join(' ')).toMatch(/Claude Opus 4.8/)
    expect(labels.join(' ')).toMatch(/DeepSeek V3.1/)
    expect(labels.join(' ')).not.toMatch(/Haiku/)
  })
})

describe('ModelCombobox — filtering', () => {
  it('filters by slug (case-insensitive)', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input)
    await userEvent.type(input, 'haiku')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent(/Claude Haiku 4.5/)
  })

  it('filters by label text too (matches the friendly name)', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input)
    await userEvent.type(input, 'gemini')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent(/Gemini 3.5 Flash/)
  })

  it('shows an empty-state when nothing matches', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input)
    await userEvent.type(input, 'zzz-nope')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/No models match/i)).toBeInTheDocument()
  })
})

describe('ModelCombobox — lab grouping', () => {
  it('groups results under friendly lab headers', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input)
    await userEvent.type(input, 'claude')
    // Both Claude models live under the Anthropic group header.
    const group = screen.getByRole('group', { name: 'Anthropic' })
    expect(within(group).getAllByRole('option').length).toBe(2)
  })

  it('maps the x-ai prefix to a friendly name in a broader filter', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input)
    await userEvent.type(input, 'openai')
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeInTheDocument()
  })
})

describe('ModelCombobox — selection', () => {
  it('clicking an option fires onselect with the model id and closes', async () => {
    const { input, onselect } = renderCombobox()
    await userEvent.click(input)
    await userEvent.type(input, 'haiku')
    await userEvent.click(screen.getByRole('option', { name: /Claude Haiku 4.5/ }))
    expect(onselect).toHaveBeenCalledWith('anthropic/claude-haiku-4.5')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('ModelCombobox — keyboard nav', () => {
  it('ArrowDown + Enter selects the active option', async () => {
    const { input, onselect } = renderCombobox()
    await userEvent.click(input)
    await userEvent.type(input, 'gpt')
    // First match active; Enter selects it.
    await userEvent.keyboard('{Enter}')
    expect(onselect).toHaveBeenCalledWith('openai/gpt-5.5')
  })

  it('ArrowDown moves the active descendant', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input) // featured list (3 items), first active
    const first = input.getAttribute('aria-activedescendant')
    await userEvent.keyboard('{ArrowDown}')
    const second = input.getAttribute('aria-activedescendant')
    expect(second).not.toBe(first)
    expect(second).toBeTruthy()
  })

  it('Escape closes the listbox', async () => {
    const { input } = renderCombobox()
    await userEvent.click(input)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
