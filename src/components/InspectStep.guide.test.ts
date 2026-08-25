/**
 * InspectStep — risk-guided flow (deterministic; Files mode only).
 *
 * Covers:
 *   - the Narrative | Risk first sort control renders in Files mode only
 *   - Narrative (default) keeps the current order (generated sink included),
 *     shows NO tail
 *   - Risk first orders attention files highest-risk first (path tie-break)
 *     and collapses mechanical files into the low-attention tail
 *   - the choice persists per-browser (localStorage review123:inspect-sort)
 *   - tail grouping: count, reason summary, findings-carrying file NEVER in
 *     the tail
 *   - "Mark all N viewed" marks tail files; a manual un-view sticks on
 *     repeat clicks (bulk-marked-once guard)
 *   - the progress line: "M of N attention files reviewed"
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import { tick } from 'svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { SkillReviewEntry } from '../lib/ai/run.svelte'
import { createViewedStore } from '../lib/viewed/viewed.svelte'

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

function makeFile(filename: string, overrides: Partial<PrFile> = {}): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH, ...overrides }
}

/**
 * Fixture mix (deterministic per-file risk, src/lib/risk/computeFileRisk):
 *   src/auth/big.ts  added +400, sensitive path → HIGH   (novel)
 *   src/mid.ts       modified +320               → MEDIUM (novel)
 *   src/app.ts       modified +5                 → LOW    (novel)
 *   pnpm-lock.yaml   lockfile                    → mechanical (tail)
 *   src/util.test.ts tests-only                  → mechanical (tail)
 */
function makeMixedFiles(): PrFile[] {
  return [
    makeFile('src/app.ts', { additions: 5 }),
    makeFile('pnpm-lock.yaml', { additions: 40 }),
    makeFile('src/auth/big.ts', { status: 'added', additions: 400 }),
    makeFile('src/mid.ts', { additions: 320 }),
    makeFile('src/util.test.ts', { additions: 12 }),
  ]
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    files: makeMixedFiles(),
    changedFiles: 5,
    mode: 'unified' as const,
    onmode: () => {},
    draftStore: null,
    ...overrides,
  }
}

/** Ids of the MAIN list's cards (direct children of the diff column — tail cards are nested). */
function mainCardIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.diff-column > [id^="file-"]')].map((el) => el.id)
}

function tailCardIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.attention-tail [id^="file-"]')].map((el) => el.id)
}

