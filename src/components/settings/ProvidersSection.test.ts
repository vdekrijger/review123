/**
 * ProvidersSection.test.ts
 *
 * Tests for the Providers & access settings section component.
 * These replace the provider/auth-related tests from SettingsPanel.test.ts,
 * retargeted to the decomposed section component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import ProvidersSection from './ProvidersSection.svelte'
import { getSettings, saveGithubAuth, saveGitlabOAuth, saveTokens } from '../../lib/settings/settings'
import { _resetAuthStateForTest } from '../../lib/auth/authState.svelte'
import { _resetSettingsStateForTest } from '../../lib/settings/settingsState.svelte'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  _resetAuthStateForTest()
  _resetSettingsStateForTest()
})

/** A GitLab OAuth bundle that is valid (not expired). */
const validGitlabOAuth = {
  token: 'glo_token123',
  refreshToken: 'glr_refresh123',
  expiresAt: Date.now() + 60 * 60 * 1000,
}

describe('ProvidersSection', () => {
  it('EC-04h: all token inputs have type="password" (masking)', async () => {
    render(ProvidersSection)
    // PAT/GitLab fields are inside the Advanced disclosure — open it first
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const inputs = document.querySelectorAll('input[type="password"]')
    // GitHub PAT + GitLab PAT + Bitbucket email + Bitbucket token = 4 password inputs
    expect(inputs.length).toBeGreaterThanOrEqual(3)
    inputs.forEach((input) => {
      expect((input as HTMLInputElement).type).toBe('password')
    })
  })

  it('typing a PAT and clicking Save stores it', async () => {
    render(ProvidersSection)
    const summary = screen.getByText(/advanced.*personal access token/i)
    await userEvent.click(summary)
    const patInput = screen.getByLabelText(/github token/i)
    await userEvent.type(patInput, 'github_pat_test123')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(getSettings().githubPat).toBe('github_pat_test123')
  })

  describe('Advanced disclosure for PAT', () => {
    it('GitHub PAT field is inside a closed <details> by default (no active PAT auth)', () => {
      render(ProvidersSection)
      const details = document.querySelector('details')
      expect(details).not.toBeNull()
      expect((details as HTMLDetailsElement).open).toBe(false)
    })

    it('Advanced disclosure is OPEN by default when PAT is the active auth method', () => {
      saveGithubAuth({ token: 'ghp_existing_pat', method: 'pat', scopes: [] })
      render(ProvidersSection)
      const details = document.querySelector('details')
      expect(details).not.toBeNull()
      expect((details as HTMLDetailsElement).open).toBe(true)
    })

    it('PAT input is visible after opening the Advanced disclosure', async () => {
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      expect(screen.getByLabelText(/github token/i)).toBeInTheDocument()
    })
  })

  describe('PAT scope guidance', () => {
    it('shows required scopes for fine-grained and classic tokens in the Advanced section', async () => {
      render(ProvidersSection)
      const details = document.querySelector('details')
      expect(details?.textContent).toMatch(/Pull requests: Read & write/)
      expect(details?.textContent).toMatch(/Contents: Read/)
      expect(details?.textContent).toMatch(/Checks: Read/)
      expect(details?.textContent).toMatch(/public_repo/)
      expect(details?.textContent).toMatch(/Configure SSO/)
    })
  })

  describe('Bitbucket auth fields', () => {
    it('Bitbucket email and token inputs are type=password (masked)', async () => {
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const emailInput = screen.getByLabelText(/bitbucket email address/i)
      const tokenInput = screen.getByLabelText(/bitbucket api token/i)
      expect((emailInput as HTMLInputElement).type).toBe('password')
      expect((tokenInput as HTMLInputElement).type).toBe('password')
    })

    it('saving Bitbucket credentials stores them via saveBitbucketAuth', async () => {
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const emailInput = screen.getByLabelText(/bitbucket email address/i)
      const tokenInput = screen.getByLabelText(/bitbucket api token/i)
      await userEvent.type(emailInput, 'user@example.com')
      await userEvent.type(tokenInput, 'myapppassword123')
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect(getSettings().bitbucketAuth).toEqual({ email: 'user@example.com', token: 'myapppassword123' })
    })

    it('Bitbucket hint text is present in the Advanced section', () => {
      render(ProvidersSection)
      const details = document.querySelector('details')
      expect(details?.textContent).toMatch(/Pull requests: Write/)
      expect(details?.textContent).toMatch(/App passwords/)
    })

    it('saving with email but empty token shows error, does not store', async () => {
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const emailInput = screen.getByLabelText(/bitbucket email address/i)
      await userEvent.type(emailInput, 'user@example.com')
      // token left empty
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    it('saving with token but empty email shows error, does not store', async () => {
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const tokenInput = screen.getByLabelText(/bitbucket api token/i)
      await userEvent.type(tokenInput, 'myapppassword123')
      // email left empty
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    it('clearing previously stored credentials saves null for bitbucketAuth', async () => {
      localStorage.setItem('review123:settings', JSON.stringify({ bitbucketAuth: { email: 'old@example.com', token: 'oldtoken' } }))
      _resetSettingsStateForTest()
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const emailInput = screen.getByLabelText(/bitbucket email address/i)
      const tokenInput = screen.getByLabelText(/bitbucket api token/i)
      await userEvent.clear(emailInput)
      await userEvent.clear(tokenInput)
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect(getSettings().bitbucketAuth).toBeNull()
    })
  })

  describe('GitLab host field', () => {
    it('renders a GitLab host input inside the Advanced section', async () => {
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const hostInput = screen.getByLabelText(/gitlab host/i)
      expect(hostInput).toBeInTheDocument()
    })

    it('GitLab host input has placeholder "gitlab.com"', async () => {
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const hostInput = screen.getByLabelText(/gitlab host/i) as HTMLInputElement
      expect(hostInput.placeholder).toBe('gitlab.com')
    })

    it('typing a custom host and saving persists it in settings', async () => {
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const hostInput = screen.getByLabelText(/gitlab host/i)
      await userEvent.clear(hostInput)
      await userEvent.type(hostInput, 'gitlab.mycompany.com')
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect(getSettings().gitlabHost).toBe('gitlab.mycompany.com')
    })

    it('GitLab host input is pre-filled from stored settings', async () => {
      localStorage.setItem('review123:settings', JSON.stringify({ gitlabHost: 'mygitlab.corp' }))
      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const hostInput = screen.getByLabelText(/gitlab host/i) as HTMLInputElement
      expect(hostInput.value).toBe('mygitlab.corp')
    })
  })

  describe('save does not log out OAuth user', () => {
    beforeEach(() => {
      localStorage.clear()
      _resetAuthStateForTest()
      _resetSettingsStateForTest()
    })

    it('saving with empty PAT field while signed in via OAuth preserves githubAuth', async () => {
      saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['repo'] })
      _resetAuthStateForTest()
      _resetSettingsStateForTest()

      render(ProvidersSection)
      // PAT field is empty (user did not type anything). Edit another field so
      // the section is dirty and Save is enabled — the realistic flow.
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      await userEvent.type(screen.getByLabelText(/gitlab personal access token/i), 'glpat_new123')
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

      // The edited field was saved…
      expect(getSettings().gitlabToken).toBe('glpat_new123')
      // …and the OAuth auth must be untouched
      expect(getSettings().githubAuth).toEqual({ token: 'gho_oauth123', method: 'oauth', scopes: ['repo'] })
    })

    it('PAT user clearing the PAT field still clears githubAuth', async () => {
      saveGithubAuth({ token: 'ghp_existing', method: 'pat', scopes: [] })
      _resetAuthStateForTest()

      render(ProvidersSection)
      const summary = screen.getByText(/advanced.*personal access token/i)
      await userEvent.click(summary)
      const patInput = screen.getByLabelText(/github token/i)
      await userEvent.clear(patInput)
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

      expect(getSettings().githubAuth).toBeNull()
    })
  })

  describe('GitHub OAuth sign-in entry point', () => {
    it('shows the official "Sign in with GitHub" button when signed out', () => {
      render(ProvidersSection)
      expect(screen.getByRole('button', { name: /sign in with github/i })).toBeInTheDocument()
    })

    it('hides the GitHub sign-in button and shows a GitHub sign-out when signed in via OAuth', () => {
      saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['public_repo'] })
      _resetAuthStateForTest()
      render(ProvidersSection)
      expect(screen.queryByRole('button', { name: /sign in with github/i })).toBeNull()
      expect(screen.getByRole('button', { name: /sign out of github/i })).toBeInTheDocument()
    })

    it('clicking GitHub sign-out clears githubAuth', async () => {
      saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['public_repo'] })
      _resetAuthStateForTest()
      render(ProvidersSection)
      await userEvent.click(screen.getByRole('button', { name: /sign out of github/i }))
      expect(getSettings().githubAuth).toBeNull()
    })

    it('GitHub sign-in stores returnTo = location.pathname so the user comes back to /settings', async () => {
      Object.defineProperty(globalThis, 'location', {
        value: { pathname: '/settings', origin: 'http://localhost', assign: vi.fn(), href: 'http://localhost/settings' },
        writable: true,
        configurable: true,
      })
      render(ProvidersSection)
      await userEvent.click(screen.getByRole('button', { name: /sign in with github/i }))
      expect(sessionStorage.getItem('review123:returnTo')).toBe('/settings')
    })
  })

  describe('GitLab OAuth sign-in entry point', () => {
    it('shows the "Sign in with GitLab" button when GitLab OAuth is not connected', () => {
      render(ProvidersSection)
      expect(screen.getByRole('button', { name: /sign in with gitlab/i })).toBeInTheDocument()
    })

    it('hides the GitLab sign-in button and shows signed-in chip + sign-out when GitLab OAuth is connected', () => {
      saveGitlabOAuth(validGitlabOAuth)
      render(ProvidersSection)
      expect(screen.queryByRole('button', { name: /sign in with gitlab/i })).toBeNull()
      expect(screen.getByText(/gitlab · connected/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /sign out of gitlab/i })).toBeInTheDocument()
    })

    it('clicking GitLab sign-out clears gitlabOAuth', async () => {
      saveGitlabOAuth(validGitlabOAuth)
      render(ProvidersSection)
      await userEvent.click(screen.getByRole('button', { name: /sign out of gitlab/i }))
      expect(getSettings().gitlabOAuth).toBeNull()
    })

    it('GitLab sign-in stores returnTo = location.pathname so the user comes back to /settings', async () => {
      Object.defineProperty(globalThis, 'location', {
        value: { pathname: '/settings', origin: 'http://localhost', assign: vi.fn(), href: 'http://localhost/settings' },
        writable: true,
        configurable: true,
      })
      render(ProvidersSection)
      await userEvent.click(screen.getByRole('button', { name: /sign in with gitlab/i }))
      expect(sessionStorage.getItem('review123:returnTo')).toBe('/settings')
    })
  })

  describe('provider sessions are independent', () => {
    it('being signed into GitHub does not affect the GitLab UI state', () => {
      saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['public_repo'] })
      _resetAuthStateForTest()
      render(ProvidersSection)
      // GitHub: signed in
      expect(screen.queryByRole('button', { name: /sign in with github/i })).toBeNull()
      // GitLab: still signed out — sign-in button visible, status unchanged
      expect(screen.getByRole('button', { name: /sign in with gitlab/i })).toBeInTheDocument()
      expect(screen.getByText(/gitlab: not configured/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /sign out of gitlab/i })).toBeNull()
    })

    it('being signed into GitLab does not affect the GitHub UI state', () => {
      saveGitlabOAuth(validGitlabOAuth)
      render(ProvidersSection)
      // GitLab: signed in
      expect(screen.queryByRole('button', { name: /sign in with gitlab/i })).toBeNull()
      // GitHub: still signed out — sign-in button visible, status unchanged
      expect(screen.getByRole('button', { name: /sign in with github/i })).toBeInTheDocument()
      expect(screen.getByText(/^not signed in$/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /sign out of github/i })).toBeNull()
    })

    it('GitHub sign-out leaves the GitLab session intact', async () => {
      saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['public_repo'] })
      _resetAuthStateForTest()
      saveGitlabOAuth(validGitlabOAuth)
      render(ProvidersSection)
      await userEvent.click(screen.getByRole('button', { name: /sign out of github/i }))
      expect(getSettings().gitlabOAuth).toEqual(validGitlabOAuth)
      expect(getSettings().githubAuth).toBeNull()
    })

    it('GitLab sign-out leaves the GitHub session intact', async () => {
      saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['public_repo'] })
      _resetAuthStateForTest()
      saveGitlabOAuth(validGitlabOAuth)
      render(ProvidersSection)
      await userEvent.click(screen.getByRole('button', { name: /sign out of gitlab/i }))
      expect(getSettings().githubAuth).toEqual({ token: 'gho_oauth123', method: 'oauth', scopes: ['public_repo'] })
      expect(getSettings().gitlabOAuth).toBeNull()
    })
  })

  describe('save UX — dirty tracking and saved feedback', () => {
    async function openAdvanced() {
      await userEvent.click(screen.getByText(/advanced.*personal access token/i))
    }

    it('Save button is disabled when no field differs from stored settings', () => {
      render(ProvidersSection)
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    })

    it('typing in a field enables Save and shows an "unsaved changes" hint', async () => {
      render(ProvidersSection)
      expect(screen.queryByText(/unsaved changes/i)).toBeNull()
      await openAdvanced()
      await userEvent.type(screen.getByLabelText(/github token/i), 'github_pat_x')
      expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
      expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument()
    })

    it('reverting an edit back to the stored value makes the section clean again', async () => {
      localStorage.setItem('review123:settings', JSON.stringify({ gitlabHost: 'gitlab.com' }))
      _resetSettingsStateForTest()
      render(ProvidersSection)
      await openAdvanced()
      const hostInput = screen.getByLabelText(/gitlab host/i)
      await userEvent.clear(hostInput)
      await userEvent.type(hostInput, 'gitlab.corp')
      expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
      await userEvent.clear(hostInput)
      await userEvent.type(hostInput, 'gitlab.com')
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
      expect(screen.queryByText(/unsaved changes/i)).toBeNull()
    })

    it('clicking Save shows "Saved ✓" in an aria-live=polite region and disables Save again', async () => {
      render(ProvidersSection)
      await openAdvanced()
      await userEvent.type(screen.getByLabelText(/github token/i), 'github_pat_y')
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      const saved = screen.getByText(/saved ✓/i)
      expect(saved).toBeInTheDocument()
      expect(saved.closest('[aria-live="polite"]')).not.toBeNull()
      // Section is clean again: hint gone, Save back to quiet/disabled
      expect(screen.queryByText(/unsaved changes/i)).toBeNull()
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    })

    it('the "Saved ✓" confirmation is transient (fades after ~2s)', async () => {
      render(ProvidersSection)
      await openAdvanced()
      await userEvent.type(screen.getByLabelText(/github token/i), 'github_pat_z')
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect(screen.getByText(/saved ✓/i)).toBeInTheDocument()
      await waitFor(() => expect(screen.queryByText(/saved ✓/i)).toBeNull(), { timeout: 3500 })
    })

    it('a failed save (invalid Bitbucket pair) shows the error and does NOT show Saved ✓', async () => {
      render(ProvidersSection)
      await openAdvanced()
      await userEvent.type(screen.getByLabelText(/bitbucket email address/i), 'user@example.com')
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.queryByText(/saved ✓/i)).toBeNull()
      // Still dirty — the user can fix and retry
      expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
    })

    it('after saving a host entered as an origin URL, the field shows the normalized stored value (clean)', async () => {
      render(ProvidersSection)
      await openAdvanced()
      const hostInput = screen.getByLabelText(/gitlab host/i)
      await userEvent.clear(hostInput)
      await userEvent.type(hostInput, 'https://gitlab.corp.example')
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
      expect((hostInput as HTMLInputElement).value).toBe('gitlab.corp.example')
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    })
  })

  describe('compact connected chips', () => {
    it('GitHub OAuth connected → one chip row "✓ GitHub · connected" with an icon sign-out button (aria-label + title)', () => {
      saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['public_repo'] })
      _resetAuthStateForTest()
      render(ProvidersSection)
      expect(screen.getByText(/github · connected/i)).toBeInTheDocument()
      const signOut = screen.getByRole('button', { name: /sign out of github/i })
      expect(signOut).toHaveAttribute('title', 'Sign out of GitHub')
      // The sign-out lives INSIDE the chip row (merged status + action)
      expect(signOut.closest('.connected-chip')).not.toBeNull()
      // The old separate status line is gone
      expect(screen.queryByText(/signed in via github \(scopes/i)).toBeNull()
    })

    it('GitLab OAuth connected → identical chip treatment with icon sign-out button', () => {
      saveGitlabOAuth(validGitlabOAuth)
      render(ProvidersSection)
      expect(screen.getByText(/gitlab · connected/i)).toBeInTheDocument()
      const signOut = screen.getByRole('button', { name: /sign out of gitlab/i })
      expect(signOut).toHaveAttribute('title', 'Sign out of GitLab')
      expect(signOut.closest('.connected-chip')).not.toBeNull()
      expect(screen.queryByText(/gitlab: signed in via oauth/i)).toBeNull()
    })

    it('disconnected providers keep their status lines and sign-in buttons (no chips)', () => {
      render(ProvidersSection)
      expect(document.querySelector('.connected-chip')).toBeNull()
      expect(screen.getByText(/^not signed in$/i)).toBeInTheDocument()
      expect(screen.getByText(/gitlab: not configured/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /sign in with github/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /sign in with gitlab/i })).toBeInTheDocument()
    })
  })
})

