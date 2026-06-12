import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import ConsentDialog from './ConsentDialog.svelte'

describe('ConsentDialog', () => {
  it('renders dialog with repo name and explanation', () => {
    render(ConsentDialog, { props: { repo: 'owner/private', onresult: vi.fn() } })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/owner\/private/)).toBeInTheDocument()
    expect(screen.getByText(/sent to DeepSeek/i)).toBeInTheDocument()
  })

  it('accept button calls onresult(true)', async () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/private', onresult } })
    await userEvent.click(screen.getByRole('button', { name: /Send code to DeepSeek/i }))
    expect(onresult).toHaveBeenCalledWith(true)
  })

  it('decline button ("Not now") calls onresult(false)', async () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/private', onresult } })
    await userEvent.click(screen.getByRole('button', { name: /Not now/i }))
    expect(onresult).toHaveBeenCalledWith(false)
  })

  it('Esc key (native cancel event) calls onresult(false)', async () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/private', onresult } })
    const dialog = screen.getByRole('dialog')
    // Real modal dialogs fire a 'cancel' event (not keydown) when Esc is pressed
    dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }))
    expect(onresult).toHaveBeenCalledWith(false)
  })

  it('mentions the repo name in the explanation text', () => {
    render(ConsentDialog, { props: { repo: 'acme/secret-app', onresult: vi.fn() } })
    expect(screen.getByText(/acme\/secret-app/)).toBeInTheDocument()
  })
})
