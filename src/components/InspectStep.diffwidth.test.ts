/**
 * Tests for Fix 3: Diff width setting (diffWidth: 'centered' | 'full').
 *
 * - settings.ts: diffWidth added to Settings interface with default 'centered'
 * - setDiffWidth() setter exported
 * - SettingsPanel: Diff width radiogroup (Centered / Full width) in Appearance section
 * - InspectStep: when diffWidth='full', inspect-layout gets class 'diff-full'
 * - InspectStep: when diffWidth='centered' (default), no 'diff-full' class
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import SettingsPanel from './SettingsPanel.svelte'
import { getSettings, setDiffWidth } from '../lib/settings/settings'
import type { PrFile } from '../lib/github/types'

// Stub applyAppearance for SettingsPanel tests
vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFiles(names: string[]): PrFile[] {
  return names.map(filename => ({
    filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH,
  }))
}

// ---------------------------------------------------------------------------
// Fix 3: Settings API
// ---------------------------------------------------------------------------

describe('settings — diffWidth (Fix 3)', () => {
  it('default diffWidth is "centered"', () => {
    expect(getSettings().diffWidth).toBe('centered')
  })

  it('setDiffWidth("full") persists the setting', () => {
    setDiffWidth('full')
    expect(getSettings().diffWidth).toBe('full')
  })

  it('setDiffWidth("centered") persists the setting', () => {
    setDiffWidth('full')
    setDiffWidth('centered')
    expect(getSettings().diffWidth).toBe('centered')
  })

  it('coerces unknown diffWidth to centered (robustness)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ diffWidth: 'bananas' }))
    expect(getSettings().diffWidth).toBe('centered')
  })

  it('coerces stored "full" correctly', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ diffWidth: 'full' }))
    expect(getSettings().diffWidth).toBe('full')
  })
})

// ---------------------------------------------------------------------------
// Fix 3: SettingsPanel UI
// ---------------------------------------------------------------------------

describe('SettingsPanel — Diff width radiogroup (Fix 3)', () => {
  it('renders Diff width fieldset/radiogroup', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(screen.getByRole('group', { name: /diff width/i })).toBeInTheDocument()
  })

  it('renders Centered and Full width radio options', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const group = screen.getByRole('group', { name: /diff width/i })
    expect(within(group).getByRole('radio', { name: /centered/i })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /full width/i })).toBeInTheDocument()
  })

  it('Centered radio is checked by default', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const centeredRadio = screen.getByRole('radio', { name: /centered/i })
    expect((centeredRadio as HTMLInputElement).checked).toBe(true)
  })

  it('Full width radio is checked when diffWidth=full in storage', () => {
    setDiffWidth('full')
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const fullRadio = screen.getByRole('radio', { name: /full width/i })
    expect((fullRadio as HTMLInputElement).checked).toBe(true)
  })

  it('clicking Full width radio saves diffWidth=full immediately', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    await fireEvent.click(screen.getByRole('radio', { name: /full width/i }))
    expect(getSettings().diffWidth).toBe('full')
  })

  it('clicking Centered radio saves diffWidth=centered immediately', async () => {
    setDiffWidth('full')
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    await fireEvent.click(screen.getByRole('radio', { name: /centered/i }))
    expect(getSettings().diffWidth).toBe('centered')
  })
})

// ---------------------------------------------------------------------------
// Fix 3: InspectStep class application
// ---------------------------------------------------------------------------

describe('InspectStep — diff-full class (Fix 3)', () => {
  it('inspect-layout has NO "diff-full" class when diffWidth=centered (default)', () => {
    const { container } = render(InspectStep, {
      props: { files: makeFiles(['src/a.ts']), changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.classList.contains('diff-full')).toBe(false)
  })

  it('inspect-layout has "diff-full" class when diffWidth=full', () => {
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: { files: makeFiles(['src/a.ts']), changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.classList.contains('diff-full')).toBe(true)
  })

  it('inspect-layout does NOT have "diff-full" when diffWidth is centered at mount time', () => {
    // Ensure setting is centered before render
    setDiffWidth('centered')
    const result = render(InspectStep, {
      props: { files: makeFiles(['src/a.ts']), changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    expect(result.container.querySelector('.inspect-layout')?.classList.contains('diff-full')).toBe(false)
  })
})
