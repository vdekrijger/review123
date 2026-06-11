import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { AttentionResult } from '../lib/ai/schemas'
import type { PrFile } from '../lib/github/types'
import { createViewedStore } from '../lib/viewed/viewed.svelte'

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
