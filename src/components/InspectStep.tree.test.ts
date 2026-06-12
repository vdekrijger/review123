/**
 * InspectStep file-tree integration tests.
 *
 * Tests:
 * 1. FileTree is rendered in step 2 (present in DOM, inside a drawer)
 * 2. Drawer is closed by default (toggle tab visible, tree not visible)
 * 3. Toggle opens drawer, tree becomes visible; state persists to settings
 * 4. Escape key closes the drawer (focus returns to toggle)
 * 5. Narrow viewport (<900px): file-select closes the drawer
 * 6. Clicking a file in the tree calls scrollIntoView on the corresponding article
 * 7. Clicking a file that is viewed-collapsed expands it
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import { createViewedStore } from '../lib/viewed/viewed.svelte'
import { getSettings } from '../lib/settings/settings'

// Canvas stub for DiffView in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  // Reset any viewport width overrides
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true })
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 2, deletions: 1, patch: PATCH }
}

// ---------------------------------------------------------------------------
// Default state: drawer closed
// ---------------------------------------------------------------------------

describe('InspectStep — drawer closed by default', () => {
  it('tree toggle tab is visible', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab')
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('drawer is not visible when closed (aria-expanded false)', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const drawer = container.querySelector('.file-tree-drawer')
    // drawer should not be visible — either hidden or has data-open="false"
    expect(drawer).toBeInTheDocument()
    expect(drawer).not.toHaveAttribute('data-open', 'true')
  })

  it('file tree nav is not in DOM when drawer is closed', () => {
    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const drawer = container.querySelector('.file-tree-drawer')
    expect(drawer).not.toHaveAttribute('data-open', 'true')
    // The file-tree-nav should not be in the DOM when drawer is closed
    expect(container.querySelector('.file-tree-nav')).not.toBeInTheDocument()
  })

  it('reads treeOpen=false from settings on mount (default closed)', () => {
    // treeOpen defaults to false — so drawer should be closed
    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('reads treeOpen=true from settings on mount (open if stored open)', () => {
    localStorage.setItem('review123:settings', JSON.stringify({ treeOpen: true }))
    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
})

// ---------------------------------------------------------------------------
// Toggle opens drawer + persists to settings
// ---------------------------------------------------------------------------

describe('InspectStep — toggle opens drawer', () => {
  it('clicking toggle tab opens the drawer (aria-expanded becomes true)', async () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const drawer = container.querySelector('.file-tree-drawer')
    expect(drawer).toHaveAttribute('data-open', 'true')
  })

  it('clicking toggle tab persists treeOpen=true to settings', async () => {
    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    await fireEvent.click(toggle)

    expect(getSettings().treeOpen).toBe(true)
  })

  it('clicking toggle twice closes the drawer again + persists treeOpen=false', async () => {
    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    await fireEvent.click(toggle)
    await fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(getSettings().treeOpen).toBe(false)
  })

  it('when drawer is open, file buttons are accessible in the tree', async () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    await fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: /a\.ts/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /b\.ts/ })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Keyboard: Escape closes the drawer
// ---------------------------------------------------------------------------

describe('InspectStep — Escape closes open drawer', () => {
  it('pressing Escape when drawer is open closes it', async () => {
    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    // Open drawer
    await fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // Press Escape
    await fireEvent.keyDown(document, { key: 'Escape' })

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('Escape on closed drawer does nothing', async () => {
    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await fireEvent.keyDown(document, { key: 'Escape' })

    // Still closed — no error
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})

// ---------------------------------------------------------------------------
// Narrow viewport (<900px): file-select closes drawer
// ---------------------------------------------------------------------------

describe('InspectStep — narrow viewport: file-select closes drawer', () => {
  it('selecting a file on narrow viewport closes the drawer', async () => {
    // Simulate narrow viewport
    Object.defineProperty(window, 'innerWidth', { value: 600, writable: true, configurable: true })

    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })

    // Open the drawer
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    await fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // Stub scrollIntoView for the target wrapper
    const slugA = 'src-a-ts'
    const wrapper = container.querySelector(`#file-${slugA}`)
    if (wrapper) wrapper.scrollIntoView = vi.fn()

    // Click the file in the tree (should close drawer on narrow viewport)
    const fileBtn = screen.getByRole('button', { name: /a\.ts/ })
    await fireEvent.click(fileBtn)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('selecting a file on wide viewport does NOT close the drawer', async () => {
    // Wide viewport
    Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true, configurable: true })

    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })

    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    await fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const slugA = 'src-a-ts'
    const wrapper = container.querySelector(`#file-${slugA}`)
    if (wrapper) wrapper.scrollIntoView = vi.fn()

    const fileBtn = screen.getByRole('button', { name: /a\.ts/ })
    await fireEvent.click(fileBtn)

    // On wide viewport, drawer stays open
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
})

// ---------------------------------------------------------------------------
// File tree select: scrolls to article (open drawer first)
// ---------------------------------------------------------------------------

describe('InspectStep — tree select scrolls to article', () => {
  it('calls scrollIntoView on the corresponding article when a tree file is clicked', async () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })

    // Open the drawer first
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    await fireEvent.click(toggle)

    // Spy on scrollIntoView for the target article
    const slugA = 'src-a-ts'
    const articleWrapper = container.querySelector(`#file-${slugA}`)
    expect(articleWrapper).toBeInTheDocument()

    const spy = vi.fn()
    articleWrapper!.scrollIntoView = spy

    // Click the file in the tree
    await fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }))

    expect(spy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// File tree select: expands viewed-collapsed article (open drawer first)
// ---------------------------------------------------------------------------

describe('InspectStep — tree select expands viewed-collapsed article', () => {
  it('removes is-collapsed when selecting a viewed-collapsed file via the tree', async () => {
    const files = [makeFile('src/a.ts')]
    const viewedStore = createViewedStore('owner/repo#42')
    // Mark the file as viewed → it will render as is-collapsed
    viewedStore.toggle('src/a.ts', PATCH)

    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, viewedStore },
    })

    // Open the drawer first
    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    await fireEvent.click(toggle)

    // Initially collapsed
    expect(container.querySelector('article.file-diff.is-collapsed')).toBeInTheDocument()

    // Stub scrollIntoView so it doesn't throw
    const slugA = 'src-a-ts'
    const wrapper = container.querySelector(`#file-${slugA}`)
    if (wrapper) wrapper.scrollIntoView = vi.fn()

    // Click the file in the tree
    await fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }))

    // Article should now be expanded (not collapsed)
    expect(container.querySelector('article.file-diff.is-collapsed')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Wide-viewport: drawer expands into left margin, not pushing diff column
// ---------------------------------------------------------------------------

describe('InspectStep — wide viewport: drawer opens into left margin', () => {
  it('diff-column does NOT shrink when drawer opens on wide viewport (≥1200px)', async () => {
    // Wide viewport with plenty of left-margin space
    Object.defineProperty(window, 'innerWidth', { value: 1400, writable: true, configurable: true })

    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })

    // Measure diff column before opening
    const diffCol = container.querySelector('.diff-column') as HTMLElement
    expect(diffCol).toBeInTheDocument()

    const toggle = container.querySelector('.tree-toggle-tab') as HTMLButtonElement
    await fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // On wide viewport, drawer should be absolutely positioned (left-margin mode)
    // so diff-column does NOT get the drawer-open class that would add margin
    expect(diffCol).not.toHaveClass('drawer-open')
  })

  it('inspect-layout has data-wide-mode when viewport is wide enough', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 1400, writable: true, configurable: true })

    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })

    const layout = container.querySelector('.inspect-layout') as HTMLElement
    expect(layout).toBeInTheDocument()

    // On wide viewport, layout should carry an attribute indicating wide mode
    // so the drawer is positioned absolutely into the left margin
    expect(layout).toHaveAttribute('data-wide', 'true')
  })

  it('inspect-layout does NOT have data-wide when viewport is narrow (<1200px)', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 800, writable: true, configurable: true })

    const files = [makeFile('src/a.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null },
    })

    const layout = container.querySelector('.inspect-layout') as HTMLElement
    expect(layout).not.toHaveAttribute('data-wide', 'true')
  })
})
