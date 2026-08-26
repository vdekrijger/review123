/**
 * src/lib/skills/calibration.ts — Per-reviewer dismissal-calibration ledger.
 *
 * The feedback loop for reviewer quality: when the user dismisses a finding
 * WITH a reason ("Not real" / "Not worth flagging"), the dismissed pattern is
 * recorded against THAT reviewer (skill id). Future runs of the reviewer get
 * the ledger injected into their prompt ("PAST DISMISSED FINDINGS — do not
 * re-raise this pattern unless the case materially differs"), so the tool
 * learns the user's personal mootness taste per persona.
 *
 * Storage: localStorage `review123:skill-calibration`, shape
 *   { [skillId]: CalibrationEntry[] }   (entries oldest → newest)
 *
 * Caps:
 *   - CALIBRATION_CAP_PER_SKILL (15) entries per reviewer — oldest evicted.
 *   - CALIBRATION_PATTERN_MAX (140) chars per stored pattern.
 *   - CALIBRATION_BLOCK_MAX (1500) chars per injected prompt block.
 *
 * Prompt safety: patterns are USER-INFLUENCED data going into a prompt — they
 * are sanitized (markdown/control chars stripped, whitespace collapsed) at
 * record time AND again at block-build time (defense in depth for entries
 * written by older versions or edited by hand).
 *
 * Cache interplay (documented for run.svelte.ts): the injected block joins
 * the reviewer's content hash — `djb2(skill.content + block)` — so a new
 * dismissal-with-reason re-keys ONLY that reviewer's cached results. An empty
 * ledger yields '' and the hash stays byte-identical to `djb2(skill.content)`.
 */

import { djb2 } from '../viewed/viewed.svelte'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const CALIBRATION_KEY = 'review123:skill-calibration'
export const CALIBRATION_CAP_PER_SKILL = 15
export const CALIBRATION_PATTERN_MAX = 140
export const CALIBRATION_BLOCK_MAX = 1500

/** The injected section's header — the e2e stub asserts on this phrase. */
export const CALIBRATION_BLOCK_HEADER =
  'PAST DISMISSED FINDINGS — the user judged these not worth raising; do not ' +
  're-raise the same pattern unless the case materially differs:'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why the user dismissed a finding (the one-click reasons on the card). */
export type DismissReason = 'not-real' | 'not-worth'

export interface CalibrationEntry {
  /** Compact sanitized description of the dismissed finding (≤140 chars + file hint). */
  pattern: string
  reason: DismissReason
  addedAt: number
  /** djb2 of `${path}|${body}` — dedupe identity + per-entry delete handle. */
  findingDigest: string
}

type Ledger = Record<string, CalibrationEntry[]>

// ---------------------------------------------------------------------------
// Shape validator — element-level, tolerant of extra keys
// ---------------------------------------------------------------------------

