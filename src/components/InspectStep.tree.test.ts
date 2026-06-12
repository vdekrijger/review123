/**
 * InspectStep file-tree integration tests.
 *
 * Tests:
 * 1. FileTree is rendered in step 2 (visible in DOM)
 * 2. Clicking a file in the tree calls scrollIntoView on the corresponding article
 * 3. Clicking a file that is viewed-collapsed expands it
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import { createViewedStore } from '../lib/viewed/viewed.svelte'

// Canvas stub for DiffView in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 2, deletions: 1, patch: PATCH }
}

describe('InspectStep — FileTree visible', () => {
  it('renders the file tree alongside file diffs', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })
    // The tree navigation should be present
    expect(container.querySelector('.file-tree-nav')).toBeInTheDocument()
    // Both file buttons should be in the tree
    expect(screen.getByRole('button', { name: /a\.ts/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /b\.ts/ })).toBeInTheDocument()
  })
})

describe('InspectStep — tree select scrolls to article', () => {
  it('calls scrollIntoView on the corresponding article when a tree file is clicked', async () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null },
    })

    // Spy on scrollIntoView for the target article
    const slugA = 'src/a.ts'.replace(/[^a-zA-Z0-9]/g, '-')
    const articleWrapper = container.querySelector(`#file-${slugA}`)
    expect(articleWrapper).toBeInTheDocument()

    const spy = vi.fn()
    articleWrapper!.scrollIntoView = spy

    // Click the file in the tree
    await fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }))

    expect(spy).toHaveBeenCalled()
  })
})

describe('InspectStep — tree select expands viewed-collapsed article', () => {
  it('removes is-collapsed when selecting a viewed-collapsed file via the tree', async () => {
    const files = [makeFile('src/a.ts')]
    const viewedStore = createViewedStore('owner/repo#42')
    // Mark the file as viewed → it will render as is-collapsed
    viewedStore.toggle('src/a.ts', PATCH)

    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, viewedStore },
    })

    // Initially collapsed
    expect(container.querySelector('article.file-diff.is-collapsed')).toBeInTheDocument()

    // Stub scrollIntoView so it doesn't throw
    const slugA = 'src/a.ts'.replace(/[^a-zA-Z0-9]/g, '-')
    const wrapper = container.querySelector(`#file-${slugA}`)
    if (wrapper) wrapper.scrollIntoView = vi.fn()

    // Click the file in the tree
    await fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }))

    // Article should now be expanded (not collapsed)
    expect(container.querySelector('article.file-diff.is-collapsed')).not.toBeInTheDocument()
  })
})
