/**
 * InspectStep × excluding bot threads: the toolbar switch, the honest count
 * beside it, its persistence, and the gate that keeps it from appearing on a
 * pull request no bot has touched.
 *
 * The count carries one extra clause its resolved-thread sibling does not —
 * "still fixable" — because #285 makes bot comments candidates for the fixing
 * agent, that list is built from the PULL REQUEST rather than from the diff,
 * and a reader who saw bot findings in the panel and none in the code would
 * otherwise have no way to work out where they came from.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { PrComment } from '../lib/github/comments'
import {
  getHideBotThreads,
  _resetBotThreadsPrefForTest,
} from '../lib/guide/botThreadsPref.svelte'
import { _resetResolvedThreadsPrefForTest } from '../lib/guide/resolvedThreadsPref.svelte'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})
Element.prototype.scrollIntoView = function () {}

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame
}

beforeEach(() => {
  localStorage.clear()
  _resetSettingsStateForTest()
  _resetResolvedThreadsPrefForTest()
  _resetBotThreadsPrefForTest()
})

const FILES: PrFile[] = [
  {
    filename: 'src/a.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: '@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n unchanged',
  },
]

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

function renderInspect(prComments: PrComment[] = [], resolvedIds: number[] = []) {
  return render(InspectStep, {
    props: {
      files: FILES,
      changedFiles: FILES.length,
      mode: 'unified' as const,
      onmode: () => {},
      draftStore: null,
      prComments,
      resolvedCommentIds: new Set(resolvedIds),
    },
  })
}

const BOT = comment({ id: 1, author: 'posthog[bot]' })
const BOT2 = comment({ id: 2, author: 'veria-ai[bot]' })
const HUMAN = comment({ id: 3 })

describe('InspectStep — the Hide-bots switch', () => {
  it('is on by default — the user called them noise, so they start excluded', () => {
    renderInspect([BOT, HUMAN])
    const btn = screen.getByTestId('hide-bots-toggle')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn.textContent).toContain('Hide bots')
  })

  it('states the count beside it rather than hiding silently', () => {
    renderInspect([BOT, HUMAN])
    expect(screen.getByTestId('bot-hidden-count').textContent).toContain('1 bot thread hidden')
  })

  it('says the hiding is the diff’s business only, so the fixing panel makes sense', () => {
    renderInspect([BOT, HUMAN])
    const note = screen.getByTestId('bot-hidden-count')
    expect(note.textContent).toContain('still fixable')
    expect(note.getAttribute('title')).toMatch(/pull request, not from the diff/)
  })

  it('pluralises', () => {
    renderInspect([BOT, BOT2, HUMAN])
    expect(screen.getByTestId('bot-hidden-count').textContent).toContain('2 bot threads hidden')
  })

  it('turning it off drops the count line and persists per-browser', async () => {
    renderInspect([BOT, HUMAN])
    await userEvent.click(screen.getByTestId('hide-bots-toggle'))
    expect(screen.getByTestId('hide-bots-toggle')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('bot-hidden-count')).not.toBeInTheDocument()
    expect(getHideBotThreads()).toBe(false)
    expect(JSON.parse(localStorage.getItem('review123:hide-bot-comments')!)).toEqual({
      hidden: false,
    })
  })

  it('a stored preference is honoured on mount', () => {
    localStorage.setItem('review123:hide-bot-comments', JSON.stringify({ hidden: false }))
    _resetBotThreadsPrefForTest()
    renderInspect([BOT, HUMAN])
    expect(screen.getByTestId('hide-bots-toggle')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('bot-hidden-count')).not.toBeInTheDocument()
  })

  it('leaves the resolved switch alone — two independent preferences', async () => {
    renderInspect([BOT, comment({ id: 4 })], [4])
    await userEvent.click(screen.getByTestId('hide-bots-toggle'))
    expect(screen.getByTestId('hide-resolved-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('review123:hide-resolved')).toBeNull()
  })
})

describe('InspectStep — the switch is only offered when there is something to hide', () => {
  it('no bot comments at all: no switch, no count', () => {
    renderInspect([HUMAN])
    expect(screen.queryByTestId('hide-bots-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('bot-hidden-count')).not.toBeInTheDocument()
  })

  it('no comments loaded yet: no switch', () => {
    renderInspect([])
    expect(screen.queryByTestId('hide-bots-toggle')).not.toBeInTheDocument()
  })

  it('a bot thread a person has ANSWERED does not conjure a switch — it is a conversation', () => {
    renderInspect([BOT, comment({ id: 5, inReplyTo: 1 })])
    expect(screen.queryByTestId('hide-bots-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('bot-hidden-count')).not.toBeInTheDocument()
  })

  it('a bot REPLY under a human root does not count — the thread is the person’s', () => {
    renderInspect([HUMAN, comment({ id: 6, author: 'posthog[bot]', inReplyTo: 3 })])
    expect(screen.queryByTestId('hide-bots-toggle')).not.toBeInTheDocument()
  })
})

describe('InspectStep — the two counts never claim the same thread twice', () => {
  // id 1 is both a bot thread and resolved; id 2 is a bot thread only.
  it('a resolved bot thread is counted by the resolved filter alone', () => {
    renderInspect([BOT, BOT2], [1])
    expect(screen.getByTestId('resolved-hidden-count').textContent).toContain(
      '1 resolved thread hidden',
    )
    expect(screen.getByTestId('bot-hidden-count').textContent).toContain('1 bot thread hidden')
  })

  it('turning "Hide resolved" off hands that thread to the bot count, not back to the diff', async () => {
    renderInspect([BOT, BOT2], [1])
    await userEvent.click(screen.getByTestId('hide-resolved-toggle'))
    expect(screen.queryByTestId('resolved-hidden-count')).not.toBeInTheDocument()
    expect(screen.getByTestId('bot-hidden-count').textContent).toContain('2 bot threads hidden')
  })

  it('the switch is still offered for a bot thread that is only hidden as resolved', () => {
    // Everything bot here is also resolved: the bot count is 0, but the control
    // must stay, or turning the resolved switch off would strand the thread
    // with no way to reach the filter now holding it.
    renderInspect([BOT], [1])
    expect(screen.getByTestId('hide-bots-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('bot-hidden-count')).not.toBeInTheDocument()
  })
})
