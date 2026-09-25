/**
 * FileDiff × the gutter marker for hidden threads, and the way back (#295).
 *
 * THE REPORT. A screenshot of FOUR full-width "2 resolved threads hidden —
 * show" bands stacked through twenty lines of Python: "would be great if we
 * could re-hide the resolved threads by the click of a button, and if the blue
 * thing maybe just becomes a marker on the left side at the line numbers so we
 * don't take away from the reading code experience".
 *
 * Two separate faults, and these tests pin both.
 *
 *   1. REVEALING WAS A ONE-WAY DOOR. `revealThreads` only ever added to
 *      `revealedRoots`; the only way back was the Inspect toolbar's global
 *      switch, which un-hides every OTHER group in the PR as a side effect.
 *      Reveal is now a toggle, and the way back is as LOCAL as the reveal —
 *      the property #272 established and #290 preserved.
 *
 *   2. THE NOTICE WAS IN THE CODE FLOW. A line whose threads were all hidden
 *      still rendered `.inline-comment-threads` — a banner-tinted block in the
 *      library's extend row — purely to say so. It now renders ONLY for threads
 *      that are on screen, and the count lives in a marker inside
 *      @git-diff-view's own line-number cell, which costs no row at all.
 *
 * WHAT THIS FILE CANNOT SEE. It reads the DOM, not pixels: that the marker is
 * inside `td.diff-line-num` is asserted here, but whether that cell clips it,
 * traps it in a stacking context, or covers it with the library's own "+"
 * widget is a rendered-geometry question jsdom cannot answer. That half is
 * e2e/hidden-thread-marker.spec.ts, which hit-tests it in a real browser —
 * the same division #279 drew after a popover that looked right in the source.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import type { PrComment } from '../lib/github/comments'
import {
  setHideResolvedThreads,
  _resetResolvedThreadsPrefForTest,
} from '../lib/guide/resolvedThreadsPref.svelte'
import {
  setHideBotThreads,
  _resetBotThreadsPrefForTest,
} from '../lib/guide/botThreadsPref.svelte'

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
    writable: true,
  })
})

beforeEach(() => {
  localStorage.clear()
  _resetResolvedThreadsPrefForTest()
  _resetBotThreadsPrefForTest()
})

/** RIGHT lines 1–3 are in the patch; line 99 is not (→ bottom "General" list). */
const modified: PrFile = {
  filename: 'src/a.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n unchanged',
}

function comment(overrides: Partial<PrComment> & { id: number }): PrComment {
  return {
    author: 'reviewer',
    authorAvatar: null,
    body: `body ${overrides.id}`,
    createdAt: '2024-01-01T10:00:00Z',
    path: 'src/a.ts',
    line: 2,
    side: 'RIGHT',
    inReplyTo: null,
    ...overrides,
  }
}

const MARKER = '[data-testid="hidden-threads-marker"]'
const RESOLVED_REHIDE = '[data-testid="resolved-rehide"]'
const BOT_REHIDE = '[data-testid="bot-rehide"]'
const RESOLVED_NOTE = '[data-testid="resolved-hidden-note"]'
const BOT_NOTE = '[data-testid="bot-hidden-note"]'

function renderDiff(
  comments: PrComment[],
  opts: { mode?: 'unified' | 'split'; resolvedIds?: number[] } = {},
) {
  return render(FileDiff, {
    props: {
      file: modified,
      mode: opts.mode ?? ('unified' as const),
      comments,
      resolvedCommentIds: new Set(opts.resolvedIds ?? []),
    },
  })
}

/** The marker is synced in on an animation frame — wait for it like the DOM. */
async function marker(container: HTMLElement): Promise<HTMLElement> {
  let found: HTMLElement | null = null
  await vi.waitFor(() => {
    found = container.querySelector<HTMLElement>(MARKER)
    expect(found).toBeInTheDocument()
  })
  return found!
}

// ---------------------------------------------------------------------------
// The marker: where it is, what it says
// ---------------------------------------------------------------------------

