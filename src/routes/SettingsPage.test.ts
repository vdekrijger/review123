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
