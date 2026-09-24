/**
 * FileDiff × excluding resolved threads (src/lib/guide/resolvedThreadsPref).
 *
 * A resolved thread is a finished conversation. Collapsing it to one line was
 * not enough — eight of them still fill the viewport ahead of the unresolved
 * comments that need an answer — so the preference EXCLUDES them, hidden by
 * default.
 *
 * What these tests pin:
 *   - hidden by default, on EVERY surface threads render on: inline in the
 *     diff (unified AND split) and the per-file bottom list ("General" group)
 *   - nothing is hidden SILENTLY: each surface states the count and reveals
 *     its own threads with one click, without flipping the global preference
 *   - unresolved threads are never touched
 *   - preference off → the pre-existing collapsed <details> behaviour, and no
 *     note anywhere
 *   - Bitbucket (empty resolvedCommentIds — the provider reports no resolved
 *     threads at all): nothing hidden, no note, no behaviour change
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

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
    writable: true,
  })
})

beforeEach(() => {
  localStorage.clear()
  _resetResolvedThreadsPrefForTest()
})

// RIGHT lines 1–3 are in the patch; line 99 is not (→ bottom "General" list).
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
    line: 99,
    side: 'RIGHT',
    inReplyTo: null,
    ...overrides,
  }
}

const noteSel = '[data-testid="resolved-hidden-note"]'

describe('FileDiff — resolved threads in the bottom list (the "General" block)', () => {
  const resolvedOne = comment({ id: 1, body: 'done-thread-marker' })
  const openOne = comment({ id: 2, body: 'open-thread-marker' })

  function renderBottom(resolvedIds: number[] = [1]) {
    return render(FileDiff, {
      props: {
        file: modified,
        mode: 'unified' as const,
        comments: [resolvedOne, openOne],
        resolvedCommentIds: new Set(resolvedIds),
      },
    })
  }

  it('hides the resolved thread by default and keeps the unresolved one', () => {
    const { container } = renderBottom()
    const bottom = container.querySelector('.existing-comments')!
    expect(bottom.textContent).toContain('open-thread-marker')
    expect(bottom.textContent).not.toContain('done-thread-marker')
    expect(container.querySelector('details.resolved-thread')).not.toBeInTheDocument()
  })

  it('states the hidden count rather than hiding silently', () => {
    const { container } = renderBottom()
    const note = container.querySelector(noteSel)!
    expect(note).toBeInTheDocument()
    expect(note.textContent).toContain('1 resolved thread hidden')
  })

  it('pluralises the count', () => {
    const { container } = render(FileDiff, {
      props: {
        file: modified,
        mode: 'unified' as const,
        comments: [resolvedOne, comment({ id: 3, body: 'second-resolved' }), openOne],
        resolvedCommentIds: new Set([1, 3]),
      },
    })
    expect(container.querySelector(noteSel)!.textContent).toContain('2 resolved threads hidden')
  })

  it('the group label still counts every comment — the block never lies about what is there', () => {
    const { container } = renderBottom()
    expect(container.querySelector('.existing-line-label')!.textContent).toContain('2 comments')
  })

  it('the note reveals the hidden threads in place, one click away', async () => {
    const { container } = renderBottom()
    await fireEvent.click(container.querySelector(noteSel)!)
    expect(container.querySelector('.existing-comments')!.textContent).toContain('done-thread-marker')
    // revealed as the pre-existing collapsed <details>, not expanded prose
    expect(container.querySelector('details.resolved-thread')).toBeInTheDocument()
    // nothing left hidden here → the note is gone
    expect(container.querySelector(noteSel)).not.toBeInTheDocument()
  })

  it('revealing locally does NOT flip the global preference', async () => {
    const { container } = renderBottom()
    await fireEvent.click(container.querySelector(noteSel)!)
    expect(JSON.parse(localStorage.getItem('review123:hide-resolved') ?? 'null')).toBeNull()
  })

  it('preference off: resolved threads render collapsed as before, with no note', () => {
    setHideResolvedThreads(false)
    const { container } = renderBottom()
    expect(container.querySelector('.existing-comments')!.textContent).toContain('done-thread-marker')
    expect(container.querySelector('details.resolved-thread')).toBeInTheDocument()
    expect(container.querySelector(noteSel)).not.toBeInTheDocument()
  })

  it('Bitbucket (no resolved threads reported at all): nothing hidden, no note', () => {
    const { container } = renderBottom([])
    const bottom = container.querySelector('.existing-comments')!
    expect(bottom.textContent).toContain('done-thread-marker')
    expect(bottom.textContent).toContain('open-thread-marker')
    expect(container.querySelector(noteSel)).not.toBeInTheDocument()
  })

  it('every thread in a group resolved: the group still announces them', () => {
    const { container } = render(FileDiff, {
      props: {
        file: modified,
        mode: 'unified' as const,
        comments: [comment({ id: 1, line: null, body: 'done-thread-marker' })],
        resolvedCommentIds: new Set([1]),
      },
    })
    // the group survives (label + count), only the threads are gone
    expect(container.querySelector('.existing-line-label')!.textContent).toContain('General')
    expect(container.querySelector(noteSel)!.textContent).toContain('1 resolved thread hidden')
  })
})

describe('FileDiff — resolved threads inline in the diff', () => {
  // RIGHT line 2 IS in the patch → the thread renders inline, not in the list.
  const anchoredResolved = comment({ id: 10, line: 2, body: 'inline-resolved-marker' })

  async function renderInline(mode: 'unified' | 'split', resolvedIds = [10]) {
    const r = render(FileDiff, {
      props: {
        file: modified,
        mode,
        comments: [anchoredResolved],
        resolvedCommentIds: new Set(resolvedIds),
      },
    })
    await vi.waitFor(() => {
      expect(r.container.querySelector('.inline-comment-threads')).toBeInTheDocument()
    })
    return r
  }

  for (const mode of ['unified', 'split'] as const) {
    it(`${mode}: hides the resolved thread and states the count in its place`, async () => {
      const { container } = await renderInline(mode)
      const inline = container.querySelector('.inline-comment-threads')!
      expect(inline.textContent).not.toContain('inline-resolved-marker')
      expect(inline.querySelector(noteSel)!.textContent).toContain('1 resolved thread hidden')
    })

    it(`${mode}: the inline note reveals the thread at its line`, async () => {
      const { container } = await renderInline(mode)
      await fireEvent.click(container.querySelector(`.inline-comment-threads ${noteSel}`)!)
      const inline = container.querySelector('.inline-comment-threads')!
      expect(inline.textContent).toContain('inline-resolved-marker')
      expect(inline.querySelector('details.resolved-thread')).toBeInTheDocument()
    })
  }

  it('an unresolved inline thread is untouched and draws no note', async () => {
    const { container } = await renderInline('unified', [])
    const inline = container.querySelector('.inline-comment-threads')!
    expect(inline.textContent).toContain('inline-resolved-marker')
    expect(inline.querySelector(noteSel)).not.toBeInTheDocument()
  })
})
