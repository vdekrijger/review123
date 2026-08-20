/**
 * FileDiff — finding re-anchor integration (drag a mis-anchored AI finding to
 * the correct diff line).
 *
 * Contract under test:
 *  - An anchor override moves the card: it renders at the NEW line's extend
 *    row (unified AND split modes) and no longer at the original line.
 *  - Off-diff rescue: a fallback-block finding (line not in the diff) with an
 *    override onto a real diff line renders INLINE and leaves the fallback
 *    block.
 *  - The moved card shows the "moved from line N" chip; its undo (✕) clears
 *    the override and the card returns to its original placement.
 *  - Keyboard path: "Move to line…" + a valid line re-anchors; an invalid line
 *    shows an inline error and does not move the card.
 *  - Drag path: dragover on a valid diff row highlights it; drop applies the
 *    override. Rows outside the patch hunks are not valid targets.
 *  - "Add as draft" on a moved card reports the CORRECTED line/side.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import {
  findingAnchorHash,
  getAnchorOverride,
  setAnchorOverride,
  reanchorDrag,
  _resetReanchorForTest,
  REANCHOR_DND_MIME,
} from '../lib/findings/reanchor.svelte'
import { _setCaptureForTest } from '../lib/analytics/analytics'

// DiffView uses canvas.getContext('2d') for text measurement — jsdom has none.
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
    writable: true,
  })
})

beforeEach(() => {
  localStorage.clear()
  _resetReanchorForTest()
})

// New-file lines: 1 "line1" (ctx), 2 "line2new" (+), 3 "line3" (ctx)
const PATCH = '@@ -1,3 +1,3 @@\n line1\n-line2\n+line2new\n line3'

const file: PrFile = {
  filename: 'src/foo.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: PATCH,
}

function makeFinding(line: number, body = 'Mis-anchored finding body') {
  return { skillName: 'Security', line, severity: 'high' as const, body, key: `skill-sec:src/foo.ts:${line}:${body.slice(0, 30)}` }
}

function hashOf(f: ReturnType<typeof makeFinding>): string {
  return findingAnchorHash({ key: f.key, path: file.filename, line: f.line, body: f.body })
}

function renderDiff(findings: ReturnType<typeof makeFinding>[], props: Record<string, unknown> = {}) {
  return render(FileDiff, {
    props: { file, mode: 'unified', skillFindings: findings, ...props },
  })
}

describe('FileDiff re-anchor — override moves the card', () => {
  it('override → card renders at the NEW line, not the original (unified)', () => {
    const f = makeFinding(2)
    setAnchorOverride(hashOf(f), { path: file.filename, line: 3, side: 'RIGHT' })
    const { container } = renderDiff([f])
    expect(container.querySelector('[data-line-findings="3"]')).toBeTruthy()
    expect(container.querySelector('[data-line-findings="3"]')?.textContent).toContain('Mis-anchored finding body')
    expect(container.querySelector('[data-line-findings="2"]')).toBeNull()
  })

  it('override → card renders at the NEW line in split mode', () => {
    const f = makeFinding(2)
    setAnchorOverride(hashOf(f), { path: file.filename, line: 3, side: 'RIGHT' })
    const { container } = renderDiff([f], { mode: 'split' })
    const moved = container.querySelector('[data-line-findings="3"]')
    expect(moved).toBeTruthy()
    expect(moved?.textContent).toContain('Mis-anchored finding body')
    expect(container.querySelector('[data-line-findings="2"]')).toBeNull()
  })

  it('an override recorded for ANOTHER file never moves this card', () => {
    const f = makeFinding(2)
    setAnchorOverride(hashOf(f), { path: 'src/other.ts', line: 3, side: 'RIGHT' })
    const { container } = renderDiff([f])
    expect(container.querySelector('[data-line-findings="2"]')).toBeTruthy()
    expect(container.querySelector('[data-line-findings="3"]')).toBeNull()
  })

  it('setting an override AFTER render moves the card live (reactive)', async () => {
    const f = makeFinding(2)
    const { container } = renderDiff([f])
    expect(container.querySelector('[data-line-findings="2"]')).toBeTruthy()
    setAnchorOverride(hashOf(f), { path: file.filename, line: 3, side: 'RIGHT' })
    await waitFor(() => {
      expect(container.querySelector('[data-line-findings="3"]')).toBeTruthy()
      expect(container.querySelector('[data-line-findings="2"]')).toBeNull()
    })
  })
})

describe('FileDiff re-anchor — off-diff rescue (fallback block → inline)', () => {
  it('finding at a line NOT in the diff + override onto a real line → renders inline, fallback block gone', () => {
    const f = makeFinding(999, 'Off-diff rescued body')
    setAnchorOverride(hashOf(f), { path: file.filename, line: 1, side: 'RIGHT' })
    const { container } = renderDiff([f])
    const inline = container.querySelector('[data-line-findings="1"]')
    expect(inline).toBeTruthy()
    expect(inline?.textContent).toContain('Off-diff rescued body')
    expect(container.querySelector('.skill-findings-annotations')).toBeNull()
  })

  it('without the override the same finding stays in the fallback block', () => {
    const f = makeFinding(999, 'Off-diff rescued body')
    const { container } = renderDiff([f])
    expect(container.querySelector('.skill-findings-annotations .skill-finding')).toBeTruthy()
    expect(container.querySelector('.line-findings')).toBeNull()
  })
})

describe('FileDiff re-anchor — moved chip + undo', () => {
  it('moved card shows "moved from line N" chip with the ORIGINAL line', () => {
    const f = makeFinding(2)
    setAnchorOverride(hashOf(f), { path: file.filename, line: 3, side: 'RIGHT' })
    const { container } = renderDiff([f])
    const chip = container.querySelector('[data-testid="finding-moved-chip"]')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toContain('moved from line 2')
  })

  it('un-moved card has no moved chip', () => {
    const { container } = renderDiff([makeFinding(2)])
    expect(container.querySelector('[data-testid="finding-moved-chip"]')).toBeNull()
  })

  it('undo (✕) clears the override and the card returns to its original line', async () => {
    const user = userEvent.setup()
    const f = makeFinding(2)
    setAnchorOverride(hashOf(f), { path: file.filename, line: 3, side: 'RIGHT' })
    const { container } = renderDiff([f])
    await user.click(screen.getByRole('button', { name: /undo move — restore line 2/i }))
    await waitFor(() => {
      expect(container.querySelector('[data-line-findings="2"]')).toBeTruthy()
      expect(container.querySelector('[data-line-findings="3"]')).toBeNull()
    })
    expect(getAnchorOverride(hashOf(f))).toBeNull()
  })

  it('undo on a rescued off-diff finding returns it to the fallback block', async () => {
    const user = userEvent.setup()
    const f = makeFinding(999, 'Back to fallback')
    setAnchorOverride(hashOf(f), { path: file.filename, line: 1, side: 'RIGHT' })
    const { container } = renderDiff([f])
    await user.click(screen.getByRole('button', { name: /undo move — restore line 999/i }))
    await waitFor(() => {
      expect(container.querySelector('.skill-findings-annotations .skill-finding')).toBeTruthy()
      expect(container.querySelector('.line-findings')).toBeNull()
    })
  })
})

describe('FileDiff re-anchor — keyboard "Move to line…" path', () => {
  it('valid line: typing 3 + Move re-anchors the card to line 3', async () => {
    const user = userEvent.setup()
    const f = makeFinding(2)
    const { container } = renderDiff([f])
    await user.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await user.type(screen.getByRole('spinbutton', { name: /target line number/i }), '3')
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => {
      expect(container.querySelector('[data-line-findings="3"]')).toBeTruthy()
      expect(container.querySelector('[data-line-findings="2"]')).toBeNull()
    })
    expect(getAnchorOverride(hashOf(f))).toEqual({ path: file.filename, line: 3, side: 'RIGHT' })
  })

  it('invalid line (not in diff): shows an inline error, card does not move', async () => {
    const user = userEvent.setup()
    const f = makeFinding(2)
    const { container } = renderDiff([f])
    await user.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await user.type(screen.getByRole('spinbutton', { name: /target line number/i }), '999')
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(screen.getByRole('alert').textContent).toContain("line 999 isn't in this diff")
    expect(container.querySelector('[data-line-findings="2"]')).toBeTruthy()
    expect(getAnchorOverride(hashOf(f))).toBeNull()
  })

  it('rescues an off-diff finding: Move to line 1 anchors it inline', async () => {
    const user = userEvent.setup()
    const f = makeFinding(999, 'Rescue via keyboard')
    const { container } = renderDiff([f])
    await user.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await user.type(screen.getByRole('spinbutton', { name: /target line number/i }), '1')
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => {
      expect(container.querySelector('[data-line-findings="1"]')).toBeTruthy()
      expect(container.querySelector('.skill-findings-annotations')).toBeNull()
    })
  })
})

describe('FileDiff re-anchor — drag & drop path', () => {
  function rowForNewLine(container: HTMLElement, line: number): HTMLTableRowElement {
    const numEl = container.querySelector(`[data-line-new-num="${line}"]`)
    const row = numEl?.closest('tr')
    if (!row) throw new Error(`no rendered row for new line ${line}`)
    return row as HTMLTableRowElement
  }

  it('dragover on a valid diff row (while dragging this file\'s finding) highlights it', async () => {
    const f = makeFinding(2)
    const { container } = renderDiff([f])
    reanchorDrag.hash = hashOf(f) // as the card's dragstart handler would
    const row = rowForNewLine(container, 3)
    await fireEvent.dragOver(row, { dataTransfer: { dropEffect: 'none' } })
    expect(row.classList.contains('reanchor-drop-target')).toBe(true)
  })

  it('dragover with NO finding drag in flight does nothing (foreign drags ignored)', async () => {
    const f = makeFinding(2)
    const { container } = renderDiff([f])
    reanchorDrag.hash = null
    const row = rowForNewLine(container, 3)
    await fireEvent.dragOver(row, { dataTransfer: { dropEffect: 'none' } })
    expect(row.classList.contains('reanchor-drop-target')).toBe(false)
  })

  it('drop on a valid row applies the override and moves the card', async () => {
    const f = makeFinding(2)
    const hash = hashOf(f)
    const { container } = renderDiff([f])
    reanchorDrag.hash = hash
    const row = rowForNewLine(container, 3)
    await fireEvent.drop(row, { dataTransfer: { getData: (t: string) => (t === REANCHOR_DND_MIME ? hash : '') } })
    await waitFor(() => {
      expect(container.querySelector('[data-line-findings="3"]')).toBeTruthy()
      expect(container.querySelector('[data-line-findings="2"]')).toBeNull()
    })
    expect(getAnchorOverride(hash)).toEqual({ path: file.filename, line: 3, side: 'RIGHT' })
    expect(reanchorDrag.hash).toBeNull() // drop clears the in-flight drag
  })

  it('drop of a hash that is NOT one of this file\'s findings is ignored', async () => {
    const f = makeFinding(2)
    const { container } = renderDiff([f])
    reanchorDrag.hash = 'foreign-hash'
    const row = rowForNewLine(container, 3)
    await fireEvent.drop(row, { dataTransfer: { getData: () => 'foreign-hash' } })
    expect(container.querySelector('[data-line-findings="2"]')).toBeTruthy()
    expect(getAnchorOverride('foreign-hash')).toBeNull()
  })

  it('the drag handle renders on an anchored finding card', () => {
    const { container } = renderDiff([makeFinding(2)])
    expect(container.querySelector('[data-testid="finding-drag-handle"]')).toBeTruthy()
  })
})

describe('FileDiff re-anchor — analytics (input-method threading)', () => {
  const capture = vi.fn()
  beforeEach(() => {
    capture.mockClear()
    _setCaptureForTest(capture)
  })

  function eventsNamed(name: string) {
    return capture.mock.calls.filter(([n]) => n === name)
  }

  it('keyboard move fires finding_moved with method keyboard + distance', async () => {
    const user = userEvent.setup()
    const { container } = renderDiff([makeFinding(2)])
    await user.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await user.type(screen.getByRole('spinbutton', { name: /target line number/i }), '3')
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(container.querySelector('[data-line-findings="3"]')).toBeTruthy())
    const events = eventsNamed('finding_moved')
    expect(events).toHaveLength(1)
    expect(events[0][1]).toEqual({ method: 'keyboard', distance: 1, same_side: true, off_diff_rescue: false })
  })

  it('an INVALID keyboard move (line not in diff) fires nothing', async () => {
    const user = userEvent.setup()
    renderDiff([makeFinding(2)])
    await user.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await user.type(screen.getByRole('spinbutton', { name: /target line number/i }), '999')
    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(eventsNamed('finding_moved')).toHaveLength(0)
  })

  it('drag drop fires finding_moved with method drag', async () => {
    const f = makeFinding(2)
    const hash = hashOf(f)
    const { container } = renderDiff([f])
    reanchorDrag.hash = hash
    const numEl = container.querySelector('[data-line-new-num="3"]')
    const row = numEl?.closest('tr') as HTMLTableRowElement
    await fireEvent.drop(row, { dataTransfer: { getData: (t: string) => (t === REANCHOR_DND_MIME ? hash : '') } })
    await waitFor(() => expect(getAnchorOverride(hash)).not.toBeNull())
    const events = eventsNamed('finding_moved')
    expect(events).toHaveLength(1)
    expect(events[0][1]).toEqual({ method: 'drag', distance: 1, same_side: true, off_diff_rescue: false })
  })

  it('rescuing an off-diff finding reports off_diff_rescue true + full distance', async () => {
    const user = userEvent.setup()
    const f = makeFinding(999, 'Rescue analytics body')
    const { container } = renderDiff([f])
    await user.click(screen.getByRole('button', { name: /move this finding to another diff line/i }))
    await user.type(screen.getByRole('spinbutton', { name: /target line number/i }), '1')
    await user.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(container.querySelector('[data-line-findings="1"]')).toBeTruthy())
    expect(eventsNamed('finding_moved')[0][1]).toEqual({
      method: 'keyboard',
      distance: 998,
      same_side: true,
      off_diff_rescue: true,
    })
  })

  it('undo (✕) fires finding_move_undone', async () => {
    const user = userEvent.setup()
    const f = makeFinding(2)
    setAnchorOverride(hashOf(f), { path: file.filename, line: 3, side: 'RIGHT' }) // setup: no meta → no move event
    capture.mockClear()
    renderDiff([f])
    await user.click(screen.getByRole('button', { name: /undo move — restore line 2/i }))
    await waitFor(() => expect(getAnchorOverride(hashOf(f))).toBeNull())
    expect(eventsNamed('finding_move_undone')).toHaveLength(1)
    expect(eventsNamed('finding_moved')).toHaveLength(0)
  })
})

describe('FileDiff re-anchor — "Add as draft" uses the corrected anchor', () => {
  it('moved finding: onAddSkillFindingDraft receives the NEW line and RIGHT side', async () => {
    const user = userEvent.setup()
    const f = makeFinding(2)
    setAnchorOverride(hashOf(f), { path: file.filename, line: 3, side: 'RIGHT' })
    const onAddSkillFindingDraft = vi.fn().mockResolvedValue(undefined)
    renderDiff([f], { onAddSkillFindingDraft })
    await user.click(screen.getByRole('button', { name: /add as draft comment/i }))
    expect(onAddSkillFindingDraft).toHaveBeenCalledWith({
      body: f.body,
      line: 3,
      key: f.key,
      skillName: 'Security',
      side: 'RIGHT',
    })
  })

  it('un-moved finding: onAddSkillFindingDraft receives the original line', async () => {
    const user = userEvent.setup()
    const f = makeFinding(2)
    const onAddSkillFindingDraft = vi.fn().mockResolvedValue(undefined)
    renderDiff([f], { onAddSkillFindingDraft })
    await user.click(screen.getByRole('button', { name: /add as draft comment/i }))
    expect(onAddSkillFindingDraft).toHaveBeenCalledWith(
      expect.objectContaining({ line: 2, side: 'RIGHT' }),
    )
  })
})
