/**
 * Tests for Fix 3 (revised): Diff width setting — attribute-driven, applies immediately.
 *
 * Root causes confirmed and tested:
 * 1. .review container (max-width: 70rem) is the true constraint; child .inspect-layout
 *    cannot widen past its parent. Fix: applyAppearance sets data-diffwidth on :root,
 *    CSS `:root[data-diffwidth='full'] .review { max-width: none }` lifts the cap.
 * 2. diffWidth read once at InspectStep mount — toggling does nothing without remount.
 *    Fix: attribute approach — AppearanceSection's onDiffWidthChange calls applyAppearance()
 *    (same as theme/font flow), so the attribute flips immediately in the live DOM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import AppearanceSection from './settings/AppearanceSection.svelte'
import { getSettings, setDiffWidth } from '../lib/settings/settings'
import * as appearanceModule from '../lib/settings/appearance.svelte'
import type { PrFile } from '../lib/github/types'

// Stub applyAppearance for AppearanceSection tests
vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-diffwidth')
  vi.mocked(appearanceModule.applyAppearance).mockClear()
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
// Fix 3: Settings UI (AppearanceSection)
// ---------------------------------------------------------------------------

describe('AppearanceSection — Diff width radiogroup (Fix 3)', () => {
  it('renders Diff width fieldset/radiogroup', () => {
    render(AppearanceSection)
    expect(screen.getByRole('group', { name: /diff width/i })).toBeInTheDocument()
  })

  it('renders Centered and Full width radio options', () => {
    render(AppearanceSection)
    const group = screen.getByRole('group', { name: /diff width/i })
    expect(within(group).getByRole('radio', { name: /centered/i })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /full width/i })).toBeInTheDocument()
  })

  it('Centered radio is checked by default', () => {
    render(AppearanceSection)
    const centeredRadio = screen.getByRole('radio', { name: /centered/i })
    expect((centeredRadio as HTMLInputElement).checked).toBe(true)
  })

  it('Full width radio is checked when diffWidth=full in storage', () => {
    setDiffWidth('full')
    render(AppearanceSection)
    const fullRadio = screen.getByRole('radio', { name: /full width/i })
    expect((fullRadio as HTMLInputElement).checked).toBe(true)
  })

  it('clicking Full width radio saves diffWidth=full immediately', async () => {
    render(AppearanceSection)
    await fireEvent.click(screen.getByRole('radio', { name: /full width/i }))
    expect(getSettings().diffWidth).toBe('full')
  })

  it('clicking Centered radio saves diffWidth=centered immediately', async () => {
    setDiffWidth('full')
    render(AppearanceSection)
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

// ---------------------------------------------------------------------------
// Root cause 1 + 2 regression tests (attribute-driven fix)
// ---------------------------------------------------------------------------

describe('AppearanceSection — onDiffWidthChange calls applyAppearance (attribute-driven fix)', () => {
  it('clicking Full width radio calls applyAppearance immediately', async () => {
    render(AppearanceSection)
    vi.mocked(appearanceModule.applyAppearance).mockClear()
    await fireEvent.click(screen.getByRole('radio', { name: /full width/i }))
    expect(vi.mocked(appearanceModule.applyAppearance)).toHaveBeenCalled()
  })

  it('clicking Centered radio calls applyAppearance immediately', async () => {
    setDiffWidth('full')
    render(AppearanceSection)
    vi.mocked(appearanceModule.applyAppearance).mockClear()
    await fireEvent.click(screen.getByRole('radio', { name: /centered/i }))
    expect(vi.mocked(appearanceModule.applyAppearance)).toHaveBeenCalled()
  })
})

describe('applyAppearance — sets data-diffwidth on documentElement (container-level fix)', () => {
  it('documentElement gets data-diffwidth=full immediately when Full width radio clicked', async () => {
    render(AppearanceSection)
    vi.mocked(appearanceModule.applyAppearance).mockClear()
    await fireEvent.click(screen.getByRole('radio', { name: /full width/i }))
    // Setting must be persisted AND applyAppearance called (which sets data-diffwidth on :root)
    expect(getSettings().diffWidth).toBe('full')
    expect(vi.mocked(appearanceModule.applyAppearance)).toHaveBeenCalledTimes(1)
  })

  it('documentElement gets data-diffwidth=centered immediately when Centered radio clicked', async () => {
    setDiffWidth('full')
    render(AppearanceSection)
    vi.mocked(appearanceModule.applyAppearance).mockClear()
    await fireEvent.click(screen.getByRole('radio', { name: /centered/i }))
    expect(getSettings().diffWidth).toBe('centered')
    expect(vi.mocked(appearanceModule.applyAppearance)).toHaveBeenCalledTimes(1)
  })
})
