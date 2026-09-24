/**
 * ExistingThread — thread display + reply affordance tests.
 *
 * - renders root + replies (replies indented via CommentThread)
 * - resolved threads collapse into <details class="resolved-thread">
 * - Reply affordance only when onReply provided (capability-gated by parent)
 * - honest button copy: "Reply (posts now)" — replies post immediately,
 *   unlike drafts which are queued with the review
 * - reply posting via DI seam (onReply prop, typed Result):
 *     ok    → editor closes, value cleared
 *     error → error surfaced, editor keeps text for retry
 * - optimistic insert: pending body visible in the thread while in flight
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/svelte'
import ExistingThread from './ExistingThread.svelte'
import componentSource from './ExistingThread.svelte?raw'
import type { PrComment } from '../lib/github/comments'
import type { CommentThread } from '../lib/github/commentThreads'
import type { ReplyOutcome } from '../lib/github/replies'

function comment(overrides: Partial<PrComment> & { id: number }): PrComment {
  return {
    author: 'alice',
    authorAvatar: null,
    body: `body ${overrides.id}`,
    createdAt: '2024-01-01T10:00:00Z',
    path: 'src/a.ts',
    line: 2,
    side: 'RIGHT',
    inReplyTo: null,
    ...overrides,
  }
}

function makeThread(): CommentThread {
  return {
    root: comment({ id: 1, body: 'root body' }),
    replies: [comment({ id: 2, body: 'reply body', inReplyTo: 1, author: 'bob' })],
  }
}

describe('ExistingThread — display', () => {
  it('renders root and reply bodies, reply indented', () => {
    const { container } = render(ExistingThread, { props: { thread: makeThread() } })
    expect(screen.getByText(/root body/)).toBeInTheDocument()
    expect(screen.getByText(/reply body/)).toBeInTheDocument()
    expect(container.querySelector('.comment-item.reply')).toBeInTheDocument()
  })

  it('resolved=true collapses into a <details class="resolved-thread">', () => {
    const { container } = render(ExistingThread, {
      props: { thread: makeThread(), resolved: true },
    })
    const details = container.querySelector('details.resolved-thread')
    expect(details).toBeInTheDocument()
    expect(details!.querySelector('summary.resolved-summary')!.textContent).toMatch(/resolved/i)
    expect(details!.textContent).toContain('alice')
  })

  it('no onReply → no Reply affordance (provider lacks capability)', () => {
    render(ExistingThread, { props: { thread: makeThread() } })
    expect(screen.queryByRole('button', { name: /reply/i })).not.toBeInTheDocument()
  })
})

/**
 * The resolved summary is a one-line RECAP. Two bugs made it read as garbage:
 * the global `details > summary` uppercase reached the prose, and the 60-char
 * slice happened on the RAW body, so a comment opening with a badge image
 * showed `<a href="#"><img alt="P1" src="https://…` instead of any words.
 */
describe('ExistingThread — resolved summary snippet', () => {
  /** The snippet with the `author: ` prefix removed — just the recapped body. */
  function resolvedSnippet(body: string): string {
    const { container } = render(ExistingThread, {
      props: { thread: { root: comment({ id: 1, body }), replies: [] }, resolved: true },
    })
    const text = container.querySelector('.resolved-snippet')!.textContent!
    expect(text.startsWith('alice: ')).toBe(true)
    return text.slice('alice: '.length)
  }

  it('strips a leading HTML link+image (the bot case) instead of spending the budget on tags', () => {
    const body =
      '<a href="#"><img alt="P1" src="https://greptile-static-assets.s3.amazonaws.com/p1.svg"></a> ' +
      'Potential race condition when two fetches settle out of order.'
    const text = resolvedSnippet(body)
    expect(text).not.toContain('<')
    expect(text).not.toContain('href')
    expect(text).not.toContain('src=')
    // Image alt text is content — kept, like any plain-text rendering of an image
    expect(text).toContain('P1')
    expect(text).toContain('Potential race condition')
  })

  it('strips a leading markdown badge image and keeps its alt text', () => {
    const text = resolvedSnippet('![P1](https://example.com/p1.svg) Unhandled rejection here.')
    expect(text).toContain('P1')
    expect(text).toContain('Unhandled rejection here.')
    expect(text).not.toContain('https://')
  })

  it('renders link text, not the URL', () => {
    const text = resolvedSnippet('See [the debounce helper](https://example.com/a/very/long/url) for this.')
    expect(text).toContain('the debounce helper')
    expect(text).not.toContain('https://example.com')
  })

  it('truncates on the PLAIN text, so 60 chars are 60 chars of content', () => {
    const prose = 'A'.repeat(200)
    const text = resolvedSnippet(`<img alt="" src="https://example.com/very/long/badge.svg"> ${prose}`)
    expect(text.endsWith('…')).toBe(true)
    // 60 content chars + the ellipsis — none of the budget eaten by the tag
    expect(text).toBe('A'.repeat(60) + '…')
  })

  it('short bodies are left whole, with no ellipsis', () => {
    expect(resolvedSnippet('Fixed, thanks.')).toBe('Fixed, thanks.')
  })

  it('drops markdown emphasis, code fences, headings, quotes and bullets', () => {
    const text = resolvedSnippet('> **Nit:** use `DEBOUNCE_MS`\n\n- and a bullet')
    expect(text).toContain('Nit:')
    expect(text).toContain('DEBOUNCE_MS') // underscores in identifiers survive
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
    expect(text).not.toContain('>')
    expect(text).not.toMatch(/^\s*-/)
  })

  it('decodes the common HTML entities', () => {
    expect(resolvedSnippet('a &lt; b &amp;&amp; c &gt; d')).toBe('a < b && c > d')
  })

  it('leaves a bare comparison alone (not every angle bracket is a tag)', () => {
    expect(resolvedSnippet('guard that a < b before the slice')).toBe('guard that a < b before the slice')
  })
})

