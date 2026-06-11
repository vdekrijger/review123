import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'

// DiffView uses canvas.getContext('2d') for text measurement — jsdom has no canvas.
// Stub it so the component can render without throwing.
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      font: '',
      measureText: (_text: string) => ({ width: 0 }),
    }),
    writable: true,
  })
})

// bare hunk — real GitHub wire format; buildDiffFile synthesises the envelope
const modified: PrFile = {
  filename: 'src/a.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n unchanged',
}

const renameOnly: PrFile = {
  filename: 'b.ts',
  previousFilename: 'a.ts',
  status: 'renamed',
  additions: 0,
  deletions: 0,
}

const noPatch: PrFile = {
  filename: 'img.png',
  status: 'added',
  additions: 0,
  deletions: 0,
}

describe('FileDiff', () => {
  it('rename-only fixture shows the rename note', () => {
    render(FileDiff, { props: { file: renameOnly, mode: 'unified' } })
    expect(screen.getByText(/rename only/i)).toBeInTheDocument()
  })

  it('no-patch fixture shows the binary note', () => {
    render(FileDiff, { props: { file: noPatch, mode: 'unified' } })
    expect(screen.getByText(/binary or too large/i)).toBeInTheDocument()
  })

  it('renders header with filename for modified file', () => {
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    expect(container.querySelector('article.file-diff')).toBeInTheDocument()
    expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument()
  })

  it('renders rename header with arrow for renamed file', () => {
    render(FileDiff, { props: { file: renameOnly, mode: 'unified' } })
    expect(screen.getByText(/a\.ts.*→.*b\.ts/)).toBeInTheDocument()
  })

  it('smoke: renders modified file without throwing and DiffView mounts', () => {
    // jsdom stubs canvas so DiffView can mount; DiffView uses a virtual scroll /
    // lazy-render strategy so 'const a = 2' won't be in the initial DOM —
    // we verify the component tree is present and no fallback note is shown.
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    expect(container.querySelector('article.file-diff')).toBeInTheDocument()
    // The diff view element should be rendered (not a note paragraph)
    expect(container.querySelector('.note')).not.toBeInTheDocument()
    // DiffView should have rendered some diff structure
    expect(container.querySelector('article.file-diff')!.childElementCount).toBeGreaterThan(1)
  })
})
