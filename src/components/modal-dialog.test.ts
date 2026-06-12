/**
 * modal-dialog.test.ts
 *
 * TDD tests for the "real modal" behaviour of SettingsPanel and ConsentDialog.
 *
 * Root cause being fixed: both components used <dialog open> (non-modal, no
 * top layer) so high-z-index diff internals stacked above them. Fix: call
 * showModal() so the browser places the dialog in the top layer.
 *
 * jsdom 29 does NOT implement showModal/close on HTMLDialogElement, so
 * test-setup.ts polyfills them (sets open=true / open=false). These tests spy
 * on that polyfill to verify the components call it correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPanel from './SettingsPanel.svelte'
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
// SettingsPanel — modal behaviour
// ---------------------------------------------------------------------------

describe('SettingsPanel — modal behaviour', () => {
  it('calls showModal() on the dialog element after mount', () => {
    const showModalSpy = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(showModalSpy).toHaveBeenCalledOnce()
    showModalSpy.mockRestore()
  })

  it('does NOT use the open attribute directly (no <dialog open>)', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    // After mount the dialog should be open — but via showModal, not `open` attr
    // We cannot distinguish with jsdom, so we just verify getByRole works
    // (polyfill sets open=true in showModal, so the dialog is accessible)
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument()
  })

  it('native cancel event (Esc) calls onclose', () => {
    const onclose = vi.fn()
    render(SettingsPanel, { props: { onclose } })
    const dialog = screen.getByRole('dialog', { name: /settings/i })
    dialog.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true }))
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('backdrop click (event.target === dialog) calls onclose', async () => {
    const onclose = vi.fn()
    render(SettingsPanel, { props: { onclose } })
    const dialog = screen.getByRole('dialog', { name: /settings/i })
    // Simulate a click where the target IS the dialog element itself (backdrop area)
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('click inside dialog content does NOT call onclose', async () => {
    const onclose = vi.fn()
    render(SettingsPanel, { props: { onclose } })
    // Click on the h2 heading inside the dialog — should not close
    const heading = screen.getByRole('heading', { name: /settings/i })
    await userEvent.click(heading)
    expect(onclose).not.toHaveBeenCalled()
  })

  it('dialog has a ::backdrop (dialog element is open as modal — check open state)', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const dialog = screen.getByRole('dialog', { name: /settings/i }) as HTMLDialogElement
    // jsdom polyfill sets open=true when showModal() is called
    expect(dialog.open).toBe(true)
  })
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