describe('ExistingThread — resolved summary casing (static CSS guard)', () => {
  const css = componentSource.match(/<style[^>]*>([\s\S]*?)<\/style>/)![1]

  /** The declaration block of a single-class rule in this component's <style>. */
  function block(className: string): string {
    const match = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`))
    expect(match, `no .${className} rule in ExistingThread.svelte`).not.toBeNull()
    return match![1]
  }

  it('.resolved-summary resets the global details>summary uppercase (prose must keep word shape)', () => {
    const rule = block('resolved-summary')
    expect(rule).toMatch(/text-transform:\s*none/)
    expect(rule).toMatch(/letter-spacing:\s*normal/)
  })

  it('.resolved-label re-applies the editorial caps — the LABEL, not the snippet', () => {
    const rule = block('resolved-label')
    expect(rule).toMatch(/text-transform:\s*uppercase/)
  })

  it('.resolved-snippet never sets a text-transform of its own', () => {
    expect(block('resolved-snippet')).not.toMatch(/text-transform/)
  })
})

describe('ExistingThread — reply flow (DI seam via onReply)', () => {
  it('shows the honest "Reply (posts now)" affordance when onReply is provided', () => {
    render(ExistingThread, {
      props: { thread: makeThread(), onReply: vi.fn() },
    })
    expect(screen.getByRole('button', { name: 'Reply (posts now)' })).toBeInTheDocument()
  })

  it('clicking Reply opens the standard comment editor with an immediate-post hint', async () => {
    render(ExistingThread, {
      props: { thread: makeThread(), onReply: vi.fn() },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Reply (posts now)' }))
    expect(screen.getByRole('textbox', { name: /comment body/i })).toBeInTheDocument()
    expect(screen.getByText(/posts immediately to the PR/i)).toBeInTheDocument()
  })

  it('successful post: calls onReply with root + body, clears and closes the editor', async () => {
    const thread = makeThread()
    const onReply = vi.fn(async (): Promise<ReplyOutcome> => ({
      ok: true,
      comment: comment({ id: 99, body: 'posted', inReplyTo: 1 }),
    }))
    render(ExistingThread, { props: { thread, onReply } })

    await fireEvent.click(screen.getByRole('button', { name: 'Reply (posts now)' }))
    const textarea = screen.getByRole('textbox', { name: /comment body/i })
    await fireEvent.input(textarea, { target: { value: 'my new reply' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Reply (posts now)' }))

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith(thread.root, 'my new reply')
      // Editor closed after success
      expect(screen.queryByRole('textbox', { name: /comment body/i })).not.toBeInTheDocument()
    })
  })

  it('optimistic insert: pending reply body visible in the thread while posting', async () => {
    let resolvePost!: (v: ReplyOutcome) => void
    const onReply = vi.fn(() => new Promise<ReplyOutcome>((resolve) => { resolvePost = resolve }))
    render(ExistingThread, { props: { thread: makeThread(), onReply } })

    await fireEvent.click(screen.getByRole('button', { name: 'Reply (posts now)' }))
    await fireEvent.input(screen.getByRole('textbox', { name: /comment body/i }), {
      target: { value: 'optimistic reply' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Reply (posts now)' }))

    // While in flight: pending entry shown in the thread
    const pending = screen.getByTestId('reply-pending')
    expect(pending.textContent).toContain('optimistic reply')
    expect(pending.textContent).toMatch(/posting/i)

    resolvePost({ ok: true, comment: comment({ id: 99, body: 'optimistic reply', inReplyTo: 1 }) })
    await vi.waitFor(() => {
      expect(screen.queryByTestId('reply-pending')).not.toBeInTheDocument()
    })
  })

  it('failed post: typed error surfaced, pending removed, editor keeps text for retry', async () => {
    const onReply = vi.fn(async (): Promise<ReplyOutcome> => ({
      ok: false,
      message: 'GitHub server error (HTTP 500).',
    }))
    render(ExistingThread, { props: { thread: makeThread(), onReply } })

    await fireEvent.click(screen.getByRole('button', { name: 'Reply (posts now)' }))
    await fireEvent.input(screen.getByRole('textbox', { name: /comment body/i }), {
      target: { value: 'doomed reply' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Reply (posts now)' }))

    await vi.waitFor(() => {
      expect(screen.getByTestId('reply-error').textContent).toContain('GitHub server error (HTTP 500).')
    })
    // Optimistic entry removed on failure
    expect(screen.queryByTestId('reply-pending')).not.toBeInTheDocument()
    // Editor still open, text preserved for retry
    const textarea = screen.getByRole('textbox', { name: /comment body/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe('doomed reply')
  })

  it('submit button disabled while empty and while posting', async () => {
    let resolvePost!: (v: ReplyOutcome) => void
    const onReply = vi.fn(() => new Promise<ReplyOutcome>((resolve) => { resolvePost = resolve }))
    render(ExistingThread, { props: { thread: makeThread(), onReply } })

    await fireEvent.click(screen.getByRole('button', { name: 'Reply (posts now)' }))
    const submit = screen.getByRole('button', { name: 'Reply (posts now)' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    await fireEvent.input(screen.getByRole('textbox', { name: /comment body/i }), {
      target: { value: 'x' },
    })
    expect((submit as HTMLButtonElement).disabled).toBe(false)

    await fireEvent.click(submit)
    expect(screen.getByRole('button', { name: /posting/i })).toBeDisabled()
    resolvePost({ ok: true, comment: comment({ id: 99, inReplyTo: 1 }) })
  })
})
