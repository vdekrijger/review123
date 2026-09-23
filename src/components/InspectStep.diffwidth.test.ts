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
  it('default diffWidth is "full"', () => {
    expect(getSettings().diffWidth).toBe('full')
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

  it('coerces unknown diffWidth to the default (robustness)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ diffWidth: 'bananas' }))
    expect(getSettings().diffWidth).toBe('full')
  })

  it('coerces stored "full" correctly', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ diffWidth: 'full' }))
    expect(getSettings().diffWidth).toBe('full')
  })
})

// ---------------------------------------------------------------------------
// The default moved 'centered' -> 'full'. The whole risk of that change is
// whether it reaches over someone who already chose. getSettings() is
// `{ ...DEFAULTS, ...coerce(stored) }`, so a stored value is applied LAST and
// wins — these pin that, because a regression here silently overrides a
// deliberate user preference and nothing else in the suite would notice.
// ---------------------------------------------------------------------------

describe('diffWidth — a stored preference beats the new default', () => {
  it('stored "centered" survives the default being "full"', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ diffWidth: 'centered' }))
    expect(getSettings().diffWidth).toBe('centered')
  })

  it('stored "centered" survives alongside other stored settings', () => {
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ diffWidth: 'centered', theme: 'dark', diffMode: 'split' }),
    )
    const s = getSettings()
    expect(s.diffWidth).toBe('centered')
    expect(s.theme).toBe('dark')
  })

  it('setDiffWidth("centered") round-trips — an explicit choice is re-read as chosen', () => {
    setDiffWidth('centered')
    expect(getSettings().diffWidth).toBe('centered')
    expect(JSON.parse(localStorage.getItem('review123:settings') ?? '{}').diffWidth).toBe('centered')
  })

  it('ONLY the unset default moves: absent key -> full, present key -> as stored', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ theme: 'dark' }))
    expect(getSettings().diffWidth).toBe('full')
    localStorage.setItem('review123:settings', JSON.stringify({ theme: 'dark', diffWidth: 'centered' }))
    expect(getSettings().diffWidth).toBe('centered')
  })

  it('a stored "centered" still reaches the rendered layout (no diff-full class)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ diffWidth: 'centered' }))
    const { container } = render(InspectStep, {
      props: { files: makeFiles(['src/a.ts']), changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    expect(container.querySelector('.inspect-layout')?.classList.contains('diff-full')).toBe(false)
  })

  it('a stored "centered" still checks the Centered radio in Appearance', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ diffWidth: 'centered' }))
    render(AppearanceSection)
    expect((screen.getByRole('radio', { name: /centered/i }) as HTMLInputElement).checked).toBe(true)
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

  it('Full width radio is checked by default', () => {
    render(AppearanceSection)
    const fullRadio = screen.getByRole('radio', { name: /full width/i })
    expect((fullRadio as HTMLInputElement).checked).toBe(true)
  })

  it('Centered radio is checked when diffWidth=centered in storage', () => {
    setDiffWidth('centered')
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
    setDiffWidth('centered')
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
  it('inspect-layout HAS "diff-full" class by default (nothing stored)', () => {
    const { container } = render(InspectStep, {
      props: { files: makeFiles(['src/a.ts']), changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.classList.contains('diff-full')).toBe(true)
  })

  it('inspect-layout has NO "diff-full" class when diffWidth=centered', () => {
    setDiffWidth('centered')
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
    setDiffWidth('centered')
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
    setDiffWidth('centered')
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
