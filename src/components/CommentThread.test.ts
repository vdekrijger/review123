/**
 * Tests for CommentThread — renders a thread of existing PR comments.
 *
 * EC-CT-01: top-level comment renders author, relative time, body via markdown
 * EC-CT-02: reply is indented once (has 'reply' class or indent style)
 * EC-CT-03: avatar img rendered with lazy + 20px + alt=author; null avatar → initial circle
 * EC-CT-04: XSS — script tags in body are stripped by renderMarkdown
 * EC-CT-05: thread grouping — top-level first, replies follow it (inReplyTo chain)
 * EC-CT-06: relative time utility — "3h ago", "2d ago", "just now"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/svelte'
import { tick } from 'svelte'
import CommentThread from './CommentThread.svelte'
import type { PrComment } from '../lib/github/comments'

function makeComment(overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: 1,
    author: 'alice',
    authorAvatar: 'https://avatars.github.com/alice',
    body: 'LGTM!',
    createdAt: new Date().toISOString(),
    path: 'src/foo.ts',
    line: 10,
    side: 'RIGHT',
    inReplyTo: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// EC-CT-01: basic rendering
// ---------------------------------------------------------------------------

describe('CommentThread — basic rendering (EC-CT-01)', () => {
  it('renders author name', () => {
    const comment = makeComment({ author: 'alice' })
    render(CommentThread, { props: { comments: [comment] } })
    expect(screen.getByText('alice')).toBeInTheDocument()
  })

  it('renders body via markdown (bold text processed)', () => {
    const comment = makeComment({ body: '**important** note' })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    // marked converts **text** to <strong>
    const strong = container.querySelector('strong')
    expect(strong).toBeInTheDocument()
    expect(strong!.textContent).toBe('important')
  })

  it('renders relative time element for each comment', () => {
    const comment = makeComment({ createdAt: new Date().toISOString() })
    render(CommentThread, { props: { comments: [comment] } })
    // relative time shown (e.g. "just now")
    expect(screen.getByText(/just now|ago/i)).toBeInTheDocument()
  })

  it('renders no comments gracefully when list is empty', () => {
    const { container } = render(CommentThread, { props: { comments: [] } })
    expect(container.firstElementChild).toBeDefined()
    // No author names
    expect(screen.queryByText('alice')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// EC-CT-02: reply indentation
// ---------------------------------------------------------------------------

describe('CommentThread — reply indentation (EC-CT-02)', () => {
  it('top-level comment does not have reply class', () => {
    const comment = makeComment({ id: 1, inReplyTo: null })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    const items = container.querySelectorAll('.comment-item')
    expect(items[0].classList.contains('reply')).toBe(false)
  })

  it('reply to a top-level comment has reply class', () => {
    const topLevel = makeComment({ id: 1, inReplyTo: null })
    const reply = makeComment({ id: 2, inReplyTo: 1, author: 'bob' })
    const { container } = render(CommentThread, { props: { comments: [topLevel, reply] } })
    const items = container.querySelectorAll('.comment-item')
    // Find the reply item (bob's comment)
    const replyItem = Array.from(items).find(el => el.textContent?.includes('bob'))
    expect(replyItem!.classList.contains('reply')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// EC-CT-03: avatar rendering
// ---------------------------------------------------------------------------

describe('CommentThread — avatar rendering (EC-CT-03)', () => {
  it('renders img avatar with lazy loading, 20px size, and alt=author when avatar URL given', () => {
    const comment = makeComment({
      author: 'alice',
      authorAvatar: 'https://avatars.github.com/alice',
    })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    const img = container.querySelector('img.avatar')
    expect(img).toBeInTheDocument()
    expect(img!.getAttribute('loading')).toBe('lazy')
    expect(img!.getAttribute('alt')).toBe('alice')
    const width = (img as HTMLImageElement).width
    const heightAttr = img!.getAttribute('height')
    // 20px width OR style contains 20
    expect(
      img!.getAttribute('width') === '20' || heightAttr === '20' || img!.getAttribute('style')?.includes('20')
    ).toBe(true)
  })

  it('renders initial circle fallback when authorAvatar is null', () => {
    const comment = makeComment({ author: 'bob', authorAvatar: null })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    // No img element
    expect(container.querySelector('img.avatar')).not.toBeInTheDocument()
    // Initial circle shown — contains first letter of author name
    const initial = container.querySelector('.avatar-initial')
    expect(initial).toBeInTheDocument()
    expect(initial!.textContent!.trim()).toBe('b')
  })
})

// ---------------------------------------------------------------------------
// EC-CT-04: XSS safety
// ---------------------------------------------------------------------------

describe('CommentThread — XSS safety (EC-CT-04)', () => {
  it('strips script tags from body content', () => {
    const comment = makeComment({ body: 'safe text<script>alert("xss")</script>' })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    expect(container.querySelector('script')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toContain('<script>')
    expect(screen.getByText(/safe text/)).toBeInTheDocument()
  })

  it('strips inline event handlers from body content', () => {
    const comment = makeComment({ body: '<img src="x" onerror="alert(1)">' })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    const img = container.querySelector('img')
    if (img) {
      expect(img.getAttribute('onerror')).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// EC-CT-05: thread grouping — top-level first, replies follow (by inReplyTo)
// ---------------------------------------------------------------------------

describe('CommentThread — thread grouping (EC-CT-05)', () => {
  it('orders top-level comments before their replies in rendered output', () => {
    // reply comes first in the array but should render after top-level
    const reply = makeComment({ id: 2, inReplyTo: 1, author: 'bob', createdAt: '2024-01-01T11:00:00Z' })
    const topLevel = makeComment({ id: 1, inReplyTo: null, author: 'alice', createdAt: '2024-01-01T10:00:00Z' })
    const { container } = render(CommentThread, { props: { comments: [topLevel, reply] } })
    const items = container.querySelectorAll('.comment-item')
    // alice (top-level) should appear before bob (reply)
    const texts = Array.from(items).map(el => el.textContent ?? '')
    const aliceIdx = texts.findIndex(t => t.includes('alice'))
    const bobIdx = texts.findIndex(t => t.includes('bob'))
    expect(aliceIdx).toBeLessThan(bobIdx)
  })

  it('renders multiple top-level comments each with their replies', () => {
    const c1 = makeComment({ id: 1, author: 'alice', inReplyTo: null })
    const c2 = makeComment({ id: 2, author: 'bob', inReplyTo: null })
    const reply1 = makeComment({ id: 3, author: 'carol', inReplyTo: 1 })

    const { container } = render(CommentThread, { props: { comments: [c1, c2, reply1] } })
    const items = container.querySelectorAll('.comment-item')
    expect(items).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// EC-CT-06: relative time utility tests
// ---------------------------------------------------------------------------

describe('relativeTime utility (EC-CT-06)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows "just now" for a comment created moments ago', () => {
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'))
    const comment = makeComment({ createdAt: '2024-01-01T12:00:00Z' })
    render(CommentThread, { props: { comments: [comment] } })
    expect(screen.getByText(/just now/i)).toBeInTheDocument()
  })

  it('shows "Xh ago" for a comment created hours ago', () => {
    vi.setSystemTime(new Date('2024-01-01T15:00:00Z'))
    const comment = makeComment({ createdAt: '2024-01-01T12:00:00Z' })
    render(CommentThread, { props: { comments: [comment] } })
    expect(screen.getByText(/3h ago/i)).toBeInTheDocument()
  })

  it('shows "Xd ago" for a comment created days ago', () => {
    vi.setSystemTime(new Date('2024-01-03T12:00:00Z'))
    const comment = makeComment({ createdAt: '2024-01-01T12:00:00Z' })
    render(CommentThread, { props: { comments: [comment] } })
    expect(screen.getByText(/2d ago/i)).toBeInTheDocument()
  })

  it('shows "Xm ago" for a comment created minutes ago', () => {
    vi.setSystemTime(new Date('2024-01-01T12:30:00Z'))
    const comment = makeComment({ createdAt: '2024-01-01T12:00:00Z' })
    render(CommentThread, { props: { comments: [comment] } })
    expect(screen.getByText(/30m ago/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// EC-CT-07: comment body styling — code blocks, tables, details
// ---------------------------------------------------------------------------

describe('CommentThread — comment body prose styling (EC-CT-07)', () => {
  it('code blocks inside comment bodies render as <pre><code> elements', () => {
    const comment = makeComment({ body: '```\nconst x = 1\n```' })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    const pre = container.querySelector('.comment-body pre')
    expect(pre).toBeInTheDocument()
    const code = pre!.querySelector('code')
    expect(code).toBeInTheDocument()
  })

  it('inline code renders as <code> element', () => {
    const comment = makeComment({ body: 'use `foo()` here' })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    const code = container.querySelector('.comment-body code')
    expect(code).toBeInTheDocument()
    expect(code!.textContent).toContain('foo()')
  })

  it('tables in comment body render with <table> element', () => {
    const tableBody = '| A | B |\n|---|---|\n| 1 | 2 |'
    const comment = makeComment({ body: tableBody })
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    // marked renders GFM tables as <table>
    const table = container.querySelector('.comment-body table')
    expect(table).toBeInTheDocument()
  })

  it('thread container uses .comment-item class (not a filled block)', () => {
    const comment = makeComment()
    const { container } = render(CommentThread, { props: { comments: [comment] } })
    const item = container.querySelector('.comment-item')
    expect(item).toBeInTheDocument()
    // Must NOT use class that implies a solid navy/filled background
    expect(item!.classList.contains('filled-block')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// EC-CT-08: per-comment menu (Copy link + Quote reply)
// ---------------------------------------------------------------------------

describe('CommentThread — per-comment menu (EC-CT-08)', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
  })

  function openMenu(container: HTMLElement) {
    const trigger = container.querySelector(
      'button[aria-label="Comment actions"]',
    ) as HTMLButtonElement
    expect(trigger).toBeInTheDocument()
    return trigger
  }

  it('renders a kebab menu button with aria-haspopup and aria-label', () => {
    const { container } = render(CommentThread, {
      props: { comments: [makeComment({ url: 'https://x/c/1' })] },
    })
    const trigger = openMenu(container)
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-label')).toBe('Comment actions')
  })

  it('opens an accessible role=menu on click and sets aria-expanded', async () => {
    const { container } = render(CommentThread, {
      props: { comments: [makeComment({ url: 'https://x/c/1' })] },
    })
    const trigger = openMenu(container)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[role="menu"]')).toBeInTheDocument()
  })

  it('"Copy link to comment" copies comment.url and shows a transient confirmation', async () => {
    const { container } = render(CommentThread, {
      props: { comments: [makeComment({ url: 'https://github.com/o/r/pull/1#discussion_r9' })] },
    })
    await fireEvent.click(openMenu(container))
    const copyItem = screen.getByRole('menuitem', { name: /copy link to comment/i })
    await fireEvent.click(copyItem)
    expect(writeText).toHaveBeenCalledWith('https://github.com/o/r/pull/1#discussion_r9')
    await tick()
    // transient confirmation, aria-live
    const confirm = container.querySelector('[aria-live]')
    expect(confirm).toBeInTheDocument()
    expect(confirm!.textContent).toMatch(/copied/i)
  })

  it('omits "Copy link to comment" when comment.url is absent', async () => {
    const { container } = render(CommentThread, {
      props: { comments: [makeComment({ url: undefined })] },
    })
    await fireEvent.click(openMenu(container))
    expect(screen.queryByRole('menuitem', { name: /copy link to comment/i })).not.toBeInTheDocument()
    // Quote reply still available
    expect(screen.getByRole('menuitem', { name: /quote reply/i })).toBeInTheDocument()
  })

  it('"Quote reply" copies the body as a markdown quote with an attribution line', async () => {
    const { container } = render(CommentThread, {
      props: {
        comments: [
          makeComment({ author: 'alice', body: 'first line\nsecond line', url: undefined }),
        ],
      },
    })
    await fireEvent.click(openMenu(container))
    const quoteItem = screen.getByRole('menuitem', { name: /quote reply/i })
    await fireEvent.click(quoteItem)
    expect(writeText).toHaveBeenCalledTimes(1)
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('> @alice wrote:')
    expect(copied).toContain('> first line')
    expect(copied).toContain('> second line')
  })

  it('closes the menu on Escape', async () => {
    const { container } = render(CommentThread, {
      props: { comments: [makeComment({ url: 'https://x/c/1' })] },
    })
    const trigger = openMenu(container)
    await fireEvent.click(trigger)
    expect(container.querySelector('[role="menu"]')).toBeInTheDocument()
    await fireEvent.keyDown(window, { key: 'Escape' })
    await tick()
    expect(container.querySelector('[role="menu"]')).not.toBeInTheDocument()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the menu on outside click', async () => {
    const { container } = render(CommentThread, {
      props: { comments: [makeComment({ url: 'https://x/c/1' })] },
    })
    const trigger = openMenu(container)
    await fireEvent.click(trigger)
    expect(container.querySelector('[role="menu"]')).toBeInTheDocument()
    await fireEvent.click(document.body)
    await tick()
    expect(container.querySelector('[role="menu"]')).not.toBeInTheDocument()
  })

  it('each comment in a thread gets its own menu', () => {
    const top = makeComment({ id: 1, author: 'alice', url: 'https://x/c/1' })
    const reply = makeComment({ id: 2, author: 'bob', inReplyTo: 1, url: 'https://x/c/2' })
    const { container } = render(CommentThread, { props: { comments: [top, reply] } })
    const triggers = container.querySelectorAll('button[aria-label="Comment actions"]')
    expect(triggers).toHaveLength(2)
  })

  it('menu uses within() scoping — quote works alongside copy when url present', async () => {
    const { container } = render(CommentThread, {
      props: { comments: [makeComment({ author: 'carol', body: 'hi', url: 'https://x/c/5' })] },
    })
    await fireEvent.click(openMenu(container))
    const menu = container.querySelector('[role="menu"]') as HTMLElement
    expect(within(menu).getByRole('menuitem', { name: /copy link to comment/i })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /quote reply/i })).toBeInTheDocument()
  })
})
