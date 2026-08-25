/**
 * Tests for src/lib/ai/runInput.ts — the shared AiRunInput builder (the
 * prepare-ahead seam). Pins the construction the Review route has always done:
 * prKey format, pack() composition, capability-gated deep-review tools, and
 * the code-context wiring — so the headless prepare path provably builds the
 * SAME input (and therefore the same cache keys) as the route.
 */

import { describe, it, expect, vi } from 'vitest'
import { aiPrKey, aiBudgetTokens, buildAiRunInput, type AiRunWiring } from './runInput'
import { LLM_CONFIG } from '../llm/config'
import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type { ReviewProvider } from '../provider/types'

const META: PrMeta = {
  title: 'A PR',
  state: 'open',
  merged: false,
  body: 'The body',
  baseSha: 'base1',
  headSha: 'head1',
  private: true,
  changedFiles: 1,
  authorLogin: null,
}

const FILES: PrFile[] = [
  { filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n a\n+b', additions: 1, deletions: 0 },
]

const CI: CiSummary = { total: 0, passed: 0, failed: 0, pending: 0, failures: [] }

function makeWiring(overrides: Partial<AiRunWiring> = {}): AiRunWiring {
  return {
    providerId: 'github',
    provider: {
      getFileAtRef: vi.fn().mockResolvedValue('content'),
    } as unknown as ReviewProvider,
    owner: 'o',
    repo: 'r',
    number: 7,
    meta: META,
    files: FILES,
    getContents: vi.fn().mockResolvedValue(new Map()),
    contentsNow: () => null,
    getCi: vi.fn().mockResolvedValue(CI),
    ask: async () => true,
    ...overrides,
  }
}

describe('aiPrKey', () => {
  it('matches the cache identity format the route has always used', () => {
    expect(aiPrKey('github', 'o', 'r', 7, 'abc')).toBe('github:o/r#7@abc')
  })
})

describe('aiBudgetTokens', () => {
  it("is the route's long-standing pack budget formula", () => {
    expect(aiBudgetTokens()).toBe(LLM_CONFIG.contextWindowTokens - LLM_CONFIG.maxOutputTokens - 2000)
  })
})

describe('buildAiRunInput', () => {
  it('maps identity, visibility, and the intent meta', () => {
    const input = buildAiRunInput(makeWiring())
    expect(input.prKey).toBe('github:o/r#7@head1')
    expect(input.repo).toBe('o/r')
    expect(input.isPrivate).toBe(true)
    expect(input.meta).toEqual({ title: 'A PR', body: 'The body' })
  })

  it('pack() awaits the memoized contents + CI and packs the files', async () => {
    const w = makeWiring()
    const input = buildAiRunInput(w)
    const ctx = await input.pack()
    expect(w.getContents).toHaveBeenCalledTimes(1)
    expect(w.getCi).toHaveBeenCalledTimes(1)
    expect(ctx.text).toContain('src/a.ts')
    expect(ctx.storyFiles?.map((f) => f.path)).toEqual(['src/a.ts'])
  })

  it('ci() delegates to the memoized CI fetch', async () => {
    const w = makeWiring()
    const input = buildAiRunInput(w)
    await expect(input.ci()).resolves.toBe(CI)
    expect(w.getCi).toHaveBeenCalledTimes(1)
  })

  it('wires deep-review file reads to head/base SHAs', async () => {
    const w = makeWiring()
    const input = buildAiRunInput(w)
    await input.deepReview!.getFileAtHead('src/a.ts')
    await input.deepReview!.getFileAtBase('src/a.ts')
    const getFileAtRef = w.provider.getFileAtRef as ReturnType<typeof vi.fn>
    expect(getFileAtRef).toHaveBeenCalledWith({ owner: 'o', repo: 'r' }, 'src/a.ts', 'head1')
    expect(getFileAtRef).toHaveBeenCalledWith({ owner: 'o', repo: 'r' }, 'src/a.ts', 'base1')
  })

  it('capability-gates searchCode / findReferences on provider method presence', () => {
    const without = buildAiRunInput(makeWiring())
    expect(without.deepReview!.searchCode).toBeUndefined()
    expect(without.deepReview!.findReferences).toBeUndefined()

    const searchCode = vi.fn().mockResolvedValue([])
    const findReferences = vi.fn().mockResolvedValue([])
    const withSearch = buildAiRunInput(
      makeWiring({
        provider: {
          getFileAtRef: vi.fn(),
          searchCode,
          findReferences,
        } as unknown as ReviewProvider,
      }),
    )
    expect(withSearch.deepReview!.searchCode).toBeDefined()
    expect(withSearch.deepReview!.findReferences).toBeDefined()
    void withSearch.deepReview!.searchCode!('query')
    expect(searchCode).toHaveBeenCalledWith({ owner: 'o', repo: 'r' }, 'query')
  })

  it('code-context builders read the CURRENT contents map (late resolution)', () => {
    let resolved: Map<string, { before: string | null; after: string | null }> | null = null
    const w = makeWiring({ contentsNow: () => resolved })
    const input = buildAiRunInput(w)

    // Before contents resolve: still returns entries (hunk excerpts only).
    const before = input.coachCodeContext!([{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'x' } as never])
    expect(Array.isArray(before)).toBe(true)

    // After resolution the SAME input sees the map — no rebuild required.
    resolved = new Map([['src/a.ts', { before: 'a', after: 'a\nb' }]])
    const after = input.verifyCodeContext!([{ path: 'src/a.ts', line: 2, side: 'RIGHT' }])
    expect(Array.isArray(after)).toBe(true)
  })

  it('passes drafts through only when wired (prepare omits it)', () => {
    expect(buildAiRunInput(makeWiring()).drafts).toBeUndefined()
    const drafts = () => []
    expect(buildAiRunInput(makeWiring({ drafts })).drafts).toBe(drafts)
  })
})
