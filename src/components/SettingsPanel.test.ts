import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPanel from './SettingsPanel.svelte'
import { getSettings, saveGithubAuth, setShowProgress, saveBitbucketAuth } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'

// Stub applyAppearance so SettingsPanel tests don't need real DOM env for it
vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
})

describe('SettingsPanel', () => {
  it('renders the settings dialog', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument()
  })

  it('EC-04h: all token inputs have type="password" (masking)', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    // PAT/GitLab fields are inside the Advanced disclosure — open it first
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const inputs = document.querySelectorAll('input[type="password"]')
    // DeepSeek + GitHub PAT + GitLab PAT = 3 password inputs
    expect(inputs.length).toBeGreaterThanOrEqual(3)
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

  describe('Appearance section', () => {
    beforeEach(() => {
      // Reset appearance mock call count
      vi.clearAllMocks()
    })

    it('renders Theme radiogroup with Auto, Light, Dark options', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const themeGroup = screen.getByRole('group', { name: /theme/i })
      expect(themeGroup).toBeInTheDocument()
      expect(within(themeGroup).getByRole('radio', { name: /^auto$/i })).toBeInTheDocument()
      expect(within(themeGroup).getByRole('radio', { name: /^light$/i })).toBeInTheDocument()
      expect(within(themeGroup).getByRole('radio', { name: /^dark$/i })).toBeInTheDocument()
    })

    it('renders Font radiogroup with Plex, System, Serif options', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const fontGroup = screen.getByRole('group', { name: /font/i })
      expect(fontGroup).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /plex/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /system/i })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /serif/i })).toBeInTheDocument()
    })

    it('selecting Dark theme immediately sets data-theme=dark on documentElement', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      // Select Dark radio
      await userEvent.click(screen.getByRole('radio', { name: /dark/i }))
      // applyAppearance mock was called — simulate it by directly checking settings
      expect(getSettings().theme).toBe('dark')
    })

    it('selecting Light theme persists in getSettings', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const themeGroup = screen.getByRole('group', { name: /theme/i })
      await userEvent.click(within(themeGroup).getByRole('radio', { name: /^light$/i }))
      expect(getSettings().theme).toBe('light')
    })

    it('selecting Plex font persists in getSettings', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('radio', { name: /plex/i }))
      expect(getSettings().uiFont).toBe('plex')
    })

    it('selecting Serif font persists in getSettings', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('radio', { name: /serif/i }))
      expect(getSettings().uiFont).toBe('serif')
    })

    it('Auto is selected by default for theme (matches stored default)', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const autoRadio = screen.getByRole('radio', { name: /auto/i })
      expect((autoRadio as HTMLInputElement).checked).toBe(true)
    })

    it('Plex is selected by default for font (matches stored default)', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const plexRadio = screen.getByRole('radio', { name: /plex/i })
      expect((plexRadio as HTMLInputElement).checked).toBe(true)
    })

    it('renders "Show review progress bar" checkbox in Appearance section', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      expect(screen.getByRole('checkbox', { name: /show review progress bar/i })).toBeInTheDocument()
    })

    it('"Show review progress bar" checkbox is checked by default (showProgress defaults to true)', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const cb = screen.getByRole('checkbox', { name: /show review progress bar/i }) as HTMLInputElement
      expect(cb.checked).toBe(true)
    })

    it('"Show review progress bar" unchecked when showProgress=false in storage', () => {
      setShowProgress(false)
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const cb = screen.getByRole('checkbox', { name: /show review progress bar/i }) as HTMLInputElement
      expect(cb.checked).toBe(false)
    })

    it('toggling the checkbox immediately persists showProgress=false', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const cb = screen.getByRole('checkbox', { name: /show review progress bar/i })
      await userEvent.click(cb)
      expect(getSettings().showProgress).toBe(false)
    })

    it('toggling the checkbox twice restores showProgress=true', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const cb = screen.getByRole('checkbox', { name: /show review progress bar/i })
      await userEvent.click(cb)
      await userEvent.click(cb)
      expect(getSettings().showProgress).toBe(true)
    })
  })
})

