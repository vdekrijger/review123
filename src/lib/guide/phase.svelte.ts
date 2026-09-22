/**
 * src/lib/guide/phase.svelte.ts — per-PR REVIEW PHASE state.
 *
 * THE WORKFLOW this models: a reviewer reads the IMPLEMENTATION first (non-test
 * code — read it, click through, get a feel), and only once that is signed off
 * reviews the TESTS against the now-settled implementation. The two phases ask
 * different questions, so the tool stops mixing them into one undifferentiated
 * file list.
 *
 * Storage: localStorage `review123:review-phase`
 * Schema:  { [prKey]: { phase, updatedAt, implApprovedAt?, headShaAtApproval? } }
 * prKey:   "provider:owner/repo#number" (the drafts/finding-anchors format —
 *          NO sha, so the phase survives a force-push), 'demo', or 'local'.
 *          Supplied by the caller (InspectStep passes currentPrKey()), so this
 *          module stays pure and unit-testable.
 * Default: { phase: 'implementation' } — absent / corrupt entries read as that.
 * Cap:     30 PRs LRU by updatedAt (mirrors review123:finding-anchors).
 *
 * DESIGN RULES (all of these are load-bearing, and tested):
 *
 *  1. Approval is EXPLICIT and REVERSIBLE. Nothing auto-approves; `reopen()`
 *     always puts the reviewer back in Implementation and clears the approval.
 *
 *  2. Selecting a phase is NOT approving. `select('tests')` with no approval on
 *     record is the documented QUIET OVERRIDE — the reviewer who insists on
 *     peeking at the tests early gets to, and the UI says so plainly
 *     (previewing, not approved). Only `approve()` records implApprovedAt.
 *
 *  3. An approval is pinned to the head SHA it was made against. New commits
 *     land → isApprovalStale() reports it so the UI can offer to re-open
 *     Implementation, instead of silently carrying an approval of older code.
 *     An approval recorded WITHOUT a head sha is never reported stale (we have
 *     nothing honest to compare against).
 *
 *  4. The test/non-test partition reuses `isTestFile` — the SAME detector
 *     src/lib/guide/triage.ts calls for its "tests only" mechanical reason.
 *     There is deliberately no second heuristic here.
 *
 * Phases are a Files-mode concept only; Story mode is a narrative walkthrough
 * of everything and simply does not apply them (enforced by the caller).
 */

import type { PrFile } from '../github/types'
import { isTestFile } from '../testFile'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewPhase = 'implementation' | 'tests'

export const DEFAULT_PHASE: ReviewPhase = 'implementation'

export interface PhaseRecord {
  /** The phase the reviewer is currently in. */
  phase: ReviewPhase
  /** When the implementation was explicitly approved. Absent → not approved. */
  implApprovedAt?: number
  /** The PR head sha the approval was made against (absent → unknown). */
  headShaAtApproval?: string
}

interface StoredPhase extends PhaseRecord {
  /** Last touch — the LRU score. */
  updatedAt: number
}

type PhaseStore = Record<string, StoredPhase>

// ---------------------------------------------------------------------------
// File partition (the SAME isTestFile triage.ts uses — never a second heuristic)
// ---------------------------------------------------------------------------

/** True when this path is a test file — the phase partition's only signal. */
export function isPhaseTestFile(path: string): boolean {
  return isTestFile(path)
}

/**
 * Split a PR's files into the two phases, preserving the caller's order within
 * each side. `implementation` is every NON-test file; `tests` is every test
 * file. Every file lands in exactly one side — nothing is dropped.
 */
export function partitionFilesByPhase(files: readonly PrFile[]): {
  implementation: PrFile[]
  tests: PrFile[]
} {
  const implementation: PrFile[] = []
  const tests: PrFile[] = []
  for (const f of files) {
    if (isPhaseTestFile(f.filename)) tests.push(f)
    else implementation.push(f)
  }
  return { implementation, tests }
}

/** The files belonging to one phase (partition + pick, for call sites that only need one side). */
export function filesForPhase(files: readonly PrFile[], phase: ReviewPhase): PrFile[] {
  const parts = partitionFilesByPhase(files)
  return phase === 'tests' ? parts.tests : parts.implementation
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const KEY = 'review123:review-phase'
const MAX_PRS = 30

function isPhaseValue(raw: unknown): raw is ReviewPhase {
  return raw === 'implementation' || raw === 'tests'
}

function isValidStored(raw: unknown): raw is StoredPhase {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const o = raw as Record<string, unknown>
  if (!isPhaseValue(o['phase'])) return false
  if (typeof o['updatedAt'] !== 'number' || !Number.isFinite(o['updatedAt'])) return false
  if ('implApprovedAt' in o && o['implApprovedAt'] !== undefined) {
    if (typeof o['implApprovedAt'] !== 'number' || !Number.isFinite(o['implApprovedAt'])) return false
  }
  if ('headShaAtApproval' in o && o['headShaAtApproval'] !== undefined) {
    if (typeof o['headShaAtApproval'] !== 'string') return false
  }
  return true
}

function readStore(): PhaseStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: PhaseStore = {}
    for (const [prKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidStored(value)) result[prKey] = value
    }
    return result
  } catch {
    return {}
  }
}

