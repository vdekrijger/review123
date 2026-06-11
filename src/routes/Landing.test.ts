import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import Landing from './Landing.svelte'
import { addToHistory, clearHistory } from '../lib/history/history'

beforeEach(() => {
  localStorage.clear()
})

describe('Landing', () => {
  it('EC-01b: empty submit shows "enter a PR URL", no navigation', async () => {
    history.replaceState(null, '', '/')
    render(Landing)
    await userEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/enter a github pr url/i)
    expect(location.pathname).toBe('/')
  })

  it('EC-01i: non-PR URL shows specific message', async () => {
    render(Landing)
    await userEvent.type(screen.getByRole('textbox'), 'https://github.com/just-an-owner')
    await userEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/does not look like a pull request url/i)
  })

  it('valid URL navigates to the review route', async () => {
    render(Landing)
    await userEvent.type(screen.getByRole('textbox'), 'https://github.com/a/b/pull/12')
    await userEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(location.pathname).toBe('/review/a/b/12')
  })
})

describe('Landing recent reviews', () => {
  it('does not render "Recent reviews" section when history is empty', () => {
    render(Landing)
    expect(screen.queryByText(/recent reviews/i)).not.toBeInTheDocument()
  })

  it('renders "Recent reviews" when history contains entries', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    expect(screen.getByText(/recent reviews/i)).toBeInTheDocument()
  })

  it('renders history entry as owner/repo#number — title', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    expect(screen.getByText(/alice\/widgets#42/)).toBeInTheDocument()
    expect(screen.getByText('Add feature')).toBeInTheDocument()
  })

  it('clicking a history entry navigates to the review route', async () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    // Click the button for the PR
    const btn = screen.getByRole('button', { name: /alice\/widgets#42/i })
    await userEvent.click(btn)
    expect(location.pathname).toBe('/review/alice/widgets/42')
  })

  it('Clear button removes history entries from the UI', async () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    render(Landing)
    expect(screen.getByText(/alice\/widgets#42/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /clear history/i }))
    expect(screen.queryByText(/recent reviews/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/alice\/widgets#42/)).not.toBeInTheDocument()
  })

  it('renders multiple history entries', () => {
    addToHistory({ owner: 'a', repo: 'r', number: 1, title: 'First PR' })
    addToHistory({ owner: 'b', repo: 's', number: 2, title: 'Second PR' })
    render(Landing)
    expect(screen.getByText(/a\/r#1/)).toBeInTheDocument()
    expect(screen.getByText(/b\/s#2/)).toBeInTheDocument()
  })
})
