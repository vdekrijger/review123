import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import InspectStep from './InspectStep.svelte'
import type { AttentionResult } from '../lib/ai/schemas'
import type { PrFile } from '../lib/github/types'

// Minimal canvas stub so FileDiff doesn't throw in jsdom
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: () => ({
    font: '',
    measureText: () => ({ width: 0 }),
  }),
  writable: true,
})

const makeFiles = (names: string[]): PrFile[] =>
  names.map(filename => ({
    filename, status: 'modified', additions: 1, deletions: 0,
    patch: `@@ -1 +1 @@\n-old\n+new`,
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
