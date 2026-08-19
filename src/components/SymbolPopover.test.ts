import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import SymbolPopover from './SymbolPopover.svelte'
import type { SymbolDefinition, SymbolReference } from '../lib/symbols/symbolIndex'

const def: SymbolDefinition = {
  name: 'computeTotal',
  kind: 'function',
  file: 'src/util.ts',
  line: 4,
  side: 'new',
  snippet: 'export function computeTotal(values: number[]): number {',
  inDiff: true,
}

const refs: SymbolReference[] = [
  { name: 'computeTotal', file: 'src/app.ts', line: 9, side: 'new', snippet: 'const t = computeTotal(items)', inDiff: true },
  { name: 'computeTotal', file: 'src/app.ts', line: 2, side: 'old', snippet: 'legacyTotal = computeTotal(x)', inDiff: true },
  { name: 'computeTotal', file: 'src/util.ts', line: 90, side: 'new', snippet: 'cache.set(k, computeTotal(v))', inDiff: false },
]

function renderPopover(overrides: Partial<Record<string, unknown>> = {}) {
  const onJump = vi.fn()
  const onClose = vi.fn()
  const utils = render(SymbolPopover, {
    props: {
      symbol: 'computeTotal',
      definitions: [def],
      references: refs,
      x: 100,
      y: 100,
      currentFile: 'src/app.ts',
      onJump,
      onClose,
      ...overrides,
    },
  })
  return { ...utils, onJump, onClose }
}

describe('SymbolPopover', () => {
  it('renders the definition snippet with a file:line jump', async () => {
    const { onJump, onClose } = renderPopover()
    expect(screen.getByText('Definition')).toBeInTheDocument()
    expect(screen.getByText(/export function computeTotal/)).toBeInTheDocument()
    const loc = screen.getByRole('button', { name: 'src/util.ts:4' })
    await fireEvent.click(loc)
    expect(onJump).toHaveBeenCalledWith('src/util.ts', 4, 'new')
    expect(onClose).toHaveBeenCalled() // jump also dismisses the popover
  })

  it('renders the honest not-found line when no definition is available', () => {
    renderPopover({ definitions: [] })
    expect(screen.getByText(/Definition not in the changed files of this PR/)).toBeInTheDocument()
  })

  it('renders call points with the total count, grouped by file (current file first)', () => {
    const { container } = renderPopover()
    expect(screen.getByText('Call points in this PR (3)')).toBeInTheDocument()
    const fileNames = [...container.querySelectorAll('.ref-file-name')].map((el) => el.textContent)
    expect(fileNames).toEqual(['src/app.ts', 'src/util.ts'])
  })

  it('jumps to a reference row and closes', async () => {
    const { onJump, onClose } = renderPopover()
    const row = screen.getByRole('button', { name: /9\s*const t = computeTotal\(items\)/ })
    await fireEvent.click(row)
    expect(onJump).toHaveBeenCalledWith('src/app.ts', 9, 'new')
    expect(onClose).toHaveBeenCalled()
  })

  it('marks old-side reference rows and jumps with side old', async () => {
    const { onJump } = renderPopover()
    const row = screen.getByRole('button', { name: /−2\s*legacyTotal/ })
    await fireEvent.click(row)
    expect(onJump).toHaveBeenCalledWith('src/app.ts', 2, 'old')
  })

  it('renders out-of-hunk references as non-clickable rows with an explanation', () => {
    const { container } = renderPopover()
    const staticRow = container.querySelector('.ref-row.static')!
    expect(staticRow).toBeInTheDocument()
    expect(staticRow.textContent).toContain('cache.set(k, computeTotal(v))')
    expect(staticRow.getAttribute('title')).toMatch(/unchanged region/i)
    expect(staticRow.tagName).not.toBe('BUTTON')
  })

  it('shows an empty-references message', () => {
    renderPopover({ references: [] })
    expect(screen.getByText('Call points in this PR (0)')).toBeInTheDocument()
    expect(screen.getByText(/No references in this PR's files/)).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const { onClose } = renderPopover()
    const dialog = screen.getByRole('dialog', { name: /Symbol computeTotal/ })
    await fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via the close button', async () => {
    const { onClose } = renderPopover()
    await fireEvent.click(screen.getByRole('button', { name: 'Close symbol popover' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the popover on open', async () => {
    renderPopover()
    // The mount $effect focuses the dialog (flushed after render microtask).
    await new Promise((r) => setTimeout(r, 0))
    const dialog = screen.getByRole('dialog', { name: /Symbol computeTotal/ })
    expect(document.activeElement).toBe(dialog)
  })

  it('closes when focus leaves the popover', async () => {
    const { onClose } = renderPopover()
    const dialog = screen.getByRole('dialog', { name: /Symbol computeTotal/ })
    await fireEvent.focusOut(dialog, { relatedTarget: document.body })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close when focus moves within the popover', async () => {
    const { onClose } = renderPopover()
    const dialog = screen.getByRole('dialog', { name: /Symbol computeTotal/ })
    const closeBtn = screen.getByRole('button', { name: 'Close symbol popover' })
    await fireEvent.focusOut(dialog, { relatedTarget: closeBtn })
    expect(onClose).not.toHaveBeenCalled()
  })
})
