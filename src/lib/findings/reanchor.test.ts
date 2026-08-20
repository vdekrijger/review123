/**
 * reanchor.svelte.ts — user-corrected finding anchors.
 *
 * Contract under test:
 *  - Identity: findingAnchorHash is stable for identical content, differs when
 *    any stable part (key / path / line / body) changes.
 *  - CRUD: set → get roundtrip; clear removes; get without override → null.
 *  - Per-PR scoping: overrides for one PR are invisible to another.
 *  - Persistence: overrides survive a module state reset (localStorage-backed);
 *    corrupt storage degrades to empty, never throws.
 *  - Pruning: hashes absent from the live set are dropped; live ones kept.
 *  - Bounds: per-PR override cap evicts the OLDEST moves.
 *  - Analytics: set fires `finding_moved` ONLY when the caller passes move
 *    meta (deltas/enums only); clear of an existing override fires
 *    `finding_move_undone`; no-op clears and metaless sets fire nothing.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  findingAnchorHash,
  getAnchorOverride,
  setAnchorOverride,
  clearAnchorOverride,
  pruneAnchorOverrides,
  currentPrKey,
  _resetReanchorForTest,
  type FindingAnchorIdentity,
  type ReanchorMove,
} from './reanchor.svelte'
import { _setCaptureForTest } from '../analytics/analytics'
import { router } from '../router/router.svelte'

const KEY = 'review123:finding-anchors'
const PR = 'github:owner/repo#1'

function identity(overridesArg: Partial<FindingAnchorIdentity> = {}): FindingAnchorIdentity {
  return {
    key: 'skill-sec:src/a.ts:12:Potential XSS vulnerability: use',
    path: 'src/a.ts',
    line: 12,
    body: 'Potential XSS vulnerability: user input is not sanitized',
    ...overridesArg,
  }
}

beforeEach(() => {
  localStorage.clear()
  _resetReanchorForTest()
})

describe('findingAnchorHash — identity', () => {
  it('is deterministic: same content → same hash', () => {
    expect(findingAnchorHash(identity())).toBe(findingAnchorHash(identity()))
  })

  it('changes when the body changes (re-run rewording orphans the override)', () => {
    expect(findingAnchorHash(identity())).not.toBe(findingAnchorHash(identity({ body: 'different body' })))
  })

  it('changes when the original line changes', () => {
    expect(findingAnchorHash(identity())).not.toBe(findingAnchorHash(identity({ line: 13 })))
  })

  it('changes when the path changes', () => {
    expect(findingAnchorHash(identity())).not.toBe(findingAnchorHash(identity({ path: 'src/b.ts' })))
  })

  it('changes when the finding key (reviewer) changes', () => {
    expect(findingAnchorHash(identity())).not.toBe(
      findingAnchorHash(identity({ key: 'skill-perf:src/a.ts:12:Potential XSS vulnerability: use' })),
    )
  })

  it('hashes a null line (file-level finding) without throwing', () => {
    expect(findingAnchorHash(identity({ line: null }))).toBeTruthy()
  })
})

describe('override CRUD', () => {
  const hash = findingAnchorHash(identity())

  it('get without a set override → null', () => {
    expect(getAnchorOverride(hash, PR)).toBeNull()
  })

  it('set → get roundtrip returns the target', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    expect(getAnchorOverride(hash, PR)).toEqual({ path: 'src/a.ts', line: 14, side: 'RIGHT' })
  })

  it('set twice → last write wins', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    setAnchorOverride(hash, { path: 'src/a.ts', line: 3, side: 'LEFT' }, PR)
    expect(getAnchorOverride(hash, PR)).toEqual({ path: 'src/a.ts', line: 3, side: 'LEFT' })
  })

  it('clear removes the override (undo)', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    clearAnchorOverride(hash, PR)
    expect(getAnchorOverride(hash, PR)).toBeNull()
  })

  it('clear on an absent hash is a no-op (never throws)', () => {
    expect(() => clearAnchorOverride('nope', PR)).not.toThrow()
  })

  it('overrides are PR-scoped: another prKey sees nothing', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    expect(getAnchorOverride(hash, 'github:other/repo#9')).toBeNull()
  })
})

describe('analytics — finding_moved / finding_move_undone', () => {
  const hash = findingAnchorHash(identity())
  const capture = vi.fn()
  beforeEach(() => {
    capture.mockClear()
    _setCaptureForTest(capture)
  })

  function eventsNamed(name: string) {
    return capture.mock.calls.filter(([n]) => n === name)
  }

  const MOVE: ReanchorMove = { method: 'drag', reportedLine: 12, offDiffRescue: false }

  it('set WITH move meta fires finding_moved with method/distance/side/rescue', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR, MOVE)
    const events = eventsNamed('finding_moved')
    expect(events).toHaveLength(1)
    expect(events[0][1]).toEqual({ method: 'drag', distance: 2, same_side: true, off_diff_rescue: false })
  })

  it('keyboard method + off-diff rescue thread through as given', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 3, side: 'RIGHT' }, PR, {
      method: 'keyboard',
      reportedLine: 999,
      offDiffRescue: true,
    })
    expect(eventsNamed('finding_moved')[0][1]).toEqual({
      method: 'keyboard',
      distance: 996,
      same_side: true,
      off_diff_rescue: true,
    })
  })

  it('a LEFT-side drop reports same_side false (reported side is always RIGHT)', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 10, side: 'LEFT' }, PR, MOVE)
    expect(eventsNamed('finding_moved')[0][1]).toMatchObject({ same_side: false })
  })

  it('a file-level finding (reportedLine null) omits distance', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 5, side: 'RIGHT' }, PR, {
      method: 'drag',
      reportedLine: null,
      offDiffRescue: true,
    })
    const props = eventsNamed('finding_moved')[0][1] as Record<string, unknown>
    expect(props).not.toHaveProperty('distance')
    expect(props).toMatchObject({ method: 'drag', off_diff_rescue: true })
  })

  it('set WITHOUT move meta (programmatic/storage-level) fires nothing', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    expect(eventsNamed('finding_moved')).toHaveLength(0)
  })

  it('clear of an existing override fires finding_move_undone (no props)', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    clearAnchorOverride(hash, PR)
    const events = eventsNamed('finding_move_undone')
    expect(events).toHaveLength(1)
    expect(events[0][1]).toEqual({})
  })

  it('clear on an absent hash fires nothing (no-op undo)', () => {
    clearAnchorOverride('nope', PR)
    expect(eventsNamed('finding_move_undone')).toHaveLength(0)
  })
})

describe('persistence', () => {
  const hash = findingAnchorHash(identity())

  it('survives a state reset (reload simulation): stored override re-reads', () => {
    setAnchorOverride(hash, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    _resetReanchorForTest() // re-reads from localStorage
    expect(getAnchorOverride(hash, PR)).toEqual({ path: 'src/a.ts', line: 14, side: 'RIGHT' })
  })

  it('corrupt storage JSON → empty store, no throw', () => {
    localStorage.setItem(KEY, '{not json')
    _resetReanchorForTest()
    expect(getAnchorOverride(hash, PR)).toBeNull()
  })

  it('invalid override shapes are dropped on read; valid ones kept', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        [PR]: {
          good: { path: 'src/a.ts', line: 2, side: 'RIGHT', movedAt: 1 },
          badSide: { path: 'src/a.ts', line: 2, side: 'MIDDLE', movedAt: 1 },
          badLine: { path: 'src/a.ts', line: 0, side: 'RIGHT', movedAt: 1 },
          notObj: 'x',
        },
      }),
    )
    _resetReanchorForTest()
    expect(getAnchorOverride('good', PR)).toEqual({ path: 'src/a.ts', line: 2, side: 'RIGHT' })
    expect(getAnchorOverride('badSide', PR)).toBeNull()
    expect(getAnchorOverride('badLine', PR)).toBeNull()
    expect(getAnchorOverride('notObj', PR)).toBeNull()
  })
})

describe('pruning — orphaned overrides are dropped', () => {
  const hashA = findingAnchorHash(identity())
  const hashB = findingAnchorHash(identity({ body: 'a second finding' }))

  it('drops hashes not in the live set, keeps live ones', () => {
    setAnchorOverride(hashA, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    setAnchorOverride(hashB, { path: 'src/a.ts', line: 20, side: 'RIGHT' }, PR)
    pruneAnchorOverrides(new Set([hashA]), PR)
    expect(getAnchorOverride(hashA, PR)).not.toBeNull()
    expect(getAnchorOverride(hashB, PR)).toBeNull()
  })

  it('prune with all-live set is a no-op', () => {
    setAnchorOverride(hashA, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    pruneAnchorOverrides(new Set([hashA, hashB]), PR)
    expect(getAnchorOverride(hashA, PR)).not.toBeNull()
  })

  it('prune only touches the given PR', () => {
    const otherPr = 'github:other/repo#9'
    setAnchorOverride(hashA, { path: 'src/a.ts', line: 14, side: 'RIGHT' }, PR)
    setAnchorOverride(hashA, { path: 'src/a.ts', line: 5, side: 'RIGHT' }, otherPr)
    pruneAnchorOverrides(new Set(), PR)
    expect(getAnchorOverride(hashA, PR)).toBeNull()
    expect(getAnchorOverride(hashA, otherPr)).not.toBeNull()
  })

  it('prune persists (survives state reset)', () => {
    setAnchorOverride(hashB, { path: 'src/a.ts', line: 20, side: 'RIGHT' }, PR)
    pruneAnchorOverrides(new Set([hashA]), PR)
    _resetReanchorForTest()
    expect(getAnchorOverride(hashB, PR)).toBeNull()
  })
})

describe('bounds — per-PR cap evicts oldest moves', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('51st override evicts the OLDEST (movedAt) one', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 51; i++) {
      vi.setSystemTime(1_000 + i) // strictly increasing movedAt
      setAnchorOverride(`h${i}`, { path: 'src/a.ts', line: i + 1, side: 'RIGHT' }, PR)
    }
    expect(getAnchorOverride('h0', PR)).toBeNull() // oldest evicted
    expect(getAnchorOverride('h1', PR)).not.toBeNull()
    expect(getAnchorOverride('h50', PR)).not.toBeNull()
  })
})

describe('currentPrKey — router-derived bucket', () => {
  const original = router.route
  afterEach(() => {
    router.route = original
  })

  it('review route → provider:owner/repo#number', () => {
    router.route = { name: 'review', provider: 'github', owner: 'o', repo: 'r', number: 7, step: 2 }
    expect(currentPrKey()).toBe('github:o/r#7')
  })

  it('demo route → "demo"', () => {
    router.route = { name: 'demo' }
    expect(currentPrKey()).toBe('demo')
  })

  it('any other route → "local"', () => {
    router.route = { name: 'landing' }
    expect(currentPrKey()).toBe('local')
  })
})
