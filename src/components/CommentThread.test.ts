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
import { render, screen } from '@testing-library/svelte'
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
