/**
 * Tests for the local accept/dismiss decision store (src/lib/eval/decisions.ts).
 * Uses fake-indexeddb/auto for IDB in the Node/vitest environment.
 *
 * Covers: record + read round-trip across instances, last-write-wins, the pure
 * LRU pruning helper, the cross-PR read used by the capture flow, and the
 * in-memory fallback when IndexedDB is unavailable.
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createDecisionStore,
  readDecisionsForPr,
  prKeysToPrune,
  type DecisionRecord,
  type DecisionVerificationContext,
} from './decisions'

afterEach(() => {
  vi.unstubAllGlobals()
})

let idx = 0
function nextPrKey() {
  return `github:owner/repo#${++idx}@sha`
}

const ctx: DecisionVerificationContext = {
  deep: false,
  crossVerified: false,
  confirmedBy: 0,
  polledModels: 0,
  raisedByCount: 0,
}

describe('decision store record + read', () => {
  it('records an accept and reads it back', async () => {
    const prKey = nextPrKey()
    const db = `dec-${idx}`
    const store = createDecisionStore(prKey, db)
    await store.load()
    await store.record({
      findingKey: 'bug-hunter:src/a.ts:10:abc',
      decision: 'accepted',
      severity: 'high',
      verificationContext: ctx,
    })
    const rec = store.get('bug-hunter:src/a.ts:10:abc')
    expect(rec?.decision).toBe('accepted')
    expect(rec?.severity).toBe('high')
    expect(rec?.prKey).toBe(prKey)
  })

  it('persists across store instances (fresh load sees prior write)', async () => {
    const prKey = nextPrKey()
    const db = `dec-rt-${idx}`
    const s1 = createDecisionStore(prKey, db)
    await s1.load()
    await s1.record({ findingKey: 'k:1', decision: 'dismissed', severity: 'low', verificationContext: ctx })

    const s2 = createDecisionStore(prKey, db)
    await s2.load()
    expect(s2.get('k:1')?.decision).toBe('dismissed')
  })

  it('last write wins (dismiss then accept ends accepted)', async () => {
    const prKey = nextPrKey()
    const db = `dec-lww-${idx}`
    const store = createDecisionStore(prKey, db)
    await store.load()
    await store.record({ findingKey: 'k:2', decision: 'dismissed', severity: 'medium', verificationContext: ctx })
    await store.record({ findingKey: 'k:2', decision: 'accepted', severity: 'medium', verificationContext: ctx })
    expect(store.get('k:2')?.decision).toBe('accepted')
    expect(store.list()).toHaveLength(1)
  })

  it('carries verification context (counts/enums) but no body field', async () => {
    const prKey = nextPrKey()
    const db = `dec-vc-${idx}`
    const store = createDecisionStore(prKey, db)
    await store.load()
    await store.record({
      findingKey: 'k:3',
      decision: 'accepted',
      severity: 'high',
      verificationContext: { deep: true, crossVerified: true, confirmedBy: 2, polledModels: 3, fusionMode: 'generate', raisedByCount: 2 },
    })
    const rec = store.get('k:3') as DecisionRecord
    expect(rec.verificationContext).toEqual({ deep: true, crossVerified: true, confirmedBy: 2, polledModels: 3, fusionMode: 'generate', raisedByCount: 2 })
    expect(rec).not.toHaveProperty('body')
  })
})

describe('list (PR-scoped read used to seed reload suppression)', () => {
  it('returns this PR\'s recorded decisions after a fresh load, and not another PR\'s', async () => {
    const prA = nextPrKey()
    const prB = nextPrKey()
    const db = `dec-list-${idx}`
    // PR A: one dismissed + one accepted decision.
    const a = createDecisionStore(prA, db)
    await a.load()
    await a.record({ findingKey: 'rev:src/a.ts:1:dismissed-one', decision: 'dismissed', severity: 'low', verificationContext: ctx })
    await a.record({ findingKey: 'rev:src/a.ts:2:accepted-one', decision: 'accepted', severity: 'high', verificationContext: ctx })
    // PR B: a decision that must NOT leak into PR A's read.
    const b = createDecisionStore(prB, db)
    await b.load()
    await b.record({ findingKey: 'rev:src/b.ts:9:other-pr', decision: 'dismissed', severity: 'low', verificationContext: ctx })

    // A FRESH PR-A store instance (simulating a reload) loads then reads.
    const reloaded = createDecisionStore(prA, db)
    await reloaded.load()
    const list = reloaded.list()
    const byKey = new Map(list.map((r) => [r.findingKey, r.decision]))
    expect(byKey.get('rev:src/a.ts:1:dismissed-one')).toBe('dismissed')
    expect(byKey.get('rev:src/a.ts:2:accepted-one')).toBe('accepted')
    expect(byKey.has('rev:src/b.ts:9:other-pr')).toBe(false)
    expect(list).toHaveLength(2)
  })
})

describe('readDecisionsForPr (capture-flow read)', () => {
  it('returns only the requested PR\'s decisions', async () => {
    const prA = nextPrKey()
    const prB = nextPrKey()
    const db = `dec-cross-${idx}`
    const a = createDecisionStore(prA, db)
    await a.load()
    await a.record({ findingKey: 'fa', decision: 'accepted', severity: 'high', verificationContext: ctx })
    const b = createDecisionStore(prB, db)
    await b.load()
    await b.record({ findingKey: 'fb', decision: 'dismissed', severity: 'low', verificationContext: ctx })

    const onlyA = await readDecisionsForPr(prA, db)
    expect(onlyA).toHaveLength(1)
    expect(onlyA[0].findingKey).toBe('fa')
  })
})

describe('prKeysToPrune (pure LRU bound)', () => {
  function rec(prKey: string, at: number): DecisionRecord {
    return { prKey, findingKey: `${prKey}:f`, decision: 'accepted', severity: 'low', verificationContext: ctx, at }
  }

  it('keeps everything under the bound', () => {
    const records = [rec('p1', 1), rec('p2', 2)]
    expect(prKeysToPrune(records, 'p3', 10, 5)).toEqual([])
  })

  it('evicts the oldest PRs beyond the bound, never the touched one', () => {
    const records = [rec('old', 1), rec('mid', 5), rec('p3', 9)]
    // touched 'p3' (now=10); maxPrs=2 → 3 distinct PRs → evict 1 oldest = 'old'
    expect(prKeysToPrune(records, 'p3', 10, 2)).toEqual(['old'])
  })

  it('never evicts the touched PR even if its prior decisions are oldest', () => {
    const records = [rec('p3', 1), rec('a', 5), rec('b', 6)]
    const evicted = prKeysToPrune(records, 'p3', 10, 2)
    expect(evicted).not.toContain('p3')
    expect(evicted).toHaveLength(1)
  })
})

describe('in-memory fallback (no IndexedDB)', () => {
  it('records and reads without IndexedDB present', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const store = createDecisionStore('github:o/r#999@s', 'dec-fallback')
    await store.load()
    await store.record({ findingKey: 'm:1', decision: 'accepted', severity: 'high', verificationContext: ctx })
    expect(store.persistent).toBe(false)
    expect(store.get('m:1')?.decision).toBe('accepted')
  })
})
