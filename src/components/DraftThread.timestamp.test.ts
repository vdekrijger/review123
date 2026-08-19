/**
 * DraftThread — view-mode created-at chip:
 *   - relative age ("2d ago") with the exact local datetime as title
 *   - "earlier session" fallback for drafts without createdAt
 *   - hidden while composing a NEW draft and while editing an existing one
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import DraftThread from './DraftThread.svelte'
import { draftTimeTitle } from '../lib/drafts/drafts.svelte'
import type { Draft } from '../lib/drafts/drafts.svelte'

const DAY = 24 * 60 * 60 * 1000

const baseDraft: Draft = {
  prKey: 'owner/repo#1',
  path: 'src/a.ts',
  line: 5,
  side: 'RIGHT',
  body: 'This looks wrong',
  updatedAt: Date.now(),
}

function commonProps() {
  return {
    path: 'src/a.ts',
    line: 5,
    side: 'RIGHT' as const,
    onsave: vi.fn<(body: string) => void>(),
    ondelete: vi.fn<() => void>(),
    oncancel: vi.fn<() => void>(),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('DraftThread — created-at chip', () => {
  it('view mode shows the relative age with the exact datetime as title', () => {
    const createdAt = Date.now() - 2 * DAY
    render(DraftThread, {
      props: { ...commonProps(), draft: { ...baseDraft, createdAt } },
    })

    const chip = screen.getByTestId('draft-created-at')
    expect(chip).toHaveTextContent('2d ago')
    expect(chip).toHaveAttribute('title', draftTimeTitle(createdAt))
  })

  it('falls back to "earlier session" for drafts without createdAt', () => {
    render(DraftThread, {
      props: { ...commonProps(), draft: { ...baseDraft } }, // no createdAt
    })

    const chip = screen.getByTestId('draft-created-at')
    expect(chip).toHaveTextContent('earlier session')
    expect(chip).toHaveAttribute('title', 'Created in an earlier session (no timestamp recorded)')
  })

  it('no chip while composing a NEW draft', () => {
    render(DraftThread, {
      props: { ...commonProps(), draft: null },
    })
    expect(screen.queryByTestId('draft-created-at')).toBeNull()
  })

  it('chip hides while editing and returns on cancel back to view mode', async () => {
    const user = userEvent.setup()
    render(DraftThread, {
      props: { ...commonProps(), draft: { ...baseDraft, createdAt: Date.now() - DAY } },
    })

    expect(screen.getByTestId('draft-created-at')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /edit/i }))
    expect(screen.queryByTestId('draft-created-at')).toBeNull()

    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.getByTestId('draft-created-at')).toHaveTextContent('1d ago')
  })
})
