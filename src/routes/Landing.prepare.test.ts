/**
 * Tests for the Landing queue's per-row Prepare-ahead control.
 *
 * The prepare module is mocked with a controllable plain state object; each
 * test sets the desired store state BEFORE render (the real module's $state
 * reactivity is covered by prepare.test.ts — these tests pin the row UI:
 * idle / keyless / preparing / busy / ready(+cost) / error / persisted).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import Landing from './Landing.svelte'
import * as queueModule from '../lib/provider/queue'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'
import type { QueueItem } from '../lib/provider/types'

vi.mock('../lib/router/router.svelte', () => ({
  navigate: vi.fn(),
}))

vi.mock('../lib/provider/registry', () => ({
  PROVIDERS: new Map([
    ['github', {
      id: 'github',
      displayName: 'GitHub',
      authState: () => ({ configured: true, hint: '' }),
      getMyQueue: vi.fn(),
      capabilities: { resolvedThreads: false, checks: false, suggestions: false, atomicReview: false, compare: false, commentReplies: false, selfReviewBlocked: false },
    }],
  ]),
  parseAnyUrl: vi.fn().mockReturnValue(null),
}))

// Controllable stand-in for the prepare module. Tests mutate `mockPrepare`
// BEFORE render; the component reads it during that render.
const mockPrepare = {
  rows: {} as Record<string, { status: string; error?: string; errorDetail?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }>,
  activeId: null as string | null,
  progress: null as { done: number; total: number } | null,
  preparedFor: new Set<string>(),
  record: null as { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } | null,
}

vi.mock('../lib/ai/prepare.svelte', () => ({
  prepareStore: {
    get rows() { return mockPrepare.rows },
    get activeId() { return mockPrepare.activeId },
  },
  preparePr: vi.fn().mockResolvedValue({ started: true, outcome: 'ready' }),
  cancelPrepare: vi.fn(),
  preparePrId: (providerId: string, owner: string, repo: string, number: number) =>
    `${providerId}:${owner}/${repo}#${number}`,
  prepareProgress: vi.fn(() => mockPrepare.progress),
  isPreparedFor: vi.fn((prId: string) => mockPrepare.preparedFor.has(prId)),
  preparedRecord: vi.fn(() => mockPrepare.record),
}))

import { preparePr } from '../lib/ai/prepare.svelte'

const UPDATED_AT = '2026-08-20T10:00:00.000Z'

function makeItem(number = 5): QueueItem {
  return {
    ref: { provider: 'github', owner: 'org', repo: 'repo', number },
    title: 'A queue PR',
    authorIsMe: false,
    updatedAt: UPDATED_AT,
  }
}

const PR_ID = 'github:org/repo#5'

function seedKey(extra: Record<string, unknown> = {}): void {
  localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test', ...extra }))
  _resetSettingsStateForTest()
}

async function renderWithQueue(items: QueueItem[] = [makeItem()]) {
  vi.spyOn(queueModule, 'fetchAllQueues').mockResolvedValue(items)
  render(Landing)
  await screen.findByRole('button', { name: /org\/repo#5/i })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  queueModule._resetQueueCacheForTest()
  mockPrepare.rows = {}
  mockPrepare.activeId = null
  mockPrepare.progress = null
  mockPrepare.preparedFor = new Set()
  mockPrepare.record = null
  _resetSettingsStateForTest()
})

describe('Landing — Prepare control (idle)', () => {
  it('renders an enabled Prepare button when a key is configured, and clicking starts the prepare', async () => {
    seedKey()
    await renderWithQueue()

    const btn = screen.getByTestId('prepare-btn')
    expect(btn).toBeEnabled()
    expect(btn).toHaveTextContent('Prepare')

    await fireEvent.click(btn)
    expect(preparePr).toHaveBeenCalledWith({
      providerId: 'github',
      owner: 'org',
      repo: 'repo',
      number: 5,
      updatedAt: UPDATED_AT,
    })
  })

  it('keyless: the button is disabled with the provider-naming hint (askDisabledReason idiom)', async () => {
    // No LLM key seeded.
    await renderWithQueue()

    const btn = screen.getByTestId('prepare-btn')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringContaining('No API key configured'))
    expect(btn).toHaveAttribute('title', expect.stringContaining('DeepSeek'))
    // NOTE: no synthetic click assertion — fireEvent bypasses `disabled` in
    // jsdom; the disabled attribute itself is the browser-level guard.
  })

  it('one-at-a-time: while ANOTHER row prepares, this row is disabled with the honest hint', async () => {
    seedKey()
    mockPrepare.activeId = 'github:other/repo#9'
    await renderWithQueue()

    const btn = screen.getByTestId('prepare-btn')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringContaining('One prepare runs at a time'))
  })
})

describe('Landing — Prepare control (preparing)', () => {
  it('shows the live task K/N progress label', async () => {
    seedKey()
    mockPrepare.rows[PR_ID] = { status: 'preparing' }
    mockPrepare.activeId = PR_ID
    mockPrepare.progress = { done: 3, total: 9 }
    await renderWithQueue()

    const status = screen.getByTestId('prepare-status')
    expect(status).toHaveTextContent('Preparing… (3/9)')
    expect(screen.queryByTestId('prepare-btn')).not.toBeInTheDocument()
  })

  it('falls back to a plain label when progress is not derivable', async () => {
    seedKey()
    mockPrepare.rows[PR_ID] = { status: 'preparing' }
    mockPrepare.progress = null
    await renderWithQueue()

    expect(screen.getByTestId('prepare-status')).toHaveTextContent(/^Preparing…$/)
  })
})

describe('Landing — Prepare control (ready)', () => {
  it('shows Ready ✓ without cost when showTokenCost is off', async () => {
    seedKey()
    mockPrepare.rows[PR_ID] = {
      status: 'ready',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }
    await renderWithQueue()

    const status = screen.getByTestId('prepare-status')
    expect(status).toHaveTextContent('Ready ✓')
    expect(status.textContent).not.toContain('tokens')
  })

  it('appends the usage label when showTokenCost is on', async () => {
    seedKey({ showTokenCost: true })
    mockPrepare.rows[PR_ID] = {
      status: 'ready',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }
    await renderWithQueue()

    const status = screen.getByTestId('prepare-status')
    expect(status).toHaveTextContent('Ready ✓')
    expect(status.textContent).toContain('150 tokens')
  })

  it('renders Ready ✓ from the PERSISTED record (survives reload) with its stored usage', async () => {
    seedKey({ showTokenCost: true })
    mockPrepare.preparedFor = new Set([PR_ID])
    mockPrepare.record = { usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 } }
    await renderWithQueue()

    const status = screen.getByTestId('prepare-status')
    expect(status).toHaveTextContent('Ready ✓')
    expect(status.textContent).toContain('1.0k tokens')
  })

  it('an updated PR (isPreparedFor false) falls back to the idle Prepare button', async () => {
    seedKey()
    mockPrepare.preparedFor = new Set() // record exists but updatedAt moved
    mockPrepare.record = null
    await renderWithQueue()

    expect(screen.getByTestId('prepare-btn')).toHaveTextContent('Prepare')
    expect(screen.queryByTestId('prepare-status')).not.toBeInTheDocument()
  })
})

describe('Landing — Prepare control (error)', () => {
  it('shows the calm retry button with the concrete detail on hover (errorDetail idiom)', async () => {
    seedKey()
    mockPrepare.rows[PR_ID] = {
      status: 'error',
      error: '1 of 8 AI tasks failed',
      errorDetail: 'DeepSeek server error (503) — retried automatically before failing',
    }
    await renderWithQueue()

    const btn = screen.getByTestId('prepare-btn')
    expect(btn).toHaveTextContent('Prepare failed — retry')
    expect(btn).toHaveAttribute('title', expect.stringContaining('503'))
    expect(btn).toBeEnabled()

    await fireEvent.click(btn)
    expect(preparePr).toHaveBeenCalledTimes(1)
  })

  it('falls back to the lead error line when no detail exists', async () => {
    seedKey()
    mockPrepare.rows[PR_ID] = { status: 'error', error: 'AI consent needed — open the PR once and allow AI analysis, then prepare.' }
    await renderWithQueue()

    expect(screen.getByTestId('prepare-btn')).toHaveAttribute(
      'title',
      expect.stringContaining('consent'),
    )
  })
})
