/**
 * AppearanceSection.test.ts
 *
 * Tests for the Appearance settings section component.
 * These replace the Appearance-related tests from SettingsPanel.test.ts,
 * retargeted to the decomposed section component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import AppearanceSection from './AppearanceSection.svelte'
import { getSettings, setShowProgress } from '../../lib/settings/settings'

// Stub applyAppearance so tests don't need real DOM env for it
vi.mock('../../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('AppearanceSection', () => {
  it('renders Theme radiogroup with Auto, Light, Dark options', () => {
    render(AppearanceSection)
    const themeGroup = screen.getByRole('group', { name: /theme/i })
    expect(themeGroup).toBeInTheDocument()
    expect(within(themeGroup).getByRole('radio', { name: /^auto$/i })).toBeInTheDocument()
    expect(within(themeGroup).getByRole('radio', { name: /^light$/i })).toBeInTheDocument()
    expect(within(themeGroup).getByRole('radio', { name: /^dark$/i })).toBeInTheDocument()
  })

  it('renders Font radiogroup with Plex, System, Serif options', () => {
    render(AppearanceSection)
    const fontGroup = screen.getByRole('group', { name: /font/i })
    expect(fontGroup).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /plex/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /system/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /serif/i })).toBeInTheDocument()
  })

  it('selecting Dark theme persists in getSettings', async () => {
    render(AppearanceSection)
    await userEvent.click(screen.getByRole('radio', { name: /dark/i }))
    expect(getSettings().theme).toBe('dark')
  })

  it('selecting Light theme persists in getSettings', async () => {
    render(AppearanceSection)
    const themeGroup = screen.getByRole('group', { name: /theme/i })
    await userEvent.click(within(themeGroup).getByRole('radio', { name: /^light$/i }))
    expect(getSettings().theme).toBe('light')
  })

  it('selecting Plex font persists in getSettings', async () => {
    render(AppearanceSection)
    await userEvent.click(screen.getByRole('radio', { name: /plex/i }))
    expect(getSettings().uiFont).toBe('plex')
  })

  it('selecting Serif font persists in getSettings', async () => {
    render(AppearanceSection)
    await userEvent.click(screen.getByRole('radio', { name: /serif/i }))
    expect(getSettings().uiFont).toBe('serif')
  })

  it('Auto is selected by default for theme (matches stored default)', () => {
    render(AppearanceSection)
    const autoRadio = screen.getByRole('radio', { name: /auto/i })
    expect((autoRadio as HTMLInputElement).checked).toBe(true)
  })

  it('Plex is selected by default for font (matches stored default)', () => {
    render(AppearanceSection)
    const plexRadio = screen.getByRole('radio', { name: /plex/i })
    expect((plexRadio as HTMLInputElement).checked).toBe(true)
  })

  it('renders Progress bar radiogroup with Show and Hide options (fieldset style, no bare checkbox)', () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /progress bar/i })
    expect(group).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /^show$/i })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /^hide$/i })).toBeInTheDocument()
    // The old bare checkbox must be gone
    expect(screen.queryByRole('checkbox', { name: /show review progress bar/i })).toBeNull()
  })

  it('Show is selected by default (showProgress defaults to true)', () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /progress bar/i })
    const showRadio = within(group).getByRole('radio', { name: /^show$/i }) as HTMLInputElement
    expect(showRadio.checked).toBe(true)
  })

  it('Hide is selected when showProgress=false in storage', () => {
    setShowProgress(false)
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /progress bar/i })
    const hideRadio = within(group).getByRole('radio', { name: /^hide$/i }) as HTMLInputElement
    expect(hideRadio.checked).toBe(true)
  })

  it('clicking Hide immediately persists showProgress=false', async () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /progress bar/i })
    await userEvent.click(within(group).getByRole('radio', { name: /^hide$/i }))
    expect(getSettings().showProgress).toBe(false)
  })

  it('clicking Hide then Show restores showProgress=true', async () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /progress bar/i })
    await userEvent.click(within(group).getByRole('radio', { name: /^hide$/i }))
    await userEvent.click(within(group).getByRole('radio', { name: /^show$/i }))
    expect(getSettings().showProgress).toBe(true)
  })

  it('renders Test files radio fieldset', () => {
    render(AppearanceSection)
    expect(screen.getByRole('group', { name: /test files/i })).toBeInTheDocument()
  })

  it('Normal radio is checked by default for test files', () => {
    render(AppearanceSection)
    const normalRadio = screen.getByRole('radio', { name: /^normal$/i })
    expect((normalRadio as HTMLInputElement).checked).toBe(true)
  })

  it('Highlight radio changes setting to highlight on click', async () => {
    render(AppearanceSection)
    const highlightRadio = screen.getByRole('radio', { name: /^highlight$/i })
    await fireEvent.click(highlightRadio)
    expect(getSettings().testFileDisplay).toBe('highlight')
  })

  it('De-emphasize radio changes setting to dim on click', async () => {
    render(AppearanceSection)
    const dimRadio = screen.getByRole('radio', { name: /de-emphasize/i })
    await fireEvent.click(dimRadio)
    expect(getSettings().testFileDisplay).toBe('dim')
  })

  it('renders Diff width fieldset with Centered and Full width', () => {
    render(AppearanceSection)
    expect(screen.getByRole('group', { name: /diff width/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /centered/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /full width/i })).toBeInTheDocument()
  })
})
