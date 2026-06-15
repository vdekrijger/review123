import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import StorySlideshow from './StorySlideshow.svelte'
import { track } from '../lib/analytics/analytics'
import type { PrFile } from '../lib/github/types'
import type { StoryOrderResult } from '../lib/ai/schemas'

vi.mock('../lib/analytics/analytics', () => ({
  track: vi.fn(),
  initAnalytics: vi.fn(),
  _setCaptureForTest: vi.fn(),
}))

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
  vi.mocked(track).mockClear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'

const makeFiles = (names: string[]): PrFile[] =>
  names.map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH }))

const STORY: StoryOrderResult = {
  steps: [
    { index: 0, files: ['src/db/schema.ts'], caption: 'Schema gains a provider column.', layer: 'data', relatedTests: ['src/db/schema.test.ts'] },
    { index: 1, files: ['src/api/route.ts'], caption: 'API reads the new column.', layer: 'api', relatedTests: [] },
    { index: 2, files: ['src/ui/Card.svelte'], caption: 'UI renders the provider badge.', layer: 'ui', relatedTests: [] },
  ],
}

const ALL_FILES = makeFiles(['src/db/schema.ts', 'src/db/schema.test.ts', 'src/api/route.ts', 'src/ui/Card.svelte'])

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    story: STORY,
    files: ALL_FILES,
    mode: 'unified' as const,
    draftStore: null,
    onAddDraft: () => {},
    onRemoveDraft: () => {},
    onAddSkillFindingDraft: async () => {},
    ...overrides,
  }
}

describe('StorySlideshow — navigation', () => {
  it('shows the first step caption + counter on mount', () => {
    render(StorySlideshow, { props: baseProps() })
    expect(screen.getByText('Schema gains a provider column.')).toBeInTheDocument()
    expect(screen.getAllByText('1 of 3').length).toBeGreaterThan(0)
  })

  it('advances on Next and goes back on Prev', async () => {
    render(StorySlideshow, { props: baseProps() })
    const next = screen.getAllByRole('button', { name: 'Next step' })[0]
    await fireEvent.click(next)
    expect(screen.getByText('API reads the new column.')).toBeInTheDocument()
    expect(screen.getAllByText('2 of 3').length).toBeGreaterThan(0)
    const prev = screen.getAllByRole('button', { name: 'Previous step' })[0]
    await fireEvent.click(prev)
    expect(screen.getByText('Schema gains a provider column.')).toBeInTheDocument()
  })

  it('clamps Prev at the first step and Next at the last', async () => {
    render(StorySlideshow, { props: baseProps() })
    const prev = screen.getAllByRole('button', { name: 'Previous step' })[0] as HTMLButtonElement
    expect(prev.disabled).toBe(true)
    const next = screen.getAllByRole('button', { name: 'Next step' })[0]
    await fireEvent.click(next)
    await fireEvent.click(next)
    expect(screen.getAllByText('3 of 3').length).toBeGreaterThan(0)
    const nextNow = screen.getAllByRole('button', { name: 'Next step' })[0] as HTMLButtonElement
    expect(nextNow.disabled).toBe(true)
  })

  it('navigates with ArrowRight / ArrowLeft keys', async () => {
    render(StorySlideshow, { props: baseProps() })
    await fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(screen.getByText('API reads the new column.')).toBeInTheDocument()
    await fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(screen.getByText('Schema gains a provider column.')).toBeInTheDocument()
  })
})

describe('StorySlideshow — related tests + content', () => {
  it('renders related test files inline beneath the step', () => {
    render(StorySlideshow, { props: baseProps() })
    expect(screen.getByText('Related tests — sense-check the change')).toBeInTheDocument()
    // The related test file's diff card is rendered
    expect(document.getElementById('file-src-db-schema-test-ts')).not.toBeNull()
  })

  it('shows a layer chip for the current step', () => {
    render(StorySlideshow, { props: baseProps() })
    expect(screen.getByText('Data model')).toBeInTheDocument()
  })
})

describe('StorySlideshow — filtering unusable steps', () => {
  it('drops steps whose files are not in the PR and re-indexes', () => {
    const story: StoryOrderResult = {
      steps: [
        { index: 0, files: ['ghost.ts'], caption: 'Ghost step.', layer: 'data', relatedTests: [] },
        { index: 1, files: ['src/api/route.ts'], caption: 'Real step.', layer: 'api', relatedTests: [] },
      ],
    }
    render(StorySlideshow, { props: baseProps({ story }) })
    expect(screen.queryByText('Ghost step.')).not.toBeInTheDocument()
    expect(screen.getByText('Real step.')).toBeInTheDocument()
    expect(screen.getAllByText('1 of 1').length).toBeGreaterThan(0)
  })
})

describe('StorySlideshow — tolerant path matching', () => {
  it('maps a step path that differs by a leading ./ (renders, not dropped)', () => {
    const story: StoryOrderResult = {
      steps: [
        { index: 0, files: ['./src/api/route.ts'], caption: 'Normalized path step.', layer: 'api', relatedTests: [] },
      ],
    }
    render(StorySlideshow, { props: baseProps({ story }) })
    expect(screen.getByText('Normalized path step.')).toBeInTheDocument()
    expect(document.getElementById('file-src-api-route-ts')).not.toBeNull()
  })

  it('maps a step path by unique basename', () => {
    const story: StoryOrderResult = {
      steps: [{ index: 0, files: ['route.ts'], caption: 'Basename step.', layer: 'api', relatedTests: [] }],
    }
    render(StorySlideshow, { props: baseProps({ story }) })
    expect(screen.getByText('Basename step.')).toBeInTheDocument()
    expect(document.getElementById('file-src-api-route-ts')).not.toBeNull()
  })
})

describe('StorySlideshow — anti-overlap (dedupe across steps)', () => {
  it('does not render the same file in two adjacent steps', () => {
    const story: StoryOrderResult = {
      steps: [
        { index: 0, files: ['src/db/schema.ts'], caption: 'First touches schema.', layer: 'data', relatedTests: [] },
        { index: 1, files: ['src/db/schema.ts', 'src/api/route.ts'], caption: 'Second re-lists schema.', layer: 'api', relatedTests: [] },
      ],
    }
    render(StorySlideshow, { props: baseProps({ story }) })
    // Step 1 keeps schema; step 2 keeps only route (schema stripped as a dupe).
    expect(screen.getByText('First touches schema.')).toBeInTheDocument()
    expect(document.getElementById('file-src-db-schema-ts')).not.toBeNull()
    const next = screen.getAllByRole('button', { name: 'Next step' })[0]
    return fireEvent.click(next).then(() => {
      expect(screen.getByText('Second re-lists schema.')).toBeInTheDocument()
      // schema.ts no longer rendered on step 2 — only route.ts
      expect(document.getElementById('file-src-db-schema-ts')).toBeNull()
      expect(document.getElementById('file-src-api-route-ts')).not.toBeNull()
    })
  })
})

describe('StorySlideshow — analytics', () => {
  it('fires story_mode_entered once and story_step_viewed with index only', async () => {
    render(StorySlideshow, { props: baseProps() })
    expect(vi.mocked(track)).toHaveBeenCalledWith('story_mode_entered')
    expect(vi.mocked(track)).toHaveBeenCalledWith('story_step_viewed', { index: 0 })
    await fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(vi.mocked(track)).toHaveBeenCalledWith('story_step_viewed', { index: 1 })
    // story_mode_entered fired exactly once
    const enteredCalls = vi.mocked(track).mock.calls.filter((c) => c[0] === 'story_mode_entered')
    expect(enteredCalls).toHaveLength(1)
  })
})
