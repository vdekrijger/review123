import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import SymbolPopover from './SymbolPopover.svelte'
import type { SymbolDefinition, SymbolReference } from '../lib/symbols/symbolIndex'
import type { RepoSearchOutcome } from '../lib/symbols/repoSearch'
import { registerSymbolSource, _resetSymbolSourcesForTest } from '../lib/symbols/symbolSources'

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

// ---------------------------------------------------------------------------
// "In repo" section (Tier 2 — on-demand repo search)
// ---------------------------------------------------------------------------

const repoRefs: RepoSearchOutcome = {
  ok: true,
  definitions: [],
  references: [
    { name: 'computeTotal', file: 'src/other.ts', line: 1, side: 'new', snippet: "import { computeTotal } from './util'", inDiff: false },
    { name: 'computeTotal', file: 'src/other.ts', line: 3, side: 'new', snippet: 'return computeTotal(xs) * 2', inDiff: false },
  ],
  filesScanned: 1,
  filesSkipped: 0,
}

describe('SymbolPopover — In repo section', () => {
  it('is hidden entirely when the provider has no code search (onSearchRepo null)', () => {
    renderPopover({ onSearchRepo: null })
    expect(screen.queryByText(/^In repo/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Search repo' })).not.toBeInTheDocument()
  })

  it('shows the on-demand Search repo button and never searches automatically', () => {
    const onSearchRepo = vi.fn()
    renderPopover({ onSearchRepo })
    expect(screen.getByText('In repo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search repo' })).toBeInTheDocument()
    expect(onSearchRepo).not.toHaveBeenCalled()
  })

  it('parks focus on the dialog when the search starts (the unmounting button must not self-close the popover)', async () => {
    // The loading state unmounts the [Search repo] button. If it unmounted
    // while still focused, the browser would fire focusout with relatedTarget
    // null and the focus-leave idiom would close the popover mid-search.
    let resolve!: (v: RepoSearchOutcome) => void
    const onSearchRepo = vi.fn(() => new Promise<RepoSearchOutcome>((r) => { resolve = r }))
    const { onClose } = renderPopover({ onSearchRepo })
    const btn = screen.getByRole('button', { name: 'Search repo' })
    btn.focus()
    await fireEvent.click(btn)
    const dialog = screen.getByRole('dialog', { name: /Symbol computeTotal/ })
    expect(document.activeElement).toBe(dialog)
    expect(onClose).not.toHaveBeenCalled()
    resolve({ ok: true, definitions: [], references: [], filesScanned: 0, filesSkipped: 0 })
    await screen.findByText('In repo (0)')
  })

  it('shows a loading state while the search runs', async () => {
    let resolve!: (v: RepoSearchOutcome) => void
    const onSearchRepo = vi.fn(() => new Promise<RepoSearchOutcome>((r) => { resolve = r }))
    renderPopover({ onSearchRepo })
    await fireEvent.click(screen.getByRole('button', { name: 'Search repo' }))
    expect(onSearchRepo).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('Searching repo…')
    resolve(repoRefs)
    await screen.findByText('In repo (2)')
  })

  it('renders results grouped by file — non-clickable, with tooltip and footnote', async () => {
    const { container } = renderPopover({ onSearchRepo: vi.fn().mockResolvedValue(repoRefs) })
    await fireEvent.click(screen.getByRole('button', { name: 'Search repo' }))
    await screen.findByText('In repo (2)')

    const section = container.querySelector('section.repo')!
    expect(section.querySelector('.ref-file-name.repo-file')!.textContent).toContain('src/other.ts')
    const rows = [...section.querySelectorAll('.ref-row.static')]
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain("import { computeTotal } from './util'")
    expect(rows[0].getAttribute('title')).toBe("Not in this PR's diff")
    expect(rows.every((r) => r.tagName !== 'BUTTON')).toBe(true)
    // The path is copyable (copy button per file group).
    expect(screen.getByRole('button', { name: 'Copy path src/other.ts' })).toBeInTheDocument()
    // Honest footnote about the default-branch search index + head re-check.
    expect(screen.getByText(/default branch index; results re-checked at this PR's head/)).toBeInTheDocument()
  })

  it('shows the empty message when no other call points exist', async () => {
    const onSearchRepo = vi.fn().mockResolvedValue({ ok: true, definitions: [], references: [], filesScanned: 0, filesSkipped: 0 })
    renderPopover({ onSearchRepo })
    await fireEvent.click(screen.getByRole('button', { name: 'Search repo' }))
    await screen.findByText('No other call points found in the repo.')
    expect(screen.getByText('In repo (0)')).toBeInTheDocument()
  })

  it('surfaces a search error and keeps the button for retry', async () => {
    const onSearchRepo = vi.fn().mockResolvedValue({ ok: false, message: 'Code search rate-limited — try again in a minute.' })
    renderPopover({ onSearchRepo })
    await fireEvent.click(screen.getByRole('button', { name: 'Search repo' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('Code search rate-limited — try again in a minute.')
    expect(screen.getByRole('button', { name: 'Search repo' })).toBeInTheDocument()
  })

  it('upgrades the "not in changed files" state when the search finds the definition', async () => {
    const withDef: RepoSearchOutcome = {
      ok: true,
      definitions: [
        { name: 'computeTotal', kind: 'function', file: 'src/other.ts', line: 1, side: 'new', snippet: 'export function computeTotal(values: number[]): number {', inDiff: false },
      ],
      references: [],
      filesScanned: 1,
      filesSkipped: 0,
    }
    renderPopover({ definitions: [], onSearchRepo: vi.fn().mockResolvedValue(withDef) })
    expect(screen.getByText(/Definition not in the changed files of this PR/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Search repo' }))
    await screen.findByTestId('repo-definition')
    expect(screen.queryByText(/Definition not in the changed files of this PR/)).not.toBeInTheDocument()
    const entry = screen.getByTestId('repo-definition')
    expect(entry.textContent).toContain('export function computeTotal')
    expect(entry.textContent).toContain('src/other.ts:1')
    expect(entry.textContent).toContain('repo')
    // Repo definitions are never jump targets.
    expect(entry.querySelector('button.loc')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Definition peek — expandable code block per definition row
// ---------------------------------------------------------------------------

const UTIL_CONTENT = [
  '// utils', // 1
  'export const A = 1', // 2
  '', // 3
  'export function computeTotal(values: number[]): number {', // 4
  '  return values.reduce((t, v) => t + v, 0)', // 5
  '}', // 6
  'export const B = 2', // 7
].join('\n')

/** Register the def file's source (full contents) — the peek reads from it. */
function registerUtilSource(content = UTIL_CONTENT) {
  registerSymbolSource({
    filename: 'src/util.ts',
    status: 'modified',
    contents: { before: null, after: content },
  })
}

const PEEK_TOGGLE = { name: 'Definition body at src/util.ts:4' }

describe('SymbolPopover — definition peek', () => {
  afterEach(() => {
    _resetSymbolSourcesForTest()
  })

  it('offers no expand affordance when the definition file has no registered source', () => {
    renderPopover()
    expect(screen.queryByRole('button', { name: /Definition body at/ })).not.toBeInTheDocument()
  })

  it('expands to the definition body with real line numbers, and collapses again', async () => {
    registerUtilSource()
    renderPopover()
    const toggle = screen.getByRole('button', PEEK_TOGGLE)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('definition-peek')).not.toBeInTheDocument()

    await fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const block = screen.getByTestId('definition-peek')
    expect(block.textContent).toContain('return values.reduce((t, v) => t + v, 0)')
    // Line numbers start at the definition's REAL line (4), not 1.
    expect(block.querySelector('.peek-gutter')!.textContent).toBe('4\n5\n6')
    // Complete body → neither the cap marker nor the patch-only note.
    expect(block.textContent).not.toContain('more line')
    expect(block.textContent).not.toContain('Only the changed lines')

    await fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('definition-peek')).not.toBeInTheDocument()
  })

  it('keeps focus on the toggle and the popover open across expand/collapse', async () => {
    registerUtilSource()
    const { onClose } = renderPopover()
    const toggle = screen.getByRole('button', PEEK_TOGGLE)
    toggle.focus()
    await fireEvent.click(toggle)
    expect(document.activeElement).toBe(toggle) // no unmount → no focusout close
    await fireEvent.click(toggle)
    expect(document.activeElement).toBe(toggle)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('syntax-highlights the expanded body (hljs token spans)', async () => {
    registerUtilSource()
    renderPopover()
    await fireEvent.click(screen.getByRole('button', PEEK_TOGGLE))
    await waitFor(() => {
      expect(screen.getByTestId('definition-peek').querySelector('.peek-code')!.innerHTML).toContain('hljs-')
    })
  })

  it('caps long bodies at 40 lines with an honest more-lines marker', async () => {
    const body = ['export function computeTotal() {', ...Array.from({ length: 59 }, (_, i) => `  step(${i})`), '}']
    registerUtilSource(body.join('\n'))
    renderPopover({ definitions: [{ ...def, line: 1, endLine: 61 }] })
    await fireEvent.click(screen.getByRole('button', { name: 'Definition body at src/util.ts:1' }))
    const block = screen.getByTestId('definition-peek')
    expect(block.querySelector('.peek-gutter')!.textContent!.split('\n')).toHaveLength(40)
    expect(block.textContent).toContain('… (21 more lines)')
  })

  it('shows the honest patch-only note when the hunk cuts the body off', async () => {
    registerSymbolSource({
      filename: 'src/util.ts',
      status: 'modified',
      patch: ['@@ -4,2 +4,2 @@', ' export function computeTotal(values: number[]): number {', '+  return values.reduce((t, v) => t + v, 0)'].join('\n'),
    })
    renderPopover()
    await fireEvent.click(screen.getByRole('button', PEEK_TOGGLE))
    const block = screen.getByTestId('definition-peek')
    expect(block.querySelector('.peek-gutter')!.textContent).toBe('4\n5')
    expect(block.textContent).toContain('Only the changed lines are available for this file.')
  })

  it('multiple definitions expand independently', async () => {
    registerUtilSource()
    registerSymbolSource({
      filename: 'src/copy.ts',
      status: 'modified',
      contents: { before: null, after: 'export function computeTotal(): number {\n  return 0\n}' },
    })
    const secondDef: SymbolDefinition = { ...def, file: 'src/copy.ts', line: 1 }
    renderPopover({ definitions: [def, secondDef] })
    await fireEvent.click(screen.getByRole('button', PEEK_TOGGLE))
    expect(screen.getAllByTestId('definition-peek')).toHaveLength(1)
    expect(screen.getByRole('button', PEEK_TOGGLE)).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Definition body at src/copy.ts:1' })).toHaveAttribute('aria-expanded', 'false')
    await fireEvent.click(screen.getByRole('button', { name: 'Definition body at src/copy.ts:1' }))
    expect(screen.getAllByTestId('definition-peek')).toHaveLength(2)
  })

  it('references never get a peek toggle — definitions only', async () => {
    registerUtilSource()
    const { container } = renderPopover()
    // Exactly one toggle: the single definition row. None on the ref rows.
    expect(screen.getAllByRole('button', { name: /Definition body at/ })).toHaveLength(1)
    expect(container.querySelectorAll('section.refs .peek-toggle')).toHaveLength(0)
  })

  it('repo-found definitions peek from the fetched head-SHA contents', async () => {
    const repoFileContent = [
      'export function computeTotal(values: number[]): number {', // 1
      '  return values.length', // 2
      '}', // 3
    ].join('\n')
    const withDef: RepoSearchOutcome = {
      ok: true,
      definitions: [
        { name: 'computeTotal', kind: 'function', file: 'src/other.ts', line: 1, endLine: 3, side: 'new', snippet: 'export function computeTotal(values: number[]): number {', inDiff: false },
      ],
      references: [],
      filesScanned: 1,
      filesSkipped: 0,
      contentsByPath: new Map([['src/other.ts', repoFileContent]]),
    }
    renderPopover({ definitions: [], onSearchRepo: vi.fn().mockResolvedValue(withDef) })
    await fireEvent.click(screen.getByRole('button', { name: 'Search repo' }))
    await screen.findByTestId('repo-definition')
    const toggle = screen.getByRole('button', { name: 'Definition body at src/other.ts:1' })
    await fireEvent.click(toggle)
    const block = screen.getByTestId('definition-peek')
    expect(block.textContent).toContain('return values.length')
    expect(block.querySelector('.peek-gutter')!.textContent).toBe('1\n2\n3')
    // Fetched full contents → complete, no patch-only note.
    expect(block.textContent).not.toContain('Only the changed lines')
  })

  it('repo definitions without carried contents offer no peek (hand-built outcomes)', async () => {
    const withDef: RepoSearchOutcome = {
      ok: true,
      definitions: [
        { name: 'computeTotal', kind: 'function', file: 'src/other.ts', line: 1, side: 'new', snippet: 'export function computeTotal(values: number[]): number {', inDiff: false },
      ],
      references: [],
      filesScanned: 1,
      filesSkipped: 0,
    }
    renderPopover({ definitions: [], onSearchRepo: vi.fn().mockResolvedValue(withDef) })
    await fireEvent.click(screen.getByRole('button', { name: 'Search repo' }))
    await screen.findByTestId('repo-definition')
    expect(screen.queryByRole('button', { name: /Definition body at/ })).not.toBeInTheDocument()
  })
})