function writeStore(store: PhaseStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // localStorage unavailable/full — phase degrades to session-only
  }
}

/** Bound the PR count: keep the MAX_PRS most recently touched PRs. */
function capPrs(store: PhaseStore): PhaseStore {
  const prKeys = Object.keys(store)
  if (prKeys.length <= MAX_PRS) return store
  const scored = prKeys.map((prKey) => ({ prKey, updatedAt: store[prKey].updatedAt }))
  scored.sort((a, b) => b.updatedAt - a.updatedAt)
  const keep = new Set(scored.slice(0, MAX_PRS).map((s) => s.prKey))
  const result: PhaseStore = {}
  for (const prKey of prKeys) {
    if (keep.has(prKey)) result[prKey] = store[prKey]
  }
  return result
}

/** Strip the storage-only `updatedAt` so callers see the public record shape. */
function toRecord(stored: StoredPhase | undefined): PhaseRecord {
  if (!stored) return { phase: DEFAULT_PHASE }
  const record: PhaseRecord = { phase: stored.phase }
  if (typeof stored.implApprovedAt === 'number') record.implApprovedAt = stored.implApprovedAt
  if (typeof stored.headShaAtApproval === 'string') record.headShaAtApproval = stored.headShaAtApproval
  return record
}

// ---------------------------------------------------------------------------
// Pure read/write API
// ---------------------------------------------------------------------------

/** This PR's phase record. Defaults to `{ phase: 'implementation' }`. */
export function getPhaseRecord(prKey: string): PhaseRecord {
  return toRecord(readStore()[prKey])
}

function persist(prKey: string, record: PhaseRecord): PhaseRecord {
  const store = readStore()
  store[prKey] = { ...record, updatedAt: Date.now() }
  writeStore(capPrs(store))
  return record
}

/**
 * Move to a phase WITHOUT changing the approval. Selecting 'tests' with no
 * approval on record is the quiet override (preview) — deliberate, and the UI
 * labels it as such.
 */
export function setReviewPhase(prKey: string, phase: ReviewPhase): PhaseRecord {
  const current = getPhaseRecord(prKey)
  return persist(prKey, { ...current, phase })
}

/**
 * Explicitly approve the implementation and move to the Tests phase. The head
 * sha (when known) is pinned so later commits can be reported as making the
 * approval stale.
 */
export function approveImplementation(prKey: string, headSha?: string): PhaseRecord {
  const record: PhaseRecord = { phase: 'tests', implApprovedAt: Date.now() }
  if (headSha) record.headShaAtApproval = headSha
  return persist(prKey, record)
}

/** Withdraw the approval and go back to Implementation. Always available. */
export function reopenImplementation(prKey: string): PhaseRecord {
  return persist(prKey, { phase: 'implementation' })
}

/**
 * True when the implementation was approved against a DIFFERENT head sha than
 * the PR's current one — i.e. new commits landed since the sign-off, so the
 * approval covers older code. Unknown shas (either side) → not stale: we never
 * invent staleness we cannot prove.
 */
export function isApprovalStale(record: PhaseRecord, currentHeadSha?: string): boolean {
  if (typeof record.implApprovedAt !== 'number') return false
  if (!record.headShaAtApproval || !currentHeadSha) return false
  return record.headShaAtApproval !== currentHeadSha
}

// ---------------------------------------------------------------------------
// Reactive store (Svelte 5) — one per mounted PR
// ---------------------------------------------------------------------------

/**
 * A reactive view of one PR's phase record. App.svelte remounts the review
 * route per PR identity ({#key}), so the prKey is read once at construction —
 * the viewed-store idiom.
 */
export function createPhaseStore(prKey: string) {
  let record = $state<PhaseRecord>(getPhaseRecord(prKey))

  return {
    get phase(): ReviewPhase {
      return record.phase
    },
    get record(): PhaseRecord {
      return record
    },
    /** True once the implementation has been explicitly approved. */
    get implApproved(): boolean {
      return typeof record.implApprovedAt === 'number'
    },
    get implApprovedAt(): number | undefined {
      return record.implApprovedAt
    },
    get headShaAtApproval(): string | undefined {
      return record.headShaAtApproval
    },
    /** Switch phase without touching the approval (the quiet override). */
    select(phase: ReviewPhase): void {
      record = setReviewPhase(prKey, phase)
    },
    /** Explicit "Implementation looks good" — records approval, moves to Tests. */
    approve(headSha?: string): void {
      record = approveImplementation(prKey, headSha)
    },
    /** Explicit "re-open" — clears approval, back to Implementation. */
    reopen(): void {
      record = reopenImplementation(prKey)
    },
    /** New commits since the approval? (see isApprovalStale) */
    isStale(currentHeadSha?: string): boolean {
      return isApprovalStale(record, currentHeadSha)
    },
  }
}
