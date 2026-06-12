/**
 * SettingsPage.test.ts
 *
 * Tests for the dedicated /settings page route.
 * Verifies composition of section components and Back navigation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPage from './SettingsPage.svelte'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'
import { navigate } from '../lib/router/router.svelte'

// Stub applyAppearance so tests don't need real DOM env for it
vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

// Stub navigate to avoid real history mutations in tests
vi.mock('../lib/router/router.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/router/router.svelte')>()
  return { ...actual, navigate: vi.fn() }
})

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
  _resetSettingsStateForTest()
  sessionStorage.clear()
  vi.clearAllMocks()
})

describe('SettingsPage', () => {
  it('renders the settings page heading', () => {
    render(SettingsPage)
    expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument()
  })

  it('renders a Back button', () => {
    render(SettingsPage)
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
  })

  it('renders the Appearance section', () => {
    render(SettingsPage)
    expect(screen.getByRole('region', { name: /appearance/i })).toBeInTheDocument()
  })

  it('renders the Providers & access section', () => {
    render(SettingsPage)
    expect(screen.getByRole('region', { name: /providers and access/i })).toBeInTheDocument()
  })

  it('renders the AI models section', () => {
    render(SettingsPage)
    expect(screen.getByRole('region', { name: /ai models/i })).toBeInTheDocument()
  })

  it('renders the Reviewer skills section', () => {
    render(SettingsPage)
    expect(screen.getByRole('region', { name: /reviewer skills/i })).toBeInTheDocument()
  })

  it('renders the section nav', () => {
    render(SettingsPage)
    expect(screen.getByRole('navigation', { name: /settings sections/i })).toBeInTheDocument()
  })

  it('Back button navigates to returnTo path from sessionStorage', async () => {
    sessionStorage.setItem('review123:settingsReturnTo', '/review/github/owner/repo/42')
    render(SettingsPage)
    const backBtn = screen.getByRole('button', { name: /back/i })
    await userEvent.click(backBtn)
    expect(navigate).toHaveBeenCalledWith('/review/github/owner/repo/42')
  })

  it('Back button navigates to / when no returnTo stored', async () => {
    render(SettingsPage)
    const backBtn = screen.getByRole('button', { name: /back/i })
    await userEvent.click(backBtn)
    expect(navigate).toHaveBeenCalledWith('/')
  })
})

describe('SettingsPage — save scope', () => {
  it('exactly ONE plain "Save" button exists on the page, inside the Providers section (no floating/global save)', () => {
    render(SettingsPage)
    const saveButtons = screen.getAllByRole('button', { name: /^save$/i })
    expect(saveButtons).toHaveLength(1)
    const providersSection = screen.getByRole('region', { name: /providers and access/i })
    expect(providersSection.contains(saveButtons[0])).toBe(true)
  })

  it('the Providers Save persists ONLY Providers edits — a pending AI key edit is not saved', async () => {
    render(SettingsPage)

    // Edit a field in the AI models section (do NOT save it)
    await userEvent.type(screen.getByLabelText(/deepseek api key/i), 'sk-should-not-persist')

    // Edit a field in the Providers section and save THAT section
    const providersSection = screen.getByRole('region', { name: /providers and access/i })
    await userEvent.click(screen.getByText(/advanced.*personal access token/i))
    await userEvent.type(screen.getByLabelText(/github token/i), 'github_pat_scoped')
    const { getSettings } = await import('../lib/settings/settings')
    const saveBtn = screen.getAllByRole('button', { name: /^save$/i })[0]
    expect(providersSection.contains(saveBtn)).toBe(true)
    await userEvent.click(saveBtn)

    expect(getSettings().githubPat).toBe('github_pat_scoped')
    expect(getSettings().deepseekKey).toBeNull()
  })

  it('Appearance section advertises immediate apply and has no Save button', () => {
    render(SettingsPage)
    const appearance = screen.getByRole('region', { name: /appearance/i })
    expect(appearance.textContent).toMatch(/applies immediately/i)
    const saveButtons = screen.getAllByRole('button', { name: /^save$/i })
    for (const btn of saveButtons) {
      expect(appearance.contains(btn)).toBe(false)
    }
  })
})
