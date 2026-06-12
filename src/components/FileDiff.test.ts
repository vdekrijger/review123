import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import type { PrComment } from '../lib/github/comments'

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

describe('FileDiff — viewed state', () => {
  it('renders a "Viewed" checkbox with correct aria-label', () => {
    render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const checkbox = screen.getByRole('checkbox', { name: /mark src\/a\.ts as viewed/i })
    expect(checkbox).toBeInTheDocument()
    expect((checkbox as HTMLInputElement).checked).toBe(false)
  })

  it('viewed=true: checkbox is checked and diff body is collapsed', () => {
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified', viewed: true } })
    const checkbox = screen.getByRole('checkbox', { name: /mark src\/a\.ts as viewed/i })
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    // Article should have is-collapsed class
    expect(container.querySelector('article.file-diff')!.classList.contains('is-collapsed')).toBe(true)
    // The diff view should not be rendered (collapsed)
    expect(container.querySelector('.note')).not.toBeInTheDocument()
    // No DiffView rendered when collapsed
    const article = container.querySelector('article.file-diff')!
    // Header is the only child when collapsed
    const headerChildren = article.querySelectorAll('header')
    expect(headerChildren.length).toBe(1)
  })

  it('viewed=false: article is not collapsed', () => {
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified', viewed: false } })
    expect(container.querySelector('article.file-diff')!.classList.contains('is-collapsed')).toBe(false)
  })

  it('changedSinceViewed=true: amber badge is shown', () => {
    render(FileDiff, { props: { file: modified, mode: 'unified', changedSinceViewed: true } })
    expect(screen.getByText(/changed since you viewed it/i)).toBeInTheDocument()
  })

  it('changedSinceViewed=false: amber badge is not shown', () => {
    render(FileDiff, { props: { file: modified, mode: 'unified', changedSinceViewed: false } })
    expect(screen.queryByText(/changed since you viewed it/i)).not.toBeInTheDocument()
  })

  it('onToggleViewed is called when checkbox changes', async () => {
    let called = false
    render(FileDiff, { props: { file: modified, mode: 'unified', onToggleViewed: () => { called = true } } })
    const checkbox = screen.getByRole('checkbox', { name: /mark src\/a\.ts as viewed/i })
    await fireEvent.change(checkbox, { target: { checked: true } })
    expect(called).toBe(true)
  })

  it('rename-only file: shows viewed checkbox', () => {
    render(FileDiff, { props: { file: renameOnly, mode: 'unified' } })
    expect(screen.getByRole('checkbox', { name: /mark b\.ts as viewed/i })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// FileDiff — existing PR comments rendering
// ---------------------------------------------------------------------------

describe('FileDiff — existing comments (EC-FD-COMM)', () => {
  function makeExistingComment(overrides: Partial<PrComment> = {}): PrComment {
    return {
      id: 1,
      author: 'reviewer',
      authorAvatar: null,
      body: 'Existing review comment',
      createdAt: new Date().toISOString(),
      path: 'src/a.ts',
      line: 2,
      side: 'RIGHT',
      inReplyTo: null,
      ...overrides,
    }
  }

  it('renders existing comment section when comments prop has items', () => {
    const comment = makeExistingComment({ body: 'Please refactor this.' })
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [comment] },
    })
    expect(container.querySelector('.existing-comments')).toBeInTheDocument()
  })

  it('does not render existing comment section when comments is empty', () => {
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [] },
    })
    expect(container.querySelector('.existing-comments')).not.toBeInTheDocument()
  })

  it('does not render existing comment section when comments prop is omitted', () => {
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified' },
    })
    expect(container.querySelector('.existing-comments')).not.toBeInTheDocument()
  })

  it('shows existing comment author in the thread', () => {
    const comment = makeExistingComment({ author: 'carol' })
    render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [comment] },
    })
    expect(screen.getByText('carol')).toBeInTheDocument()
  })

  it('existing comments section has visually distinct class from draft-annotations', () => {
    const comment = makeExistingComment()
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [comment] },
    })
    const existingSection = container.querySelector('.existing-comments')
    expect(existingSection).toBeInTheDocument()
    // Must NOT have draft-annotations class — these are separate
    expect(existingSection!.classList.contains('draft-annotations')).toBe(false)
  })

  it('groups comments by line with a line label', () => {
    const c1 = makeExistingComment({ id: 1, line: 5, body: 'Comment on line 5' })
    const c2 = makeExistingComment({ id: 2, line: 5, body: 'Another on line 5', inReplyTo: 1 })
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [c1, c2] },
    })
    // Should show a "Line 5" label in the existing-line-label
    const lineLabel = container.querySelector('.existing-line-label')
    expect(lineLabel).toBeInTheDocument()
    expect(lineLabel!.textContent).toMatch(/line 5/i)
  })

  it('renders body content of existing comment', () => {
    const comment = makeExistingComment({ body: 'This is the review comment body.' })
    render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [comment] },
    })
    expect(screen.getByText(/This is the review comment body\./i)).toBeInTheDocument()
  })
})
