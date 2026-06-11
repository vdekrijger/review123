import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import Landing from './Landing.svelte'

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
