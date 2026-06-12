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
  getSettings: () => ({ railCollapsed: false, aiProvider: 'deepseek' }),
  setRailCollapsed: vi.fn(),
  setDiffMode: vi.fn(),
  saveTokens: vi.fn(),
  saveGithubAuth: vi.fn(),
  // settingsState.svelte.ts registers itself on import (AiPanel → settingsState)
  _registerSettingsRefresh: vi.fn(),
  _registerAuthRefresh: vi.fn(),
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

  it('hotspot is a plain button, not a link — no href to trigger a page load', () => {
    const attn: AttentionResult = {
      readingOrder: [], testFlags: [],
      hotspots: [{ path: 'src/hot.ts', reason: 'Critical', level: 'high' }],
    }
    const { container } = render(ContextRail, {
      props: { run: makeRun(attn), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const btn = container.querySelector('.hotspot-btn')!
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('href')).toBeNull()
    expect(btn.closest('a')).toBeNull()
  })
})

describe('ContextRail hotspot legend (level markers explained)', () => {
  const attn: AttentionResult = {
    readingOrder: [],
    testFlags: [],
    hotspots: [
      { path: 'src/risky.ts', reason: 'Rewrites auth flow', level: 'high' },
      { path: 'src/mid.ts', reason: 'New cache layer', level: 'medium' },
      { path: 'src/minor.ts', reason: 'Rename only', level: 'low' },
    ],
  }

  function renderWithHotspots() {
    return render(ContextRail, {
      props: { run: makeRun(attn), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
  }

  it('renders a one-line visible legend naming all three attention levels', () => {
    const { container } = renderWithHotspots()
    const legend = container.querySelector('.hotspot-legend')
    expect(legend).not.toBeNull()
    expect(legend!.textContent).toContain('⚠ high risk')
    expect(legend!.textContent).toContain('◆ medium')
    expect(legend!.textContent).toContain('● low attention')
  })

  it('each hotspot button carries a title with its level and AI reason', () => {
    renderWithHotspots()
    const high = screen.getByRole('button', { name: /src\/risky\.ts/i })
    const medium = screen.getByRole('button', { name: /src\/mid\.ts/i })
    const low = screen.getByRole('button', { name: /src\/minor\.ts/i })
    expect(high.getAttribute('title')).toBe('high attention — Rewrites auth flow')
    expect(medium.getAttribute('title')).toBe('medium attention — New cache layer')
    expect(low.getAttribute('title')).toBe('low attention — Rename only')
  })

  it('marker icon matches the level (⚠ high, ◆ medium, ● low)', () => {
    renderWithHotspots()
    const high = screen.getByRole('button', { name: /src\/risky\.ts/i })
    const medium = screen.getByRole('button', { name: /src\/mid\.ts/i })
    const low = screen.getByRole('button', { name: /src\/minor\.ts/i })
    expect(high.querySelector('.hotspot-icon')!.textContent).toBe('⚠')
    expect(medium.querySelector('.hotspot-icon')!.textContent).toBe('◆')
    expect(low.querySelector('.hotspot-icon')!.textContent).toBe('●')
  })

  it('does not render the legend when there are no hotspots', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    expect(container.querySelector('.hotspot-legend')).toBeNull()
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

  it('renders "Why this verdict" section header when expanded', () => {
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

// ---------------------------------------------------------------------------
// Registry-driven completeness: ci-details and pr-description now in rail (task item 3)
// ---------------------------------------------------------------------------

import type { CiSummary } from '../lib/github/checks'
import type { PrMeta } from '../lib/github/types'

describe('ContextRail registry completeness — ci-details in rail', () => {
  it('renders CI details section header when expanded', () => {
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = document.querySelectorAll('details > summary')
    const texts = Array.from(summaries).map((s) => s.textContent?.toLowerCase() ?? '')
    expect(texts.some((t) => t.includes('ci details') || t.includes('ci'))).toBe(true)
  })

  it('renders Original PR description section header when expanded', () => {
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = document.querySelectorAll('details > summary')
    const texts = Array.from(summaries).map((s) => s.textContent?.toLowerCase() ?? '')
    expect(texts.some((t) => t.includes('pr description') || t.includes('original pr'))).toBe(true)
  })

  it('passes CI data into ci-details section when ci prop provided', () => {
    const ci: CiSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      failures: [],
    }
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn(), ci },
    })
    // Open all details
    document.querySelectorAll('details').forEach((d) => { d.open = true })
    // CiSummary renders .ci-pass when all passed
    expect(container.querySelector('.ci-pass')).not.toBeNull()
  })

  it('renders PR body when meta prop provided', () => {
    const meta: PrMeta = {
      title: 'My PR',
      state: 'open',
      merged: false,
      body: 'Hello from PR description.',
      baseSha: 'abc',
      headSha: 'def',
      private: false,
      changedFiles: 1,
      authorLogin: null,
    }
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn(), meta },
    })
    document.querySelectorAll('details').forEach((d) => { d.open = true })
    expect(screen.getByText('Hello from PR description.')).toBeInTheDocument()
  })

  it('shows "No description." when meta has no body', () => {
    const meta: PrMeta = {
      title: 'My PR',
      state: 'open',
      merged: false,
      body: null,
      baseSha: 'abc',
      headSha: 'def',
      private: false,
      changedFiles: 1,
      authorLogin: null,
    }
    render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn(), meta },
    })
    document.querySelectorAll('details').forEach((d) => { d.open = true })
    expect(screen.getByText(/no description/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// No Ask AI in rail (task item 4)
// ---------------------------------------------------------------------------

describe('ContextRail — no Ask AI section', () => {
  it('does not render AskAi widget in the rail body', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    // AskAi renders .ask-ai-section and a textarea
    expect(container.querySelector('.ask-ai-section')).toBeNull()
    // No textarea in rail body
    const body = container.querySelector('.rail-body')
    expect(body?.querySelector('textarea')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Registry order visible in rail (summary before diagrams, etc.)
// ---------------------------------------------------------------------------

describe('ContextRail — registry section order', () => {
  it('Summary section appears before Diagrams in DOM order', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = Array.from(container.querySelectorAll('details > summary'))
    const summaryIdx = summaries.findIndex((s) => s.textContent?.toLowerCase().includes('full summary') || s.textContent?.toLowerCase() === 'summary')
    const diagramsIdx = summaries.findIndex((s) => s.textContent?.toLowerCase().includes('diagrams'))
    expect(summaryIdx).toBeGreaterThanOrEqual(0)
    expect(diagramsIdx).toBeGreaterThan(summaryIdx)
  })

  it('Diagrams section appears before Test coverage in DOM order', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = Array.from(container.querySelectorAll('details > summary'))
    const diagramsIdx = summaries.findIndex((s) => s.textContent?.toLowerCase().includes('diagrams'))
    const testsIdx = summaries.findIndex((s) => s.textContent?.toLowerCase().includes('test coverage'))
    expect(diagramsIdx).toBeGreaterThanOrEqual(0)
    expect(testsIdx).toBeGreaterThan(diagramsIdx)
  })

  it('"Why this verdict" appears before CI details in DOM order', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = Array.from(container.querySelectorAll('details > summary'))
    const verdictIdx = summaries.findIndex((s) => s.textContent?.toLowerCase().includes('verdict'))
    const ciIdx = summaries.findIndex((s) => s.textContent?.toLowerCase().includes('ci'))
    expect(verdictIdx).toBeGreaterThanOrEqual(0)
    expect(ciIdx).toBeGreaterThan(verdictIdx)
  })

  it('CI details appears before PR description in DOM order', () => {
    const { container } = render(ContextRail, {
      props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
    })
    const summaries = Array.from(container.querySelectorAll('details > summary'))
    const ciIdx = summaries.findIndex((s) => s.textContent?.toLowerCase().includes('ci'))
    const prDescIdx = summaries.findIndex((s) => s.textContent?.toLowerCase().includes('pr description') || s.textContent?.toLowerCase().includes('original pr'))
    expect(ciIdx).toBeGreaterThanOrEqual(0)
    expect(prDescIdx).toBeGreaterThan(ciIdx)
  })
})
