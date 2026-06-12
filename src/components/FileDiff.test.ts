import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { tick } from 'svelte'
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
  // NOTE on anchoring: `modified` has patch lines RIGHT 1–3 (and LEFT 1–2).
  // Comments anchored to a patch line render INLINE (extendData) and must NOT
  // appear in the bottom `.existing-comments` list — that list is only for
  // file-level / unanchorable comments. Line 99 is NOT in the patch →
  // unanchorable → bottom list.
  function makeExistingComment(overrides: Partial<PrComment> = {}): PrComment {
    return {
      id: 1,
      author: 'reviewer',
      authorAvatar: null,
      body: 'Existing review comment',
      createdAt: new Date().toISOString(),
      path: 'src/a.ts',
      line: 99,
      side: 'RIGHT',
      inReplyTo: null,
      ...overrides,
    }
  }

  it('renders existing comment section when comments prop has unanchorable items', () => {
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

  it('groups unanchorable comments by line with a line label', () => {
    const c1 = makeExistingComment({ id: 1, line: 55, body: 'Comment on line 55' })
    const c2 = makeExistingComment({ id: 2, line: 55, body: 'Another on line 55', inReplyTo: 1 })
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [c1, c2] },
    })
    // Should show a "Line 55" label in the existing-line-label
    const lineLabel = container.querySelector('.existing-line-label')
    expect(lineLabel).toBeInTheDocument()
    expect(lineLabel!.textContent).toMatch(/line 55/i)
  })

  it('file-level comment (line null) appears under a "General" label', () => {
    const comment = makeExistingComment({ id: 7, line: null, side: null, body: 'File-level remark' })
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [comment] },
    })
    const lineLabel = container.querySelector('.existing-line-label')
    expect(lineLabel).toBeInTheDocument()
    expect(lineLabel!.textContent).toMatch(/general/i)
    expect(screen.getByText(/File-level remark/i)).toBeInTheDocument()
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
// FileDiff — dedupe: anchored → inline only; file-level/unanchorable → bottom
// ---------------------------------------------------------------------------

describe('FileDiff — anchored comments render inline only (dedupe)', () => {
  function makeComment(overrides: Partial<PrComment> = {}): PrComment {
    return {
      id: 1,
      author: 'reviewer',
      authorAvatar: null,
      body: 'Anchored comment',
      createdAt: '2024-01-01T10:00:00Z',
      path: 'src/a.ts',
      line: 2, // RIGHT line 2 IS in the `modified` patch (context "unchanged")
      side: 'RIGHT',
      inReplyTo: null,
      ...overrides,
    }
  }

  it('anchored comment renders inline (inline-annotations) and NOT in the bottom list', async () => {
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [makeComment()] },
    })
    // Inline annotation row appears at the line (extend row)
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="inline-annotations"]')).toBeInTheDocument()
    })
    expect(screen.getByText(/Anchored comment/i)).toBeInTheDocument()
    // NOT duplicated in the bottom-of-file list
    expect(container.querySelector('.existing-comments')).not.toBeInTheDocument()
  })

  it('anchored comment body appears exactly once (no duplicate render)', async () => {
    render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [makeComment({ body: 'unique-body-marker' })] },
    })
    await vi.waitFor(() => {
      expect(screen.getAllByText(/unique-body-marker/i)).toHaveLength(1)
    })
  })

  it('split mode: anchored comment also renders inline only', async () => {
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'split', comments: [makeComment()] },
    })
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="inline-annotations"]')).toBeInTheDocument()
    })
    expect(container.querySelector('.existing-comments')).not.toBeInTheDocument()
  })

  it('mixed: anchored inline, unanchorable in bottom list — never both for one thread', async () => {
    const anchored = makeComment({ id: 1, body: 'marker-inline-only' })
    const unanchored = makeComment({ id: 2, line: 99, body: 'marker-bottom-only' })
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [anchored, unanchored] },
    })
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="inline-annotations"]')).toBeInTheDocument()
    })
    const bottom = container.querySelector('.existing-comments')
    expect(bottom).toBeInTheDocument()
    expect(bottom!.textContent).toContain('marker-bottom-only')
    expect(bottom!.textContent).not.toContain('marker-inline-only')
    expect(screen.getAllByText(/marker-inline-only/i)).toHaveLength(1)
    expect(screen.getAllByText(/marker-bottom-only/i)).toHaveLength(1)
  })

  it('thread on an anchored line renders root + reply inside the inline annotation', async () => {
    const root = makeComment({ id: 10, body: 'thread root body' })
    const reply = makeComment({ id: 11, body: 'thread reply body', inReplyTo: 10, author: 'replier' })
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', comments: [root, reply] },
    })
    await vi.waitFor(() => {
      const inline = container.querySelector('[data-testid="inline-annotations"]')
      expect(inline).toBeInTheDocument()
      expect(inline!.textContent).toContain('thread root body')
      expect(inline!.textContent).toContain('thread reply body')
    })
    // reply is rendered as an indented .comment-item.reply
    expect(container.querySelector('.comment-item.reply')).toBeInTheDocument()
    // one thread → one inline ExistingThread, nothing at the bottom
    expect(container.querySelector('.existing-comments')).not.toBeInTheDocument()
  })
})