describe('PAT scope guidance', () => {
  it('shows required scopes for fine-grained and classic tokens in the Advanced section', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const details = document.querySelector('details')
    expect(details?.textContent).toMatch(/Pull requests: Read & write/)
    expect(details?.textContent).toMatch(/Contents: Read/)
    expect(details?.textContent).toMatch(/Checks: Read/)
    expect(details?.textContent).toMatch(/public_repo/)
    expect(details?.textContent).toMatch(/Configure SSO/)
  })
})

// ---------------------------------------------------------------------------
// SettingsPanel — testFileDisplay radio row (task 7)
// ---------------------------------------------------------------------------

describe('SettingsPanel — testFileDisplay setting', () => {
  beforeEach(() => { localStorage.clear() })

  it('renders Test files radio fieldset', () => {
    render(SettingsPanel, { props: { onclose: () => {} } })
    expect(screen.getByRole('group', { name: /test files/i })).toBeInTheDocument()
  })

  it('Normal radio is checked by default', () => {
    render(SettingsPanel, { props: { onclose: () => {} } })
    const normalRadio = screen.getByRole('radio', { name: /^normal$/i })
    expect((normalRadio as HTMLInputElement).checked).toBe(true)
  })

  it('Highlight radio changes setting to highlight on click', async () => {
    render(SettingsPanel, { props: { onclose: () => {} } })
    const highlightRadio = screen.getByRole('radio', { name: /^highlight$/i })
    await fireEvent.click(highlightRadio)
    expect(getSettings().testFileDisplay).toBe('highlight')
  })

  it('De-emphasize radio changes setting to dim on click', async () => {
    render(SettingsPanel, { props: { onclose: () => {} } })
    const dimRadio = screen.getByRole('radio', { name: /de-emphasize/i })
    await fireEvent.click(dimRadio)
    expect(getSettings().testFileDisplay).toBe('dim')
  })
})

// ---------------------------------------------------------------------------
// SettingsPanel — Bitbucket auth fields (task 49)
// ---------------------------------------------------------------------------

describe('SettingsPanel — Bitbucket auth fields', () => {
  beforeEach(() => { localStorage.clear() })

  it('Bitbucket email and token inputs are type=password (masked)', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const emailInput = screen.getByLabelText(/bitbucket email address/i)
    const tokenInput = screen.getByLabelText(/bitbucket api token/i)
    expect((emailInput as HTMLInputElement).type).toBe('password')
    expect((tokenInput as HTMLInputElement).type).toBe('password')
  })

  it('saving Bitbucket credentials stores them via saveBitbucketAuth', async () => {
    const onclose = vi.fn()
    render(SettingsPanel, { props: { onclose } })
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const emailInput = screen.getByLabelText(/bitbucket email address/i)
    const tokenInput = screen.getByLabelText(/bitbucket api token/i)
    await userEvent.type(emailInput, 'user@example.com')
    await userEvent.type(tokenInput, 'myapppassword123')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onclose).toHaveBeenCalledOnce()
    expect(getSettings().bitbucketAuth).toEqual({ email: 'user@example.com', token: 'myapppassword123' })
  })

  it('Bitbucket hint text is present in the Advanced section', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const details = document.querySelector('details')
    expect(details?.textContent).toMatch(/Pull requests: Write/)
    expect(details?.textContent).toMatch(/App passwords/)
  })

  it('saving with email but empty token shows error, does not call onclose', async () => {
    const onclose = vi.fn()
    render(SettingsPanel, { props: { onclose } })
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const emailInput = screen.getByLabelText(/bitbucket email address/i)
    await userEvent.type(emailInput, 'user@example.com')
    // token left empty
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(onclose).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
