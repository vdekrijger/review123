/**
 * src/lib/guide/phase.test.ts — per-PR review-phase state.
 *
 * Storage: localStorage `review123:review-phase`,
 *          { [prKey]: { phase, updatedAt, implApprovedAt?, headShaAtApproval? } }.
 *
 * Pins: the implementation default, explicit + reversible approval, the quiet
 * "preview the tests without approving" override, per-PR isolation, the 30-PR
 * LRU bound, corrupt-storage tolerance, headSha-changed-after-approval
 * detection, and the test/non-test file partition.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  DEFAULT_PHASE,
  approveImplementation,
  filesForPhase,
  getPhaseRecord,
  isApprovalStale,
  isPhaseTestFile,
  partitionFilesByPhase,
  reopenImplementation,
  setReviewPhase,
} from './phase.svelte'
import type { PrFile } from '../github/types'

const KEY = 'review123:review-phase'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

function makeFile(filename: string): PrFile {
  return { filename, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }
}

function readRaw(): Record<string, { phase: string; updatedAt: number; implApprovedAt?: number; headShaAtApproval?: string }> {
  return JSON.parse(localStorage.getItem(KEY)!)
}

// ---------------------------------------------------------------------------
// File partition
// ---------------------------------------------------------------------------

describe('phase — file partition (reuses isTestFile, no second heuristic)', () => {
  it('detects the same test shapes triage.ts calls "tests only"', () => {
    expect(isPhaseTestFile('src/util.test.ts')).toBe(true)
    expect(isPhaseTestFile('src/util.spec.js')).toBe(true)
    expect(isPhaseTestFile('pkg/thing_test.go')).toBe(true)
    expect(isPhaseTestFile('api/test_utils.py')).toBe(true)
    expect(isPhaseTestFile('src/__tests__/foo.ts')).toBe(true)
    expect(isPhaseTestFile('e2e/tests/login.ts')).toBe(true)
    expect(isPhaseTestFile('src/util.ts')).toBe(false)
    expect(isPhaseTestFile('pnpm-lock.yaml')).toBe(false)
  })

  it('splits files into implementation / tests, preserving order and losing nothing', () => {
    const files = [
      makeFile('src/a.ts'),
      makeFile('src/a.test.ts'),
      makeFile('pnpm-lock.yaml'),
      makeFile('src/b.ts'),
      makeFile('src/__tests__/b.ts'),
    ]
    const parts = partitionFilesByPhase(files)
    expect(parts.implementation.map((f) => f.filename)).toEqual(['src/a.ts', 'pnpm-lock.yaml', 'src/b.ts'])
    expect(parts.tests.map((f) => f.filename)).toEqual(['src/a.test.ts', 'src/__tests__/b.ts'])
    expect(parts.implementation.length + parts.tests.length).toBe(files.length)
  })

  it('filesForPhase picks one side', () => {
    const files = [makeFile('src/a.ts'), makeFile('src/a.test.ts')]
    expect(filesForPhase(files, 'implementation').map((f) => f.filename)).toEqual(['src/a.ts'])
    expect(filesForPhase(files, 'tests').map((f) => f.filename)).toEqual(['src/a.test.ts'])
  })

  it('handles a PR with no test files and a PR with only test files', () => {
    expect(partitionFilesByPhase([makeFile('src/a.ts')]).tests).toEqual([])
    expect(partitionFilesByPhase([makeFile('src/a.test.ts')]).implementation).toEqual([])
    expect(partitionFilesByPhase([])).toEqual({ implementation: [], tests: [] })
  })
})

// ---------------------------------------------------------------------------
// Default + transitions
// ---------------------------------------------------------------------------

describe('phase — default and transitions', () => {
  it('defaults to implementation with no approval', () => {
    expect(DEFAULT_PHASE).toBe('implementation')
    expect(getPhaseRecord('github:o/r#1')).toEqual({ phase: 'implementation' })
  })

  it('setReviewPhase moves phase WITHOUT approving (the quiet preview override)', () => {
    setReviewPhase('github:o/r#1', 'tests')
    const record = getPhaseRecord('github:o/r#1')
    expect(record.phase).toBe('tests')
    expect(record.implApprovedAt).toBeUndefined()
    expect(record.headShaAtApproval).toBeUndefined()
  })

  it('approveImplementation records the approval, the head sha, and moves to tests', () => {
    const before = Date.now()
    const record = approveImplementation('github:o/r#1', 'abc123')
    expect(record.phase).toBe('tests')
    expect(record.implApprovedAt).toBeGreaterThanOrEqual(before)
    expect(record.headShaAtApproval).toBe('abc123')
    expect(getPhaseRecord('github:o/r#1')).toEqual(record)
  })

  it('approving without a known head sha omits headShaAtApproval', () => {
    const record = approveImplementation('github:o/r#1')
    expect(record.headShaAtApproval).toBeUndefined()
    expect(record.implApprovedAt).toEqual(expect.any(Number))
  })

  it('reopenImplementation is reversible — clears the approval and goes back', () => {
    approveImplementation('github:o/r#1', 'abc123')
    const record = reopenImplementation('github:o/r#1')
    expect(record).toEqual({ phase: 'implementation' })
    expect(getPhaseRecord('github:o/r#1')).toEqual({ phase: 'implementation' })
  })

  it('selecting implementation after approval KEEPS the approval (re-entering never re-litigates)', () => {
    approveImplementation('github:o/r#1', 'abc123')
    setReviewPhase('github:o/r#1', 'implementation')
    const record = getPhaseRecord('github:o/r#1')
    expect(record.phase).toBe('implementation')
    expect(record.implApprovedAt).toEqual(expect.any(Number))
    expect(record.headShaAtApproval).toBe('abc123')
  })
})

// ---------------------------------------------------------------------------
// Per-PR isolation + persistence
// ---------------------------------------------------------------------------

describe('phase — per-PR isolation and persistence', () => {
  it('keeps each PR independent', () => {
    approveImplementation('github:o/r#1', 'sha1')
    setReviewPhase('github:o/r#2', 'tests')
    expect(getPhaseRecord('github:o/r#1').implApprovedAt).toEqual(expect.any(Number))
    expect(getPhaseRecord('github:o/r#2').implApprovedAt).toBeUndefined()
    expect(getPhaseRecord('github:o/r#3')).toEqual({ phase: 'implementation' })
  })

  it('survives a reload (state lives in localStorage, not memory)', () => {
    approveImplementation('gitlab:g/p#7', 'deadbee')
    // A fresh read is all a reload does — nothing is cached in module state.
    expect(getPhaseRecord('gitlab:g/p#7')).toEqual({
      phase: 'tests',
      implApprovedAt: expect.any(Number),
      headShaAtApproval: 'deadbee',
    })
  })

  it('writes the documented storage shape', () => {
    setReviewPhase('demo', 'tests')
    const raw = readRaw()
    expect(raw['demo'].phase).toBe('tests')
    expect(raw['demo'].updatedAt).toEqual(expect.any(Number))
  })
})

// ---------------------------------------------------------------------------
// LRU bound
// ---------------------------------------------------------------------------

describe('phase — LRU bound (30 PRs)', () => {
  it('keeps at most 30 PRs, evicting the least recently touched', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    for (let i = 1; i <= 31; i++) {
      vi.setSystemTime(new Date(Date.UTC(2025, 0, 1, 0, 0, i)))
      setReviewPhase(`github:o/r#${i}`, 'tests')
    }
    const raw = readRaw()
    expect(Object.keys(raw).length).toBe(30)
    // #1 was the oldest touch → evicted; #31 (newest) and #2 survive.
    expect(raw['github:o/r#1']).toBeUndefined()
    expect(raw['github:o/r#2']).toBeDefined()
    expect(raw['github:o/r#31']).toBeDefined()
    // An evicted PR simply reads as the default again — never as an error.
    expect(getPhaseRecord('github:o/r#1')).toEqual({ phase: 'implementation' })
  })

  it('re-touching an old PR keeps it alive through the next eviction', () => {
    vi.useFakeTimers()
    for (let i = 1; i <= 30; i++) {
      vi.setSystemTime(new Date(Date.UTC(2025, 0, 1, 0, 0, i)))
      setReviewPhase(`github:o/r#${i}`, 'tests')
    }
    // Touch the oldest, then add one more PR.
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 1, 0, 1, 0)))
    setReviewPhase('github:o/r#1', 'implementation')
    vi.setSystemTime(new Date(Date.UTC(2025, 0, 1, 0, 1, 1)))
    setReviewPhase('github:o/r#99', 'tests')

    const raw = readRaw()
    expect(Object.keys(raw).length).toBe(30)
    expect(raw['github:o/r#1']).toBeDefined() // re-touched → survived
    expect(raw['github:o/r#2']).toBeUndefined() // now the oldest → evicted
  })
})

// ---------------------------------------------------------------------------
// Corrupt storage
// ---------------------------------------------------------------------------

describe('phase — corrupt storage tolerance', () => {
  it('degrades unparseable JSON to the default', () => {
    localStorage.setItem(KEY, '{not json')
    expect(getPhaseRecord('github:o/r#1')).toEqual({ phase: 'implementation' })
  })

  it('degrades wrong top-level shapes to the default', () => {
    localStorage.setItem(KEY, JSON.stringify(['tests']))
    expect(getPhaseRecord('github:o/r#1')).toEqual({ phase: 'implementation' })
    localStorage.setItem(KEY, JSON.stringify('tests'))
    expect(getPhaseRecord('github:o/r#1')).toEqual({ phase: 'implementation' })
  })

  it('drops entries with an unknown phase, a missing updatedAt or bad field types', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        'github:o/r#1': { phase: 'chaos', updatedAt: 1 },
        'github:o/r#2': { phase: 'tests' },
        'github:o/r#3': { phase: 'tests', updatedAt: 'soon' },
        'github:o/r#4': { phase: 'tests', updatedAt: 1, implApprovedAt: 'yes' },
        'github:o/r#5': { phase: 'tests', updatedAt: 1, headShaAtApproval: 42 },
        'github:o/r#6': { phase: 'tests', updatedAt: 1, headShaAtApproval: 'ok' },
      }),
    )
    for (const n of [1, 2, 3, 4, 5]) {
      expect(getPhaseRecord(`github:o/r#${n}`)).toEqual({ phase: 'implementation' })
    }
    // The one valid entry still reads back.
    expect(getPhaseRecord('github:o/r#6')).toEqual({ phase: 'tests', headShaAtApproval: 'ok' })
  })

  it('a write over corrupt storage still lands', () => {
    localStorage.setItem(KEY, '{not json')
    approveImplementation('github:o/r#1', 'abc')
    expect(getPhaseRecord('github:o/r#1').phase).toBe('tests')
  })
})

// ---------------------------------------------------------------------------
// headSha-changed-after-approval
// ---------------------------------------------------------------------------

describe('phase — approval staleness after new commits', () => {
  it('is stale when the current head sha differs from the approved one', () => {
    const record = approveImplementation('github:o/r#1', 'oldsha')
    expect(isApprovalStale(record, 'newsha')).toBe(true)
  })

  it('is NOT stale when the head sha is unchanged', () => {
    const record = approveImplementation('github:o/r#1', 'samesha')
    expect(isApprovalStale(record, 'samesha')).toBe(false)
  })

  it('is NOT stale without an approval at all', () => {
    const record = setReviewPhase('github:o/r#1', 'tests')
    expect(isApprovalStale(record, 'anything')).toBe(false)
  })

  it('never invents staleness when either sha is unknown', () => {
    expect(isApprovalStale(approveImplementation('github:o/r#1'), 'newsha')).toBe(false)
    expect(isApprovalStale(approveImplementation('github:o/r#2', 'oldsha'), undefined)).toBe(false)
  })

  it('re-approving against the new head clears the staleness', () => {
    approveImplementation('github:o/r#1', 'oldsha')
    const reapproved = approveImplementation('github:o/r#1', 'newsha')
    expect(isApprovalStale(reapproved, 'newsha')).toBe(false)
  })
})
