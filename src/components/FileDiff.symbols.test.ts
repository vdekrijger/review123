/**
 * FileDiff × symbol click-through (Tier 1): every mounted FileDiff registers
 * its file's text into the shared symbol-source registry (and unregisters on
 * unmount) so identifier clicks anywhere in the review can resolve
 * definitions/references across all rendered PR files.
 *
 * The click → popover pipeline itself is covered by clickToken/symbolIndex
 * unit tests and e2e/symbol-nav.spec.ts (DiffView lazy-renders rows in jsdom,
 * so a jsdom click on real diff DOM is not reliable here).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import { currentSymbolIndex, _resetSymbolSourcesForTest } from '../lib/symbols/symbolSources'

// DiffView uses canvas.getContext('2d') for text measurement — jsdom has no canvas.
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      font: '',
      measureText: (_text: string) => ({ width: 0 }),
    }),
    writable: true,
  })
})

beforeEach(() => {
  _resetSymbolSourcesForTest()
})

const file: PrFile = {
  filename: 'src/calc.ts',
  status: 'modified',
  additions: 2,
  deletions: 0,
  patch: '@@ -1,2 +1,4 @@\n const keep = 1\n+export function computeTotal(v: number[]) {\n+const t = computeTotal([1])\n unchanged',
}

describe('FileDiff symbol-source registration', () => {
  it('registers the file text on mount so the symbol index sees it', () => {
    render(FileDiff, { props: { file, mode: 'unified' } })
    const index = currentSymbolIndex()
    expect(index.has('computeTotal')).toBe(true)
    expect(index.definitionsOf('computeTotal')[0]?.file).toBe('src/calc.ts')
  })

  it('unregisters on unmount', () => {
    const { unmount } = render(FileDiff, { props: { file, mode: 'unified' } })
    expect(currentSymbolIndex().has('computeTotal')).toBe(true)
    unmount()
    expect(currentSymbolIndex().has('computeTotal')).toBe(false)
  })

  it('feeds fetched full contents into the index when provided', () => {
    render(FileDiff, {
      props: {
        file,
        mode: 'unified',
        contents: {
          before: 'const keep = 1\nunchanged',
          after: 'const keep = 1\nexport function computeTotal(v: number[]) {\nconst t = computeTotal([1])\nunchanged\nconst outsideHunk = computeTotal([2])',
        },
      },
    })
    const refs = currentSymbolIndex().referencesOf('computeTotal')
    // Line 5 exists only in the full contents (outside the patch hunks) and is
    // honestly tagged as not-jumpable in the rendered diff.
    const outside = refs.find((r) => r.line === 5)
    expect(outside).toBeDefined()
    expect(outside!.inDiff).toBe(false)
  })
})
