/**
 * GitHubSignInButton component tests.
 *
 * Props: { onclick: () => void | Promise<void>, label?: string }
 * - Default label: "Sign in with GitHub"
 * - Renders the GitHub Octocat SVG mark
 * - Fires onclick when clicked
 * - Role=button with accessible name from label
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import GitHubSignInButton from './GitHubSignInButton.svelte'

describe('GitHubSignInButton', () => {
  it('renders default label "Sign in with GitHub"', () => {
    render(GitHubSignInButton, { props: { onclick: vi.fn() } })
    expect(screen.getByRole('button', { name: /sign in with github/i })).toBeInTheDocument()
  })

  it('renders custom label when provided', () => {
    render(GitHubSignInButton, { props: { onclick: vi.fn(), label: 'Continue with GitHub' } })
    expect(screen.getByRole('button', { name: /continue with github/i })).toBeInTheDocument()
  })

  it('renders an inline SVG (the Octocat mark)', () => {
    const { container } = render(GitHubSignInButton, { props: { onclick: vi.fn() } })
    // The button must contain an svg element
    const svg = container.querySelector('button svg')
    expect(svg).not.toBeNull()
    // SVG should have viewBox "0 0 16 16"
    expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16')
  })

  it('fires onclick when the button is clicked', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    render(GitHubSignInButton, { props: { onclick: handler } })
    await user.click(screen.getByRole('button', { name: /sign in with github/i }))
    expect(handler).toHaveBeenCalledOnce()
  })

  it('fires async onclick without throwing', async () => {
    const user = userEvent.setup()
    let resolved = false
    const asyncHandler = async () => {
      await Promise.resolve()
      resolved = true
    }
    render(GitHubSignInButton, { props: { onclick: asyncHandler } })
    await user.click(screen.getByRole('button', { name: /sign in with github/i }))
    expect(resolved).toBe(true)
  })
})
