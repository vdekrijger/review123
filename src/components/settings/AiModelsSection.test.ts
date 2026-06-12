/**
 * AiModelsSection.test.ts
 *
 * Tests for the AI models settings section component.
 * These replace the DeepSeek key field tests from SettingsPanel.test.ts,
 * retargeted to the decomposed section component.
 * F1 will enrich this section with provider/model selection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import AiModelsSection from './AiModelsSection.svelte'
import { getSettings, saveTokens } from '../../lib/settings/settings'

beforeEach(() => {
  localStorage.clear()
})

describe('AiModelsSection', () => {
  it('renders the DeepSeek API key input', () => {
    render(AiModelsSection)
    expect(screen.getByLabelText(/deepseek api key/i)).toBeInTheDocument()
  })

  it('DeepSeek key input is type=password (masking)', () => {
    render(AiModelsSection)
    const input = screen.getByLabelText(/deepseek api key/i) as HTMLInputElement
    expect(input.type).toBe('password')
  })

  it('DeepSeek key is NOT inside a details element (stays prominent)', () => {
    render(AiModelsSection)
    const details = document.querySelector('details')
    const deepseekInput = screen.getByLabelText(/deepseek api key/i)
    // deepseekInput must not be a descendant of details
    expect(details?.contains(deepseekInput)).toBeFalsy()
  })

  it('typing a DeepSeek key and clicking Save stores it', async () => {
    render(AiModelsSection)
    const keyInput = screen.getByLabelText(/deepseek api key/i)
    await userEvent.type(keyInput, 'sk-test123')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(getSettings().deepseekKey).toBe('sk-test123')
  })

  it('clearing the DeepSeek key saves null', async () => {
    saveTokens({ deepseekKey: 'sk-existing' })
    render(AiModelsSection)
    const keyInput = screen.getByLabelText(/deepseek api key/i)
    await userEvent.clear(keyInput)
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(getSettings().deepseekKey).toBeNull()
  })

  it('pre-fills DeepSeek key from stored settings', () => {
    saveTokens({ deepseekKey: 'sk-prefilled' })
    render(AiModelsSection)
    const keyInput = screen.getByLabelText(/deepseek api key/i) as HTMLInputElement
    expect(keyInput.value).toBe('sk-prefilled')
  })
})
