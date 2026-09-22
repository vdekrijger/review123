/**
 * Tests for src/lib/ai/runInput.ts — the shared AiRunInput builder (the
 * prepare-ahead seam). Pins the construction the Review route has always done:
 * prKey format, pack() composition, capability-gated deep-review tools, and
 * the code-context wiring — so the headless prepare path provably builds the
 * SAME input (and therefore the same cache keys) as the route.
 */

import { describe, it, expect, vi } from 'vitest'
import { aiPrKey, aiBudgetTokens, buildAiRunInput, scopeFilesForPack, type AiRunWiring } from './runInput'
import { LLM_CONFIG } from '../llm/config'
import type { PrMeta, PrFile } from '../github/types'
import type { CiSummary } from '../github/checks'
import type { ReviewProvider } from '../provider/types'
import { filesForPhase } from '../guide/phase.svelte'

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

// ---------------------------------------------------------------------------
// Scoped packing (#237 — phase-scoped reviewers)
// ---------------------------------------------------------------------------

const IMPL_FILE: PrFile = {
  filename: 'src/foo.ts',
  status: 'modified',
  patch: '@@ -1 +1,2 @@\n a\n+implementation line',
  additions: 1,
  deletions: 0,
}
const TEST_FILE: PrFile = {
  filename: 'src/foo.test.ts',
  status: 'added',
  patch: '@@ -0,0 +1 @@\n+test line',
  additions: 1,
  deletions: 0,
}
const SPEC_FILE: PrFile = {
  filename: 'e2e/foo.spec.ts',
  status: 'added',
  patch: '@@ -0,0 +1 @@\n+spec line',
  additions: 1,
  deletions: 0,
}

describe('scopeFilesForPack', () => {
  it("'all' and undefined return the caller's OWN array — identity, not a copy", () => {
    // Identity is the guarantee that every task still packing the full PR gets
    // a byte-identical context (and therefore cache key).
    const files = [IMPL_FILE, TEST_FILE]
    expect(scopeFilesForPack(files, 'all')).toBe(files)
    expect(scopeFilesForPack(files, undefined)).toBe(files)
  })

  it("'implementation' drops every test file, preserving order", () => {
    const files = [TEST_FILE, IMPL_FILE, SPEC_FILE]
    expect(scopeFilesForPack(files, 'implementation').map((f) => f.filename)).toEqual(['src/foo.ts'])
  })

  it('uses the SAME partition the Tests phase shows (isTestFile — never a second heuristic)', () => {
    const files = [IMPL_FILE, TEST_FILE, SPEC_FILE]
    const scoped = scopeFilesForPack(files, 'implementation')
    expect(scoped).toEqual(filesForPhase(files, 'implementation'))
  })

  it('falls back to the FULL list on a test-only PR (never an empty reviewer context)', () => {
    const files = [TEST_FILE, SPEC_FILE]
    expect(scopeFilesForPack(files, 'implementation')).toBe(files)
  })

  it('a PR with no test files is unaffected by scoping', () => {
    const files = [IMPL_FILE]
    expect(scopeFilesForPack(files, 'implementation').map((f) => f.filename)).toEqual(['src/foo.ts'])
  })
})

describe('buildAiRunInput — pack(scope)', () => {
  function mixedWiring() {
    return makeWiring({ files: [IMPL_FILE, TEST_FILE] })
  }

  it("pack() with no argument is UNCHANGED — the full PR, test files included", async () => {
    const ctx = await buildAiRunInput(mixedWiring()).pack()
    expect(ctx.text).toContain('src/foo.ts')
    expect(ctx.text).toContain('src/foo.test.ts')
    expect(ctx.storyFiles?.map((f) => f.path).sort()).toEqual(['src/foo.test.ts', 'src/foo.ts'])
  })

  it("pack('all') is byte-identical to pack() — the ~10 automatic tasks are unaffected", async () => {
    const input = buildAiRunInput(mixedWiring())
    const bare = await input.pack()
    const all = await input.pack('all')
    expect(all.text).toBe(bare.text)
    expect(all.includedFiles).toEqual(bare.includedFiles)
    expect(all.notAnalyzed).toEqual(bare.notAnalyzed)
    expect(all.storyFiles).toEqual(bare.storyFiles)
  })

  it("pack('implementation') contains ONLY the phase's files — no test content reaches the reviewers", async () => {
    const ctx = await buildAiRunInput(mixedWiring()).pack('implementation')
    expect(ctx.text).toContain('src/foo.ts')
    expect(ctx.text).toContain('implementation line')
    expect(ctx.text).not.toContain('src/foo.test.ts')
    expect(ctx.text).not.toContain('test line')
    // storyFiles covers ALL packed non-binary files (it is budget-independent),
    // so it is the honest proof that the test file never entered the pack.
    expect(ctx.storyFiles?.map((f) => f.path)).toEqual(['src/foo.ts'])
  })

  it("the scoped pack is SMALLER than the full one (the point of the change)", async () => {
    const input = buildAiRunInput(mixedWiring())
    const full = await input.pack()
    const scoped = await input.pack('implementation')
    expect(scoped.text.length).toBeLessThan(full.text.length)
  })

  it('every scope reads the same memoized contents + CI wiring (no extra fetch shape)', async () => {
    const w = mixedWiring()
    const input = buildAiRunInput(w)
    await input.pack()
    await input.pack('implementation')
    expect(w.getContents).toHaveBeenCalledTimes(2)
    expect(w.getCi).toHaveBeenCalledTimes(2)
  })
})
