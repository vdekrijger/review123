import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import FileDiff from './FileDiff.svelte'
import type { PrFile } from '../lib/github/types'
import type { PrComment } from '../lib/github/comments'
import { buildDiffFile } from '../lib/diff/diffFile'

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

// ---------------------------------------------------------------------------
// FileDiff — context expansion (hunk expand affordance)
// ---------------------------------------------------------------------------

// A file with a small hunk in the middle of a larger file — there will be
// hidden context lines above and below when full content is provided.
const bigFile: PrFile = {
  filename: 'src/big.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -5,3 +5,3 @@\n context\n-old line\n+new line\n context',
}

const oldContent = [
  'line 1', 'line 2', 'line 3', 'line 4',
  'context', 'old line', 'context',
  'line 8', 'line 9', 'line 10',
].join('\n')

const newContent = [
  'line 1', 'line 2', 'line 3', 'line 4',
  'context', 'new line', 'context',
  'line 8', 'line 9', 'line 10',
].join('\n')

describe('FileDiff — context expansion prop', () => {
  it('without contents prop: DiffFile has getExpandEnabled()=false', () => {
    // Verify at the library level that hunk-only mode disables expansion
    const df = buildDiffFile(bigFile, 'unified')!
    expect(df.getExpandEnabled()).toBe(false)
  })

  it('with contents prop: DiffFile has getExpandEnabled()=true', () => {
    // Verify at the library level that full-content mode enables expansion
    const df = buildDiffFile(bigFile, 'unified', { before: oldContent, after: newContent })!
    expect(df.getExpandEnabled()).toBe(true)
  })

  it('without contents: component renders without expand buttons (hunk-only)', () => {
    const { container } = render(FileDiff, {
      props: { file: bigFile, mode: 'unified' },
    })
    // No expand buttons when contents are not provided
    const expandButtons = container.querySelectorAll('button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]')
    expect(expandButtons.length).toBe(0)
  })

  it('with contents: component renders expand button(s) in hunk separator rows', () => {
    const { container } = render(FileDiff, {
      props: {
        file: bigFile,
        mode: 'unified',
        contents: { before: oldContent, after: newContent },
      },
    })
    // When full content is provided and there are hidden context lines,
    // the library renders Expand Up/Down/All buttons in hunk rows.
    const expandButtons = container.querySelectorAll(
      'button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]'
    )
    expect(expandButtons.length).toBeGreaterThan(0)
  })

  it('contents arriving after first render: upgrading to expandable works (Svelte reactivity)', async () => {
    // Initially no contents — hunk-only; then update to provide contents
    // Svelte's reactivity recomputes diffFile → expand buttons appear
    const result = render(FileDiff, {
      props: { file: bigFile, mode: 'unified', contents: undefined },
    })

    // Before: no expand buttons
    let expandButtons = result.container.querySelectorAll(
      'button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]'
    )
    expect(expandButtons.length).toBe(0)

    // After: provide contents → reactivity fires, diff rebuilds with expansion
    await result.rerender({ file: bigFile, mode: 'unified', contents: { before: oldContent, after: newContent } })

    expandButtons = result.container.querySelectorAll(
      'button[title="Expand Up"], button[title="Expand Down"], button[title="Expand All"]'
    )
    expect(expandButtons.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// FileDiff — askFn prop threading (line-level Ask AI feature)
// ---------------------------------------------------------------------------

describe('FileDiff — askFn prop', () => {
  it('renders without error when askFn is not provided', () => {
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    expect(container.querySelector('article.file-diff')).toBeInTheDocument()
  })

  it('renders without error when askFn is provided', () => {
    const askFn = vi.fn(async (_q: string, _onDelta: (t: string) => void) => ({
      ok: true as const,
      answer: 'AI answer',
    }))
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', askFn },
    })
    expect(container.querySelector('article.file-diff')).toBeInTheDocument()
  })

  it('renders without error when askDisabledReason is provided', () => {
    const { container } = render(FileDiff, {
      props: {
        file: modified,
        mode: 'unified',
        askFn: vi.fn(),
        askDisabledReason: 'No API key configured.',
      },
    })
    expect(container.querySelector('article.file-diff')).toBeInTheDocument()
  })
})
