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
    alternatives: { status: 'idle' },
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
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

describe('ContextRail theme — uses CSS variables for surface', () => {
  it('.context-rail element has the context-rail class (CSS variable background applied via class)', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    // The aside element must have the class "context-rail" so the CSS-var
    // background rule applies.  A hardcoded inline background: #16161e would
    // break light theme — this class assertion catches a regression where the
    // class is removed or the element replaced with one lacking the class.
    const aside = container.querySelector('aside.context-rail')
    expect(aside).not.toBeNull()
  })

  it('.context-rail does NOT carry an inline background style (must come from CSS class/var)', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const aside = container.querySelector('aside.context-rail')
    // Inline style must not set background to a hardcoded dark color —
    // the surface color must live in the stylesheet as a CSS variable.
    expect(aside?.getAttribute('style') ?? '').not.toMatch(/background\s*:/)
  })
})
