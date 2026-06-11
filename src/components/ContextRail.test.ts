import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import ContextRail from './ContextRail.svelte'
import { track } from '../lib/analytics/analytics'
import type { AiRun } from '../lib/ai/run.svelte'
import type { AttentionResult } from '../lib/ai/schemas'

vi.mock('../lib/analytics/analytics', () => ({
  track: vi.fn(),
  initAnalytics: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

vi.mock('../lib/settings/settings', () => ({
  getSettings: () => ({ railCollapsed: false }),
  setRailCollapsed: vi.fn(),
  setDiffMode: vi.fn(),
  saveTokens: vi.fn(),
  saveGithubAuth: vi.fn(),
}))

function makeRun(attn?: AttentionResult): AiRun {
  return {
    summary: { status: 'idle' },
    attention: attn ? { status: 'done', value: attn } : { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    tests: { status: 'idle' },
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
  }
}

describe('ContextRail hotspot click', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls onhotspot and tracks when hotspot button clicked', async () => {
    const user = userEvent.setup()
    const onhotspot = vi.fn()
    const attn: AttentionResult = {
      readingOrder: [], testFlags: [],
      hotspots: [{ path: 'src/hot.ts', reason: 'Critical', level: 'high' }],
    }
    render(ContextRail, { props: { run: makeRun(attn), onhotspot, collapsed: false, oncollapse: vi.fn() } })
    const btn = screen.getByRole('button', { name: /src\/hot\.ts/i })
    await user.click(btn)
    expect(onhotspot).toHaveBeenCalledWith('src/hot.ts')
    expect(vi.mocked(track)).toHaveBeenCalledWith('hotspot_clicked')
  })
})

describe('ContextRail collapse', () => {
  it('calls oncollapse when toggle clicked', async () => {
    const user = userEvent.setup()
    const oncollapse = vi.fn()
    render(ContextRail, { props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse } })
    const btn = screen.getByRole('button', { name: /collapse/i })
    await user.click(btn)
    expect(oncollapse).toHaveBeenCalledWith(true)
  })
})