describe('FileDiff — anchored drafts render inline only (dedupe)', () => {
  function makeDraft(overrides: Partial<import('../lib/drafts/drafts.svelte').Draft> = {}) {
    return {
      prKey: 'o/r#1@sha',
      path: 'src/a.ts',
      line: 2,
      side: 'RIGHT' as const,
      body: 'Draft on anchored line',
      n: 0,
      updatedAt: Date.now(),
      ...overrides,
    }
  }

  it('anchored draft renders inline and NOT in the bottom draft-annotations list', async () => {
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', drafts: [makeDraft()] },
    })
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="inline-annotations"]')).toBeInTheDocument()
    })
    expect(screen.getAllByText(/Draft on anchored line/i)).toHaveLength(1)
    expect(container.querySelector('.draft-annotations')).not.toBeInTheDocument()
  })

  it('unanchorable draft (line outside patch) falls back to the bottom list', () => {
    const { container } = render(FileDiff, {
      props: { file: modified, mode: 'unified', drafts: [makeDraft({ line: 99, body: 'off-patch draft' })] },
    })
    expect(container.querySelector('.draft-annotations')).toBeInTheDocument()
    expect(screen.getByText(/off-patch draft/i)).toBeInTheDocument()
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

// ---------------------------------------------------------------------------
// FileDiff — copy path button (task 4 / item 2)
// ---------------------------------------------------------------------------

describe('FileDiff — copy path button', () => {
  let clipboardWriteText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clipboardWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      writable: true,
      configurable: true,
    })
  })

  it('renders a copy button with aria-label "Copy file path"', () => {
    render(FileDiff, { props: { file: modified, mode: 'unified' } })
    expect(screen.getByRole('button', { name: /copy file path/i })).toBeInTheDocument()
  })

  it('copy button calls navigator.clipboard.writeText with the file path', async () => {
    render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const copyBtn = screen.getByRole('button', { name: /copy file path/i })
    await fireEvent.click(copyBtn)
    expect(clipboardWriteText).toHaveBeenCalledWith('src/a.ts')
  })

  it('shows "Copied" confirmation text after clicking copy', async () => {
    render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const copyBtn = screen.getByRole('button', { name: /copy file path/i })
    await fireEvent.click(copyBtn)
    expect(screen.getByText(/copied/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// FileDiff — colored stat counts (task 4 / item 2)
// ---------------------------------------------------------------------------

describe('FileDiff — colored stat counts', () => {
  it('additions span has class "stat-add"', () => {
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const addSpan = container.querySelector('.stat-add')
    expect(addSpan).toBeInTheDocument()
    expect(addSpan!.textContent).toMatch(/\+/)
  })

  it('deletions span has class "stat-del"', () => {
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    const delSpan = container.querySelector('.stat-del')
    expect(delSpan).toBeInTheDocument()
    expect(delSpan!.textContent).toMatch(/−/)
  })
})

// ---------------------------------------------------------------------------
// FileDiff — test file display modes (task 4 / item 4)
// ---------------------------------------------------------------------------

import { setTestFileDisplay } from '../lib/settings/settings'

const testFile: PrFile = {
  filename: 'src/components/Foo.test.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  patch: '@@ -1,2 +1,2 @@\n-old\n+new\n ctx',
}

describe('FileDiff — test file display modes', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('highlight mode: header has class "test-highlight"', () => {
    setTestFileDisplay('highlight')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    const header = container.querySelector('header')
    expect(header!.classList.contains('test-highlight')).toBe(true)
  })

  it('highlight mode: "test" chip is shown in header', () => {
    setTestFileDisplay('highlight')
    render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(screen.getByText('test')).toBeInTheDocument()
  })

  it('highlight mode: article (whole file card) has class "test-highlight" for the accent left border', () => {
    setTestFileDisplay('highlight')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    const article = container.querySelector('article.file-diff')
    expect(article!.classList.contains('test-highlight')).toBe(true)
  })

  it('highlight mode: no test-dim class (tint+border+chip only)', () => {
    setTestFileDisplay('highlight')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(container.querySelector('.test-dim')).not.toBeInTheDocument()
  })

  it('dim mode: article has class "test-dim"', () => {
    setTestFileDisplay('dim')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    const article = container.querySelector('article.file-diff')
    expect(article!.classList.contains('test-dim')).toBe(true)
  })

  it('dim mode: "test" chip is shown in header', () => {
    setTestFileDisplay('dim')
    render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(screen.getByText('test')).toBeInTheDocument()
  })

  it('dim mode: no test-highlight classes anywhere (no tint, no accent border)', () => {
    setTestFileDisplay('dim')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(container.querySelector('.test-highlight')).not.toBeInTheDocument()
  })

  it('dim mode: test file renders expanded (not collapsed) — dim means opacity only', () => {
    setTestFileDisplay('dim')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(container.querySelector('article.file-diff.is-collapsed')).not.toBeInTheDocument()
  })

  it('normal mode: no test-highlight or test-dim classes', () => {
    setTestFileDisplay('normal')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(container.querySelector('.test-highlight')).not.toBeInTheDocument()
    expect(container.querySelector('.test-dim')).not.toBeInTheDocument()
  })

  it('normal mode: no "test" chip', () => {
    setTestFileDisplay('normal')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })
    expect(container.querySelector('.test-chip')).not.toBeInTheDocument()
  })

  it('non-test file: no test-highlight even in highlight mode', () => {
    setTestFileDisplay('highlight')
    const { container } = render(FileDiff, { props: { file: modified, mode: 'unified' } })
    expect(container.querySelector('.test-highlight')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Bug 2 regression: testFileDisplay must react live (no remount needed)
// ---------------------------------------------------------------------------
describe('FileDiff — testFileDisplay live reactivity (Bug 2 regression)', () => {
  beforeEach(() => { localStorage.clear() })

  it('switching testFileDisplay from normal→highlight adds test-highlight class without remounting', async () => {
    setTestFileDisplay('normal')
    const { container } = render(FileDiff, { props: { file: testFile, mode: 'unified' } })

    // Initially: no highlight
    expect(container.querySelector('header.test-highlight')).not.toBeInTheDocument()

    // Change setting — no remount
    setTestFileDisplay('highlight')
    await tick()

    // After: should have highlight class
    expect(container.querySelector('header.test-highlight')).toBeInTheDocument()
  })
})
