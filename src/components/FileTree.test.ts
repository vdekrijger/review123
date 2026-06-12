import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import FileTree from './FileTree.svelte'
import type { PrFile } from '../lib/github/types'
import type { AttentionResult } from '../lib/ai/schemas'
import { createViewedStore } from '../lib/viewed/viewed.svelte'

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFile(filename: string, additions = 2, deletions = 1, patch = PATCH): PrFile {
  return { filename, status: 'modified', additions, deletions, patch }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('FileTree rendering', () => {
  it('renders file names as buttons', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    render(FileTree, { props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} } })
    expect(screen.getByRole('button', { name: /a\.ts/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /b\.ts/ })).toBeInTheDocument()
  })

  it('renders directory nodes with collapsed single-child chains', () => {
    const files = [makeFile('a/b/c.ts')]
    render(FileTree, { props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} } })
    // The directory segment "a/b" should appear as a label/toggle
    expect(screen.getByText('a/b')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /c\.ts/ })).toBeInTheDocument()
  })

  it('renders +/- counts on file rows', () => {
    const files = [makeFile('src/a.ts', 5, 3)]
    render(FileTree, { props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} } })
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(screen.getByText('-3')).toBeInTheDocument()
  })

  it('renders zero counts when no additions/deletions', () => {
    const files = [{ filename: 'src/a.ts', status: 'modified' as const, additions: 0, deletions: 0 }]
    render(FileTree, { props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} } })
    // Should not throw or error — zeros may be shown or omitted, but no crash
    expect(screen.getByRole('button', { name: /a\.ts/ })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Select callback
// ---------------------------------------------------------------------------

describe('FileTree select callback', () => {
  it('calls onselect with the file path when a file button is clicked', async () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const onselect = vi.fn()
    render(FileTree, { props: { files, attention: null, viewedStore: null, activePath: null, onselect } })

    await fireEvent.click(screen.getByRole('button', { name: /a\.ts/ }))
    expect(onselect).toHaveBeenCalledWith('src/a.ts')
  })

  it('calls onselect with correct path for nested file', async () => {
    const files = [makeFile('deep/path/file.ts')]
    const onselect = vi.fn()
    render(FileTree, { props: { files, attention: null, viewedStore: null, activePath: null, onselect } })

    await fireEvent.click(screen.getByRole('button', { name: /file\.ts/ }))
    expect(onselect).toHaveBeenCalledWith('deep/path/file.ts')
  })
})

// ---------------------------------------------------------------------------
// Hotspot dots
// ---------------------------------------------------------------------------

describe('FileTree hotspot dots', () => {
  it('renders a red dot for high hotspot files', () => {
    const files = [makeFile('src/hot.ts')]
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [{ path: 'src/hot.ts', reason: 'Critical', level: 'high' }],
      testFlags: [],
    }
    const { container } = render(FileTree, { props: { files, attention, viewedStore: null, activePath: null, onselect: () => {} } })
    expect(container.querySelector('.hotspot-dot.level-high')).toBeInTheDocument()
  })

  it('renders an amber dot for medium hotspot files', () => {
    const files = [makeFile('src/med.ts')]
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [{ path: 'src/med.ts', reason: 'Medium', level: 'medium' }],
      testFlags: [],
    }
    const { container } = render(FileTree, { props: { files, attention, viewedStore: null, activePath: null, onselect: () => {} } })
    expect(container.querySelector('.hotspot-dot.level-medium')).toBeInTheDocument()
  })

  it('renders no hotspot dot when attention is null', () => {
    const files = [makeFile('src/a.ts')]
    const { container } = render(FileTree, { props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} } })
    expect(container.querySelector('.hotspot-dot')).not.toBeInTheDocument()
  })

  it('renders no hotspot dot for files not in hotspots', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const attention: AttentionResult = {
      readingOrder: [],
      hotspots: [{ path: 'src/a.ts', reason: 'Hot', level: 'high' }],
      testFlags: [],
    }
    const { container } = render(FileTree, { props: { files, attention, viewedStore: null, activePath: null, onselect: () => {} } })
    // Only one hotspot dot for src/a.ts
    expect(container.querySelectorAll('.hotspot-dot')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Viewed dimming
// ---------------------------------------------------------------------------

describe('FileTree viewed dimming', () => {
  it('renders viewed checkmark when file is viewed', () => {
    const files = [makeFile('src/a.ts')]
    const viewedStore = createViewedStore('owner/repo#1')
    viewedStore.toggle('src/a.ts', PATCH)

    const { container } = render(FileTree, { props: { files, attention: null, viewedStore, activePath: null, onselect: () => {} } })
    expect(container.querySelector('.viewed-check')).toBeInTheDocument()
  })

  it('does not render viewed checkmark when file is not viewed', () => {
    const files = [makeFile('src/a.ts')]
    const viewedStore = createViewedStore('owner/repo#1')
    // Not toggled

    const { container } = render(FileTree, { props: { files, attention: null, viewedStore, activePath: null, onselect: () => {} } })
    expect(container.querySelector('.viewed-check')).not.toBeInTheDocument()
  })

  it('works without viewedStore (null)', () => {
    const files = [makeFile('src/a.ts')]
    const { container } = render(FileTree, { props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} } })
    expect(container.querySelector('.viewed-check')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Active row highlight
// ---------------------------------------------------------------------------

describe('FileTree active highlight', () => {
  it('marks the active file row', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/b.ts')]
    const { container } = render(FileTree, {
      props: { files, attention: null, viewedStore: null, activePath: 'src/a.ts', onselect: () => {} },
    })
    const activeRow = container.querySelector('.file-row.active')
    expect(activeRow).toBeInTheDocument()
    // Only one active row
    expect(container.querySelectorAll('.file-row.active')).toHaveLength(1)
  })

  it('no active row when activePath is null', () => {
    const files = [makeFile('src/a.ts')]
    const { container } = render(FileTree, {
      props: { files, attention: null, viewedStore: null, activePath: null, onselect: () => {} },
    })
    expect(container.querySelector('.file-row.active')).not.toBeInTheDocument()
  })
})
