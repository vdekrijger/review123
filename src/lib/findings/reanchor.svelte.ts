/**
 * src/lib/findings/reanchor.svelte.ts — user-corrected anchors for AI findings.
 *
 * AI reviewers sometimes report a finding at a nearby/incorrect line (or a line
 * that isn't in the diff at all). The user can DRAG the finding card onto the
 * correct diff line (or use the card's "Move to line…" keyboard path); the
 * corrected anchor is recorded HERE as an override — the cached AI run results
 * are never mutated (risk score / convergence keep reading raw findings).
 *
 * Identity — findingAnchorHash(): a content hash (djb2, same idiom as the
 * convergence fingerprint) over the finding's stable parts: its app-wide key
 * (`skillId:path:line:bodyPrefix`), original path, original line, and full
 * body. It survives re-render and page reload; a re-run that CHANGES the
 * finding's content produces a different hash, naturally orphaning the
 * override (correct — the new run may have fixed the line itself). Orphans are
 * pruned via pruneAnchorOverrides() once the live finding set is known.
 *
 * Storage: localStorage `review123:finding-anchors`
 * Schema:  { [prKey]: { [hash]: { path, line, side, movedAt } } }
 * prKey:   "provider:owner/repo#number" (no sha — survives force-pushes),
 *          derived from the router (same source Review.svelte uses) so
 *          FileDiff needs no prop threading; 'demo' on the demo route.
 * Bounds:  50 overrides per PR (evict oldest movedAt), 30 PRs LRU
 *          (evict by oldest max-movedAt).
 *
 * Reactivity: the override map is Svelte 5 $state — FileDiff's deriveds that
 * call getAnchorOverride() re-run when an override is set/cleared, moving the
 * card live. `reanchorDrag.hash` is the in-flight HTML5 drag (dragover can't
 * read dataTransfer, so drop-target validation reads this instead).
 */

import { track } from '../analytics/analytics'
import { router } from '../router/router.svelte'

/**
 * The drag payload type for a finding-card drag. The payload value is the
 * finding's anchor hash. A custom type keeps foreign drags (text, files) from
 * ever looking like a finding drop.
 */
export const REANCHOR_DND_MIME = 'application/x-review123-finding'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The stable parts of a finding that define its re-anchor identity. */
export interface FindingAnchorIdentity {
  /** App-wide finding key (`skillId:path:line:bodyPrefix`) — see InspectStep. */
  key: string
  /** ORIGINAL path the finding was reported at. */
  path: string
  /** ORIGINAL line the finding was reported at (null = file-level). */
  line: number | null
  /** Full finding body text. */
  body: string
}

/** Where an overridden finding now anchors. */
export interface AnchorTarget {
  /** The file whose diff the finding was dropped on (same file today). */
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
}

interface StoredOverride extends AnchorTarget {
  movedAt: number
}

/**
 * Analytics context for a USER move gesture, threaded from the caller (only
 * FileDiff knows the input method and the original anchor's diff status).
 * Passing it makes setAnchorOverride fire `finding_moved`; omitting it (tests,
 * programmatic/storage-level calls) fires nothing. The reported line itself is
 * NEVER sent — only the ABS distance to the corrected line is derived from it.
 */
export interface ReanchorMove {
  /** How the user moved the finding. */
  method: 'drag' | 'keyboard'
  /** The ORIGINAL reported line (null = file-level finding, no line). */
  reportedLine: number | null
  /** True when the reported anchor wasn't a renderable diff line (fallback block). */
  offDiffRescue: boolean
}

type AnchorStore = Record<string, Record<string, StoredOverride>>

// ---------------------------------------------------------------------------
// Hashing — djb2 over printable-separated stable parts (convergence idiom)
// ---------------------------------------------------------------------------

function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

/** Content hash identifying a finding across re-renders and reloads. */
export function findingAnchorHash(f: FindingAnchorIdentity): string {
  return hashString(`${f.key}|${f.path}|${f.line}|${f.body}`)
}

// ---------------------------------------------------------------------------
// PR key — router-derived (the repoSearch idiom: no prop threading)
// ---------------------------------------------------------------------------

/**
 * The current PR's override bucket. Review route → "provider:owner/repo#number"
 * (drafts' prKey format, sans sha); demo route → "demo"; anything else (tests,
 * standalone renders) → "local".
 *
 * The router access is guarded: tests that partially mock the router module
 * (e.g. Demo.test.ts mocks only `navigate`) make ANY access to the absent
 * `router` export throw (vitest's mock proxy) — those contexts simply fall
 * into the 'local' bucket.
 */
export function currentPrKey(): string {
  let route: (typeof router)['route'] | undefined
  try {
    route = router?.route
  } catch {
    route = undefined
  }
  if (route?.name === 'review') return `${route.provider}:${route.owner}/${route.repo}#${route.number}`
  if (route?.name === 'demo') return 'demo'
  return 'local'
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const KEY = 'review123:finding-anchors'
const MAX_PER_PR = 50
const MAX_PRS = 30

function isValidOverride(raw: unknown): raw is StoredOverride {
  if (typeof raw !== 'object' || raw === null) return false
  const o = raw as Record<string, unknown>
  return (
    typeof o['path'] === 'string' &&
    typeof o['line'] === 'number' &&
    Number.isInteger(o['line']) &&
    (o['line'] as number) >= 1 &&
    (o['side'] === 'LEFT' || o['side'] === 'RIGHT') &&
    typeof o['movedAt'] === 'number'
  )
}

function readStore(): AnchorStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: AnchorStore = {}
    for (const [prKey, overrides] of Object.entries(parsed)) {
      if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) continue
      const valid: Record<string, StoredOverride> = {}
      for (const [hash, o] of Object.entries(overrides)) {
        if (isValidOverride(o)) valid[hash] = o
      }
      if (Object.keys(valid).length > 0) result[prKey] = valid
    }
    return result
  } catch {
    return {}
  }
}

