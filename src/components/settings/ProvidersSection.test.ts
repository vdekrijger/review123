/**
 * ProvidersSection.test.ts
 *
 * Tests for the Providers & access settings section component.
 * These replace the provider/auth-related tests from SettingsPanel.test.ts,
 * retargeted to the decomposed section component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import ProvidersSection from './ProvidersSection.svelte'
import { getSettings, saveGithubAuth } from '../../lib/settings/settings'
import { _resetAuthStateForTest } from '../../lib/auth/authState.svelte'

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
})

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
    })

    it('saving with empty PAT field while signed in via OAuth preserves githubAuth', async () => {
      saveGithubAuth({ token: 'gho_oauth123', method: 'oauth', scopes: ['repo'] })
      _resetAuthStateForTest()

      render(ProvidersSection)
      // PAT field is empty (user did not type anything)
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

      // OAuth auth must be untouched
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
})
