/**
 * modal-dialog.test.ts
 *
 * TDD tests for the "real modal" behaviour of ConsentDialog.
 *
 * Root cause being fixed: the component used <dialog open> (non-modal, no
 * top layer) so high-z-index diff internals stacked above it. Fix: call
 * showModal() so the browser places the dialog in the top layer.
 *
 * NOTE (Plan F Task F3): SettingsPanel's modal-behaviour tests were removed
 * with the component — settings is now the dedicated /settings page
 * (SettingsPage.svelte). Modal behaviour stays covered by ConsentDialog below.
 *
 * jsdom 29 does NOT implement showModal/close on HTMLDialogElement, so
 * test-setup.ts polyfills them (sets open=true / open=false). These tests spy
 * on that polyfill to verify the components call it correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import ConsentDialog from './ConsentDialog.svelte'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'

vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
})

// ---------------------------------------------------------------------------
// ConsentDialog — modal behaviour
// ---------------------------------------------------------------------------

describe('ConsentDialog — modal behaviour', () => {
  it('calls showModal() on the dialog element after mount', () => {
    const showModalSpy = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(ConsentDialog, { props: { repo: 'owner/repo', onresult: vi.fn() } })
    expect(showModalSpy).toHaveBeenCalledOnce()
    showModalSpy.mockRestore()
  })

  it('native cancel event (Esc) calls onresult(false)', () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/repo', onresult } })
    const dialog = screen.getByRole('dialog')
    dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }))
    expect(onresult).toHaveBeenCalledWith(false)
  })

  it('backdrop click (event.target === dialog) calls onresult(false)', () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/repo', onresult } })
    const dialog = screen.getByRole('dialog')
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onresult).toHaveBeenCalledWith(false)
  })

  it('click inside dialog content does NOT call onresult', async () => {
    const onresult = vi.fn()
    render(ConsentDialog, { props: { repo: 'owner/repo', onresult } })
    const heading = screen.getByRole('heading', { name: /Allow AI analysis/i })
    await userEvent.click(heading)
    expect(onresult).not.toHaveBeenCalled()
  })

  it('dialog is open after mount (showModal sets open=true via polyfill)', () => {
    render(ConsentDialog, { props: { repo: 'owner/repo', onresult: vi.fn() } })
    const dialog = screen.getByRole('dialog') as HTMLDialogElement
    expect(dialog.open).toBe(true)
  })
})
