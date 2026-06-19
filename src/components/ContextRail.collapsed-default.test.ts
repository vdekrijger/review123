/**
 * ContextRail.collapsed-default.test.ts — rail sections start collapsed.
 *
 * User feedback: the context rail auto-expanded sections, eating screen real
 * estate and duplicating the Understand step. New behavior:
 *   • ALL rail sections (registry-driven + Hotspots) default to COLLAPSED.
 *   • A user's expand/collapse choices persist per browser in one
 *     localStorage map (`review123:rail-expanded`, src/lib/rail/collapse.ts).
 *   • section_expanded analytics keep firing on expand (ids only).
 *   • Pending AI state (skeletons) must NOT force a section open.
 *   • The Understand STEP's page panels are unaffected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import ContextRail from './ContextRail.svelte'
import { track } from '../lib/analytics/analytics'
import type { AiRun } from '../lib/ai/run.svelte'
import type { AttentionResult } from '../lib/ai/schemas'
import type { PrMeta, PrFile } from '../lib/github/types'

const KEY = 'review123:rail-expanded'

vi.mock('../lib/analytics/analytics', () => ({
  track: vi.fn(),
  initAnalytics: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg/>' }),
  },
}))

vi.mock('../lib/settings/settings', () => ({
  getSettings: () => ({ treeOpen: false, diffMode: 'unified', diffWidth: 'centered', railCollapsed: false, testFileDisplay: 'normal', aiProvider: 'deepseek' }),
  setTreeOpen: vi.fn(),
  setRailCollapsed: vi.fn(),
  setDiffMode: vi.fn(),
  saveTokens: vi.fn(),
  saveGithubAuth: vi.fn(),
  _registerSettingsRefresh: vi.fn(),
  _registerAuthRefresh: vi.fn(),
}))

vi.mock('../lib/settings/settingsState.svelte', () => ({
  settingsState: { current: { testFileDisplay: 'normal' } },
}))

function makeRun(attn?: AttentionResult): AiRun {
  return {
    summary: { status: 'idle' },
    attention: attn ? { status: 'done', value: attn } : { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    tests: { status: 'idle' },
    alternatives: { status: 'idle' },
    story: { status: 'idle' },
    skillReviews: [],
    totalUsage: undefined,
    verdictModels: [],
    modelPerformance: [],
    modelCostBreakdown: [],
    start: async () => {},
    retry: async () => {},
    coach: async () => ({ error: 'no-key' }),
    ask: async () => ({ ok: false, error: 'no-key' }),
    runSkillReviews: async () => {},
    retrySkill: async () => {},
  }
}

const attn: AttentionResult = {
  readingOrder: [],
  testFlags: [],
  hotspots: [{ path: 'src/hot.ts', reason: 'Critical', level: 'high' }],
}

function renderRail(run: AiRun = makeRun()) {
  return render(ContextRail, {
    props: { run, onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() },
  })
}

function findSection(container: HTMLElement, titleFragment: string): HTMLDetailsElement {
  const section = Array.from(container.querySelectorAll<HTMLDetailsElement>('details.rail-section-details'))
    .find((d) => d.querySelector('summary')?.textContent?.toLowerCase().includes(titleFragment.toLowerCase()))
  expect(section, `rail section "${titleFragment}"`).toBeTruthy()
  return section!
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Default: every rail section collapsed
// ---------------------------------------------------------------------------

describe('ContextRail — all sections default to collapsed', () => {
  it('no rail section is open on first render (nothing stored)', () => {
    const { container } = renderRail()
    const sections = container.querySelectorAll('details.rail-section-details')
    expect(sections.length).toBeGreaterThan(0)
    expect(container.querySelectorAll('details.rail-section-details[open]')).toHaveLength(0)
  })

  it('the Summary section (formerly defaultOpen in rail) starts collapsed', () => {
    const { container } = renderRail()
    expect(findSection(container, 'full summary').open).toBe(false)
  })

  it('the Hotspots section starts collapsed even when attention data is available', () => {
    const { container } = renderRail(makeRun(attn))
    const hotspots = findSection(container, 'hotspots')
    expect(hotspots.open).toBe(false)
    // The hotspot buttons exist inside the closed section (shown on expand)
    expect(hotspots.querySelector('.hotspot-btn')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pending AI state must not force sections open (skeletons render collapsed)
// ---------------------------------------------------------------------------

describe('ContextRail — pending AI state does not force sections open', () => {
  it('Hotspots pending skeleton section is NOT forced open', () => {
    const { container } = renderRail() // attention idle → pending variant
    const pending = container.querySelector<HTMLDetailsElement>('details.rail-hotspots-pending')
    expect(pending).not.toBeNull()
    expect(pending!.open).toBe(false)
    // skeleton is inside the section body, revealed only when expanded
    expect(pending!.querySelector('.skeleton-block')).not.toBeNull()
  })

  it('sections with pending AI skeletons (summary idle) stay collapsed', () => {
    const { container } = renderRail()
    const summary = findSection(container, 'full summary')
    expect(summary.open).toBe(false)
    expect(summary.querySelector('.ai-panel-loading .skeleton-block')).not.toBeNull()
  })

  it('expanding the pending Hotspots section persists under the "hotspots" id', () => {
    const { container } = renderRail()
    const pending = container.querySelector<HTMLDetailsElement>('details.rail-hotspots-pending')!
    pending.open = true
    pending.dispatchEvent(new Event('toggle'))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ hotspots: true })
  })
})

// ---------------------------------------------------------------------------
// Persistence: expand/collapse choices survive re-mounts via localStorage
// ---------------------------------------------------------------------------

describe('ContextRail — expand/collapse persistence', () => {
  it('expanding a section writes { [id]: true } to the rail-expanded map', () => {
    const { container } = renderRail()
    const diagrams = findSection(container, 'change impact')
    diagrams.open = true
    diagrams.dispatchEvent(new Event('toggle'))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ diagrams: true })
  })

  it('collapsing a previously expanded section writes { [id]: false }', () => {
    localStorage.setItem(KEY, JSON.stringify({ summary: true }))
    const { container } = renderRail()
    const summary = findSection(container, 'full summary')
    summary.open = false
    summary.dispatchEvent(new Event('toggle'))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ summary: false })
  })

  it('stored expanded sections are restored open on render', () => {
    localStorage.setItem(KEY, JSON.stringify({ summary: true, 'ci-details': true }))
    const { container } = renderRail()
    expect(findSection(container, 'full summary').open).toBe(true)
    expect(findSection(container, 'ci details').open).toBe(true)
    // unmentioned sections stay collapsed
    expect(findSection(container, 'change impact').open).toBe(false)
  })

  it('stored Hotspots expansion restores the section open (done variant)', () => {
    localStorage.setItem(KEY, JSON.stringify({ hotspots: true }))
    const { container } = renderRail(makeRun(attn))
    expect(findSection(container, 'hotspots').open).toBe(true)
  })

  it('multiple sections accumulate in ONE localStorage map', () => {
    const { container } = renderRail()
    for (const title of ['change impact', 'test coverage', 'alternative']) {
      const section = findSection(container, title)
      section.open = true
      section.dispatchEvent(new Event('toggle'))
    }
    const map = JSON.parse(localStorage.getItem(KEY)!)
    expect(map).toMatchObject({ diagrams: true, 'test-insight': true, alternatives: true })
  })
})

// ---------------------------------------------------------------------------
// Analytics: section_expanded keeps firing on expand (ids only)
// ---------------------------------------------------------------------------

describe('ContextRail — section_expanded analytics unchanged', () => {
  it('fires section_expanded with the section id when expanded', () => {
    const { container } = renderRail()
    const diagrams = findSection(container, 'change impact')
    diagrams.open = true
    diagrams.dispatchEvent(new Event('toggle'))
    expect(vi.mocked(track)).toHaveBeenCalledWith('section_expanded', { section: 'diagrams', surface: 'rail' })
  })

  it('does NOT fire section_expanded on collapse', () => {
    localStorage.setItem(KEY, JSON.stringify({ diagrams: true }))
    const { container } = renderRail()
    vi.mocked(track).mockClear()
    const diagrams = findSection(container, 'change impact')
    diagrams.open = false
    diagrams.dispatchEvent(new Event('toggle'))
    const calls = vi.mocked(track).mock.calls.filter((c) => c[0] === 'section_expanded')
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Understand step is UNCHANGED — page panels ignore the rail-expanded map
// ---------------------------------------------------------------------------

const meta: PrMeta = {
  title: 'Test PR',
  state: 'open',
  merged: false,
  body: null,
  baseSha: 'base',
  headSha: 'head',
  private: false,
  changedFiles: 1,
  authorLogin: null,
}

const files: PrFile[] = [
  { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2 },
]

describe('UnderstandStep — page panels unaffected by rail collapse change', () => {
  it('page panels keep their registry defaultOpen.page behavior (all start closed)', async () => {
    const { default: UnderstandStep } = await import('./UnderstandStep.svelte')
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun() } })
    const panels = document.querySelectorAll('details.detail-panel')
    expect(panels.length).toBeGreaterThan(0)
    expect(document.querySelectorAll('details.detail-panel[open]')).toHaveLength(0)
  })

  it('rail-expanded map does NOT open page panels', async () => {
    localStorage.setItem(KEY, JSON.stringify({ summary: true, diagrams: true }))
    const { default: UnderstandStep } = await import('./UnderstandStep.svelte')
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun() } })
    expect(document.querySelectorAll('details.detail-panel[open]')).toHaveLength(0)
  })

  it('toggling a page panel does NOT write to the rail-expanded map', async () => {
    const { default: UnderstandStep } = await import('./UnderstandStep.svelte')
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun() } })
    const summaryPanel = Array.from(document.querySelectorAll<HTMLDetailsElement>('details.detail-panel'))
      .find((d) => d.querySelector('summary')?.textContent?.match(/full summary/i))!
    summaryPanel.open = true
    summaryPanel.dispatchEvent(new Event('toggle'))
    expect(localStorage.getItem(KEY)).toBeNull()
    // page analytics unchanged too
    expect(vi.mocked(track)).toHaveBeenCalledWith('section_expanded', { section: 'summary', surface: 'page' })
  })
})