describe('FileDiff — the hidden-thread marker lives in the line-number gutter', () => {
  const resolvedInline = comment({ id: 10, body: 'inline-resolved-marker' })

  it('unified: the marker is a child of the library’s own line-number cell', async () => {
    const { container } = renderDiff([resolvedInline], { resolvedIds: [10] })
    const el = await marker(container)
    expect(el.closest('td')).toHaveClass('diff-line-num')
    expect(el.dataset.line).toBe('2')
    expect(el.dataset.side).toBe('RIGHT')
  })

  it('split: the marker goes in the thread’s OWN side’s gutter', async () => {
    // The thread is RIGHT-anchored, and its extend row opens in the right
    // column — a marker in the left gutter would open a group in a column the
    // reader is not looking at.
    const { container } = renderDiff([resolvedInline], { mode: 'split', resolvedIds: [10] })
    const el = await marker(container)
    expect(el.closest('td')).toHaveClass('diff-line-new-num')
  })

  it('split: a LEFT-anchored thread’s marker goes in the LEFT gutter', async () => {
    const onDeletedLine = comment({ id: 11, line: 1, side: 'LEFT', body: 'left-marker' })
    const { container } = renderDiff([onDeletedLine], { mode: 'split', resolvedIds: [11] })
    const el = await marker(container)
    expect(el.closest('td')).toHaveClass('diff-line-old-num')
    expect(el.dataset.side).toBe('LEFT')
  })

  it('carries the count in its accessible name — quieter, never silent', async () => {
    const { container } = renderDiff(
      [resolvedInline, comment({ id: 12, body: 'second' })],
      { resolvedIds: [10, 12] },
    )
    const el = await marker(container)
    expect(el.getAttribute('aria-label')).toContain('2 resolved threads hidden')
    // …and to the mouse, through the native title tooltip, which is the one
    // tooltip the library's sticky, z-indexed wrappers cannot trap.
    expect(el.title).toBe(el.getAttribute('aria-label'))
  })

  it('is a real button: focusable, operable, and one per line — not per row', async () => {
    const { container } = renderDiff([resolvedInline], { resolvedIds: [10] })
    const el = await marker(container)
    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('type')).toBe('button')
    expect(el.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll(MARKER)).toHaveLength(1)
  })

  it('no filter is holding anything back → no marker at all', async () => {
    const { container } = renderDiff([resolvedInline], { resolvedIds: [] })
    await vi.waitFor(() => {
      expect(container.querySelector('.inline-comment-threads')).toBeInTheDocument()
    })
    expect(container.querySelector(MARKER)).not.toBeInTheDocument()
  })

  it('the global switch off → no marker, the same as no note before it', async () => {
    setHideResolvedThreads(false)
    const { container } = renderDiff([resolvedInline], { resolvedIds: [10] })
    await vi.waitFor(() => {
      expect(container.querySelector('.inline-comment-threads')).toBeInTheDocument()
    })
    expect(container.querySelector(MARKER)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Out of the code flow
// ---------------------------------------------------------------------------

describe('FileDiff — a fully hidden line costs no row in the reading column', () => {
  it('renders NO inline thread block when every thread at the line is hidden', async () => {
    const { container } = renderDiff([comment({ id: 20, body: 'gone' })], { resolvedIds: [20] })
    await marker(container)
    // The banner-tinted block is what the four stacked bands were made of.
    expect(container.querySelector('.inline-comment-threads')).not.toBeInTheDocument()
    // And no hidden-note is left anywhere inside the diff.
    expect(container.querySelector(`.inline-comment-threads ${RESOLVED_NOTE}`)).not.toBeInTheDocument()
  })

  it('a line with one thread left on screen still renders the block for it', async () => {
    const { container } = renderDiff(
      [comment({ id: 21, body: 'hidden-one' }), comment({ id: 22, body: 'open-one' })],
      { resolvedIds: [21] },
    )
    await marker(container)
    const inline = container.querySelector('.inline-comment-threads')!
    expect(inline.textContent).toContain('open-one')
    expect(inline.textContent).not.toContain('hidden-one')
  })
})

// ---------------------------------------------------------------------------
// Reversibility
// ---------------------------------------------------------------------------

describe('FileDiff — revealing is reversible, and stays local', () => {
  const hidden = comment({ id: 30, body: 'inline-resolved-marker' })

  it('one click reveals, one click puts it back', async () => {
    const { container } = renderDiff([hidden], { resolvedIds: [30] })
    const el = await marker(container)

    await fireEvent.click(el)
    await vi.waitFor(() => {
      expect(container.querySelector('.inline-comment-threads')!.textContent).toContain(
        'inline-resolved-marker',
      )
    })
    // The marker's own state is synced on the next frame, like the rest of it.
    await vi.waitFor(() => {
      expect(container.querySelector(MARKER)!.getAttribute('aria-expanded')).toBe('true')
    })

    await fireEvent.click(await marker(container))
    await vi.waitFor(() => {
      expect(container.querySelector('.inline-comment-threads')).not.toBeInTheDocument()
    })
    await vi.waitFor(() => {
      expect(container.querySelector(MARKER)!.getAttribute('aria-expanded')).toBe('false')
    })
  })

  it('the way back also sits at the FOOT of what was revealed', async () => {
    // The reader's eye is at the bottom of the group they just read, not back
    // up at the marker that opened it.
    const { container } = renderDiff([hidden], { resolvedIds: [30] })
    await fireEvent.click(await marker(container))

    let rehide: HTMLElement | null = null
    await vi.waitFor(() => {
      rehide = container.querySelector<HTMLElement>(`.inline-comment-threads ${RESOLVED_REHIDE}`)
      expect(rehide).toBeInTheDocument()
    })
    expect(rehide!.textContent).toContain('Hide 1 resolved thread again')

    await fireEvent.click(rehide!)
    await vi.waitFor(() => {
      expect(container.querySelector('.inline-comment-threads')).not.toBeInTheDocument()
    })
  })

  it('neither direction flips the global preference', async () => {
    const { container } = renderDiff([hidden], { resolvedIds: [30] })
    await fireEvent.click(await marker(container))
    await fireEvent.click(await marker(container))
    expect(JSON.parse(localStorage.getItem('review123:hide-resolved') ?? 'null')).toBeNull()
  })

  it('re-hiding one group leaves another revealed group alone', async () => {
    const { container } = renderDiff(
      [
        comment({ id: 31, line: 1, side: 'LEFT', body: 'group-a' }),
        comment({ id: 32, line: 2, body: 'group-b' }),
      ],
      { resolvedIds: [31, 32] },
    )
    await vi.waitFor(() => {
      expect(container.querySelectorAll(MARKER)).toHaveLength(2)
    })
    const markers = () => [...container.querySelectorAll<HTMLElement>(MARKER)]
    for (const el of markers()) await fireEvent.click(el)
    await vi.waitFor(() => {
      expect(container.textContent).toContain('group-a')
      expect(container.textContent).toContain('group-b')
    })

    const a = markers().find((m) => m.dataset.side === 'LEFT')!
    await fireEvent.click(a)
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('group-a')
    })
    expect(container.textContent).toContain('group-b')
  })
})

// ---------------------------------------------------------------------------
// Two reasons, one line
// ---------------------------------------------------------------------------

describe('FileDiff — a line holding both a resolved thread and a bot thread', () => {
  const resolvedHere = comment({ id: 40, body: 'the-resolved-one' })
  const botHere = comment({ id: 41, author: 'posthog[bot]', body: 'the-bot-one' })
  const both = [resolvedHere, botHere]

  it('is ONE marker with one bar per reason, never a blurred "2 hidden"', async () => {
    const { container } = renderDiff(both, { resolvedIds: [40] })
    const el = await marker(container)
    expect(container.querySelectorAll(MARKER)).toHaveLength(1)
    expect(el.dataset.reasons).toBe('resolved bot')
    expect(el.querySelectorAll('.gutter-thread-marker-bar')).toHaveLength(2)
  })

  it('states each reason’s own count in its own clause', async () => {
    const { container } = renderDiff(both, { resolvedIds: [40] })
    const label = (await marker(container)).getAttribute('aria-label')!
    expect(label).toContain('1 resolved thread hidden')
    expect(label).toContain('1 bot thread hidden')
    expect(label).not.toContain('2 threads')
  })

  it('what it opens still distinguishes them: a way back PER reason', async () => {
    const { container } = renderDiff(both, { resolvedIds: [40] })
    await fireEvent.click(await marker(container))

    let group: Element | null = null
    await vi.waitFor(() => {
      group = container.querySelector('.inline-comment-threads')
      expect(group?.querySelector(RESOLVED_REHIDE)).toBeInTheDocument()
      expect(group?.querySelector(BOT_REHIDE)).toBeInTheDocument()
    })

    // Put back ONLY the bot thread. The resolved one the reader is still
    // reading stays exactly where it is.
    await fireEvent.click(group!.querySelector<HTMLElement>(BOT_REHIDE)!)
    await vi.waitFor(() => {
      expect(container.querySelector('.inline-comment-threads')!.textContent).not.toContain(
        'the-bot-one',
      )
    })
    expect(container.querySelector('.inline-comment-threads')!.textContent).toContain(
      'the-resolved-one',
    )
  })

  it('a partly-revealed line says so per reason', async () => {
    const { container } = renderDiff(both, { resolvedIds: [40] })
    await fireEvent.click(await marker(container))
    await vi.waitFor(() => {
      expect(container.querySelector('.inline-comment-threads')).toBeInTheDocument()
    })
    await fireEvent.click(container.querySelector<HTMLElement>(BOT_REHIDE)!)
    await vi.waitFor(() => {
      const label = container.querySelector(MARKER)!.getAttribute('aria-label')!
      expect(label).toContain('1 resolved thread shown')
      expect(label).toContain('1 bot thread hidden')
    })
  })

  it('only one filter on: only that reason’s bar', async () => {
    setHideBotThreads(false)
    const { container } = renderDiff(both, { resolvedIds: [40] })
    const el = await marker(container)
    expect(el.dataset.reasons).toBe('resolved')
    expect(el.querySelectorAll('.gutter-thread-marker-bar')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The surface with no line to hang a marker on
// ---------------------------------------------------------------------------

describe('FileDiff — the per-file bottom list keeps its sentence', () => {
  // Line 99 is not in the patch → the "General"/unanchored block, which is not
  // in the code flow and is not what the report was about.
  const offDiff = comment({ id: 50, line: 99, body: 'bottom-resolved' })
  const offDiffBot = comment({ id: 51, line: 99, author: 'posthog[bot]', body: 'bottom-bot' })

  it('states the count as a sentence, not a gutter marker', async () => {
    const { container } = renderDiff([offDiff], { resolvedIds: [50] })
    expect(container.querySelector(RESOLVED_NOTE)!.textContent).toContain(
      '1 resolved thread hidden — show',
    )
    // Nothing to anchor a marker to down here.
    await vi.waitFor(() => {
      expect(container.querySelector('.existing-comments')).toBeInTheDocument()
    })
    expect(container.querySelector(MARKER)).not.toBeInTheDocument()
  })

  it('gains the same way back once revealed', async () => {
    const { container } = renderDiff([offDiff], { resolvedIds: [50] })
    await fireEvent.click(container.querySelector<HTMLElement>(RESOLVED_NOTE)!)
    const bottom = container.querySelector('.existing-comments')!
    expect(bottom.textContent).toContain('bottom-resolved')

    const rehide = bottom.querySelector<HTMLElement>(RESOLVED_REHIDE)!
    expect(rehide.textContent).toContain('Hide 1 resolved thread again')
    await fireEvent.click(rehide)
    expect(container.querySelector('.existing-comments')!.textContent).not.toContain(
      'bottom-resolved',
    )
    // …and the sentence is back, offering the reveal again.
    expect(container.querySelector(RESOLVED_NOTE)).toBeInTheDocument()
  })

  it('keeps the two reasons as two sentences and two ways back', async () => {
    const { container } = renderDiff([offDiff, offDiffBot], { resolvedIds: [50] })
    expect(container.querySelector(RESOLVED_NOTE)!.textContent).toContain('1 resolved thread hidden')
    expect(container.querySelector(BOT_NOTE)!.textContent).toContain('1 bot thread hidden')

    await fireEvent.click(container.querySelector<HTMLElement>(RESOLVED_NOTE)!)
    await fireEvent.click(container.querySelector<HTMLElement>(BOT_NOTE)!)
    const bottom = container.querySelector('.existing-comments')!
    expect(bottom.querySelector(RESOLVED_REHIDE)).toBeInTheDocument()
    expect(bottom.querySelector(BOT_REHIDE)).toBeInTheDocument()

    await fireEvent.click(bottom.querySelector<HTMLElement>(BOT_REHIDE)!)
    const after = container.querySelector('.existing-comments')!
    expect(after.textContent).not.toContain('bottom-bot')
    expect(after.textContent).toContain('bottom-resolved')
  })
})