describe('InspectStep — sort control (Files mode only)', () => {
  it('renders Narrative | Risk first with Narrative active by default', () => {
    render(InspectStep, { props: baseProps() })
    const group = screen.getByRole('group', { name: 'File order' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Narrative' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Risk first' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('does NOT render the sort control in Story mode (story untouched)', () => {
    render(InspectStep, {
      props: baseProps({
        storyAvailable: true,
        storyMode: true,
        storyStatus: 'done',
        story: { steps: [{ index: 0, files: ['src/app.ts'], caption: 'App.', layer: 'ui', relatedTests: [] }] },
      }),
    })
    expect(screen.queryByRole('group', { name: 'File order' })).not.toBeInTheDocument()
  })
})

describe('InspectStep — Narrative (default) order unchanged', () => {
  it('keeps the current order with the generated sink, and shows no tail', () => {
    const { container } = render(InspectStep, { props: baseProps() })
    expect(mainCardIds(container)).toEqual([
      'file-src-app-ts',
      'file-src-auth-big-ts',
      'file-src-mid-ts',
      'file-src-util-test-ts',
      'file-pnpm-lock-yaml', // generated sink: lockfile last, order otherwise untouched
    ])
    expect(container.querySelector('.attention-tail')).toBeNull()
  })
})

describe('InspectStep — Risk first ordering + tail', () => {
  it('orders attention files highest-risk first and collapses mechanical files into the tail', async () => {
    const { container } = render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: 'Risk first' }))

    // Main list: high → medium → low (deterministic).
    expect(mainCardIds(container)).toEqual(['file-src-auth-big-ts', 'file-src-mid-ts', 'file-src-app-ts'])

    // Tail: collapsed details with count + reason summary; path-sorted files.
    const tail = container.querySelector('details.attention-tail') as HTMLDetailsElement
    expect(tail).not.toBeNull()
    expect(tail.open).toBe(false)
    expect(tail.textContent).toContain('2 low-attention files — skim or mark all viewed')
    expect(tail.textContent).toContain('1 lockfile')
    expect(tail.textContent).toContain('1 tests only')
    expect(tailCardIds(container)).toEqual(['file-pnpm-lock-yaml', 'file-src-util-test-ts'])
  })

  it('tie-breaks equal-risk files by path (stable + deterministic)', async () => {
    const files = [makeFile('src/z.ts', { additions: 5 }), makeFile('src/a.ts', { additions: 5 })]
    const { container } = render(InspectStep, { props: baseProps({ files, changedFiles: 2 }) })
    await fireEvent.click(screen.getByRole('button', { name: 'Risk first' }))
    expect(mainCardIds(container)).toEqual(['file-src-a-ts', 'file-src-z-ts'])
  })

  it('persists the choice per-browser and restores it on a fresh render', async () => {
    const first = render(InspectStep, { props: baseProps() })
    await fireEvent.click(screen.getByRole('button', { name: 'Risk first' }))
    expect(JSON.parse(localStorage.getItem('review123:inspect-sort')!)).toEqual({ order: 'risk' })
    first.unmount()

    const { container } = render(InspectStep, { props: baseProps() })
    expect(screen.getByRole('button', { name: 'Risk first' }).getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.attention-tail')).not.toBeNull()
  })

  it('a findings-carrying mechanical-shaped file is NEVER in the tail', async () => {
    const skillReviews: SkillReviewEntry[] = [
      {
        skillId: 'skill-sec',
        name: 'Security Reviewer',
        state: {
          status: 'done',
          value: {
            skillName: 'Security Reviewer',
            findings: [{ path: 'pnpm-lock.yaml', line: null, severity: 'medium', body: 'Suspicious dependency pin' }],
          },
        },
      } as SkillReviewEntry,
    ]
    const { container } = render(InspectStep, { props: baseProps({ skillReviews }) })
    await fireEvent.click(screen.getByRole('button', { name: 'Risk first' }))

    // The lockfile carries a finding → surfaced in the MAIN list, not buried.
    expect(mainCardIds(container)).toContain('file-pnpm-lock-yaml')
    expect(tailCardIds(container)).toEqual(['file-src-util-test-ts'])
    expect(container.querySelector('.attention-tail')!.textContent).toContain('1 low-attention file')
  })
})

describe('InspectStep — Mark all viewed (tail)', () => {
  it('marks every tail file viewed in one click', async () => {
    const viewedStore = createViewedStore('o/r#1')
    render(InspectStep, { props: baseProps({ viewedStore }) })
    await fireEvent.click(screen.getByRole('button', { name: 'Risk first' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 viewed' }))

    expect(viewedStore.isViewed('pnpm-lock.yaml', PATCH)).toBe(true)
    expect(viewedStore.isViewed('src/util.test.ts', PATCH)).toBe(true)
    // Attention files stay untouched.
    expect(viewedStore.isViewed('src/auth/big.ts', PATCH)).toBe(false)
  })

  it('respects a manual un-view: repeat clicks never re-mark it (bulk-marks once)', async () => {
    const viewedStore = createViewedStore('o/r#1')
    render(InspectStep, { props: baseProps({ viewedStore }) })
    await fireEvent.click(screen.getByRole('button', { name: 'Risk first' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 viewed' }))
    expect(viewedStore.isViewed('pnpm-lock.yaml', PATCH)).toBe(true)

    // The user deliberately un-views one tail file…
    viewedStore.toggle('pnpm-lock.yaml', PATCH)
    await tick()
    expect(viewedStore.isViewed('pnpm-lock.yaml', PATCH)).toBe(false)

    // …and a repeat bulk click does NOT fight that choice.
    await fireEvent.click(screen.getByRole('button', { name: 'Mark all 2 viewed' }))
    expect(viewedStore.isViewed('pnpm-lock.yaml', PATCH)).toBe(false)
    expect(viewedStore.isViewed('src/util.test.ts', PATCH)).toBe(true)
  })
})

describe('InspectStep — attention progress line', () => {
  it('shows "M of N attention files reviewed" driven by the viewed store', async () => {
    const viewedStore = createViewedStore('o/r#1')
    render(InspectStep, { props: baseProps({ viewedStore }) })

    // 3 attention (novel) files; none viewed yet.
    expect(screen.getByTestId('attention-progress').textContent).toContain('0 of 3 attention files reviewed')

    viewedStore.toggle('src/mid.ts', PATCH)
    await tick()
    expect(screen.getByTestId('attention-progress').textContent).toContain('1 of 3 attention files reviewed')

    // Viewing a MECHANICAL file does not move the attention numerator.
    viewedStore.toggle('pnpm-lock.yaml', PATCH)
    await tick()
    expect(screen.getByTestId('attention-progress').textContent).toContain('1 of 3 attention files reviewed')
  })

  it('renders no progress line without a viewed store', () => {
    render(InspectStep, { props: baseProps() })
    expect(screen.queryByTestId('attention-progress')).not.toBeInTheDocument()
  })
})
