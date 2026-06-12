/**
 * Tests for the ADAPTIVE drawer contract.
 *
 * The drawer has two regimes, decided by PURE CSS (no JS viewport tracking):
 *
 *   MARGIN mode (centered diff + viewport ≥ 1750px): drawer extends LEFTWARD
 *     into the page margin; the diff column never moves.
 *   INLINE mode (full-width mode at any size, or a narrower viewport): drawer
 *     becomes an in-flow 340px flex child right of the toggle tab, pushing the
 *     diff over while open. No overlay, NO BACKDROP — ever.
 *
 * jsdom cannot evaluate CSS, so these tests assert the structural invariants
 * the CSS keys off (geometry itself is proven in e2e/drawer-left.spec.ts):
 *   - NO backdrop element is ever rendered (any viewport, any diff width).
 *   - .diff-column never carries a drawer-open class (push is plain flex flow).
 *   - .inspect-layout exposes data-diffwidth + diff-full class for CSS targeting.
 *   - data-open / aria-expanded toggle semantics; Escape closes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import { setDiffWidth } from '../lib/settings/settings'
import type { PrFile } from '../lib/github/types'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFiles(names: string[]): PrFile[] {
  return names.map(filename => ({
    filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH,
  }))
}

function renderStep() {
  return render(InspectStep, {
    props: { files: makeFiles(['src/a.ts']), changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
  })
}

// ---------------------------------------------------------------------------
// No backdrop, no drawer-open class — at ANY viewport width or diff width.
// The drawer never overlays the diff: it pushes (inline) or dwells in the
// margin (margin mode). Both are plain CSS; no overlay artifacts exist.
// ---------------------------------------------------------------------------

describe('InspectStep — adaptive drawer: no overlay artifacts in any regime', () => {
  const widths = [700, 1100, 1440, 1900]
  const modes = ['centered', 'full'] as const

  for (const width of widths) {
    for (const diffWidth of modes) {
      it(`${diffWidth} @ ${width}px + open: no backdrop, no drawer-open class`, async () => {
        vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width)
        setDiffWidth(diffWidth)
        const { container } = renderStep()
        await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
        expect(container.querySelector('.tree-backdrop')).toBeNull()
        const diffCol = container.querySelector('.diff-column')
        expect(diffCol?.classList.contains('drawer-open')).toBe(false)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// CSS hooks: the regime decision is pure CSS, keyed off these attributes.
// ---------------------------------------------------------------------------

describe('InspectStep — adaptive drawer: CSS hooks present', () => {
  it('open drawer has data-open="true" and is not aria-hidden', async () => {
    const { container } = renderStep()
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    const drawer = container.querySelector('.file-tree-drawer')
    expect(drawer?.getAttribute('data-open')).toBe('true')
    expect(drawer?.getAttribute('aria-hidden')).not.toBe('true')
  })

  it('closed drawer has data-open="false" and aria-hidden', () => {
    const { container } = renderStep()
    const drawer = container.querySelector('.file-tree-drawer')
    expect(drawer?.getAttribute('data-open')).toBe('false')
    expect(drawer?.getAttribute('aria-hidden')).toBe('true')
  })

  it('centered: inspect-layout has data-diffwidth="centered" and no diff-full class', () => {
    const { container } = renderStep()
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.getAttribute('data-diffwidth')).toBe('centered')
    expect(layout?.classList.contains('diff-full')).toBe(false)
  })

  it('full: inspect-layout has data-diffwidth="full" and diff-full class (forces inline mode)', () => {
    setDiffWidth('full')
    const { container } = renderStep()
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.getAttribute('data-diffwidth')).toBe('full')
    expect(layout?.classList.contains('diff-full')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Layout structure: drawer, tab and diff column are flex siblings so the
// inline push works through normal flex flow.
// ---------------------------------------------------------------------------

describe('InspectStep — layout structure', () => {
  it('drawer, toggle tab and diff column are direct children of inspect-layout', async () => {
    const { container } = renderStep()
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    const layout = container.querySelector('.inspect-layout')
    expect(layout?.querySelector(':scope > .file-tree-drawer')).toBeTruthy()
    expect(layout?.querySelector(':scope > .tree-toggle-tab')).toBeTruthy()
    expect(layout?.querySelector(':scope > .diff-column')).toBeTruthy()
  })

  it('file-tree-nav renders inside the drawer wrapper when open', async () => {
    const { container } = renderStep()
    await userEvent.click(screen.getByRole('button', { name: /open file tree/i }))
    expect(container.querySelector('.file-tree-drawer .file-tree-nav')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Keyboard: Escape closes the drawer (all regimes)
// ---------------------------------------------------------------------------

describe('InspectStep — Escape closes drawer', () => {
  it('pressing Escape while drawer is open closes it', async () => {
    render(InspectStep, {
      props: { files: makeFiles(['src/a.ts']), changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggleBtn = screen.getByRole('button', { name: /open file tree/i })
    await userEvent.click(toggleBtn)
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')

    await userEvent.keyboard('{Escape}')
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false')
  })
})
