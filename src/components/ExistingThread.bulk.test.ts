/**
 * ExistingThread × what a revealed bot comment costs to show.
 *
 * In the screenshot that prompted the filter, each posthog[bot] comment spent
 * ~200px rendering four collapsed <details> and no content. These tests pin the
 * two narrow rewrites ExistingThread applies (src/lib/guide/botCommentBody) and,
 * more importantly, the cases where it must leave the markdown alone.
 *
 * The rendered-CSS half of this work — the global `details > summary` rule's
 * font-weight leaking into a bot comment's own section labels — is asserted in
 * e2e/bot-comments.spec.ts, where a real browser resolves the cascade.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import ExistingThread from './ExistingThread.svelte'
import type { PrComment } from '../lib/github/comments'
import type { CommentThread } from '../lib/github/commentThreads'

function comment(overrides: Partial<PrComment> & { id: number }): PrComment {
  return {
    author: 'posthog[bot]',
    authorAvatar: null,
    body: 'body',
    createdAt: '2024-01-01T10:00:00Z',
    path: 'src/a.ts',
    line: 2,
    side: 'RIGHT',
    inReplyTo: null,
    ...overrides,
  }
}

const FOUR_SECTIONS = [
  '<details><summary>Issue description</summary>',
  '',
  'The catch block re-throws without a handler.',
  '',
  '</details>',
  '<details><summary>Why we think it is a valid issue</summary>',
  '',
  'Unhandled rejections crash the page.',
  '',
  '</details>',
  '<details><summary>Suggested fix</summary>',
  '',
  'Route the failure to component state.',
  '',
  '</details>',
  '<details><summary>Prompt to fix with AI (copy-paste)</summary>',
  '',
  'PASTE-ME-SOMEWHERE-ELSE',
  '',
  '</details>',
].join('\n')

function thread(root: PrComment, replies: PrComment[] = []): CommentThread {
  return { root, replies }
}

function renderBody(body: string, author = 'posthog[bot]') {
  return render(ExistingThread, {
    props: { thread: thread(comment({ id: 1, author, body })) },
  })
}

describe('a body that is nothing but disclosures', () => {
  it('opens the first section so the reader lands on content, not a shut door', () => {
    const { container } = renderBody(FOUR_SECTIONS)
    const all = container.querySelectorAll('.comment-body details')
    expect(all.length).toBeGreaterThan(0)
    expect(all[0].hasAttribute('open')).toBe(true)
    expect(container.textContent).toContain('The catch block re-throws without a handler.')
  })

  it('leaves the remaining sections shut — one open row, not four', () => {
    const { container } = renderBody(FOUR_SECTIONS)
    const open = container.querySelectorAll('.comment-body details[open]')
    expect(open).toHaveLength(1)
  })

  it('a body with prose outside the disclosures is untouched', () => {
    const { container } = renderBody('P1 Broken.\n\n<details><summary>Detail</summary>\n\nx\n\n</details>')
    expect(container.querySelector('.comment-body details[open]')).toBeNull()
    expect(container.textContent).toContain('P1 Broken.')
  })

  it("applies to a person's disclosure-only comment too — same problem, nothing removed", () => {
    const { container } = renderBody(
      '<details><summary>Long log</summary>\n\nthe log\n\n</details>',
      'vdekrijger',
    )
    expect(container.querySelector('.comment-body details[open]')).not.toBeNull()
  })
})

describe('the copy-paste AI prompt section', () => {
  it('is dropped from a bot comment, and the thread says so', () => {
    const { container } = renderBody(FOUR_SECTIONS)
    expect(container.textContent).not.toContain('PASTE-ME-SOMEWHERE-ELSE')
    expect(container.textContent).not.toContain('Prompt to fix with AI')
    expect(screen.getByTestId('bot-prompt-section-hidden').textContent).toMatch(
      /Copy-paste AI prompt hidden/i,
    )
  })

  it('keeps every other section of the same comment', () => {
    const { container } = renderBody(FOUR_SECTIONS)
    for (const label of ['Issue description', 'Why we think it is a valid issue', 'Suggested fix']) {
      expect(container.textContent).toContain(label)
    }
  })

  it("is NOT dropped from a person's comment — the rule is about bots", () => {
    const { container } = renderBody(FOUR_SECTIONS, 'vdekrijger')
    expect(container.textContent).toContain('Prompt to fix with AI')
    expect(screen.queryByTestId('bot-prompt-section-hidden')).not.toBeInTheDocument()
  })

  it('draws no note when nothing was dropped', () => {
    renderBody('Just a sentence about the code.')
    expect(screen.queryByTestId('bot-prompt-section-hidden')).not.toBeInTheDocument()
  })

  it('one note per thread, however many comments lost a section', () => {
    render(ExistingThread, {
      props: {
        thread: thread(comment({ id: 1, body: FOUR_SECTIONS }), [
          comment({ id: 2, body: FOUR_SECTIONS, inReplyTo: 1, author: 'veria-ai[bot]' }),
        ]),
      },
    })
    expect(screen.getAllByTestId('bot-prompt-section-hidden')).toHaveLength(1)
  })

  it('never empties a comment: a body that is ONLY that section survives whole', () => {
    const { container } = renderBody(
      '<details><summary>Prompt to fix with AI (copy-paste)</summary>\n\nKEEP-ME\n\n</details>',
    )
    expect(container.textContent).toContain('KEEP-ME')
    expect(screen.queryByTestId('bot-prompt-section-hidden')).not.toBeInTheDocument()
  })
})

describe('ordinary comments are not rewritten', () => {
  it('prose passes through', () => {
    const { container } = renderBody('Should `signal` be required rather than optional?')
    expect(container.textContent).toContain('Should signal be required rather than optional?')
    expect(screen.queryByTestId('bot-prompt-section-hidden')).not.toBeInTheDocument()
  })

  it('the resolved summary still recaps the ORIGINAL root body', () => {
    const { container } = render(ExistingThread, {
      props: { thread: thread(comment({ id: 1, body: FOUR_SECTIONS })), resolved: true },
    })
    expect(container.querySelector('summary.resolved-summary')!.textContent).toContain(
      'posthog[bot]',
    )
  })
})

describe('the reply affordance is quieter, not gone', () => {
  it('still says "Reply (posts now)" and still opens the editor', async () => {
    render(ExistingThread, {
      props: {
        thread: thread(comment({ id: 1, body: 'x' })),
        onReply: async () => ({ ok: true as const, comment: comment({ id: 2 }) }),
      },
    })
    expect(screen.getByRole('button', { name: 'Reply (posts now)' })).toBeInTheDocument()
  })
})
