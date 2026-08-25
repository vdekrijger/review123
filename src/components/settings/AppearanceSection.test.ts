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
import { getSettings, setShowProgress, setUnderstandSections } from '../../lib/settings/settings'
import { SECTION_REGISTRY } from '../panels/sectionRegistry'

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

  it('renders Focus mode fieldset with Off, Dim imports, Dim imports + comments', () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /focus mode/i })
    expect(group).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /^off$/i })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /^dim imports$/i })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /dim imports \+ comments/i })).toBeInTheDocument()
  })

  it('Dim imports is selected by default (focusMode defaults to imports)', () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /focus mode/i })
    const importsRadio = within(group).getByRole('radio', { name: /^dim imports$/i }) as HTMLInputElement
    expect(importsRadio.checked).toBe(true)
  })

  it('selecting Off persists focusMode=off', async () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /focus mode/i })
    await userEvent.click(within(group).getByRole('radio', { name: /^off$/i }))
    expect(getSettings().focusMode).toBe('off')
  })

  it('selecting Dim imports + comments persists focusMode=imports-comments', async () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /focus mode/i })
    await userEvent.click(within(group).getByRole('radio', { name: /dim imports \+ comments/i }))
    expect(getSettings().focusMode).toBe('imports-comments')
  })
})

// ---------------------------------------------------------------------------
// Understand step layout — reorder + enable/disable + reset
// ---------------------------------------------------------------------------

describe('AppearanceSection — Understand step layout', () => {
  const PAGE_TITLES = SECTION_REGISTRY.filter((s) => s.show.page).map((s) => s.title)

  /** Titles may contain regex metacharacters (e.g. "Intent check (AI)") — escape them. */
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  it('renders the layout list in registry order by default', () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /understand step layout/i })
    expect(group).toBeInTheDocument()
    const checkboxes = within(group).getAllByRole('checkbox')
    // One row per page section, all checked by default.
    expect(checkboxes.length).toBe(PAGE_TITLES.length)
    for (const cb of checkboxes) expect((cb as HTMLInputElement).checked).toBe(true)
  })

  it('Up button is disabled on the first row, Down on the last', () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /understand step layout/i })
    const firstTitle = PAGE_TITLES[0]
    const lastTitle = PAGE_TITLES[PAGE_TITLES.length - 1]
    const upFirst = within(group).getByRole('button', { name: new RegExp(`move ${esc(firstTitle)} up`, 'i') })
    const downLast = within(group).getByRole('button', { name: new RegExp(`move ${esc(lastTitle)} down`, 'i') })
    expect((upFirst as HTMLButtonElement).disabled).toBe(true)
    expect((downLast as HTMLButtonElement).disabled).toBe(true)
  })

  it('clicking Down on the first row reorders + calls the setter with the new order', async () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /understand step layout/i })
    const firstTitle = PAGE_TITLES[0]
    const secondTitle = PAGE_TITLES[1]
    await userEvent.click(within(group).getByRole('button', { name: new RegExp(`move ${esc(firstTitle)} down`, 'i') }))
    const stored = getSettings().understandSections
    expect(stored).not.toBeUndefined()
    // The first two ids are swapped vs. registry order.
    const firstId = SECTION_REGISTRY.find((s) => s.title === firstTitle)!.id
    const secondId = SECTION_REGISTRY.find((s) => s.title === secondTitle)!.id
    expect(stored![0].id).toBe(secondId)
    expect(stored![1].id).toBe(firstId)
  })

  it('clicking Up moves a row toward the top', async () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /understand step layout/i })
    const secondTitle = PAGE_TITLES[1]
    await userEvent.click(within(group).getByRole('button', { name: new RegExp(`move ${esc(secondTitle)} up`, 'i') }))
    const stored = getSettings().understandSections!
    const secondId = SECTION_REGISTRY.find((s) => s.title === secondTitle)!.id
    expect(stored[0].id).toBe(secondId)
  })

  it('toggling a checkbox off persists enabled:false for that section', async () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /understand step layout/i })
    const firstTitle = PAGE_TITLES[0]
    const checkbox = within(group).getByRole('checkbox', { name: new RegExp(`show ${esc(firstTitle)}`, 'i') })
    await userEvent.click(checkbox)
    const stored = getSettings().understandSections!
    const firstId = SECTION_REGISTRY.find((s) => s.title === firstTitle)!.id
    const entry = stored.find((s) => s.id === firstId)!
    expect(entry.enabled).toBe(false)
  })

  it('Reset to default clears the stored preference', async () => {
    // Seed a non-default preference first.
    setUnderstandSections([{ id: 'pr-description', enabled: false }])
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /understand step layout/i })
    await userEvent.click(within(group).getByRole('button', { name: /reset to default/i }))
    expect(getSettings().understandSections).toBeUndefined()
  })

  it('reflects a stored disabled section as an unchecked box', () => {
    const disabledTitle = PAGE_TITLES[0]
    const disabledId = SECTION_REGISTRY.find((s) => s.title === disabledTitle)!.id
    setUnderstandSections(
      SECTION_REGISTRY.filter((s) => s.show.page).map((s) => ({ id: s.id, enabled: s.id !== disabledId })),
    )
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /understand step layout/i })
    const checkbox = within(group).getByRole('checkbox', { name: new RegExp(`show ${esc(disabledTitle)}`, 'i') }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)
  })
})
