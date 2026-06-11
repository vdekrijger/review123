import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPanel from './SettingsPanel.svelte'
import { getSettings, saveGithubAuth } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
})

describe('SettingsPanel', () => {
  it('renders the settings dialog', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument()
  })

  it('EC-04h: both inputs have type="password" (masking)', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    // PAT is inside the Advanced disclosure — open it first
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const inputs = document.querySelectorAll('input[type="password"]')
    expect(inputs).toHaveLength(2)
    inputs.forEach((input) => {
      expect((input as HTMLInputElement).type).toBe('password')
    })
  })

  it('typing a PAT and clicking Save stores it and calls onclose', async () => {
    const onclose = vi.fn()
    render(SettingsPanel, { props: { onclose } })
    // Open the Advanced disclosure to reveal PAT input
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const patInput = screen.getByLabelText(/github token/i)
    await userEvent.type(patInput, 'github_pat_test123')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onclose).toHaveBeenCalledOnce()
    expect(getSettings().githubPat).toBe('github_pat_test123')
  })

  // PAT-behind-Advanced UX
  describe('Advanced disclosure for PAT', () => {
    it('GitHub PAT field is inside a closed <details> by default (no active PAT auth)', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const details = document.querySelector('details')
      expect(details).not.toBeNull()
      // Closed by default when no PAT auth active
      expect((details as HTMLDetailsElement).open).toBe(false)
    })

    it('Advanced disclosure is OPEN by default when PAT is the active auth method', () => {
      // Pre-seed a PAT auth so the disclosure should open by default
      saveGithubAuth({ token: 'ghp_existing_pat', method: 'pat', scopes: [] })

      render(SettingsPanel, { props: { onclose: vi.fn() } })

      const details = document.querySelector('details')
      expect(details).not.toBeNull()
      expect((details as HTMLDetailsElement).open).toBe(true)
    })

    it('DeepSeek key field is NOT inside the details element (stays prominent)', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const details = document.querySelector('details')
      const deepseekInput = screen.getByLabelText(/deepseek/i)
      // deepseekInput must not be a descendant of details
      expect(details?.contains(deepseekInput)).toBe(false)
    })

    it('PAT input is visible after opening the Advanced disclosure', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      expect(screen.getByLabelText(/github token/i)).toBeInTheDocument()
    })
  })
})
