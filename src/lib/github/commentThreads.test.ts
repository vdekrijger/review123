import { describe, it, expect } from 'vitest'
import { groupThreads, threadComments } from './commentThreads'
import type { PrComment } from './comments'

// ---------------------------------------------------------------------------
// Fixture: shaped like real GitHub REST review comments after mapping
// (in_reply_to_id → inReplyTo). Ids and chains mirror GitHub semantics where
// replies reference the thread ROOT id.
// ---------------------------------------------------------------------------

function c(overrides: Partial<PrComment> & { id: number }): PrComment {
  return {
    author: 'alice',
    authorAvatar: null,
    body: `comment ${overrides.id}`,
    createdAt: '2024-01-01T10:00:00Z',
    path: 'src/a.ts',
    line: 2,
    side: 'RIGHT',
    inReplyTo: null,
    ...overrides,
  }
}

// GitHub fixture: two threads on the same file, one with an in_reply_to_id
// chain (root 100 ← 101 ← 102), one single-comment thread (200), plus a
// file-level issue comment (300, line null).
const githubFixture: PrComment[] = [
  c({ id: 100, body: 'root of thread A', createdAt: '2024-01-01T10:00:00Z' }),
  c({ id: 101, body: 'first reply', inReplyTo: 100, author: 'bob', createdAt: '2024-01-01T11:00:00Z' }),
  c({ id: 102, body: 'second reply', inReplyTo: 100, author: 'carol', createdAt: '2024-01-01T12:00:00Z' }),
  c({ id: 200, body: 'thread B root', line: 7, createdAt: '2024-01-01T10:30:00Z' }),
  c({ id: 300, body: 'general comment', path: null, line: null, side: null, createdAt: '2024-01-01T09:00:00Z' }),
]

describe('groupThreads — GitHub in_reply_to_id chains', () => {
  it('groups a root with its replies into one thread', () => {
    const threads = groupThreads(githubFixture)
    const threadA = threads.find((t) => t.root.id === 100)
    expect(threadA).toBeDefined()
    expect(threadA!.replies.map((r) => r.id)).toEqual([101, 102])
  })

  it('keeps independent roots as separate threads (input order preserved)', () => {
    const threads = groupThreads(githubFixture)
    expect(threads.map((t) => t.root.id)).toEqual([100, 200, 300])
  })

  it('sorts replies chronologically even when input order is shuffled', () => {
    const shuffled = [githubFixture[2], githubFixture[0], githubFixture[1]]
    const threads = groupThreads(shuffled)
    expect(threads).toHaveLength(1)
    expect(threads[0].replies.map((r) => r.id)).toEqual([101, 102])
  })

  it('attaches replies-to-replies to the root thread (transitive chains)', () => {
    const chain: PrComment[] = [
      c({ id: 1, body: 'root' }),
      c({ id: 2, inReplyTo: 1, createdAt: '2024-01-01T11:00:00Z' }),
      // references the reply, not the root — must still land in thread 1
      c({ id: 3, inReplyTo: 2, createdAt: '2024-01-01T12:00:00Z' }),
    ]
    const threads = groupThreads(chain)
    expect(threads).toHaveLength(1)
    expect(threads[0].root.id).toBe(1)
    expect(threads[0].replies.map((r) => r.id)).toEqual([2, 3])
  })

  it('orphan replies (unknown parent) become standalone threads, not dropped', () => {
    const withOrphan = [...githubFixture, c({ id: 999, inReplyTo: 555, body: 'orphan' })]
    const threads = groupThreads(withOrphan)
    const orphanThread = threads.find((t) => t.root.id === 999)
    expect(orphanThread).toBeDefined()
    expect(orphanThread!.replies).toEqual([])
    // total comments preserved
    const total = threads.reduce((n, t) => n + 1 + t.replies.length, 0)
    expect(total).toBe(withOrphan.length)
  })

  it('empty input → no threads', () => {
    expect(groupThreads([])).toEqual([])
  })

  it('threadComments returns root first, then replies', () => {
    const threads = groupThreads(githubFixture)
    const threadA = threads.find((t) => t.root.id === 100)!
    expect(threadComments(threadA).map((x) => x.id)).toEqual([100, 101, 102])
  })
})

// ---------------------------------------------------------------------------
// GitLab discussions fixture: the gitlab provider maps each discussion's first
// note as root and later notes as replies (inReplyTo = root id, threadId =
// discussion id). Verify grouping reconstructs the discussions.
// ---------------------------------------------------------------------------

const gitlabFixture: PrComment[] = [
  // discussion "abc": 2 notes
  c({ id: 11, body: 'gl root', threadId: 'abc', createdAt: '2024-02-01T10:00:00Z' }),
  c({ id: 12, body: 'gl reply', threadId: 'abc', inReplyTo: 11, author: 'dora', createdAt: '2024-02-01T10:05:00Z' }),
  // discussion "def": single note
  c({ id: 21, body: 'gl single', threadId: 'def', line: 9, createdAt: '2024-02-01T11:00:00Z' }),
]

describe('groupThreads — GitLab discussion-mapped comments', () => {
  it('reconstructs each discussion as one thread', () => {
    const threads = groupThreads(gitlabFixture)
    expect(threads.map((t) => t.root.id)).toEqual([11, 21])
    expect(threads[0].replies.map((r) => r.id)).toEqual([12])
  })

  it('threadId is preserved on root and replies (needed for reply posting)', () => {
    const threads = groupThreads(gitlabFixture)
    expect(threads[0].root.threadId).toBe('abc')
    expect(threads[0].replies[0].threadId).toBe('abc')
  })
})
