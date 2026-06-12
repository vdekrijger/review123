/**
 * GitLabSignInButton component tests.
 *
 * Props: { onclick: () => void | Promise<void>, label?: string }
 * - Renders only when VITE_GITLAB_CLIENT_ID is set (gated by env var)
 * - Default label: "Sign in with GitLab"
 * - Renders the GitLab Tanuki SVG mark
 * - Fires onclick when clicked
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import GitLabSignInButton from './GitLabSignInButton.svelte'

// VITE_GITLAB_CLIENT_ID is set in vitest env (vite.config.ts test.env)
// so the button should render in tests.

describe('GitLabSignInButton', () => {
  it('renders default label "Sign in with GitLab"', () => {
    render(GitLabSignInButton, { props: { onclick: vi.fn() } })
    expect(screen.getByRole('button', { name: /sign in with gitlab/i })).toBeInTheDocument()
  })

  it('renders custom label when provided', () => {
    render(GitLabSignInButton, { props: { onclick: vi.fn(), label: 'Continue with GitLab' } })
    expect(screen.getByRole('button', { name: /continue with gitlab/i })).toBeInTheDocument()
  })

  it('renders an inline SVG (the Tanuki mark)', () => {
    const { container } = render(GitLabSignInButton, { props: { onclick: vi.fn() } })
    const svg = container.querySelector('button svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
  })

  it('fires onclick when the button is clicked', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(GitLabSignInButton, { props: { onclick: handler } })
    await user.click(screen.getByRole('button', { name: /sign in with gitlab/i }))
    expect(handler).toHaveBeenCalledOnce()
  })

  it('fires async onclick without throwing', async () => {
    const user = userEvent.setup()
    let resolved = false
    const asyncHandler = async () => {
      await Promise.resolve()
      resolved = true
    }
    render(GitLabSignInButton, { props: { onclick: asyncHandler } })
    await user.click(screen.getByRole('button', { name: /sign in with gitlab/i }))
    expect(resolved).toBe(true)
  })
})
