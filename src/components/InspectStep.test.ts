import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { AttentionResult } from '../lib/ai/schemas'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import { createViewedStore } from '../lib/viewed/viewed.svelte'
import { setShowTokenCost, setAiProvider, setAiModel } from '../lib/settings/settings'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({
    font: '',
    measureText: () => ({ width: 0 }),
  }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

const makeFiles = (names: string[]): PrFile[] =>
  names.map(filename => ({
    filename, status: 'modified', additions: 1, deletions: 0,
    patch: PATCH,
  }))

describe('InspectStep ordering (EC-12e)', () => {
  it('orders files by readingOrder with unlisted files after', () => {
    const files = makeFiles(['c.ts', 'a.ts', 'b.ts'])
    render(InspectStep, { props: { files, changedFiles: 3, mode: 'unified', onmode: () => {}, draftStore: null, readingOrder: ['a.ts', 'b.ts'] } })
    const articles = document.querySelectorAll('article.file-diff')
    // a.ts and b.ts first, c.ts last
    expect(articles[0].closest('[id]')?.id).toBe('file-a-ts')
    expect(articles[1].closest('[id]')?.id).toBe('file-b-ts')
    expect(articles[2].closest('[id]')?.id).toBe('file-c-ts')
  })

  it('ignores readingOrder entries not in PR files (EC-12e)', () => {
    const files = makeFiles(['a.ts'])
    // 'unknown.ts' is in readingOrder but not in files — should not crash
    expect(() => render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, readingOrder: ['unknown.ts', 'a.ts'] } })).not.toThrow()
    const articles = document.querySelectorAll('article.file-diff')
    expect(articles).toHaveLength(1)
  })

  it('sinks generated files to the END of the file list', () => {
    // pnpm-lock.yaml is generated → must render LAST even though it leads the input.
    const files = makeFiles(['pnpm-lock.yaml', 'a.ts', 'b.ts'])
    render(InspectStep, { props: { files, changedFiles: 3, mode: 'unified', onmode: () => {}, draftStore: null, readingOrder: [] } })
    const articles = document.querySelectorAll('article.file-diff')
    expect(articles[0].closest('[id]')?.id).toBe('file-a-ts')
    expect(articles[1].closest('[id]')?.id).toBe('file-b-ts')
    expect(articles[2].closest('[id]')?.id).toBe('file-pnpm-lock-yaml')
  })

  it('keeps generated files last even after readingOrder is applied (stable)', () => {
    // readingOrder lists the generated file first; the generated sink overrides it.
    const files = makeFiles(['app.min.js', 'a.ts', 'b.ts'])
    render(InspectStep, { props: { files, changedFiles: 3, mode: 'unified', onmode: () => {}, draftStore: null, readingOrder: ['app.min.js', 'b.ts', 'a.ts'] } })
    const articles = document.querySelectorAll('article.file-diff')
    // non-generated keep readingOrder (b before a); generated sinks last
    expect(articles[0].closest('[id]')?.id).toBe('file-b-ts')
    expect(articles[1].closest('[id]')?.id).toBe('file-a-ts')
    expect(articles[2].closest('[id]')?.id).toBe('file-app-min-js')
  })
})

describe('InspectStep hotspot badge and test flag (EC-13c, EC-13d)', () => {
  it('shows hotspot badge on matching file', () => {
    const files = makeFiles(['hot.ts', 'cool.ts'])
    const attention: AttentionResult = {
      readingOrder: [], hotspots: [{ path: 'hot.ts', reason: 'Critical logic', level: 'high' }], testFlags: [],
    }
    render(InspectStep, { props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null, attention, readingOrder: [] } })
    expect(screen.getByText(/Critical logic/)).toBeInTheDocument()
  })

  it('shows exact test flag label (EC-13d)', () => {
    const files = makeFiles(['src/thing.ts'])
    const attention: AttentionResult = {
      readingOrder: [], hotspots: [], testFlags: [{ path: 'src/thing.ts', note: 'no test' }],
    }
    render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, attention, readingOrder: [] } })
    expect(screen.getByText('AI-inferred — not measured coverage')).toBeInTheDocument()
  })

  it('unknown attention paths do not crash (EC-13c)', () => {
    const files = makeFiles(['real.ts'])
    const attention: AttentionResult = {
      readingOrder: [], hotspots: [{ path: 'ghost.ts', reason: 'x', level: 'low' }], testFlags: [{ path: 'ghost.ts', note: 'y' }],
    }
    expect(() => render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, attention, readingOrder: [] } })).not.toThrow()
  })
})

