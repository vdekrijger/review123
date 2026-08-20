/**
 * engagement-analytics.test.ts — component-level wiring tests.
 *
 * Verifies that the engagement events fire with exactly the right props when
 * UI interactions happen, and that closes do NOT fire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { track } from '../lib/analytics/analytics'
import type { AiRun } from '../lib/ai/run.svelte'
import type { PrMeta, PrFile } from '../lib/github/types'

// ---- Mocks ----

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
  getSettings: () => ({ treeOpen: false, diffMode: 'unified', diffWidth: 'centered', railCollapsed: false, testFileDisplay: 'normal' }),
  setTreeOpen: vi.fn(),
  setRailCollapsed: vi.fn(),
  setDiffMode: vi.fn(),
  saveTokens: vi.fn(),
  saveGithubAuth: vi.fn(),
}))

vi.mock('../lib/settings/settingsState.svelte', () => ({
  settingsState: {
    current: {
      testFileDisplay: 'normal',
      // Plan J: InspectStep reads aiTaskModes.skills for the reviewers gate.
      aiTaskModes: {
        summary: 'standard', attention: 'standard', diagrams: 'standard',
        tests: 'standard', alternatives: 'standard', verdict: 'standard', skills: 'standard',
      },
    },
  },
}))

// ---- Helpers ----

function makeRun(): AiRun {
  return {
    summary: { status: 'idle' },
    attention: { status: 'idle' },
    diagrams: { status: 'idle' },
    verdict: { status: 'idle' },
    tests: { status: 'idle' },
    alternatives: { status: 'idle' },
    story: { status: 'idle' },
    riskJudge: { status: 'idle' },
    skillReviews: [],
    convergence: { status: 'idle' },
    simplify: { status: 'idle' },
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

// ============================================================================
// UnderstandStep — section_expanded with surface:'page'
// ============================================================================

describe('UnderstandStep — section_expanded (surface: page)', () => {
  beforeEach(() => { vi.mocked(track).mockClear() })

  it('fires section_expanded with surface:page when a detail panel is opened', async () => {
    const { default: UnderstandStep } = await import('./UnderstandStep.svelte')
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun() } })

    // Find the "Full summary" details panel and open it
    const detailsPanels = document.querySelectorAll('details.detail-panel')
    const summaryPanel = Array.from(detailsPanels).find(
      (d) => d.querySelector('summary')?.textContent?.match(/full summary/i)
    ) as HTMLDetailsElement
    expect(summaryPanel).toBeTruthy()

    // Simulate toggle (open)
    summaryPanel.open = true
    summaryPanel.dispatchEvent(new Event('toggle'))

    expect(vi.mocked(track)).toHaveBeenCalledWith('section_expanded', { section: 'summary', surface: 'page' })
  })

  it('does NOT fire section_expanded when a detail panel is closed', async () => {
    const { default: UnderstandStep } = await import('./UnderstandStep.svelte')
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun() } })

    const detailsPanels = document.querySelectorAll('details.detail-panel')
    const summaryPanel = Array.from(detailsPanels).find(
      (d) => d.querySelector('summary')?.textContent?.match(/full summary/i)
    ) as HTMLDetailsElement

    // Open it first (fires once)
    summaryPanel.open = true
    summaryPanel.dispatchEvent(new Event('toggle'))
    vi.mocked(track).mockClear()

    // Now close it — should NOT fire again
    summaryPanel.open = false
    summaryPanel.dispatchEvent(new Event('toggle'))

    const sectionExpandedCalls = vi.mocked(track).mock.calls.filter(
      (c) => c[0] === 'section_expanded'
    )
    expect(sectionExpandedCalls.length).toBe(0)
  })

  it('debounces duplicates: fires section_expanded only once per section per mount', async () => {
    const { default: UnderstandStep } = await import('./UnderstandStep.svelte')
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun() } })

    const detailsPanels = document.querySelectorAll('details.detail-panel')
    const summaryPanel = Array.from(detailsPanels).find(
      (d) => d.querySelector('summary')?.textContent?.match(/full summary/i)
    ) as HTMLDetailsElement

    // Open, close, re-open — should only track once
    summaryPanel.open = true
    summaryPanel.dispatchEvent(new Event('toggle'))
    summaryPanel.open = false
    summaryPanel.dispatchEvent(new Event('toggle'))
    summaryPanel.open = true
    summaryPanel.dispatchEvent(new Event('toggle'))

    const sectionExpandedCalls = vi.mocked(track).mock.calls.filter(
      (c) => c[0] === 'section_expanded' && (c[1] as { section: string }).section === 'summary'
    )
    expect(sectionExpandedCalls.length).toBe(1)
  })

  it('fires section_expanded with correct section id for diagrams panel', async () => {
    const { default: UnderstandStep } = await import('./UnderstandStep.svelte')
    render(UnderstandStep, { props: { meta, files, ci: null, ciError: false, run: makeRun() } })

    const detailsPanels = document.querySelectorAll('details.detail-panel')
    const diagramsPanel = Array.from(detailsPanels).find(
      (d) => d.querySelector('summary')?.textContent?.match(/change impact/i)
    ) as HTMLDetailsElement
    expect(diagramsPanel).toBeTruthy()

    diagramsPanel.open = true
    diagramsPanel.dispatchEvent(new Event('toggle'))

    expect(vi.mocked(track)).toHaveBeenCalledWith('section_expanded', { section: 'diagrams', surface: 'page' })
  })
})

// ============================================================================
// ContextRail — section_expanded (surface: rail) and rail_expanded
// ============================================================================

describe('ContextRail — section_expanded (surface: rail)', () => {
  beforeEach(() => { vi.mocked(track).mockClear() })

  it('fires section_expanded with surface:rail when a rail section is opened', async () => {
    const { default: ContextRail } = await import('./ContextRail.svelte')
    render(ContextRail, { props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() } })

    const railSections = document.querySelectorAll('details.rail-section-details')
    // Find a section that is closed by default to trigger a real open event
    const closedSection = Array.from(railSections).find(
      (d) => !(d as HTMLDetailsElement).open
    ) as HTMLDetailsElement
    expect(closedSection).toBeTruthy()

    closedSection.open = true
    closedSection.dispatchEvent(new Event('toggle'))

    const calls = vi.mocked(track).mock.calls.filter((c) => c[0] === 'section_expanded')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0][1]).toMatchObject({ surface: 'rail' })
  })

  it('does NOT fire section_expanded on close', async () => {
    const { default: ContextRail } = await import('./ContextRail.svelte')
    render(ContextRail, { props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() } })

    const railSections = document.querySelectorAll('details.rail-section-details')
    const closedSection = Array.from(railSections).find(
      (d) => !(d as HTMLDetailsElement).open
    ) as HTMLDetailsElement

    // Open it
    closedSection.open = true
    closedSection.dispatchEvent(new Event('toggle'))
    vi.mocked(track).mockClear()

    // Close it — should not re-fire
    closedSection.open = false
    closedSection.dispatchEvent(new Event('toggle'))

    const calls = vi.mocked(track).mock.calls.filter((c) => c[0] === 'section_expanded')
    expect(calls.length).toBe(0)
  })

  it('debounces: fires section_expanded only once per section per mount in rail', async () => {
    const { default: ContextRail } = await import('./ContextRail.svelte')
    render(ContextRail, { props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse: vi.fn() } })

    const railSections = document.querySelectorAll('details.rail-section-details')
    const closedSection = Array.from(railSections).find(
      (d) => !(d as HTMLDetailsElement).open
    ) as HTMLDetailsElement

    const sectionId = closedSection.querySelector('summary')?.textContent?.toLowerCase()

    // Open, close, re-open
    closedSection.open = true
    closedSection.dispatchEvent(new Event('toggle'))
    closedSection.open = false
    closedSection.dispatchEvent(new Event('toggle'))
    closedSection.open = true
    closedSection.dispatchEvent(new Event('toggle'))

    const calls = vi.mocked(track).mock.calls.filter(
      (c) => c[0] === 'section_expanded' && (c[1] as { surface: string }).surface === 'rail'
    )
    // The specific section should have been tracked once
    expect(calls.length).toBe(1)
    void sectionId // used for contextual labeling only
  })
})

describe('ContextRail — rail_expanded', () => {
  beforeEach(() => { vi.mocked(track).mockClear() })

  it('fires rail_expanded when collapse button expands the rail', async () => {
    const { default: ContextRail } = await import('./ContextRail.svelte')
    const oncollapse = vi.fn()
    render(ContextRail, { props: { run: makeRun(), onhotspot: vi.fn(), collapsed: true, oncollapse } })

    // Click the expand button (aria-label: 'Expand context rail')
    const btn = document.querySelector('button.collapse-btn') as HTMLButtonElement
    btn.click()

    expect(vi.mocked(track)).toHaveBeenCalledWith('rail_expanded')
  })

  it('does NOT fire rail_expanded when the rail is being collapsed', async () => {
    const { default: ContextRail } = await import('./ContextRail.svelte')
    const oncollapse = vi.fn()
    render(ContextRail, { props: { run: makeRun(), onhotspot: vi.fn(), collapsed: false, oncollapse } })

    // Clicking the button when expanded → collapses it
    const btn = document.querySelector('button.collapse-btn') as HTMLButtonElement
    btn.click()

    expect(vi.mocked(track)).not.toHaveBeenCalledWith('rail_expanded')
  })
})

// ============================================================================
// FileDiff — file_expanded
// ============================================================================

describe('FileDiff — file_expanded', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear()
    // Canvas stub for DiffView
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
      writable: true,
    })
  })

  it('fires file_expanded with origin:viewed when header is clicked to expand a viewed file', async () => {
    const { default: FileDiff } = await import('./FileDiff.svelte')
    const file: PrFile = { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2 }
    render(FileDiff, { props: { file, mode: 'unified', viewed: true } })

    // File is collapsed because viewed=true
    const article = document.querySelector('article.file-diff') as HTMLElement
    expect(article.classList.contains('is-collapsed')).toBe(true)

    // Click the header to expand
    const header = article.querySelector('header') as HTMLElement
    header.click()

    expect(vi.mocked(track)).toHaveBeenCalledWith('file_expanded', { origin: 'viewed' })
  })

  it('does NOT fire file_expanded when clicking header of an already-expanded file', async () => {
    const { default: FileDiff } = await import('./FileDiff.svelte')
    const file: PrFile = { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2 }
    render(FileDiff, { props: { file, mode: 'unified', viewed: false } })

    // File is not collapsed — clicking header should not fire
    const header = document.querySelector('header') as HTMLElement
    header.click()

    const calls = vi.mocked(track).mock.calls.filter((c) => c[0] === 'file_expanded')
    expect(calls.length).toBe(0)
  })
})

// ============================================================================
// InspectStep — drawer_opened
// ============================================================================

describe('InspectStep — drawer_opened', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear()
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
      writable: true,
    })
  })

  it('fires drawer_opened when the file tree toggle is clicked to open', async () => {
    const { default: InspectStep } = await import('./InspectStep.svelte')
    render(InspectStep, {
      props: {
        files,
        changedFiles: 1,
        mode: 'unified',
        onmode: vi.fn(),
        draftStore: null,
      },
    })

    // The toggle tab button opens the tree drawer
    const toggleBtn = document.querySelector('button.tree-toggle-tab') as HTMLButtonElement
    expect(toggleBtn).toBeTruthy()
    toggleBtn.click()

    expect(vi.mocked(track)).toHaveBeenCalledWith('drawer_opened')
  })

  it('does NOT fire drawer_opened when the drawer is being closed', async () => {
    const { default: InspectStep } = await import('./InspectStep.svelte')
    render(InspectStep, {
      props: {
        files,
        changedFiles: 1,
        mode: 'unified',
        onmode: vi.fn(),
        draftStore: null,
      },
    })

    // Open it first
    const toggleBtn = document.querySelector('button.tree-toggle-tab') as HTMLButtonElement
    toggleBtn.click()
    vi.mocked(track).mockClear()

    // Close it — should NOT fire drawer_opened
    toggleBtn.click()

    const calls = vi.mocked(track).mock.calls.filter((c) => c[0] === 'drawer_opened')
    expect(calls.length).toBe(0)
  })
})
