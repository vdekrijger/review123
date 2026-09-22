/**
 * standingRulesCorpus.test.ts
 *
 * Uses fake-indexeddb/auto so the draft harvest runs for real, and includes
 * the CONTRACT TEST that pins this module's read-only cursor against
 * drafts.svelte.ts's own writer — the reason duplicating the DB and store
 * names here is safe.
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  assessCorpus,
  estimateCorpusTokens,
  countCorpus,
  corpusTotal,
  collectDismissals,
  collectDrafts,
  collectCorpus,
  harvestProviderId,
  STANDING_RULES_MIN_CORPUS,
  DRAFT_CORPUS_CAP,
  type StandingRulesCorpus,
} from './standingRulesCorpus'
import { recordDismissal, CALIBRATION_KEY } from './calibration'
import { MINE_COMMENTS_CAP } from './mineSkill'

function corpus(overrides: Partial<StandingRulesCorpus> = {}): StandingRulesCorpus {
  return { reviewComments: [], dismissals: [], drafts: [], acceptedFindings: [], ...overrides }
}

function times<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i))
}

beforeEach(() => {
  localStorage.clear()
  // Fresh IndexedDB per test — draft state must not leak between cases.
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
})

// ---------------------------------------------------------------------------
// Readiness — the honest answer when there is nothing to distil
// ---------------------------------------------------------------------------

describe('assessCorpus', () => {
  it('says so plainly on an EMPTY corpus and never claims a rule', () => {
    const result = assessCorpus(countCorpus(corpus()))
    expect(result.ready).toBe(false)
    if (result.ready) throw new Error('unreachable')
    expect(result.reason).toBe('empty')
    expect(result.message).toMatch(/Nothing to distil yet/)
    expect(result.message).toMatch(/your own review history/)
  })

  it('reports a THIN corpus with the count, not a distillation', () => {
    const counts = countCorpus(corpus({ reviewComments: times(4, (i) => `c${i}`) }))
    const result = assessCorpus(counts)
    expect(result.ready).toBe(false)
    if (result.ready) throw new Error('unreachable')
    expect(result.reason).toBe('thin')
    expect(result.message).toContain('Not enough signal yet — 4 comments')
    expect(result.message).toContain(String(STANDING_RULES_MIN_CORPUS))
  })

  it('counts ALL FOUR streams toward the threshold, not just review comments', () => {
    const counts = countCorpus(
      corpus({
        reviewComments: times(4, (i) => `c${i}`),
        dismissals: times(4, (i) => ({ pattern: `d${i}`, reason: 'not-real' as const })),
        drafts: times(4, (i) => `x${i}`),
      }),
    )
    expect(corpusTotal(counts)).toBe(12)
    expect(assessCorpus(counts).ready).toBe(true)
  })

  it('is ready exactly at the threshold, not one short of it', () => {
    const under = countCorpus(corpus({ reviewComments: times(STANDING_RULES_MIN_CORPUS - 1, (i) => `c${i}`) }))
    const at = countCorpus(corpus({ reviewComments: times(STANDING_RULES_MIN_CORPUS, (i) => `c${i}`) }))
    expect(assessCorpus(under).ready).toBe(false)
    expect(assessCorpus(at).ready).toBe(true)
  })
})

describe('estimateCorpusTokens', () => {
  it('grows with the corpus and includes prompt overhead', () => {
    const small = estimateCorpusTokens(corpus())
    const big = estimateCorpusTokens(corpus({ reviewComments: [`x`.repeat(4000)] }))
    expect(small).toBeGreaterThan(0) // the prompt itself is not free
    expect(big).toBeGreaterThan(small + 900)
  })

  it('counts every stream, so the preview cannot undercount what is sent', () => {
    const base = estimateCorpusTokens(corpus())
    for (const key of ['reviewComments', 'drafts', 'acceptedFindings'] as const) {
      expect(estimateCorpusTokens(corpus({ [key]: ['y'.repeat(400)] }))).toBeGreaterThan(base)
    }
    expect(
      estimateCorpusTokens(corpus({ dismissals: [{ pattern: 'z'.repeat(400), reason: 'not-real' }] })),
    ).toBeGreaterThan(base)
  })
})

// ---------------------------------------------------------------------------
// Dismissals — the #230 ledger, flattened
// ---------------------------------------------------------------------------

describe('collectDismissals', () => {
  it('is empty when no finding has been dismissed with a reason', () => {
    expect(collectDismissals()).toEqual([])
  })

  it('flattens across reviewers and keeps the reason — the negative signal', () => {
    recordDismissal('skill-a', { path: 'src/a.ts', body: 'missing jsdoc' }, 'not-worth')
    recordDismissal('skill-b', { path: 'src/b.ts', body: 'possible race' }, 'not-real')
    const dismissals = collectDismissals()
    expect(dismissals).toHaveLength(2)
    expect(dismissals.map((d) => d.reason).sort()).toEqual(['not-real', 'not-worth'])
    expect(dismissals.some((d) => d.pattern.includes('missing jsdoc'))).toBe(true)
  })

  it('tolerates a corrupt ledger', () => {
    localStorage.setItem(CALIBRATION_KEY, '{not json')
    expect(collectDismissals()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Drafts — the user's own words, read from their own IndexedDB
// ---------------------------------------------------------------------------

describe('collectDrafts', () => {
  it('returns empty streams when the drafts database has never been created', async () => {
    expect(await collectDrafts('review123-drafts-never-written')).toEqual({ own: [], accepted: [] })
  })

  it('CONTRACT: reads back what drafts.svelte.ts actually writes (pins the DB + store names)', async () => {
    const { createDraftStore } = await import('../drafts/drafts.svelte')
    const store = createDraftStore('github:acme/widgets#7')
    await store.upsert({ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Pull this into a shared constant.' })

    const drafts = await collectDrafts()
    expect(drafts.own).toContain('Pull this into a shared constant.')
  })

  it('splits the user\'s OWN words from findings they ACCEPTED (aiAuthored, #200)', async () => {
    const { createDraftStore } = await import('../drafts/drafts.svelte')
    const store = createDraftStore('github:acme/widgets#8')
    await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'My own words.' })
    await store.upsert({
      path: 'src/b.ts',
      line: 2,
      side: 'RIGHT',
      body: 'An AI finding I accepted.',
      aiAuthored: true,
      aiReviewer: 'Security',
    })

    const drafts = await collectDrafts()
    expect(drafts.own).toEqual(['My own words.'])
    expect(drafts.accepted).toEqual(['An AI finding I accepted.'])
  })

  it('harvests ACROSS pull requests — the corpus is account-wide, like mineSkill\'s', async () => {
    const { createDraftStore } = await import('../drafts/drafts.svelte')
    const a = createDraftStore('github:acme/widgets#1')
    await a.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'From PR one.' })
    const b = createDraftStore('github:acme/gadgets#2')
    await b.upsert({ path: 'src/b.ts', line: 1, side: 'RIGHT', body: 'From PR two.' })

    const drafts = await collectDrafts()
    expect(drafts.own.sort()).toEqual(['From PR one.', 'From PR two.'])
  })

  it('caps each stream at DRAFT_CORPUS_CAP', async () => {
    const { createDraftStore } = await import('../drafts/drafts.svelte')
    const store = createDraftStore('github:acme/widgets#9')
    for (let i = 0; i < DRAFT_CORPUS_CAP + 5; i++) {
      await store.upsert({ path: 'src/a.ts', line: i + 1, side: 'RIGHT', body: `Draft ${i}.` })
    }
    const drafts = await collectDrafts()
    expect(drafts.own).toHaveLength(DRAFT_CORPUS_CAP)
  })

  it('returns empty streams (never throws) when IndexedDB is unavailable', async () => {
    const saved = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB
    // Deliberately removing the global for this case.
    delete (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB
    try {
      expect(await collectDrafts()).toEqual({ own: [], accepted: [] })
    } finally {
      ;(globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB = saved
    }
  })
})

// ---------------------------------------------------------------------------
// Full assembly
// ---------------------------------------------------------------------------

describe('collectCorpus', () => {
  const capable = (comments: string[]) => ({
    id: 'github',
    displayName: 'GitHub',
    authState: () => ({ configured: true, hint: '' }),
    getMyAccountReviewComments: vi.fn(async () => comments),
  })

  const noDrafts = async () => ({ own: [], accepted: [] })

  it('REUSES mineSkill\'s harvest — one call, at MINE_COMMENTS_CAP, account-wide', async () => {
    const provider = capable(['a comment'])
    await collectCorpus('github', { provider, collectDrafts: noDrafts, collectDismissals: () => [] })
    expect(provider.getMyAccountReviewComments).toHaveBeenCalledTimes(1)
    expect(provider.getMyAccountReviewComments).toHaveBeenCalledWith(MINE_COMMENTS_CAP)
  })

  it('assembles all four streams with their counts', async () => {
    const result = await collectCorpus('github', {
      provider: capable(['c1', 'c2']),
      collectDrafts: async () => ({ own: ['d1'], accepted: ['f1', 'f2'] }),
      collectDismissals: () => [{ pattern: 'p1', reason: 'not-real' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.counts).toEqual({ reviewComments: 2, dismissals: 1, drafts: 1, acceptedFindings: 2 })
    expect(result.corpus.drafts).toEqual(['d1'])
    expect(result.commentsError).toBeUndefined()
  })

  it('a provider WITHOUT account harvesting degrades to the local streams and says so', async () => {
    const result = await collectCorpus('bitbucket', {
      provider: { id: 'bitbucket', displayName: 'Bitbucket', authState: () => ({ configured: true, hint: '' }) },
      collectDrafts: async () => ({ own: ['d1'], accepted: [] }),
      collectDismissals: () => [{ pattern: 'p1', reason: 'not-worth' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.commentsError).toMatch(/aren't available for Bitbucket yet/)
    expect(result.counts.drafts).toBe(1)
    expect(result.counts.reviewComments).toBe(0)
  })

  it('an UNAUTHENTICATED provider surfaces its own hint but still returns the local corpus', async () => {
    const result = await collectCorpus('github', {
      provider: {
        id: 'github',
        displayName: 'GitHub',
        authState: () => ({ configured: false, hint: 'Sign in with GitHub.' }),
        getMyAccountReviewComments: async () => [],
      },
      collectDrafts: async () => ({ own: ['d1'], accepted: [] }),
      collectDismissals: () => [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.commentsError).toBe('Sign in with GitHub.')
    expect(result.corpus.drafts).toEqual(['d1'])
  })

  it('a FAILING harvest is reported, not fatal — the local streams survive it', async () => {
    const result = await collectCorpus('github', {
      provider: {
        id: 'github',
        displayName: 'GitHub',
        authState: () => ({ configured: true, hint: '' }),
        getMyAccountReviewComments: async () => {
          throw new Error('API rate limit exceeded')
        },
      },
      collectDrafts: async () => ({ own: ['d1'], accepted: [] }),
      collectDismissals: () => [{ pattern: 'p', reason: 'not-real' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.commentsError).toBe('API rate limit exceeded')
    expect(corpusTotal(result.counts)).toBe(2)
  })

  it('an all-empty result is OK — assessCorpus, not this, owns the honest sentence', async () => {
    const result = await collectCorpus('github', {
      provider: capable([]),
      collectDrafts: noDrafts,
      collectDismissals: () => [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(corpusTotal(result.counts)).toBe(0)
    expect(assessCorpus(result.counts).ready).toBe(false)
  })
})

describe('harvestProviderId', () => {
  it('falls back to GitHub when nothing is configured', () => {
    expect(harvestProviderId()).toBe('github')
  })
})
