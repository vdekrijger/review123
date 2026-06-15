import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { PrFile } from '../lib/github/types'
import type { StoryOrderResult } from '../lib/ai/schemas'

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({ font: '', measureText: () => ({ width: 0 }) }),
  writable: true,
})

beforeEach(() => {
  localStorage.clear()
})

const PATCH = '@@ -1 +1 @@\n-old\n+new'
const makeFiles = (names: string[]): PrFile[] =>
  names.map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 0, patch: PATCH }))

const STORY: StoryOrderResult = {
  steps: [
    { index: 0, files: ['src/db.ts'], caption: 'Data layer changes.', layer: 'data', relatedTests: [] },
    { index: 1, files: ['src/ui.ts'], caption: 'UI changes.', layer: 'ui', relatedTests: [] },
  ],
}

const FILES = makeFiles(['src/db.ts', 'src/ui.ts'])

function base(overrides: Record<string, unknown> = {}) {
  return {
    files: FILES,
    changedFiles: 2,
    mode: 'unified' as const,
    onmode: () => {},
    draftStore: null,
    ...overrides,
  }
}

describe('InspectStep — story gating (no key)', () => {
  it('does not render the Story/Files switch when story is unavailable', () => {
    render(InspectStep, { props: base({ storyAvailable: false, storyMode: true, story: STORY, storyStatus: 'done' }) })
    expect(screen.queryByRole('button', { name: 'Story' })).not.toBeInTheDocument()
    // Files flow renders the all-files diff (data + ui file cards present)
    expect(document.getElementById('file-src-db-ts')).not.toBeNull()
    expect(document.getElementById('file-src-ui-ts')).not.toBeNull()
  })
})

describe('InspectStep — story gating (key present)', () => {
  it('renders the switch with Story active by default when storyMode is on', () => {
    render(InspectStep, { props: base({ storyAvailable: true, storyMode: true, story: STORY, storyStatus: 'done' }) })
    const storyBtn = screen.getByRole('button', { name: 'Story' })
    expect(storyBtn.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Data layer changes.')).toBeInTheDocument()
  })

  it('switching to Files persists the choice via onstorymode(false)', async () => {
    let persisted: boolean | null = null
    render(InspectStep, {
      props: base({ storyAvailable: true, storyMode: true, story: STORY, storyStatus: 'done', onstorymode: (v: boolean) => { persisted = v } }),
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(persisted).toBe(false)
  })

  it('Files mode (storyMode off) shows the all-files diff, not the story', () => {
    render(InspectStep, { props: base({ storyAvailable: true, storyMode: false, story: STORY, storyStatus: 'done' }) })
    expect(screen.queryByText('Data layer changes.')).not.toBeInTheDocument()
    expect(document.getElementById('file-src-db-ts')).not.toBeNull()
    expect(document.getElementById('file-src-ui-ts')).not.toBeNull()
  })
})

describe('InspectStep — story fallback', () => {
  it('shows a skeleton while the story task is loading', () => {
    render(InspectStep, { props: base({ storyAvailable: true, storyMode: true, story: null, storyStatus: 'loading' }) })
    expect(screen.getByLabelText('Building the walkthrough')).toBeInTheDocument()
  })

  it('falls back to Files with an EMPTY note when the story has no usable steps', () => {
    const empty: StoryOrderResult = { steps: [] }
    render(InspectStep, { props: base({ storyAvailable: true, storyMode: true, story: empty, storyStatus: 'done' }) })
    expect(screen.getByText("Couldn't build a walkthrough for this PR — showing all files.")).toBeInTheDocument()
    expect(document.getElementById('file-src-db-ts')).not.toBeNull()
  })

  it('falls back to Files with an ERROR note (showing the reason) + a Retry button when the story task errored', () => {
    render(InspectStep, {
      props: base({ storyAvailable: true, storyMode: true, story: null, storyStatus: 'error', storyError: 'AI returned an unexpected response format. Please retry.', onRetryStory: () => {} }),
    })
    expect(screen.getByText(/Couldn't build the walkthrough/)).toBeInTheDocument()
    expect(screen.getByText(/AI returned an unexpected response format/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(document.getElementById('file-src-db-ts')).not.toBeNull()
  })

  it('Retry button re-invokes onRetryStory (re-runs just the story task)', async () => {
    let retried = 0
    render(InspectStep, {
      props: base({ storyAvailable: true, storyMode: true, story: null, storyStatus: 'error', storyError: 'Rate limited.', onRetryStory: () => { retried++ } }),
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retried).toBe(1)
  })

  it('renders the story (no fallback) when a step maps via tolerant suffix/basename matching', () => {
    // Story emits a leading ./ and a bare basename; both must still map.
    const story: StoryOrderResult = {
      steps: [
        { index: 0, files: ['./src/db.ts'], caption: 'Data layer changes.', layer: 'data', relatedTests: [] },
        { index: 1, files: ['ui.ts'], caption: 'UI changes.', layer: 'ui', relatedTests: [] },
      ],
    }
    render(InspectStep, { props: base({ storyAvailable: true, storyMode: true, story, storyStatus: 'done' }) })
    expect(screen.getByText('Data layer changes.')).toBeInTheDocument()
    expect(screen.queryByText(/showing all files/)).not.toBeInTheDocument()
  })

  it('renders only the mappable steps when SOME paths are unmappable (no fallback)', () => {
    const story: StoryOrderResult = {
      steps: [
        { index: 0, files: ['ghost/gone.ts'], caption: 'Ghost step.', layer: 'data', relatedTests: [] },
        { index: 1, files: ['src/db.ts'], caption: 'Real step.', layer: 'data', relatedTests: [] },
      ],
    }
    render(InspectStep, { props: base({ storyAvailable: true, storyMode: true, story, storyStatus: 'done' }) })
    expect(screen.getByText('Real step.')).toBeInTheDocument()
    expect(screen.queryByText('Ghost step.')).not.toBeInTheDocument()
    expect(screen.queryByText(/showing all files/)).not.toBeInTheDocument()
  })
})
