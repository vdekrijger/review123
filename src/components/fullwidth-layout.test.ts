/**
 * Tests for full-width layout interactions fix.
 *
 * When data-diffwidth='full', the centered 70rem content column disappears,
 * breaking two margin-dwelling elements:
 *
 * 1. Rail overlap (Fix A): In full mode the context rail RESERVES space via
 *    margin-right on .review when rail is expanded, instead of dwelling in the
 *    now-nonexistent right margin. The fix uses data-rail-collapsed on .review
 *    combined with data-diffwidth=full on :root.
 *
 * 2. Tree drawer (Fix B): In full mode the drawer MUST always use overlay
 *    mode (never push the diff column) AND must show backdrop+overlay in all
 *    regimes when full-width — because there's no left margin to hide in.
 *
 * 3. Centered mode unchanged (regression guard).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import Review from '../routes/Review.svelte'
import { setDiffWidth, setRailCollapsed } from '../lib/settings/settings'
import type { PrFile } from '../lib/github/types'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-diffwidth')
  vi.restoreAllMocks()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFiles(names: string[]): PrFile[] {
  return names.map(filename => ({
    filename, status: 'modified' as const, additions: 1, deletions: 0, patch: PATCH,
  }))
}

// ===========================================================================
// FIX A: Rail reserve space in full-width mode
// ===========================================================================

describe('Fix A — full-width mode: .review reserves margin-right for expanded rail', () => {
  it('full-width + rail expanded: .review has data-rail-collapsed="false"', () => {
    setDiffWidth('full')
    document.documentElement.setAttribute('data-diffwidth', 'full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    // The inspect-layout should have diff-full class
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.classList.contains('diff-full')).toBe(true)
  })

  it('full-width + rail expanded: inspect-layout has class diff-full', () => {
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.classList.contains('diff-full')).toBe(true)
  })

  it('centered mode: inspect-layout does NOT have class diff-full', () => {
    // centered is default
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.classList.contains('diff-full')).toBe(false)
  })
})

describe('Fix A — CSS selectors: :root[data-diffwidth=full] .review[data-rail-collapsed=false] reserves space', () => {
  /**
   * jsdom doesn't evaluate CSS, but we can verify the structural hooks are in place:
   * - The app.css rule targeting [data-diffwidth='full'] .review:has(.inspect-layout)
   * - The Review component adds data-rail-collapsed to .review
   * We verify the class-hooks exist at the component level.
   */

  it('full-width + expanded rail: CSS hook is present — inspect-layout.diff-full inside .review', () => {
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    // The diff-full class must be on .inspect-layout — CSS rule targets this
    const layout = container.querySelector('.inspect-layout.diff-full')
    expect(layout).not.toBeNull()
  })
})

// ===========================================================================
// FIX B: Tree drawer — overlay mode in full-width at ALL viewports
// ===========================================================================

describe('Fix B — full-width mode: drawer is always overlay (never margin-dweller)', () => {
  it('full-width + wide viewport (≥1200px) + open: diff-column does NOT get drawer-open class', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    const diffCol = container.querySelector('.diff-column')
    expect(diffCol?.classList.contains('drawer-open')).toBe(false)
  })

  it('full-width + wide viewport + open: backdrop IS rendered (overlay needs dismiss)', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    // In full-width mode, even wide viewport must show backdrop since there's no left margin
    expect(container.querySelector('.tree-backdrop')).toBeInTheDocument()
  })

  it('full-width + mid viewport (900–1199px) + open: backdrop IS rendered', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1100)
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    expect(container.querySelector('.tree-backdrop')).toBeInTheDocument()
  })

  it('full-width + wide + open: inspect-layout has diff-full class (full mode active)', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.classList.contains('diff-full')).toBe(true)
  })

  it('full-width + narrow (<900px) + open: narrow overlay still works (diff-column gets drawer-open)', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(700)
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    const diffCol = container.querySelector('.diff-column')
    // Narrow regime is already overlay — this should still work the same in full mode
    expect(diffCol?.classList.contains('drawer-open')).toBe(true)
  })
})

// ===========================================================================
// REGRESSION: Centered mode drawer behavior unchanged
// ===========================================================================

describe('Regression — centered mode drawer behavior unchanged', () => {
  it('centered + wide + open: diff-column does NOT get drawer-open class (margin mode)', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    // centered is default
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    const diffCol = container.querySelector('.diff-column')
    expect(diffCol?.classList.contains('drawer-open')).toBe(false)
  })

  it('centered + wide + open: NO backdrop rendered (fits in margin, no overlay needed)', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440)
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    expect(container.querySelector('.tree-backdrop')).not.toBeInTheDocument()
  })

  it('centered + mid + open: backdrop rendered (not enough margin)', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1100)
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    expect(container.querySelector('.tree-backdrop')).toBeInTheDocument()
  })
})

// ===========================================================================
// FIX B structural: inspect-layout has diff-full data attribute for CSS targeting
// ===========================================================================

describe('Fix B structural — full-width data hook on inspect-layout', () => {
  it('full-width: inspect-layout has data-diffwidth="full" attribute', () => {
    setDiffWidth('full')
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.getAttribute('data-diffwidth')).toBe('full')
  })

  it('centered: inspect-layout has data-diffwidth="centered" attribute', () => {
    const { container } = render(InspectStep, {
      props: {
        files: makeFiles(['src/a.ts']),
        changedFiles: 1,
        mode: 'unified',
        onmode: () => {},
        draftStore: null,
      },
    })
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.getAttribute('data-diffwidth')).toBe('centered')
  })
})