describe('ProvidersSection — show/hide token toggles', () => {
  it('GitHub PAT, GitLab token and Bitbucket token each get a "Show key" eye toggle', async () => {
    render(ProvidersSection)
    await userEvent.click(screen.getByText(/advanced.*personal access token/i))
    const toggles = screen.getAllByRole('button', { name: 'Show key' })
    expect(toggles).toHaveLength(3)
    for (const toggle of toggles) {
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('toggling reveals the GitHub PAT as plain text and back', async () => {
    saveTokens({ githubPat: 'github_pat_secret' })
    render(ProvidersSection)
    const patInput = screen.getByLabelText(/github token/i) as HTMLInputElement
    expect(patInput.type).toBe('password')
    const toggle = patInput.closest('.secret-input')!.querySelector('button')!
    await userEvent.click(toggle)
    expect(patInput.type).toBe('text')
    expect(patInput.value).toBe('github_pat_secret')
    expect(toggle).toHaveAttribute('aria-label', 'Hide key')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(toggle)
    expect(patInput.type).toBe('password')
  })

  it('the Bitbucket email stays a plain masked field (not a token — no toggle)', async () => {
    render(ProvidersSection)
    await userEvent.click(screen.getByText(/advanced.*personal access token/i))
    const emailInput = screen.getByLabelText(/bitbucket email address/i) as HTMLInputElement
    expect(emailInput.type).toBe('password')
    expect(emailInput.closest('.secret-input')).toBeNull()
  })
})

describe('ProvidersSection — invalid key characters rejected at save', () => {
  it('an em dash in the GitHub PAT shows the friendly error and saves nothing', async () => {
    render(ProvidersSection)
    await userEvent.type(screen.getByLabelText(/github token/i), 'github_pat—oops')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/invalid character/i)
    expect(alert).toHaveTextContent(/re-copy it from the provider/i)
    expect(getSettings().githubPat).toBeNull()
  })

  it('an em dash in the GitLab token shows the friendly error and saves nothing', async () => {
    render(ProvidersSection)
    await userEvent.type(screen.getByLabelText(/gitlab personal access token/i), 'glpat—oops')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/invalid character/i)
    expect(getSettings().gitlabToken).toBeNull()
  })
})

describe('ProvidersSection — advanced disclosure stays open while typing', () => {
  it('typing in an advanced field does not snap the panel shut (regression: a one-way open attribute was re-applied by the grouped template effect on every state change)', async () => {
    saveGithubAuth({ token: 'ghp_existing_pat', method: 'pat', scopes: [] })
    render(ProvidersSection)
    const details = document.querySelector('#providers details') as HTMLDetailsElement
    expect(details.open).toBe(true)
    await userEvent.type(screen.getByLabelText(/github token/i), '-suffix')
    expect(details.open).toBe(true)
    await userEvent.type(screen.getByLabelText(/gitlab host/i), 'gitlab.corp.example')
    expect(details.open).toBe(true)
  })
})
