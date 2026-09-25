/**
 * src/lib/guide/botThreads — what the "Hide bots" filter is allowed to touch.
 *
 * The rule under test is the one the whole feature turns on: a bot comment with
 * a HUMAN reply is not a bot thread. The user's own words sit under bot
 * findings on a real PR, and hiding the noise must not hide their answer.
 */
import { describe, it, expect } from 'vitest'
import { isBotThread, isAnsweredBotThread } from './botThreads'
import type { CommentThread } from '../github/commentThreads'
import type { PrComment } from '../github/comments'

let nextId = 1
function c(author: string, body = 'body'): PrComment {
  return {
    id: nextId++,
    author,
    authorAvatar: null,
    body,
    createdAt: '2024-01-01T00:00:00Z',
    path: 'src/a.ts',
    line: 1,
    side: 'RIGHT',
    inReplyTo: null,
  }
}

function thread(root: PrComment, ...replies: PrComment[]): CommentThread {
  return { root, replies }
}

describe('isBotThread — who wrote it', () => {
  it('a GitHub App root with no replies is a bot thread', () => {
    expect(isBotThread(thread(c('posthog[bot]')))).toBe(true)
  })

  it('reuses the shared allowlist, so a plain-account review bot counts too', () => {
    // `coderabbitai` has no [bot] suffix — it is in KNOWN_REVIEW_BOTS.
    expect(isBotThread(thread(c('coderabbitai')))).toBe(true)
  })

  it('a person is never a bot thread', () => {
    expect(isBotThread(thread(c('vdekrijger')))).toBe(false)
  })

  it('the suffix match is case-insensitive, like isReviewBotAuthor', () => {
    expect(isBotThread(thread(c('Veria-AI[BOT]')))).toBe(true)
  })
})

describe('isBotThread — a bot comment with human replies is NOT a bot thread', () => {
  it('one human reply keeps the whole thread', () => {
    expect(isBotThread(thread(c('veria-ai[bot]'), c('vdekrijger', 'Disagree, see below')))).toBe(
      false,
    )
  })

  it('a human reply keeps it even among bot replies', () => {
    expect(
      isBotThread(thread(c('veria-ai[bot]'), c('posthog[bot]'), c('vdekrijger'), c('posthog[bot]'))),
    ).toBe(false)
  })

  it('bots answering bots is still only machines talking — it hides', () => {
    expect(isBotThread(thread(c('veria-ai[bot]'), c('posthog[bot]')))).toBe(true)
  })

  it('a human root is not rescued by bot replies — it was never in scope', () => {
    expect(isBotThread(thread(c('vdekrijger'), c('posthog[bot]')))).toBe(false)
  })
})

describe('isAnsweredBotThread — the count of conversations the filter spares', () => {
  it('is true exactly when a bot root has a human reply', () => {
    expect(isAnsweredBotThread(thread(c('veria-ai[bot]'), c('vdekrijger')))).toBe(true)
  })

  it('is false for an unanswered bot thread', () => {
    expect(isAnsweredBotThread(thread(c('veria-ai[bot]')))).toBe(false)
  })

  it('is false for a human thread', () => {
    expect(isAnsweredBotThread(thread(c('vdekrijger'), c('posthog[bot]')))).toBe(false)
  })

  it('never overlaps isBotThread — every thread is at most one of the two', () => {
    const cases: CommentThread[] = [
      thread(c('veria-ai[bot]')),
      thread(c('veria-ai[bot]'), c('vdekrijger')),
      thread(c('veria-ai[bot]'), c('posthog[bot]')),
      thread(c('vdekrijger')),
      thread(c('vdekrijger'), c('posthog[bot]')),
    ]
    for (const t of cases) {
      expect(isBotThread(t) && isAnsweredBotThread(t)).toBe(false)
    }
  })
})