describe('InspectStep — viewedStore wiring', () => {
  it('renders Viewed checkboxes for each file when viewedStore is provided', () => {
    const files = makeFiles(['src/a.ts', 'src/b.ts'])
    const viewedStore = createViewedStore('owner/repo#1')
    render(InspectStep, { props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null, viewedStore } })
    const checkboxes = screen.getAllByRole('checkbox', { name: /mark .* as viewed/i })
    expect(checkboxes).toHaveLength(2)
  })

  it('viewed file has is-collapsed article', () => {
    const files = makeFiles(['src/a.ts'])
    const viewedStore = createViewedStore('owner/repo#1')
    // Mark the file as viewed before rendering
    viewedStore.toggle('src/a.ts', PATCH)
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, viewedStore } })
    expect(container.querySelector('article.file-diff.is-collapsed')).toBeInTheDocument()
  })

  it('unviewed file is NOT collapsed', () => {
    const files = makeFiles(['src/a.ts'])
    const viewedStore = createViewedStore('owner/repo#1')
    // NOT toggled — not viewed
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, viewedStore } })
    expect(container.querySelector('article.file-diff.is-collapsed')).not.toBeInTheDocument()
  })

  it('works without viewedStore (null) — no collapse, no checkbox error', () => {
    const files = makeFiles(['src/a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, viewedStore: null } })
    expect(container.querySelector('article.file-diff.is-collapsed')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// InspectStep — toolbar btn class (task 5, item 1)
// ---------------------------------------------------------------------------

describe('InspectStep — toolbar btn classes', () => {
  it('Unified button has class btn', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const buttons = container.querySelectorAll('.mode-toggle button')
    const unifiedBtn = [...buttons].find(b => b.textContent?.trim() === 'Unified')
    expect(unifiedBtn).toBeTruthy()
    expect(unifiedBtn!.classList.contains('btn')).toBe(true)
  })

  it('Side-by-side button has class btn', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'split', onmode: () => {}, draftStore: null } })
    const buttons = container.querySelectorAll('.mode-toggle button')
    const splitBtn = [...buttons].find(b => b.textContent?.trim() === 'Side-by-side')
    expect(splitBtn).toBeTruthy()
    expect(splitBtn!.classList.contains('btn')).toBe(true)
  })

  it('active mode button has aria-pressed=true', () => {
    const files = makeFiles(['a.ts'])
    render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const unifiedBtn = screen.getByRole('button', { name: 'Unified' })
    expect(unifiedBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('inactive mode button has aria-pressed=false', () => {
    const files = makeFiles(['a.ts'])
    render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const splitBtn = screen.getByRole('button', { name: 'Side-by-side' })
    expect(splitBtn.getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// InspectStep — sticky drawer structural styles (task 5, item 3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// InspectStep — skill-reviewer token-usage footer (opt-in: settings.showTokenCost)
// Mirrors the AiPanel footer: shows alongside the finding chip / deep note on a
// DONE skill-reviewer card, only when the toggle is on and usage was captured.
// ---------------------------------------------------------------------------

describe('InspectStep — skill-reviewer token-usage footer', () => {
  const USAGE = { prompt_tokens: 8000, completion_tokens: 200, total_tokens: 8200 }

  const doneEntry = (overrides: Partial<SkillReviewEntry['state']> = {}): SkillReviewEntry => ({
    skillId: 'reviewer-1',
    name: 'My Reviewer',
    state: { status: 'done', value: { skillName: 'My Reviewer', findings: [] }, ...overrides },
  })

  beforeEach(() => {
    _resetSettingsStateForTest()
  })

  it('renders NOTHING when showTokenCost is off (default)', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews: [doneEntry({ usage: USAGE })] },
    })
    expect(container.querySelector('.skill-usage-footer')).toBeNull()
  })

  it('renders tokens + $ when on and the active model has pricing', () => {
    setShowTokenCost(true)
    setAiProvider('anthropic')
    setAiModel('claude-sonnet-4-6')
    _resetSettingsStateForTest()
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews: [doneEntry({ usage: USAGE })] },
    })
    const footer = container.querySelector('.skill-usage-footer')
    expect(footer).not.toBeNull()
    expect(footer!.textContent).toContain('8.2k tokens')
    expect(footer!.textContent).toContain('$0.03')
  })

  it('renders NOTHING when usage is absent (never fabricated)', () => {
    setShowTokenCost(true)
    _resetSettingsStateForTest()
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews: [doneEntry()] },
    })
    expect(container.querySelector('.skill-usage-footer')).toBeNull()
  })

  it('does NOT show the footer for non-done states even with usage', () => {
    setShowTokenCost(true)
    _resetSettingsStateForTest()
    const files = makeFiles(['a.ts'])
    const loading: SkillReviewEntry = {
      skillId: 'reviewer-1', name: 'My Reviewer',
      state: { status: 'loading', usage: USAGE },
    }
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews: [loading] },
    })
    expect(container.querySelector('.skill-usage-footer')).toBeNull()
  })
})

describe('InspectStep — sticky drawer structure', () => {
  it('file-tree-drawer has data-open attribute (CSS keys the inline width off it)', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const drawer = container.querySelector('.file-tree-drawer')
    expect(drawer).toBeInTheDocument()
    expect(drawer!.hasAttribute('data-open')).toBe(true)
  })

  it('inspect-layout has data-diffwidth attribute (CSS keys margin-vs-inline off it)', () => {
    const files = makeFiles(['a.ts'])
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null } })
    const layout = container.querySelector('.inspect-layout')
    expect(layout).toBeInTheDocument()
    expect(layout!.hasAttribute('data-diffwidth')).toBe(true)
  })
})
