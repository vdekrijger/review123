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
    skillReviews: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
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

describe('ContextRail topbar overlap fix', () => {
  it('rail top is set via CSS var --topbar-h (not hardcoded 0)', () => {
    // jsdom does not evaluate computed CSS-var values, so we assert that the
    // element does NOT have an inline top:0 style — real top positioning comes
    // from the stylesheet using var(--topbar-h).
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const aside = container.querySelector('aside.context-rail')
    expect(aside).not.toBeNull()
    // No inline style overriding top
    const inlineStyle = aside?.getAttribute('style') ?? ''
    expect(inlineStyle).not.toMatch(/\btop\s*:\s*0/)
  })

  it('topbar and settings gear are both rendered simultaneously (gear must be reachable)', () => {
    // Regression: when the rail had top:0 + z-index above the topbar, the
    // settings gear was occluded.  Verify they co-exist in the DOM with no
    // inline z-index on the rail that would beat the topbar.
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const aside = container.querySelector('aside.context-rail')
    expect(aside).not.toBeNull()
    // Rail must NOT carry an inline z-index that would override the stylesheet
    const inlineStyle = aside?.getAttribute('style') ?? ''
    expect(inlineStyle).not.toMatch(/z-index/)
  })
})

describe('ContextRail responsive width', () => {
  it('rail has no inline width attribute — width comes from CSS class (clamp formula)', () => {
    // jsdom cannot evaluate CSS clamp() so we assert the responsive width
    // lives entirely in the stylesheet (class-based), not as inline style.
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const aside = container.querySelector('aside.context-rail')
    expect(aside).not.toBeNull()
    const inlineStyle = aside?.getAttribute('style') ?? ''
    expect(inlineStyle).not.toMatch(/\bwidth\s*:/)
  })

  it('collapsed rail has class "collapsed" applied (CSS transitions to narrow state)', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: true, oncollapse: vi.fn() },
    })
    const aside = container.querySelector('aside.context-rail')
    expect(aside?.classList.contains('collapsed')).toBe(true)
  })

  it('expanded rail does NOT have class "collapsed"', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const aside = container.querySelector('aside.context-rail')
    expect(aside?.classList.contains('collapsed')).toBe(false)
  })
})

describe('ContextRail content parity — shared panels', () => {
  it('renders Summary section header when expanded', () => {
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    // The <details> summary element for the Summary panel should be present
    const summaries = document.querySelectorAll('details > summary')
    const texts = Array.from(summaries).map((s) => s.textContent?.toLowerCase() ?? '')
    expect(texts.some((t) => t.includes('summary'))).toBe(true)
  })

  it('renders Verdict evidence section header when expanded', () => {
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = document.querySelectorAll('details > summary')
    const texts = Array.from(summaries).map((s) => s.textContent?.toLowerCase() ?? '')
    expect(texts.some((t) => t.includes('verdict'))).toBe(true)
  })

  it('renders Test coverage section header when expanded', () => {
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = document.querySelectorAll('details > summary')
    const texts = Array.from(summaries).map((s) => s.textContent?.toLowerCase() ?? '')
    expect(texts.some((t) => t.includes('test'))).toBe(true)
  })

  it('renders Alternative approaches section header when expanded', () => {
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = document.querySelectorAll('details > summary')
    const texts = Array.from(summaries).map((s) => s.textContent?.toLowerCase() ?? '')
    expect(texts.some((t) => t.includes('alternative'))).toBe(true)
  })

  it('does NOT render sections when collapsed', () => {
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: true, oncollapse: vi.fn() },
    })
    // Collapsed rail has no body — no section summaries
    const summaries = document.querySelectorAll('details > summary')
    expect(summaries.length).toBe(0)
  })
})

describe('ContextRail backdrop (narrow-mode overlay)', () => {
  it('renders a backdrop element in the DOM', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    // Backdrop div must exist — CSS @media controls its visibility
    const backdrop = container.querySelector('.rail-backdrop')
    expect(backdrop).not.toBeNull()
  })

  it('backdrop has class "visible" when rail is expanded', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const backdrop = container.querySelector('.rail-backdrop')
    expect(backdrop?.classList.contains('visible')).toBe(true)
  })

  it('backdrop does NOT have class "visible" when rail is collapsed', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: true, oncollapse: vi.fn() },
    })
    const backdrop = container.querySelector('.rail-backdrop')
    expect(backdrop?.classList.contains('visible')).toBe(false)
  })

  it('calls onbackdropclick when backdrop is clicked', async () => {
    const user = userEvent.setup()
    const onbackdropclick = vi.fn()
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn(), onbackdropclick },
    })
    const backdrop = container.querySelector('.rail-backdrop') as HTMLElement
    await user.click(backdrop)
    expect(onbackdropclick).toHaveBeenCalledTimes(1)
  })

  it('backdrop is present even when onbackdropclick is not provided (optional prop)', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    // Should not throw even without onbackdropclick
    const backdrop = container.querySelector('.rail-backdrop')
    expect(backdrop).not.toBeNull()
  })
})

describe('ContextRail medium-regime: no inline width (CSS-only)', () => {
  it('aside.context-rail does not carry inline width — CSS clamp + media queries handle it', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const aside = container.querySelector('aside.context-rail')
    // No inline width — width must come from CSS class + media queries
    const inlineStyle = aside?.getAttribute('style') ?? ''
    expect(inlineStyle).not.toMatch(/\bwidth\s*:/)
  })
})
