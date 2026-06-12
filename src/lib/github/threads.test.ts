/**
 * Tests for getResolvedCommentIds — fetches resolved thread state from GraphQL.
 *
 * EC-THREAD-01: parses resolved threads and collects comment databaseIds
 * EC-THREAD-02: unresolved threads are excluded from the result set
 * EC-THREAD-03: no auth token → returns empty Set WITHOUT a network call
 * EC-THREAD-04: HTTP failure → returns empty Set (non-fatal)
 * EC-THREAD-05: GraphQL errors in response body → returns empty Set (non-fatal)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getResolvedCommentIds } from './threads'
import { jsonResponse } from '../../test-helpers'

const REF = { owner: 'acme', repo: 'web', number: 7 }

function makeGraphQLResponse(threads: Array<{ isResolved: boolean; commentIds: number[] }>) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threads.map((t) => ({
              isResolved: t.isResolved,
              comments: {
                nodes: t.commentIds.map((id) => ({ databaseId: id })),
              },
            })),
          },
        },
      },
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// EC-THREAD-01: parses resolved threads and collects databaseIds
// ---------------------------------------------------------------------------

describe('getResolvedCommentIds — collects resolved comment ids (EC-THREAD-01)', () => {
  it('returns databaseIds of all comments in resolved threads', async () => {
    const body = makeGraphQLResponse([
      { isResolved: true, commentIds: [101, 102] },
    ])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(body)))
    // Seed a token so the auth guard fires
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
    )

    const ids = await getResolvedCommentIds(REF)
    expect(ids).toBeInstanceOf(Set)
    expect(ids.has(101)).toBe(true)
    expect(ids.has(102)).toBe(true)
    expect(ids.size).toBe(2)
  })

  it('collects ids across multiple resolved threads', async () => {
    const body = makeGraphQLResponse([
      { isResolved: true, commentIds: [1, 2] },
      { isResolved: true, commentIds: [3] },
    ])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(body)))
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
    )

    const ids = await getResolvedCommentIds(REF)
    expect(ids.size).toBe(3)
    expect(ids.has(1)).toBe(true)
    expect(ids.has(2)).toBe(true)
    expect(ids.has(3)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// EC-THREAD-02: unresolved threads excluded
// ---------------------------------------------------------------------------

describe('getResolvedCommentIds — excludes unresolved threads (EC-THREAD-02)', () => {
  it('does not include comment ids from unresolved threads', async () => {
    const body = makeGraphQLResponse([
      { isResolved: false, commentIds: [200, 201] },
    ])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(body)))
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
    )

    const ids = await getResolvedCommentIds(REF)
    expect(ids.size).toBe(0)
  })

  it('only includes ids from resolved threads when mixed', async () => {
    const body = makeGraphQLResponse([
      { isResolved: true, commentIds: [10] },
      { isResolved: false, commentIds: [20] },
    ])

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(body)))
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
    )

    const ids = await getResolvedCommentIds(REF)
    expect(ids.has(10)).toBe(true)
    expect(ids.has(20)).toBe(false)
    expect(ids.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// EC-THREAD-03: no auth token → empty Set, no network call
// ---------------------------------------------------------------------------

describe('getResolvedCommentIds — no auth token short-circuit (EC-THREAD-03)', () => {
  it('returns empty Set without calling fetch when no auth token is set', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    // No settings seeded → no token

    const ids = await getResolvedCommentIds(REF)
    expect(ids).toBeInstanceOf(Set)
    expect(ids.size).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// EC-THREAD-04: HTTP failure → empty Set (non-fatal)
// ---------------------------------------------------------------------------

describe('getResolvedCommentIds — HTTP failure → empty Set (EC-THREAD-04)', () => {
  it('returns empty Set on HTTP 500 without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, {}, 500)))
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
    )

    const ids = await getResolvedCommentIds(REF)
    expect(ids).toBeInstanceOf(Set)
    expect(ids.size).toBe(0)
  })

  it('returns empty Set on network error without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('network failed')))
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
    )

    const ids = await getResolvedCommentIds(REF)
    expect(ids).toBeInstanceOf(Set)
    expect(ids.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// EC-THREAD-05: GraphQL errors in response → empty Set (non-fatal)
// ---------------------------------------------------------------------------

describe('getResolvedCommentIds — GraphQL errors → empty Set (EC-THREAD-05)', () => {
  it('returns empty Set when response contains a GraphQL errors array', async () => {
    const body = { errors: [{ message: 'Field does not exist on type' }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(body)))
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
    )

    const ids = await getResolvedCommentIds(REF)
    expect(ids).toBeInstanceOf(Set)
    expect(ids.size).toBe(0)
  })

  it('returns empty Set when data.repository is missing', async () => {
    const body = { data: null }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(body)))
    localStorage.setItem(
      'review123:settings',
      JSON.stringify({ githubAuth: { token: 'ghp_x', method: 'pat', scopes: [] } }),
    )

    const ids = await getResolvedCommentIds(REF)
    expect(ids).toBeInstanceOf(Set)
    expect(ids.size).toBe(0)
  })
})
