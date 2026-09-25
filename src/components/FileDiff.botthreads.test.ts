/**
 * FileDiff × excluding review-bot threads (src/lib/guide/botThreadsPref).
 *
 * The user: "these bot comments are quite noisy and distracting during a review
 * with no way to hide or filter them out". Hidden by default, one click to
 * reveal — the same machinery #272 built for resolved threads.
 *
 * What these tests pin:
 *   - hidden by default on EVERY surface threads render on: inline in the diff
 *     (unified AND split) and the per-file bottom list ("General" group)
 *   - nothing is hidden SILENTLY: each surface states the count and reveals its
 *     own threads with one click, without flipping the global preference
 *   - A BOT COMMENT WITH A HUMAN REPLY IS NOT A BOT THREAD. The reviewer's own
 *     words are the thing this filter must never take away.
 *   - hiding and resolving are INDEPENDENT: a thread that is both is counted
 *     once, and unticking either switch does not resurrect what the other is
 *     still hiding.
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
    author: 'vdekrijger',
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

const botNote = '[data-testid="bot-hidden-note"]'
const resolvedNote = '[data-testid="resolved-hidden-note"]'

function renderWith(comments: PrComment[], resolvedIds: number[] = []) {
  return render(FileDiff, {
    props: {
      file: modified,
      mode: 'unified' as const,
      comments,
      resolvedCommentIds: new Set(resolvedIds),
    },
  })
}

describe('FileDiff — bot threads in the bottom list', () => {
  const bot = comment({ id: 1, author: 'posthog[bot]', body: 'bot-thread-marker' })
  const human = comment({ id: 2, body: 'human-thread-marker' })

  it('hides the bot thread by default and keeps the human one', () => {
    const { container } = renderWith([bot, human])
    const bottom = container.querySelector('.existing-comments')!
    expect(bottom.textContent).toContain('human-thread-marker')
    expect(bottom.textContent).not.toContain('bot-thread-marker')
  })

  it('states the hidden count rather than hiding silently', () => {
    const { container } = renderWith([bot, human])
    expect(container.querySelector(botNote)!.textContent).toContain('1 bot thread hidden — show')
  })

  it('pluralises the count', () => {
    const { container } = renderWith([bot, comment({ id: 3, author: 'veria-ai[bot]' }), human])
    expect(container.querySelector(botNote)!.textContent).toContain('2 bot threads hidden')
  })

  it('the group label still counts every comment — the block never lies', () => {
    const { container } = renderWith([bot, human])
    expect(container.querySelector('.existing-line-label')!.textContent).toContain('2 comments')
  })

  it('the note reveals the hidden threads in place, one click away', async () => {
    const { container } = renderWith([bot, human])
    await fireEvent.click(container.querySelector(botNote)!)
    expect(container.querySelector('.existing-comments')!.textContent).toContain('bot-thread-marker')
    expect(container.querySelector(botNote)).not.toBeInTheDocument()
  })

  it('revealing locally does NOT flip the global preference', async () => {
    const { container } = renderWith([bot, human])
    await fireEvent.click(container.querySelector(botNote)!)
    expect(JSON.parse(localStorage.getItem('review123:hide-bot-comments') ?? 'null')).toBeNull()
  })

  it('preference off: bot threads render as before, with no note', () => {
    setHideBotThreads(false)
    const { container } = renderWith([bot, human])
    expect(container.querySelector('.existing-comments')!.textContent).toContain('bot-thread-marker')
    expect(container.querySelector(botNote)).not.toBeInTheDocument()
  })

  it('a PR with no bot comments is untouched and draws no note', () => {
    const { container } = renderWith([human])
    expect(container.querySelector('.existing-comments')!.textContent).toContain('human-thread-marker')
    expect(container.querySelector(botNote)).not.toBeInTheDocument()
  })

  it('every thread in a group hidden: the group still announces them', () => {
    const { container } = renderWith([comment({ id: 1, author: 'posthog[bot]', line: null })])
    expect(container.querySelector('.existing-line-label')!.textContent).toContain('General')
    expect(container.querySelector(botNote)!.textContent).toContain('1 bot thread hidden')
  })
})

describe('FileDiff — a bot comment with human replies is NOT hidden', () => {
  const botRoot = comment({ id: 10, author: 'posthog[bot]', body: 'bot-root-marker' })
  const myReply = comment({ id: 11, inReplyTo: 10, body: 'my-own-words-marker' })
  const botReply = comment({ id: 12, author: 'veria-ai[bot]', inReplyTo: 10, body: 'bot-reply-marker' })

  it('keeps the whole thread — including the bot root the reply answers', () => {
    const { container } = renderWith([botRoot, myReply])
    const bottom = container.querySelector('.existing-comments')!
    expect(bottom.textContent).toContain('my-own-words-marker')
    expect(bottom.textContent).toContain('bot-root-marker')
    expect(container.querySelector(botNote)).not.toBeInTheDocument()
  })

  it('a human reply among bot replies still keeps it', () => {
    const { container } = renderWith([botRoot, botReply, myReply])
    expect(container.querySelector('.existing-comments')!.textContent).toContain('my-own-words-marker')
    expect(container.querySelector(botNote)).not.toBeInTheDocument()
  })

  it('bots answering bots is still only machines talking — it hides', () => {
    const { container } = renderWith([botRoot, botReply])
    const bottom = container.querySelector('.existing-comments')!
    expect(bottom.textContent).not.toContain('bot-root-marker')
    expect(bottom.textContent).not.toContain('bot-reply-marker')
    expect(container.querySelector(botNote)!.textContent).toContain('1 bot thread hidden')
  })
})

describe('FileDiff — bot threads inline in the diff', () => {
  // RIGHT line 2 IS in the patch → the thread renders inline, not in the list.
  const anchoredBot = comment({ id: 20, line: 2, author: 'posthog[bot]', body: 'inline-bot-marker' })

  // #295 moved the inline count OUT of the code flow: a line whose threads are
  // all hidden no longer renders the banner block at all, and its count lives
  // in the gutter marker. The marker's own behaviour is pinned in
  // FileDiff.gutterthreads.test.ts; what belongs HERE is that the bot filter
  // still reaches the inline surface in both modes.
  const markerSel = '[data-testid="hidden-threads-marker"]'

  function renderInline(mode: 'unified' | 'split', comments = [anchoredBot]) {
    return render(FileDiff, {
      props: { file: modified, mode, comments, resolvedCommentIds: new Set<number>() },
    })
  }

  for (const mode of ['unified', 'split'] as const) {
    it(`${mode}: hides the bot thread and states the count in the gutter`, async () => {
      const { container } = renderInline(mode)
      await vi.waitFor(() => {
        expect(container.querySelector(markerSel)).toBeInTheDocument()
      })
      expect(container.textContent).not.toContain('inline-bot-marker')
      expect(container.querySelector(markerSel)!.getAttribute('aria-label')).toContain(
        '1 bot thread hidden',
      )
      expect(container.querySelector('.inline-comment-threads')).not.toBeInTheDocument()
    })

    it(`${mode}: the gutter marker reveals the thread at its line`, async () => {
      const { container } = renderInline(mode)
      await vi.waitFor(() => {
        expect(container.querySelector(markerSel)).toBeInTheDocument()
      })
      await fireEvent.click(container.querySelector(markerSel)!)
      await vi.waitFor(() => {
        expect(container.querySelector('.inline-comment-threads')).toBeInTheDocument()
      })
      expect(container.querySelector('.inline-comment-threads')!.textContent).toContain(
        'inline-bot-marker',
      )
    })
  }

  it('an inline bot thread a person answered is untouched and draws no marker', async () => {
    const { container } = renderInline('unified', [
      anchoredBot,
      comment({ id: 21, line: 2, inReplyTo: 20, body: 'my-inline-answer' }),
    ])
    await vi.waitFor(() => {
      expect(container.querySelector('.inline-comment-threads')).toBeInTheDocument()
    })
    const inline = container.querySelector('.inline-comment-threads')!
    expect(inline.textContent).toContain('my-inline-answer')
    expect(inline.textContent).toContain('inline-bot-marker')
    expect(inline.querySelector(botNote)).not.toBeInTheDocument()
    expect(container.querySelector(markerSel)).not.toBeInTheDocument()
  })
})

describe('FileDiff — hiding and resolving are independent', () => {
  // One thread that is BOTH resolved and a bot's, plus one of each alone.
  const both = comment({ id: 30, author: 'posthog[bot]', body: 'both-marker' })
  const botOnly = comment({ id: 31, author: 'veria-ai[bot]', body: 'bot-only-marker' })
  const resolvedOnly = comment({ id: 32, body: 'resolved-only-marker' })
  const all = [both, botOnly, resolvedOnly]
  const resolvedIds = [30, 32]

  it('a thread that is both is counted ONCE, by the resolved filter', () => {
    const { container } = renderWith(all, resolvedIds)
    // 2 resolved (30, 32) under the resolved note; only 31 under the bot note.
    expect(container.querySelector(resolvedNote)!.textContent).toContain('2 resolved threads hidden')
    expect(container.querySelector(botNote)!.textContent).toContain('1 bot thread hidden')
  })

  it('unticking "Hide resolved" does NOT resurrect the resolved BOT thread', () => {
    setHideResolvedThreads(false)
    const { container } = renderWith(all, resolvedIds)
    const bottom = container.querySelector('.existing-comments')!
    // The plain resolved thread comes back...
    expect(bottom.textContent).toContain('resolved-only-marker')
    // ...but the one that is also a bot's stays gone, now under the bot note.
    expect(bottom.textContent).not.toContain('both-marker')
    expect(container.querySelector(resolvedNote)).not.toBeInTheDocument()
    expect(container.querySelector(botNote)!.textContent).toContain('2 bot threads hidden')
  })

  it('unticking "Hide bots" does NOT resurrect the resolved bot thread', () => {
    setHideBotThreads(false)
    const { container } = renderWith(all, resolvedIds)
    const bottom = container.querySelector('.existing-comments')!
    expect(bottom.textContent).toContain('bot-only-marker')
    expect(bottom.textContent).not.toContain('both-marker')
    expect(container.querySelector(botNote)).not.toBeInTheDocument()
    expect(container.querySelector(resolvedNote)!.textContent).toContain('2 resolved threads hidden')
  })

  it('both off: everything is back', () => {
    setHideResolvedThreads(false)
    setHideBotThreads(false)
    const { container } = renderWith(all, resolvedIds)
    const bottom = container.querySelector('.existing-comments')!
    for (const marker of ['both-marker', 'bot-only-marker', 'resolved-only-marker']) {
      expect(bottom.textContent).toContain(marker)
    }
    expect(container.querySelector(botNote)).not.toBeInTheDocument()
    expect(container.querySelector(resolvedNote)).not.toBeInTheDocument()
  })

  it('a group holding both kinds says so in two separate, actionable sentences', () => {
    const { container } = renderWith([botOnly, resolvedOnly], [32])
    expect(container.querySelectorAll(`${resolvedNote}, ${botNote}`)).toHaveLength(2)
  })
})
