import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPanel from './SettingsPanel.svelte'
import { getSettings } from '../lib/settings/settings'

describe('SettingsPanel', () => {
  it('renders the settings dialog', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument()
  })

  it('EC-04h: both inputs have type="password" (masking)', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const inputs = document.querySelectorAll('input[type="password"]')
    expect(inputs).toHaveLength(2)
    inputs.forEach((input) => {
      expect((input as HTMLInputElement).type).toBe('password')
    })
  })

  it('typing a PAT and clicking Save stores it and calls onclose', async () => {
    localStorage.clear()
    const onclose = vi.fn()
    render(SettingsPanel, { props: { onclose } })
    const [patInput] = document.querySelectorAll('input[type="password"]')
    await userEvent.type(patInput, 'github_pat_test123')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onclose).toHaveBeenCalledOnce()
    expect(getSettings().githubPat).toBe('github_pat_test123')
  })
})