function writeStore(store: AnchorStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // localStorage unavailable/full — overrides degrade to session-only
  }
}

/** Bound one PR's overrides: keep the MAX_PER_PR most recent by movedAt. */
function capPr(overrides: Record<string, StoredOverride>): Record<string, StoredOverride> {
  const entries = Object.entries(overrides)
  if (entries.length <= MAX_PER_PR) return overrides
  entries.sort((a, b) => b[1].movedAt - a[1].movedAt)
  return Object.fromEntries(entries.slice(0, MAX_PER_PR))
}

/** Bound the PR count: keep the MAX_PRS most recently touched PRs. */
function capPrs(store: AnchorStore): AnchorStore {
  const prKeys = Object.keys(store)
  if (prKeys.length <= MAX_PRS) return store
  const scored = prKeys.map((prKey) => ({
    prKey,
    latest: Math.max(...Object.values(store[prKey]).map((o) => o.movedAt)),
  }))
  scored.sort((a, b) => b.latest - a.latest)
  const keep = new Set(scored.slice(0, MAX_PRS).map((s) => s.prKey))
  const result: AnchorStore = {}
  for (const prKey of prKeys) {
    if (keep.has(prKey)) result[prKey] = store[prKey]
  }
  return result
}

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

// Single reactive holder: reassigned wholesale on every mutation so $derived
// consumers (FileDiff's effective-findings map) always re-run.
let overrides = $state<AnchorStore>(readStore())

/**
 * The in-flight drag: the dragged finding's anchor hash, or null. Set by
 * SkillFindingCard on dragstart/dragend; read by FileDiff's dragover handler
 * (dataTransfer payload is unreadable during dragover, per the DnD spec).
 */
export const reanchorDrag = $state<{ hash: string | null }>({ hash: null })

function persist(next: AnchorStore): void {
  const capped = capPrs(next)
  overrides = capped
  writeStore(capped)
}

// ---------------------------------------------------------------------------
// API — hash-keyed CRUD + prune
// ---------------------------------------------------------------------------

/** The corrected anchor for a finding hash, or null when not overridden. */
export function getAnchorOverride(hash: string, prKey: string = currentPrKey()): AnchorTarget | null {
  const o = overrides[prKey]?.[hash]
  if (!o) return null
  return { path: o.path, line: o.line, side: o.side }
}

/**
 * Record a corrected anchor for a finding hash (persists per-PR).
 * When `move` is provided (the user-gesture call sites in FileDiff), fires the
 * `finding_moved` analytics event — deltas/enums/booleans only, never absolute
 * lines, paths, or finding text (see the allowlist in analytics.ts).
 */
export function setAnchorOverride(hash: string, target: AnchorTarget, prKey: string = currentPrKey(), move?: ReanchorMove): void {
  const forPr = { ...(overrides[prKey] ?? {}) }
  forPr[hash] = { ...target, movedAt: Date.now() }
  persist({ ...overrides, [prKey]: capPr(forPr) })
  if (move) {
    track('finding_moved', {
      method: move.method,
      // Distance is an ABS line delta (approximate when the sides differ —
      // old/new numbering). File-level findings have no reported line → omitted.
      ...(move.reportedLine !== null ? { distance: Math.abs(target.line - move.reportedLine) } : {}),
      // Findings are always REPORTED on the RIGHT (new-file) side.
      same_side: target.side === 'RIGHT',
      off_diff_rescue: move.offDiffRescue,
    })
  }
}

/** Undo: remove the override so the finding returns to its reported line. */
export function clearAnchorOverride(hash: string, prKey: string = currentPrKey()): void {
  const forPr = overrides[prKey]
  if (!forPr || !(hash in forPr)) return
  const next = { ...forPr }
  delete next[hash]
  const store = { ...overrides }
  if (Object.keys(next).length === 0) delete store[prKey]
  else store[prKey] = next
  persist(store)
  // Every production clear IS a user undo (the ✕ on the moved chip) — prune
  // has its own deletion path and never comes through here. No-op clears
  // (absent hash) returned above and fire nothing. Event carries no props.
  track('finding_move_undone')
}

/**
 * Drop overrides whose hash is no longer in the live finding set (a re-run
 * changed/removed the finding — its override is an orphan). Call ONLY with the
 * COMPLETE finding set for the PR (all reviewers, all files, dismissed
 * included), and only once at least one reviewer has settled — an empty
 * in-progress set must not wipe stored overrides (the caller guards this).
 */
export function pruneAnchorOverrides(liveHashes: Set<string>, prKey: string = currentPrKey()): void {
  const forPr = overrides[prKey]
  if (!forPr) return
  const stale = Object.keys(forPr).filter((h) => !liveHashes.has(h))
  if (stale.length === 0) return
  const next = { ...forPr }
  for (const h of stale) delete next[h]
  const store = { ...overrides }
  if (Object.keys(next).length === 0) delete store[prKey]
  else store[prKey] = next
  persist(store)
}

/** Test hook: re-read storage into the reactive map + clear drag state. */
export function _resetReanchorForTest(): void {
  overrides = readStore()
  reanchorDrag.hash = null
}
