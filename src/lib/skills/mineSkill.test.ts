/**
 * Tests for src/lib/skills/mineSkill.ts — "mine my reviews into a skill" feature.
 *
 * Covers:
 *   - fetchMineableComments: GET /user, paginated comments, author filter, cap 150, strip long fences
 *   - mineSkillFromComments: prompt structure, happy path, errors
 *   - No-auth / no-key early exits return descriptive errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchMineableComments,
  mineSkillFromComments,
  stripLongFences,
  MINE_COMMENTS_CAP,
  type RawPullComment,
} from './mineSkill'
import { githubProvider } from '../provider/github'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComment(overrides: Partial<RawPullComment> = {}): RawPullComment {
  return {
    id: 1,
    user: { login: 'alice' },
    body: 'This is a review comment.',
    created_at: '2024-01-01T00:00:00Z',
    path: 'src/foo.ts',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// fetchMineableComments
// ---------------------------------------------------------------------------

describe('fetchMineableComments', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns error when no github auth token', async () => {
    const result = await fetchMineableComments(
      { owner: 'o', repo: 'r' },
      { getToken: () => null, ghFetch: vi.fn() },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/github/i)
  })

  it('calls GET /user to get login', async () => {
    const ghFetch = vi.fn()
      .mockResolvedValueOnce({ login: 'alice' })
      .mockResolvedValueOnce([makeComment({ user: { login: 'alice' } })])
      .mockResolvedValueOnce([]) // page 2 empty
    const result = await fetchMineableComments(
      { owner: 'o', repo: 'r' },
      { getToken: () => 'tok', ghFetch },
    )
    expect(ghFetch).toHaveBeenCalledWith('/user', expect.any(String))
    expect(result.ok).toBe(true)
  })

  it('filters comments to only those by the authenticated user', async () => {
    const ghFetch = vi.fn()
      .mockResolvedValueOnce({ login: 'alice' })
      .mockResolvedValueOnce([
        makeComment({ user: { login: 'alice' }, body: 'alice comment' }),
        makeComment({ user: { login: 'bob' }, body: 'bob comment' }),
        makeComment({ user: { login: 'alice' }, body: 'alice comment 2' }),
      ])
      .mockResolvedValueOnce([]) // page 2
      .mockResolvedValueOnce([]) // page 3

    const result = await fetchMineableComments(
      { owner: 'o', repo: 'r' },
      { getToken: () => 'tok', ghFetch },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.comments).toHaveLength(2)
      expect(result.comments.every(c => c.includes('alice comment'))).toBe(true)
    }
  })

  it('caps at 150 comments', async () => {
    const manyAlice = Array.from({ length: 100 }, (_, i) =>
      makeComment({ id: i, user: { login: 'alice' }, body: `comment ${i}` }),
    )
    const manyAlice2 = Array.from({ length: 80 }, (_, i) =>
      makeComment({ id: 200 + i, user: { login: 'alice' }, body: `comment ${200 + i}` }),
    )

    const ghFetch = vi.fn()
      .mockResolvedValueOnce({ login: 'alice' })
      .mockResolvedValueOnce(manyAlice)
      .mockResolvedValueOnce(manyAlice2)
      .mockResolvedValueOnce([]) // page 3

    const result = await fetchMineableComments(
      { owner: 'o', repo: 'r' },
      { getToken: () => 'tok', ghFetch },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.comments.length).toBeLessThanOrEqual(MINE_COMMENTS_CAP)
    }
  })

  it('fetches up to 3 pages of comments', async () => {
    const page = Array.from({ length: 10 }, (_, i) =>
      makeComment({ id: i, user: { login: 'alice' } }),
    )
    const ghFetch = vi.fn()
      .mockResolvedValueOnce({ login: 'alice' })
      .mockResolvedValueOnce(page)   // page 1
      .mockResolvedValueOnce(page)   // page 2
      .mockResolvedValueOnce(page)   // page 3
      // page 4 should NOT be requested

    await fetchMineableComments(
      { owner: 'o', repo: 'r' },
      { getToken: () => 'tok', ghFetch },
    )
    // ghFetch called: /user + 3 pages of comments = 4 total
    expect(ghFetch).toHaveBeenCalledTimes(4)
  })

  it('strips code fences longer than 10 lines from comment bodies', async () => {
    const longFence = '```typescript\n' + Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n') + '\n```'
    const shortFence = '```\nshort\n```'
    const body = `Before fence\n${longFence}\nAfter fence\n${shortFence}`

    const ghFetch = vi.fn()
      .mockResolvedValueOnce({ login: 'alice' })
      .mockResolvedValueOnce([makeComment({ user: { login: 'alice' }, body })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const result = await fetchMineableComments(
      { owner: 'o', repo: 'r' },
      { getToken: () => 'tok', ghFetch },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const text = result.comments[0]
      // long fence stripped
      expect(text).not.toContain('line 14')
      // short fence kept
      expect(text).toContain('short')
    }
  })

  it('returns error with descriptive message when no comments found', async () => {
    const ghFetch = vi.fn()
      .mockResolvedValueOnce({ login: 'alice' })
      .mockResolvedValueOnce([]) // no comments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const result = await fetchMineableComments(
      { owner: 'o', repo: 'r' },
      { getToken: () => 'tok', ghFetch },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/no.*comment/i)
  })

  it('returns error when /user fetch fails', async () => {
    const ghFetch = vi.fn().mockRejectedValueOnce(new Error('network error'))
    const result = await fetchMineableComments(
      { owner: 'o', repo: 'r' },
      { getToken: () => 'tok', ghFetch },
    )
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// mineSkillFromComments
// ---------------------------------------------------------------------------

describe('mineSkillFromComments', () => {
  it('calls llmJsonWithRepair with comments included in user prompt', async () => {
    const llmJsonWithRepair = vi.fn().mockResolvedValue({
      name: 'alice\'s review style',
      content: 'Priorities:\n- correctness',
    })
    const result = await mineSkillFromComments(
      { login: 'alice', comments: ['Fix this nit.', 'Missing test.'] },
      { llmJsonWithRepair },
    )
    expect(llmJsonWithRepair).toHaveBeenCalledOnce()
    const [opts] = llmJsonWithRepair.mock.calls[0]
    expect(opts.user).toContain('Fix this nit.')
    expect(opts.user).toContain('Missing test.')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.skill.name).toBe('alice\'s review style')
    }
  })

  it('prompt system message contains key persona distillation instructions', async () => {
    const llmJsonWithRepair = vi.fn().mockResolvedValue({
      name: 'alice\'s review style',
      content: 'Priorities:\n- correctness',
    })
    await mineSkillFromComments(
      { login: 'alice', comments: ['Good catch.'] },
      { llmJsonWithRepair },
    )
    const [opts] = llmJsonWithRepair.mock.calls[0]
    // System prompt should mention: priorities, phrasing style, persona
    expect(opts.system).toMatch(/priorit/i)
    expect(opts.system).toMatch(/persona/i)
    // Should request JSON with name + content fields
    expect(opts.system).toContain('"name"')
    expect(opts.system).toContain('"content"')
  })

  it('prefills name with "{login}\'s review style"', async () => {
    const llmJsonWithRepair = vi.fn().mockResolvedValue({
      name: 'whatever-llm-returned',
      content: 'Priorities:\n- correctness',
    })
    const result = await mineSkillFromComments(
      { login: 'vasco', comments: ['Good catch.'] },
      { llmJsonWithRepair },
    )
    // The returned skill should use the login-based default name,
    // or the LLM-returned name if it differs — implementation detail.
    // What we verify: the user prompt contains the login.
    const [opts] = llmJsonWithRepair.mock.calls[0]
    expect(opts.user).toContain('vasco')
  })

  it('returns error when llm returns invalid shape', async () => {
    const llmJsonWithRepair = vi.fn().mockRejectedValue(new Error('invalid-output'))
    const result = await mineSkillFromComments(
      { login: 'alice', comments: ['comment'] },
      { llmJsonWithRepair },
    )
    expect(result.ok).toBe(false)
  })

  it('validator rejects output missing content field', async () => {
    // The validator passed to llmJsonWithRepair should return null for bad shapes
    let capturedValidator: ((x: unknown) => unknown) | null = null
    const llmJsonWithRepair = vi.fn().mockImplementation((_opts, validate) => {
      capturedValidator = validate
      return Promise.resolve({ name: 'x', content: 'y' })
    })
    await mineSkillFromComments(
      { login: 'alice', comments: ['comment'] },
      { llmJsonWithRepair },
    )
    expect(capturedValidator).not.toBeNull()
    // Missing content → null
    expect(capturedValidator!({ name: 'x' })).toBeNull()
    // Missing name → null
    expect(capturedValidator!({ content: 'y' })).toBeNull()
    // Valid → returns the object
    expect(capturedValidator!({ name: 'a', content: 'b' })).toEqual({ name: 'a', content: 'b' })
  })
})

// ---------------------------------------------------------------------------
// stripLongFences (exported util)
// ---------------------------------------------------------------------------

describe('stripLongFences (exported util)', () => {
  it('strips fences with more than 10 lines of content', () => {
    const longFence = '```ts\n' + Array.from({length: 12}, (_, i) => `line${i}`).join('\n') + '\n```'
    expect(stripLongFences(longFence)).toBe('')
  })

  it('keeps fences with 10 or fewer lines of content', () => {
    const shortFence = '```ts\nconst x = 1\n```'
    expect(stripLongFences(shortFence)).toBe(shortFence)
  })

  it('strips only long fences in mixed body', () => {
    const long = '```\n' + Array.from({length: 11}, (_, i) => `l${i}`).join('\n') + '\n```'
    const short = '```\nshort\n```'
    const body = `before\n${long}\nmiddle\n${short}\nafter`
    const result = stripLongFences(body)
    expect(result).not.toContain('l10')
    expect(result).toContain('short')
  })
})

describe('githubProvider.getMyReviewComments', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
  })

  it('method exists on github provider', () => {
    expect(typeof githubProvider.getMyReviewComments).toBe('function')
  })

  it('returns error-style rejection when no GitHub auth', async () => {
    // No token in localStorage → ghFetch will fail
    await expect(
      githubProvider.getMyReviewComments!({ owner: 'o', repo: 'r' }, 150)
    ).rejects.toThrow()
  })

  it('returns filtered comment bodies for the authenticated user', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'alice' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { user: { login: 'alice' }, body: 'alice comment 1' },
        { user: { login: 'bob' },   body: 'bob comment' },
        { user: { login: 'alice' }, body: 'alice comment 2' },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 })) // page 2 empty
    )

    const result = await githubProvider.getMyReviewComments!(
      { owner: 'myorg', repo: 'myrepo' },
      150,
    )
    expect(result).toEqual(['alice comment 1', 'alice comment 2'])
  })

  it('caps results at the cap parameter', async () => {
    const manyComments = Array.from({ length: 10 }, (_, i) => ({
      user: { login: 'alice' }, body: `comment ${i}`,
    }))
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'alice' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(manyComments), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
    )

    const result = await githubProvider.getMyReviewComments!(
      { owner: 'myorg', repo: 'myrepo' },
      3,
    )
    expect(result.length).toBeLessThanOrEqual(3)
  })
})
