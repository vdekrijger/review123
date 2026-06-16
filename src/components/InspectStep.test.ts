import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { AttentionResult } from '../lib/ai/schemas'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import { createViewedStore } from '../lib/viewed/viewed.svelte'
import { createDraftStore } from '../lib/drafts/drafts.svelte'
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

// ---------------------------------------------------------------------------
// InspectStep — reviewer chip → finding navigation (uniform popover)
// Clicking a reviewer's done result chip (or its suggestion summary chip):
//   • ANY finding count (1 or N) → opens a popover listing each finding
//                  (file:line + title); clicking an entry jumps to it. A
//                  single-finding chip NO LONGER yanks the user to the diff.
//   • error chip → keeps retry semantics (never a finding jump)
// ---------------------------------------------------------------------------

import { fireEvent } from '@testing-library/svelte'
import * as jumpToFileMod from '../lib/diff/jumpToFile'
import { vi } from 'vitest'

describe('InspectStep — reviewer chip → finding navigation', () => {
  const skillId = 'rev-x'
  const reviewerName = 'PostHog Observability Reviewer'

  const reviewEntry = (findings: { path: string; line: number | null; body: string; severity?: 'high' | 'medium' | 'low' }[]): SkillReviewEntry => ({
    skillId,
    name: reviewerName,
    state: {
      status: 'done',
      value: {
        skillName: reviewerName,
        findings: findings.map(f => ({ path: f.path, line: f.line, body: f.body, severity: f.severity ?? 'medium' })),
      },
    },
  })

  // The key SkillFindingCard emits / jumpToFinding targets (mirrors InspectStep).
  const keyOf = (path: string, line: number | null, body: string) => `${skillId}:${path}:${line}:${body.slice(0, 30)}`

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('single-finding chip opens a popover (does NOT jump); clicking the entry jumps', async () => {
    const spy = vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    const body = 'Missing capture() on this path'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: 12, body }])]
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })

    expect(container.querySelector('.findings-popover')).toBeNull()
    const chip = screen.getByRole('button', { name: `Show 1 finding from ${reviewerName}` })
    await fireEvent.click(chip)

    // Clicking the chip opens the popover — it never yanks the user to the diff.
    expect(spy).not.toHaveBeenCalled()
    const menu = container.querySelector('.findings-popover[role="menu"]')
    expect(menu).not.toBeNull()
    const items = menu!.querySelectorAll('[role="menuitem"]')
    expect(items).toHaveLength(1)
    expect(items[0].textContent).toContain('a.ts:12')
    expect(items[0].textContent).toContain('Missing capture()')

    // Jumping happens only when the user clicks the popover entry.
    await fireEvent.click(items[0] as HTMLElement)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('a.ts', keyOf('a.ts', 12, body))
  })

  it('single-finding chip popover gets focus management (first entry focused)', async () => {
    vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    const body = 'A single finding'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: 4, body }])]
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })

    await fireEvent.click(screen.getByRole('button', { name: `Show 1 finding from ${reviewerName}` }))
    const menu = container.querySelector('.findings-popover[role="menu"]')!
    expect(menu).not.toBeNull()
    // aria-haspopup/aria-expanded present even for a single-finding chip.
    const chip = container.querySelector('[data-reviewer-chip="result:rev-x"]')!
    expect(chip.getAttribute('aria-haspopup')).toBe('menu')
    expect(chip.getAttribute('aria-expanded')).toBe('true')
  })

  it('multi-finding chip opens a popover with N entries; clicking one jumps to its location', async () => {
    const spy = vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts', 'b.ts'])
    const b1 = 'First issue here'
    const b2 = 'Second issue over there'
    const skillReviews = [reviewEntry([
      { path: 'a.ts', line: 3, body: b1 },
      { path: 'b.ts', line: 9, body: b2 },
    ])]
    const { container } = render(InspectStep, { props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })

    expect(container.querySelector('.findings-popover')).toBeNull()
    const chip = screen.getByRole('button', { name: `Show 2 findings from ${reviewerName}` })
    await fireEvent.click(chip)

    const menu = container.querySelector('.findings-popover[role="menu"]')
    expect(menu).not.toBeNull()
    const items = menu!.querySelectorAll('[role="menuitem"]')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('a.ts:3')
    expect(items[0].textContent).toContain('First issue here')
    expect(items[1].textContent).toContain('b.ts:9')

    await fireEvent.click(items[1] as HTMLElement)
    expect(spy).toHaveBeenCalledWith('b.ts', keyOf('b.ts', 9, b2))
  })

  it('unanchorable finding (null line) still produces a jump entry', async () => {
    const spy = vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    const offDiff = 'Whole-file concern'
    const anchored = 'On a real line'
    const skillReviews = [reviewEntry([
      { path: 'a.ts', line: null, body: offDiff },
      { path: 'a.ts', line: 5, body: anchored },
    ])]
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })

    const chip = screen.getByRole('button', { name: `Show 2 findings from ${reviewerName}` })
    await fireEvent.click(chip)
    const menu = container.querySelector('.findings-popover')!
    const items = menu.querySelectorAll('[role="menuitem"]')
    const entry = [...items].find(i => i.textContent?.includes('Whole-file concern'))!
    expect(entry).toBeTruthy()
    await fireEvent.click(entry as HTMLElement)
    // null-line finding still jumps to its (fallback) location — not a dead link.
    expect(spy).toHaveBeenCalledWith('a.ts', keyOf('a.ts', null, offDiff))
  })

  it('popover is keyboard accessible: Escape closes it', async () => {
    vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts', 'b.ts'])
    const skillReviews = [reviewEntry([
      { path: 'a.ts', line: 3, body: 'one' },
      { path: 'b.ts', line: 9, body: 'two' },
    ])]
    const { container } = render(InspectStep, { props: { files, changedFiles: 2, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })

    await fireEvent.click(screen.getByRole('button', { name: `Show 2 findings from ${reviewerName}` }))
    const menu = container.querySelector('.findings-popover[role="menu"]')!
    expect(menu).not.toBeNull()
    await fireEvent.keyDown(menu, { key: 'Escape' })
    expect(container.querySelector('.findings-popover')).toBeNull()
  })

  it('error chip keeps its retry semantics — NOT a finding jump', () => {
    const spy = vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    const errored: SkillReviewEntry = {
      skillId, name: reviewerName, state: { status: 'error', error: 'boom' },
    }
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews: [errored] } })
    // No nav button for an error chip; the error chip is its own (non-jump) chip.
    expect(screen.queryByRole('button', { name: new RegExp(`Show .* from ${reviewerName}`) })).toBeNull()
    expect(container.querySelector('.chip-error')).not.toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('suggestion summary chip mirrors result chip — single finding opens a popover (uniform)', async () => {
    const spy = vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    const body = 'a suggestion'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: 7, body }])]
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })

    const summary = screen.getByRole('button', { name: `Show 1 suggestion from ${reviewerName}` })
    await fireEvent.click(summary)
    // Uniform: a single-suggestion summary chip opens a popover, it does NOT jump.
    expect(spy).not.toHaveBeenCalled()
    const menu = container.querySelector('.findings-popover[role="menu"]')
    expect(menu).not.toBeNull()
    const items = menu!.querySelectorAll('[role="menuitem"]')
    expect(items).toHaveLength(1)
    await fireEvent.click(items[0] as HTMLElement)
    expect(spy).toHaveBeenCalledWith('a.ts', keyOf('a.ts', 7, body))
  })

  it('null-line finding lives in the popover (no separate bottom card) and jumps to its key', async () => {
    const spy = vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    const body = 'a finding on a null line'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: null, body }])]
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })
    // The "bottom" file-level card is gone — the finding lives in the chip popover.
    expect(container.querySelector('.file-level-finding')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: `Show 1 finding from ${reviewerName}` }))
    const item = container.querySelector('.findings-popover [role="menuitem"]') as HTMLElement
    expect(item).not.toBeNull()
    expect(item.textContent).toContain('a finding on a null line')
    await fireEvent.click(item)
    expect(spy).toHaveBeenCalledWith('a.ts', keyOf('a.ts', null, body))
  })

  it('renders the full finding body as markdown in the popover (code spans, not truncated)', async () => {
    vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    // Backticked token + a long body that the old 120-char title would have cut.
    const body = 'Guard `triggered_metadata.breaching_rows` before indexing — ' +
      'this is a deliberately long finding body that exceeds one hundred and twenty characters so truncation would be visible if it happened.'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: 4, body }])]
    const { container } = render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })
    await fireEvent.click(screen.getByRole('button', { name: `Show 1 finding from ${reviewerName}` }))
    const bodyEl = container.querySelector('.findings-popover-body')!
    expect(bodyEl).not.toBeNull()
    // Backticked token rendered as <code>, NOT literal backticks.
    const code = bodyEl.querySelector('code')
    expect(code).not.toBeNull()
    expect(code!.textContent).toBe('triggered_metadata.breaching_rows')
    expect(bodyEl.innerHTML).not.toContain('`')
    // Full body shown — the tail past 120 chars is present (not truncated).
    expect(bodyEl.textContent).toContain('if it happened.')
  })

  it('Add-as-draft from a popover entry upserts a draft and hides the finding', async () => {
    vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const store = createDraftStore('testorg/testrepo#1@sha-popover', `review123-popover-add-${Date.now()}`)
    const upsert = vi.spyOn(store, 'upsert')
    const files = makeFiles(['a.ts'])
    const body = 'Add me as a draft'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: null, body }])]
    render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: store, skillReviews } })
    await fireEvent.click(screen.getByRole('button', { name: `Show 1 finding from ${reviewerName}` }))
    await fireEvent.click(screen.getByRole('button', { name: 'Add as draft comment' }))
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', body }))
    // Added-as-draft hides the finding → the chip no longer reports it.
    expect(screen.queryByRole('button', { name: `Show 1 finding from ${reviewerName}` })).toBeNull()
  })

  it('Dismiss from a popover entry hides the finding (records the decision)', async () => {
    vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    const body = 'Dismiss me'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: null, body }])]
    render(InspectStep, { props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews } })
    await fireEvent.click(screen.getByRole('button', { name: `Show 1 finding from ${reviewerName}` }))
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss finding' }))
    expect(screen.queryByRole('button', { name: `Show 1 finding from ${reviewerName}` })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// InspectStep — demoted + file-level findings visible in BOTH modes
// Regression for: a reviewer chip counts N findings, but demoted (cross-model)
// and file-level (null-line) findings render nowhere in Story mode and hide in
// a collapsed group in Files mode — so chip navigation lands on nothing. The fix
// renders EVERY counted finding as a visible card in both modes.
// ---------------------------------------------------------------------------

describe('InspectStep — demoted + file-level findings visible in both modes', () => {
  const skillId = 'rev-demoted'
  const reviewerName = 'Pragmatic Reviewer'

  const demotedVerification = (confirmedBy: number, polledModels: number) => ({
    confirmedBy,
    polledModels,
    surfaced: false,
    perModel: [],
  })

  const keyOf = (path: string, line: number | null, body: string) => `${skillId}:${path}:${line}:${body.slice(0, 30)}`

  const reviewEntry = (
    findings: { path: string; line: number | null; body: string; severity?: 'high' | 'medium' | 'low'; verification?: ReturnType<typeof demotedVerification> }[],
  ): SkillReviewEntry => ({
    skillId,
    name: reviewerName,
    state: {
      status: 'done',
      value: {
        skillName: reviewerName,
        findings: findings.map(f => ({
          path: f.path,
          line: f.line,
          body: f.body,
          severity: f.severity ?? 'medium',
          ...(f.verification ? { verification: f.verification } : {}),
        })),
      },
    },
  })

  beforeEach(() => {
    _resetSettingsStateForTest()
  })

  it('a demoted line-anchored finding renders inline (no collapsed lower-confidence group)', () => {
    const files = makeFiles(['a.ts'])
    const body = 'Possible race condition here'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: 1, body, verification: demotedVerification(1, 3) }])]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews },
    })

    // The retired collapsed group must be gone.
    expect(container.querySelector('.lower-confidence-group')).toBeNull()

    // The finding renders as a visible card with the matching jump-target key,
    // dimmed with the lower-confidence badge.
    const card = container.querySelector(`[data-finding-key="${keyOf('a.ts', 1, body)}"]`)
    expect(card).not.toBeNull()
    expect(card!.classList.contains('lower-confidence')).toBe(true)
    expect(card!.querySelector('.skill-lower-confidence-chip')?.textContent).toContain('flagged by 1/3')
  })

  it('a demoted null-line finding is reachable via the chip popover (no bottom card)', async () => {
    vi.spyOn(jumpToFileMod, 'jumpToFinding').mockImplementation(() => {})
    const files = makeFiles(['a.ts'])
    const body = 'Whole-file concern (demoted)'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: null, body, verification: demotedVerification(1, 2) }])]
    const { container } = render(InspectStep, {
      props: { files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews },
    })
    // No separate bottom card — the (demoted, null-line) finding lives in the popover.
    expect(container.querySelector('.file-level-finding')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: `Show 1 finding from ${reviewerName}` }))
    const item = container.querySelector('.findings-popover [role="menuitem"]')!
    expect(item.textContent).toContain('Whole-file concern (demoted)')
  })

  it('Story mode renders file-level (null-line) findings with their jump-target key', () => {
    const files = makeFiles(['a.ts'])
    const body = 'A whole-file note shown in story mode'
    const skillReviews = [reviewEntry([{ path: 'a.ts', line: null, body }])]
    const story = { steps: [{ index: 0, files: ['a.ts'], caption: 'The file', layer: 'logic' as const, relatedTests: [] }] }
    const { container } = render(InspectStep, {
      props: {
        files, changedFiles: 1, mode: 'unified', onmode: () => {}, draftStore: null, skillReviews,
        storyAvailable: true, storyMode: true, story, storyStatus: 'done' as const,
      },
    })
    // We're in story mode (the slideshow rendered, not the files layout).
    expect(container.querySelector('.story')).not.toBeNull()
    // The file-level finding has a visible card carrying the jump-target key.
    const card = container.querySelector(`[data-finding-key="${keyOf('a.ts', null, body)}"]`)
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('A whole-file note shown in story mode')
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
