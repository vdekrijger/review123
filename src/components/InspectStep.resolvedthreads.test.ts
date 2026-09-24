/**
 * InspectStep × excluding resolved threads: the toolbar switch, the honest
 * count next to it, its persistence, and the capability rule.
 *
 * The switch is only OFFERED when this PR actually has resolved threads. That
 * is what keeps it honest on Bitbucket, where the provider reports none at all
 * (resolvedThreads capability false → getResolvedCommentIds returns an empty
 * Set): the toolbar never shows a control for something the provider cannot do.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { PrComment } from '../lib/github/comments'
import {
  getHideResolvedThreads,
  _resetResolvedThreadsPrefForTest,
} from '../lib/guide/resolvedThreadsPref.svelte'
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

const ROOT = comment({ id: 1 })
const REPLY = comment({ id: 2, inReplyTo: 1 })
const OPEN = comment({ id: 3 })

describe('InspectStep — the Hide-resolved switch', () => {
  it('is on by default — resolved threads are noise, so they start excluded', () => {
    renderInspect([ROOT, OPEN], [1])
    const btn = screen.getByTestId('hide-resolved-toggle')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn.textContent).toContain('Hide resolved')
  })

  it('states the count next to it rather than hiding silently', () => {
    renderInspect([ROOT, OPEN], [1])
    expect(screen.getByTestId('resolved-hidden-count').textContent).toContain(
      '1 resolved thread hidden',
    )
  })

  it('counts THREADS, not comment ids (a resolved thread carries its replies)', () => {
    // resolvedCommentIds holds every comment in the resolved thread — root AND
    // reply — so its size (2) must not be mistaken for a thread count (1).
    renderInspect([ROOT, REPLY, OPEN], [1, 2])
    expect(screen.getByTestId('resolved-hidden-count').textContent).toContain(
      '1 resolved thread hidden',
    )
  })

  it('pluralises', () => {
    renderInspect([ROOT, comment({ id: 4 }), OPEN], [1, 4])
    expect(screen.getByTestId('resolved-hidden-count').textContent).toContain(
      '2 resolved threads hidden',
    )
  })

  it('turning it off drops the count line and persists per-browser', async () => {
    renderInspect([ROOT, OPEN], [1])
    await userEvent.click(screen.getByTestId('hide-resolved-toggle'))
    expect(screen.getByTestId('hide-resolved-toggle')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('resolved-hidden-count')).not.toBeInTheDocument()
    expect(getHideResolvedThreads()).toBe(false)
    expect(JSON.parse(localStorage.getItem('review123:hide-resolved')!)).toEqual({ hidden: false })
  })

  it('a stored preference is honoured on mount', () => {
    localStorage.setItem('review123:hide-resolved', JSON.stringify({ hidden: false }))
    _resetResolvedThreadsPrefForTest()
    renderInspect([ROOT, OPEN], [1])
    expect(screen.getByTestId('hide-resolved-toggle')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('resolved-hidden-count')).not.toBeInTheDocument()
  })
})

describe('InspectStep — the switch never implies a capability the provider lacks', () => {
  it('Bitbucket (empty resolvedCommentIds): no switch, no count', () => {
    renderInspect([ROOT, OPEN], [])
    expect(screen.queryByTestId('hide-resolved-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resolved-hidden-count')).not.toBeInTheDocument()
  })

  it('a GitHub PR with nothing resolved: no switch either (nothing to hide)', () => {
    renderInspect([OPEN], [])
    expect(screen.queryByTestId('hide-resolved-toggle')).not.toBeInTheDocument()
  })

  it('no comments loaded yet: no switch', () => {
    renderInspect([], [1])
    expect(screen.queryByTestId('hide-resolved-toggle')).not.toBeInTheDocument()
  })

  it('a resolved id that matches no thread root does not conjure a switch', () => {
    // The set can name a REPLY id; only a resolved thread ROOT counts.
    renderInspect([ROOT, REPLY], [2])
    expect(screen.queryByTestId('hide-resolved-toggle')).not.toBeInTheDocument()
  })
})