function isValidEntry(x: unknown): x is CalibrationEntry {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const obj = x as Record<string, unknown>
  if (typeof obj['pattern'] !== 'string' || obj['pattern'].trim() === '') return false
  if (obj['reason'] !== 'not-real' && obj['reason'] !== 'not-worth') return false
  if (typeof obj['addedAt'] !== 'number') return false
  if (typeof obj['findingDigest'] !== 'string') return false
  return true
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function load(): Ledger {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Ledger = {}
    for (const [skillId, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue
      const valid = entries.filter(isValidEntry)
      if (valid.length > 0) out[skillId] = valid.slice(-CALIBRATION_CAP_PER_SKILL)
    }
    return out
  } catch {
    return {}
  }
}

function save(ledger: Ledger): void {
  localStorage.setItem(CALIBRATION_KEY, JSON.stringify(ledger))
}

// ---------------------------------------------------------------------------
// Sanitization + pattern derivation
// ---------------------------------------------------------------------------

/**
 * Strip everything that could break out of (or bloat) a prompt line: fenced
 * code blocks, markdown markup, control characters; collapse whitespace.
 */
function sanitizeForPrompt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks (may span lines)
    .replace(/`+/g, ' ') // stray backticks / inline code markers
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ") // control chars incl. newlines
    .replace(/[*_#>|~[\]]/g, '') // markdown markup
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Derive a compact, self-contained pattern from a dismissed finding: the
 * sanitized body's first ~140 chars plus a file-kind hint (the path's
 * basename) — useful in a prompt without leaking huge finding text.
 */
export function derivePattern(finding: { path: string; body: string }): string {
  const compact = sanitizeForPrompt(finding.body)
  const cut =
    compact.length > CALIBRATION_PATTERN_MAX
      ? `${compact.slice(0, CALIBRATION_PATTERN_MAX).trimEnd()}…`
      : compact
  const basename = sanitizeForPrompt(finding.path.split('/').pop() ?? '')
  return basename ? `${cut} (in ${basename})` : cut
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

/** All ledgers, keyed by skill id (validated; corrupt entries skipped). */
export function listAllCalibration(): Record<string, CalibrationEntry[]> {
  return load()
}

/** This reviewer's entries, oldest → newest (empty array when none). */
export function listCalibration(skillId: string): CalibrationEntry[] {
  return load()[skillId] ?? []
}

/** Count of this reviewer's ledger entries. */
export function calibrationCount(skillId: string): number {
  return listCalibration(skillId).length
}

/**
 * Record a dismissed-with-reason finding against a reviewer. Dedupes on the
 * finding digest (a re-dismissal updates the reason and moves the entry to
 * newest). Caps at CALIBRATION_CAP_PER_SKILL — oldest entries evicted.
 */
export function recordDismissal(
  skillId: string,
  finding: { path: string; body: string },
  reason: DismissReason,
): CalibrationEntry {
  const entry: CalibrationEntry = {
    pattern: derivePattern(finding),
    reason,
    addedAt: Date.now(),
    findingDigest: djb2(`${finding.path}|${finding.body}`),
  }
  const ledger = load()
  const existing = (ledger[skillId] ?? []).filter((e) => e.findingDigest !== entry.findingDigest)
  existing.push(entry)
  ledger[skillId] = existing.slice(-CALIBRATION_CAP_PER_SKILL)
  save(ledger)
  return entry
}

/** Delete ONE entry (by finding digest) from a reviewer's ledger. No-op if absent. */
export function removeCalibrationEntry(skillId: string, findingDigest: string): void {
  const ledger = load()
  const entries = ledger[skillId]
  if (!entries) return
  const kept = entries.filter((e) => e.findingDigest !== findingDigest)
  if (kept.length > 0) ledger[skillId] = kept
  else delete ledger[skillId]
  save(ledger)
}

/** Clear a reviewer's entire ledger (also called when the skill is deleted). */
export function clearCalibration(skillId: string): void {
  const ledger = load()
  if (!(skillId in ledger)) return
  delete ledger[skillId]
  save(ledger)
}

/** Clear every reviewer's ledger. */
export function clearAllCalibration(): void {
  localStorage.removeItem(CALIBRATION_KEY)
}

// ---------------------------------------------------------------------------
// Prompt-injection block
// ---------------------------------------------------------------------------

/**
 * Build the calibration section for a reviewer's prompt, or '' when the
 * ledger is empty. Entries render newest-first, 'not-real' phrased as false
 * positives and 'not-worth' as noise; the total block is capped at
 * CALIBRATION_BLOCK_MAX chars (newest entries win the budget). Every line is
 * re-sanitized defensively — entries are user-influenced data.
 */
export function buildCalibrationBlock(skillId: string): string {
  const entries = listCalibration(skillId)
  if (entries.length === 0) return ''
  const lines: string[] = []
  let total = CALIBRATION_BLOCK_HEADER.length
  for (const entry of [...entries].reverse()) {
    const label = entry.reason === 'not-real' ? '[false positive]' : '[noise]'
    const line = `- ${label} ${sanitizeForPrompt(entry.pattern)}`
    if (total + line.length + 1 > CALIBRATION_BLOCK_MAX) break
    lines.push(line)
    total += line.length + 1
  }
  if (lines.length === 0) return ''
  return `${CALIBRATION_BLOCK_HEADER}\n${lines.join('\n')}`
}
