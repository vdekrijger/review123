import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import { computeWhitespaceHiddenPatch } from '../lib/diff/whitespace'

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

const BEFORE = 'a\nfoo bar\nkeep\nreal change\nend\n'
const AFTER = 'a\nfoo  bar\nkeep\nreal CHANGE\nend\n'

const mixedFile: PrFile = {
  filename: 'src/mixed.ts',
  status: 'modified',
  additions: 2,
  deletions: 2,
  patch: '@@ -1,5 +1,5 @@\n a\n-foo bar\n+foo  bar\n keep\n-real change\n+real CHANGE\n end',
}

const wsOnlyFile: PrFile = {
  filename: 'src/ws-only.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -1,3 +1,3 @@\n function f() {\n-return 1\n+  return 1\n }',
}

describe('FileDiff — whitespace prop', () => {
  it('whitespace=collapsed renders the placeholder instead of a diff', () => {
    render(FileDiff, {
      props: { file: wsOnlyFile, mode: 'unified', whitespace: { kind: 'collapsed' } },
    })
    expect(screen.getByText('No changes when hiding whitespace.')).toBeInTheDocument()
    expect(document.querySelector('[data-component="git-diff-view"], .diff-style-root, table')).toBeNull()
  })

  it('collapsed placeholder keeps the file header (stats + viewed checkbox)', () => {
    render(FileDiff, {
      props: { file: wsOnlyFile, mode: 'unified', whitespace: { kind: 'collapsed' } },
    })
    expect(screen.getByText('src/ws-only.ts')).toBeInTheDocument()
    expect(screen.getByLabelText('Mark src/ws-only.ts as viewed')).toBeInTheDocument()
  })

  it('whitespace=recomputed renders the recomputed patch and the anchoring note', () => {
    const result = computeWhitespaceHiddenPatch(BEFORE, AFTER)
    expect(result.kind).toBe('recomputed')
    render(FileDiff, {
      props: {
        file: mixedFile,
        mode: 'unified',
        contents: { before: BEFORE, after: AFTER },
        whitespace: result,
      },
    })
    expect(screen.getByText(/Line comments are disabled while whitespace changes are hidden/)).toBeInTheDocument()
  })

  it('whitespace=unavailable keeps the provider diff and shows the honest note', () => {
    render(FileDiff, {
      props: { file: mixedFile, mode: 'unified', whitespace: { kind: 'unavailable' } },
    })
    expect(
      screen.getByText("Whitespace hiding isn't available for this file — showing the full diff."),
    ).toBeInTheDocument()
    expect(screen.queryByText('No changes when hiding whitespace.')).not.toBeInTheDocument()
  })

  it('whitespace=null renders the normal diff with no notes', () => {
    render(FileDiff, {
      props: { file: mixedFile, mode: 'unified', whitespace: null },
    })
    expect(screen.queryByText(/Line comments are disabled/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Whitespace hiding isn't available/)).not.toBeInTheDocument()
    expect(screen.queryByText('No changes when hiding whitespace.')).not.toBeInTheDocument()
  })

  it('split mode with recomputed patch renders without throwing', () => {
    const result = computeWhitespaceHiddenPatch(BEFORE, AFTER)
    expect(() =>
      render(FileDiff, {
        props: {
          file: mixedFile,
          mode: 'split',
          contents: { before: BEFORE, after: AFTER },
          whitespace: result,
        },
      }),
    ).not.toThrow()
  })
})
