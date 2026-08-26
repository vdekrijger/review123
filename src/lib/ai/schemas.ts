/**
 * src/lib/ai/schemas.ts — Typed validator functions for AI task output shapes.
 *
 * Validators are hand-rolled typed guards (no runtime deps).
 * Strategy: strict on required fields, types, and enum values; tolerant of
 * extra keys (unknown keys are ignored).
 *
 * GraphResult / Graph are imported from lib/diagram/types to keep the types
 * in sync with the Mermaid serializer (Task 7).
 */

import type { Graph, GraphResult, NodeStatus, ChangeImpact, ImpactChanged, ImpactNode } from '../diagram/types'
import { isGeneratedPath } from '../diff/generated'

// Re-export so consumers can import everything from one place.
export type { Graph, GraphResult, ChangeImpact, ImpactChanged, ImpactNode }

/**
 * Cap on entries PER GROUP (changed / callers / callees) in a change-impact
 * view. Keeps the blast-radius graph tiny + legible and the structured output
 * short enough to come back intact. Exported so the prompt builder, validator,
 * and any consumer share one number.
 */
export const IMPACT_MAX_PER_GROUP = 6

// ---------------------------------------------------------------------------
// AttentionResult
// ---------------------------------------------------------------------------

export interface AttentionResult {
  readingOrder: string[]
  hotspots: { path: string; reason: string; level: 'high' | 'medium' | 'low' }[]
  testFlags: { path: string; note: string }[]
}

const HOTSPOT_LEVELS = new Set<string>(['high', 'medium', 'low'])

/**
 * Validate an unknown value as AttentionResult.
 * Returns the typed value or null if the shape is invalid.
 *
 * EC-15a: a percentage or numeric level value returns null.
 */
export function validateAttention(x: unknown): AttentionResult | null {
  if (!isObject(x)) return null

  // readingOrder — required, must be array of strings
  if (!Array.isArray(x['readingOrder'])) return null
  for (const item of x['readingOrder']) {
    if (typeof item !== 'string') return null
  }

  // hotspots — required, array of objects
  if (!Array.isArray(x['hotspots'])) return null
  for (const hs of x['hotspots']) {
    if (!isObject(hs)) return null
    if (typeof hs['path'] !== 'string') return null
    if (typeof hs['reason'] !== 'string') return null
    if (typeof hs['level'] !== 'string' || !HOTSPOT_LEVELS.has(hs['level'] as string)) return null
  }

  // testFlags — required, array of objects
  if (!Array.isArray(x['testFlags'])) return null
  for (const tf of x['testFlags']) {
    if (!isObject(tf)) return null
    if (typeof tf['path'] !== 'string') return null
    if (typeof tf['note'] !== 'string') return null
  }

  return x as unknown as AttentionResult
}

// ---------------------------------------------------------------------------
// VerdictResult
// ---------------------------------------------------------------------------

export interface VerdictResult {
  level: 'behavior-preserved' | 'minor-changes' | 'significant-changes'
  evidence: string[]
  notAnalyzed: string[]
  /**
   * Cross-model verification per evidence row (Plan M), keyed by the evidence
   * array index. Attached post-generation; absent rows render unverified.
   */
  evidenceVerification?: Record<number, FindingVerification>
  /**
   * Multi-generator provenance per evidence row (Plan O 'generate' mode), keyed
   * by the evidence array index: the display names of every model that raised it.
   * Absent in single-generator ('verify') mode.
   */
  evidenceRaisedBy?: Record<number, string[]>
}

const VERDICT_LEVELS = new Set<string>([
  'behavior-preserved',
  'minor-changes',
  'significant-changes',
])

/**
 * Validate an unknown value as VerdictResult.
 * Returns the typed value or null if the shape is invalid.
 *
 * EC-15a: a numeric or percentage value for level returns null.
 */
export function validateVerdict(x: unknown): VerdictResult | null {
  if (!isObject(x)) return null

  // level — required string enum
  if (typeof x['level'] !== 'string' || !VERDICT_LEVELS.has(x['level'] as string)) return null

  // evidence — required array of strings
  if (!Array.isArray(x['evidence'])) return null
  for (const item of x['evidence']) {
    if (typeof item !== 'string') return null
  }

  // notAnalyzed — required array of strings
  if (!Array.isArray(x['notAnalyzed'])) return null
  for (const item of x['notAnalyzed']) {
    if (typeof item !== 'string') return null
  }

  return x as unknown as VerdictResult
}

// ---------------------------------------------------------------------------
// RiskJudgeResult — LLM change-risk judgment (PROMPT_VERSION 25)
//
// One single-pass task whose 0–3 judgment of the REVIEW ATTENTION a change
// deserves feeds the deterministic review-effort score (src/lib/risk) as ONE
// factor ("AI judgment"). Advisory framing only — never defect probability.
// ---------------------------------------------------------------------------

/** Hard cap on risky snippets the judge may return (the validator truncates). */
export const RISK_JUDGE_MAX_SNIPPETS = 5

/** One place a reviewer should slow down: file (+ optional line) and why. */
export interface RiskJudgeSnippet {
  path: string
  line?: number
  reason: string
}

export interface RiskJudgeResult {
  /** 0 (routine skim) … 3 (deserves the most careful review attention). */
  score: number
  /** One-line justification for the score (≤140 chars requested of the model). */
  rationale: string
  /** Up to RISK_JUDGE_MAX_SNIPPETS highlighted risky spots. May be empty. */
  snippets: RiskJudgeSnippet[]
}

/**
 * Validate an unknown value as RiskJudgeResult.
 * Returns a NORMALIZED value or null if the shape is invalid:
 * - score must be a finite number; it is clamped (and rounded) into 0…3.
 * - rationale must be a non-empty string.
 * - snippets must be an array; each entry needs a non-empty path + reason.
 *   line is optional (finite number → rounded; missing/null → omitted).
 * - The snippets list is capped at RISK_JUDGE_MAX_SNIPPETS entries.
 */
export function validateRiskJudge(x: unknown): RiskJudgeResult | null {
  if (!isObject(x)) return null

  const rawScore = x['score']
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return null
  const score = Math.min(3, Math.max(0, Math.round(rawScore)))

  const rationale = x['rationale']
  if (typeof rationale !== 'string' || rationale.trim().length === 0) return null

  if (!Array.isArray(x['snippets'])) return null
  const snippets: RiskJudgeSnippet[] = []
  for (const s of x['snippets']) {
    if (!isObject(s)) return null
    if (typeof s['path'] !== 'string' || s['path'].trim().length === 0) return null
    if (typeof s['reason'] !== 'string' || s['reason'].trim().length === 0) return null
    const line = s['line']
    const hasLine = typeof line === 'number' && Number.isFinite(line)
    if (line !== undefined && line !== null && !hasLine) return null
    snippets.push({
      path: s['path'],
      ...(hasLine ? { line: Math.round(line) } : {}),
      reason: s['reason'],
    })
  }

  return { score, rationale, snippets: snippets.slice(0, RISK_JUDGE_MAX_SNIPPETS) }
}

// ---------------------------------------------------------------------------
// IntentCheckResult — intent-vs-implementation check (PROMPT_VERSIONS.intent)
//
// The task reads the PR DESCRIPTION as the stated intent and verifies the
// diff against it: which promises are matched (with in-diff evidence), which
// changes a reader of the description would not expect (unrequested), and
// which promises have no corresponding change (unfulfilled).
// ---------------------------------------------------------------------------

/** Cap per collection (intents / matched / unrequested / unfulfilled). */
export const INTENT_MAX_ITEMS = 12

/** One stated intent derived from the PR description. */
export interface IntentItem {
  id: string
  text: string
}

/** One piece of evidence for a matched intent: a changed file (+ line). */
export interface IntentEvidence {
  path: string
  line?: number
}

/** One intent the diff fulfils, with the evidence and a one-line note. */
export interface IntentMatched {
  intentId: string
  evidence: IntentEvidence[]
  note: string
}

/** One change a reader of the description would not expect. */
export interface IntentUnrequested {
  description: string
  paths: string[]
  significance: 'minor' | 'notable'
}

/** One stated intent with no corresponding change in the diff. */
export interface IntentUnfulfilled {
  intentId: string
  note: string
}

export interface IntentCheckResult {
  intents: IntentItem[]
  matched: IntentMatched[]
  unrequested: IntentUnrequested[]
  unfulfilled: IntentUnfulfilled[]
}

const INTENT_SIGNIFICANCE = new Set<string>(['minor', 'notable'])

function validateIntentEvidence(x: unknown): IntentEvidence | null {
  if (!isObject(x)) return null
  if (typeof x['path'] !== 'string' || x['path'].trim().length === 0) return null
  const line = x['line']
  const hasLine = typeof line === 'number' && Number.isFinite(line)
  if (line !== undefined && line !== null && !hasLine) return null
  return { path: x['path'], ...(hasLine ? { line: Math.round(line) } : {}) }
}

/**
 * Validate an unknown value as IntentCheckResult (STRICT).
 * Returns a NORMALIZED value or null if the shape is invalid.
 *
 * Strict rules (any violation → null; the caller then tries the salvage):
 * - all four collections must be arrays.
 * - intents: each { id: non-empty string, text: non-empty string }.
 * - matched/unfulfilled: intentId must reference a LISTED intent id;
 *   note must be a string; evidence entries need a non-empty path
 *   (line optional finite number → rounded).
 * - unrequested: description non-empty string, paths array of strings,
 *   significance exactly 'minor' | 'notable'.
 * Each collection is capped at INTENT_MAX_ITEMS entries (truncated, not
 * rejected — mirrors validateRiskJudge's snippet cap).
 */
export function validateIntentCheck(x: unknown): IntentCheckResult | null {
  if (!isObject(x)) return null
  if (!Array.isArray(x['intents']) || !Array.isArray(x['matched']) || !Array.isArray(x['unrequested']) || !Array.isArray(x['unfulfilled'])) return null

  const intents: IntentItem[] = []
  for (const raw of x['intents']) {
    if (!isObject(raw)) return null
    if (typeof raw['id'] !== 'string' || raw['id'].trim().length === 0) return null
    if (typeof raw['text'] !== 'string' || raw['text'].trim().length === 0) return null
    intents.push({ id: raw['id'], text: raw['text'] })
  }
  const intentIds = new Set(intents.map((i) => i.id))

  const matched: IntentMatched[] = []
  for (const raw of x['matched']) {
    if (!isObject(raw)) return null
    if (typeof raw['intentId'] !== 'string' || !intentIds.has(raw['intentId'])) return null
    if (typeof raw['note'] !== 'string') return null
    if (!Array.isArray(raw['evidence'])) return null
    const evidence: IntentEvidence[] = []
    for (const ev of raw['evidence']) {
      const validated = validateIntentEvidence(ev)
      if (validated === null) return null
      evidence.push(validated)
    }
    matched.push({ intentId: raw['intentId'], evidence, note: raw['note'] })
  }

  const unrequested: IntentUnrequested[] = []
  for (const raw of x['unrequested']) {
    if (!isObject(raw)) return null
    if (typeof raw['description'] !== 'string' || raw['description'].trim().length === 0) return null
    if (!Array.isArray(raw['paths'])) return null
    for (const p of raw['paths']) {
      if (typeof p !== 'string') return null
    }
    if (typeof raw['significance'] !== 'string' || !INTENT_SIGNIFICANCE.has(raw['significance'])) return null
    unrequested.push({
      description: raw['description'],
      paths: raw['paths'] as string[],
      significance: raw['significance'] as 'minor' | 'notable',
    })
  }

  const unfulfilled: IntentUnfulfilled[] = []
  for (const raw of x['unfulfilled']) {
    if (!isObject(raw)) return null
    if (typeof raw['intentId'] !== 'string' || !intentIds.has(raw['intentId'])) return null
    if (typeof raw['note'] !== 'string') return null
    unfulfilled.push({ intentId: raw['intentId'], note: raw['note'] })
  }

  return {
    intents: intents.slice(0, INTENT_MAX_ITEMS),
    matched: matched.slice(0, INTENT_MAX_ITEMS),
    unrequested: unrequested.slice(0, INTENT_MAX_ITEMS),
    unfulfilled: unfulfilled.slice(0, INTENT_MAX_ITEMS),
  }
}

/**
 * Best-effort PER-COLLECTION salvage of a malformed intent-check payload
 * (mirrors salvageAlternativesResult / #220's simplify salvage): each
 * collection is walked leniently and each element that carries the substance
 * is KEPT — one truncated/garbled entry no longer nukes the whole result.
 *
 * Per-item rules (violation → that ITEM is dropped, the rest kept):
 * - intents: id + non-empty text required.
 * - matched/unfulfilled: a KNOWN intentId + string note required; malformed
 *   evidence entries are dropped individually (a matched item may end with
 *   empty evidence — the panel then renders the note without links).
 * - unrequested: non-empty description required; non-string paths dropped;
 *   a missing/invalid significance degrades to 'minor' (the collapsed,
 *   lowest-stakes group) rather than dropping the item.
 * Missing/malformed matched/unrequested/unfulfilled arrays degrade to [].
 *
 * Returns null only when nothing usable survives: the value isn't an object
 * or `intents` isn't an array at all — the caller then takes the error path.
 */
export function salvageIntentCheck(x: unknown): IntentCheckResult | null {
  if (!isObject(x)) return null
  if (!Array.isArray(x['intents'])) return null

  const intents: IntentItem[] = []
  for (const raw of x['intents']) {
    if (!isObject(raw)) continue
    if (typeof raw['id'] !== 'string' || raw['id'].trim().length === 0) continue
    if (typeof raw['text'] !== 'string' || raw['text'].trim().length === 0) continue
    intents.push({ id: raw['id'], text: raw['text'] })
  }
  const intentIds = new Set(intents.map((i) => i.id))

  const matched: IntentMatched[] = []
  if (Array.isArray(x['matched'])) {
    for (const raw of x['matched']) {
      if (!isObject(raw)) continue
      if (typeof raw['intentId'] !== 'string' || !intentIds.has(raw['intentId'])) continue
      if (typeof raw['note'] !== 'string') continue
      const evidence: IntentEvidence[] = []
      if (Array.isArray(raw['evidence'])) {
        for (const ev of raw['evidence']) {
          const validated = validateIntentEvidence(ev)
          if (validated !== null) evidence.push(validated)
        }
      }
      matched.push({ intentId: raw['intentId'], evidence, note: raw['note'] })
    }
  }

  const unrequested: IntentUnrequested[] = []
  if (Array.isArray(x['unrequested'])) {
    for (const raw of x['unrequested']) {
      if (!isObject(raw)) continue
      if (typeof raw['description'] !== 'string' || raw['description'].trim().length === 0) continue
      const paths = Array.isArray(raw['paths'])
        ? raw['paths'].filter((p): p is string => typeof p === 'string')
        : []
      const significance =
        typeof raw['significance'] === 'string' && INTENT_SIGNIFICANCE.has(raw['significance'])
          ? (raw['significance'] as 'minor' | 'notable')
          : 'minor'
      unrequested.push({ description: raw['description'], paths, significance })
    }
  }

  const unfulfilled: IntentUnfulfilled[] = []
  if (Array.isArray(x['unfulfilled'])) {
    for (const raw of x['unfulfilled']) {
      if (!isObject(raw)) continue
      if (typeof raw['intentId'] !== 'string' || !intentIds.has(raw['intentId'])) continue
      if (typeof raw['note'] !== 'string') continue
      unfulfilled.push({ intentId: raw['intentId'], note: raw['note'] })
    }
  }

  return {
    intents: intents.slice(0, INTENT_MAX_ITEMS),
    matched: matched.slice(0, INTENT_MAX_ITEMS),
    unrequested: unrequested.slice(0, INTENT_MAX_ITEMS),
    unfulfilled: unfulfilled.slice(0, INTENT_MAX_ITEMS),
  }
}

// ---------------------------------------------------------------------------
// ExpectedOutcomesResult — expected-outcomes check (PROMPT_VERSIONS.outcomes)
//
// The task derives the concrete OBSERVABLE behavior changes the diff makes —
// before → after pairs with in-diff evidence and the changed symbols each
// claim hinges on (for the DETERMINISTIC symbol↔test cross-reference done
// client-side, never by the LLM) — plus a "without this change" necessity
// note.
// ---------------------------------------------------------------------------

/** Hard cap on outcome rows (the validator truncates; the prompt requests ≤8). */
export const OUTCOMES_MAX_ITEMS = 8

/** One piece of evidence for an outcome claim: a changed file (+ line). */
export interface OutcomeEvidence {
  path: string
  line?: number
}

/** One observable behavior change: before → after, with evidence + symbols. */
export interface OutcomeItem {
  id: string
  /** ONE plain sentence: the observable behavior BEFORE this change. */
  before: string
  /** ONE plain sentence: the observable behavior AFTER this change. */
  after: string
  /** Changed files (+ optional new-file line) grounding the claim. */
  evidence: OutcomeEvidence[]
  /**
   * Changed function/class names this claim hinges on. Consumed by the
   * deterministic test cross-reference (src/lib/ai/outcomeTests.ts) — the LLM
   * never guesses test names; the panel resolves these symbols against the
   * PR's changed test files via the #95 pairing machinery.
   */
  symbols: string[]
}

export interface ExpectedOutcomesResult {
  /** Most significant first. EMPTY is legitimate (pure refactor/cosmetic). */
  outcomes: OutcomeItem[]
  /** 1–2 sentences: what stays broken/missing without this PR. */
  withoutThis: string
}

function validateOutcomeEvidence(x: unknown): OutcomeEvidence | null {
  if (!isObject(x)) return null
  if (typeof x['path'] !== 'string' || x['path'].trim().length === 0) return null
  const line = x['line']
  const hasLine = typeof line === 'number' && Number.isFinite(line)
  if (line !== undefined && line !== null && !hasLine) return null
  return { path: x['path'], ...(hasLine ? { line: Math.round(line) } : {}) }
}

/**
 * Validate an unknown value as ExpectedOutcomesResult (STRICT).
 * Returns a NORMALIZED value or null if the shape is invalid.
 *
 * Strict rules (any violation → null; the caller then tries the salvage):
 * - outcomes must be an array (EMPTY is valid — the auto-suppress signal for
 *   pure refactors; the panel renders the calm "no observable changes" note).
 * - each outcome: id/before/after non-empty strings; evidence an array of
 *   valid entries (non-empty path, optional finite line → rounded); symbols
 *   an array of strings.
 * - withoutThis must be a string.
 * The outcomes list is capped at OUTCOMES_MAX_ITEMS entries (truncated, not
 * rejected — mirrors validateIntentCheck's collection caps).
 */
export function validateExpectedOutcomes(x: unknown): ExpectedOutcomesResult | null {
  if (!isObject(x)) return null
  if (!Array.isArray(x['outcomes'])) return null
  if (typeof x['withoutThis'] !== 'string') return null

  const outcomes: OutcomeItem[] = []
  for (const raw of x['outcomes']) {
    if (!isObject(raw)) return null
    if (typeof raw['id'] !== 'string' || raw['id'].trim().length === 0) return null
    if (typeof raw['before'] !== 'string' || raw['before'].trim().length === 0) return null
    if (typeof raw['after'] !== 'string' || raw['after'].trim().length === 0) return null
    if (!Array.isArray(raw['evidence'])) return null
    const evidence: OutcomeEvidence[] = []
    for (const ev of raw['evidence']) {
      const validated = validateOutcomeEvidence(ev)
      if (validated === null) return null
      evidence.push(validated)
    }
    if (!Array.isArray(raw['symbols'])) return null
    for (const s of raw['symbols']) {
      if (typeof s !== 'string') return null
    }
    outcomes.push({
      id: raw['id'],
      before: raw['before'],
      after: raw['after'],
      evidence,
      symbols: raw['symbols'] as string[],
    })
  }

  return { outcomes: outcomes.slice(0, OUTCOMES_MAX_ITEMS), withoutThis: x['withoutThis'] }
}

/**
 * Best-effort PER-ELEMENT salvage of a malformed expected-outcomes payload
 * (mirrors salvageIntentCheck): each outcome that carries the substance is
 * KEPT — one truncated/garbled entry no longer nukes the whole result.
 *
 * Per-item rules (violation → that ITEM is dropped, the rest kept):
 * - before + after (non-empty strings) are the substance — required.
 * - a missing/blank id is SYNTHESIZED positionally ("o1"…) — nothing
 *   cross-references outcome ids, so the substance survives.
 * - malformed evidence entries are dropped individually; a missing evidence
 *   array degrades to [].
 * - non-string symbols are dropped individually; missing array degrades to [].
 * - a missing/invalid withoutThis degrades to '' (the panel hides the footer).
 *
 * Returns null when nothing usable survives: the value isn't an object,
 * `outcomes` isn't an array at all, or a NON-EMPTY outcomes array salvages to
 * zero items (an all-garbage list must not masquerade as the legitimate
 * "no observable changes" empty result) — the caller then takes the error path.
 */
export function salvageExpectedOutcomes(x: unknown): ExpectedOutcomesResult | null {
  if (!isObject(x)) return null
  if (!Array.isArray(x['outcomes'])) return null

  const outcomes: OutcomeItem[] = []
  for (const raw of x['outcomes']) {
    if (!isObject(raw)) continue
    if (typeof raw['before'] !== 'string' || raw['before'].trim().length === 0) continue
    if (typeof raw['after'] !== 'string' || raw['after'].trim().length === 0) continue
    const id =
      typeof raw['id'] === 'string' && raw['id'].trim().length > 0
        ? raw['id']
        : `o${outcomes.length + 1}`
    const evidence: OutcomeEvidence[] = []
    if (Array.isArray(raw['evidence'])) {
      for (const ev of raw['evidence']) {
        const validated = validateOutcomeEvidence(ev)
        if (validated !== null) evidence.push(validated)
      }
    }
    const symbols = Array.isArray(raw['symbols'])
      ? raw['symbols'].filter((s): s is string => typeof s === 'string')
      : []
    outcomes.push({ id, before: raw['before'], after: raw['after'], evidence, symbols })
  }

  // A non-empty raw list that salvages to nothing is garbage, not a legitimate
  // empty result — refuse rather than render a false "no observable changes".
  if (x['outcomes'].length > 0 && outcomes.length === 0) return null

  const withoutThis = typeof x['withoutThis'] === 'string' ? x['withoutThis'] : ''
  return { outcomes: outcomes.slice(0, OUTCOMES_MAX_ITEMS), withoutThis }
}

// ---------------------------------------------------------------------------
// GraphResult
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as GraphResult.
 * Returns the typed value or null if the shape is invalid.
 *
 * Accepts optional `changeMap` (D1: change-map graph with statuses), optional
 * `impact` (change-impact / blast-radius view), and optional `status` on
 * nodes/edges. Absent statuses/changeMap/impact stay valid — old cached results
 * (including retired `flow`-only payloads, whose unknown `flow` key is simply
 * ignored) degrade gracefully to a suppressed impact.
 *
 * Invalid status enum value → null (strict enum enforcement).
 */
export function validateGraphResult(x: unknown): GraphResult | null {
  if (!isObject(x)) return null

  // kind — required string enum
  if (x['kind'] !== 'flow' && x['kind'] !== 'module') return null

  // before + after — required Graph shapes
  const before = validateGraph(x['before'])
  if (before === null) return null

  const after = validateGraph(x['after'])
  if (after === null) return null

  // changeMap — optional Graph shape (D1)
  let changeMap: Graph | undefined
  if ('changeMap' in x && x['changeMap'] !== undefined) {
    const cm = validateGraph(x['changeMap'])
    if (cm === null) return null
    changeMap = cm
  }

  // impact — optional ChangeImpact (change-impact / blast-radius view).
  // Absent → backward-compatible (old cached results, incl. retired `flow`-only
  // payloads, degrade to the suppressed note). Present-but-malformed → null.
  let impact: ChangeImpact | undefined
  if ('impact' in x && x['impact'] !== undefined) {
    const im = validateChangeImpact(x['impact'])
    if (im === null) return null
    impact = im
  }

  const result: GraphResult = { before, after, kind: x['kind'] as 'flow' | 'module' }
  if (changeMap !== undefined) result.changeMap = changeMap
  if (impact !== undefined) result.impact = impact
  return result
}

// ---------------------------------------------------------------------------
// ChangeImpact (change-impact / blast-radius view)
// ---------------------------------------------------------------------------

const IMPACT_KINDS = new Set<string>(['added', 'changed', 'removed'])

/** Validate one caller/callee node: { symbol: string, file?: string }. */
function validateImpactNode(x: unknown): ImpactNode | null {
  if (!isObject(x)) return null
  if (typeof x['symbol'] !== 'string') return null
  if ('file' in x && x['file'] !== undefined && typeof x['file'] !== 'string') return null
  return x as unknown as ImpactNode
}

/**
 * Validate an unknown value as ChangeImpact.
 * Returns the typed value or null if the shape is invalid.
 *
 * Strict on: changed array (each { symbol: string, file?: string, kind:
 * added|changed|removed }) and callers/callees arrays (each { symbol: string,
 * file?: string }). Each of the three arrays is capped at IMPACT_MAX_PER_GROUP
 * (more than the cap → null). Tolerant of extra keys. An EMPTY impact (changed
 * = []) is VALID — it is the AUTO-SUPPRESS signal (the panel renders the "no
 * notable call-graph impact" note). Forward-compatible: unknown extra fields on
 * the root/elements are ignored.
 */
export function validateChangeImpact(x: unknown): ChangeImpact | null {
  if (!isObject(x)) return null

  // changed — required array (may be empty = suppress), capped, kind enum strict.
  if (!Array.isArray(x['changed'])) return null
  if (x['changed'].length > IMPACT_MAX_PER_GROUP) return null
  for (const c of x['changed']) {
    if (!isObject(c)) return null
    if (typeof c['symbol'] !== 'string') return null
    if ('file' in c && c['file'] !== undefined && typeof c['file'] !== 'string') return null
    if (typeof c['kind'] !== 'string' || !IMPACT_KINDS.has(c['kind'] as string)) return null
  }

  // callers — required array (may be empty), capped.
  if (!Array.isArray(x['callers'])) return null
  if (x['callers'].length > IMPACT_MAX_PER_GROUP) return null
  for (const n of x['callers']) {
    if (validateImpactNode(n) === null) return null
  }

  // callees — required array (may be empty), capped.
  if (!Array.isArray(x['callees'])) return null
  if (x['callees'].length > IMPACT_MAX_PER_GROUP) return null
  for (const n of x['callees']) {
    if (validateImpactNode(n) === null) return null
  }

  return x as unknown as ChangeImpact
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// 'context' (deep-diagram mode) is additive — old cached graphs that never
// carry it still validate, and graphs that do still pass the strict enum check.
const NODE_STATUSES = new Set<string>(['added', 'removed', 'changed', 'unchanged', 'context'])

function validateGraph(x: unknown): Graph | null {
  if (!isObject(x)) return null

  // nodes — required array of {id: string, label: string, status?: NodeStatus}
  if (!Array.isArray(x['nodes'])) return null
  for (const node of x['nodes']) {
    if (!isObject(node)) return null
    if (typeof node['id'] !== 'string') return null
    if (typeof node['label'] !== 'string') return null
    // status is optional — only validate type/enum if present
    if ('status' in node && node['status'] !== undefined) {
      if (typeof node['status'] !== 'string' || !NODE_STATUSES.has(node['status'] as string)) return null
    }
  }

  // edges — required array of {from: string, to: string, label?: string, status?: NodeStatus}
  if (!Array.isArray(x['edges'])) return null
  for (const edge of x['edges']) {
    if (!isObject(edge)) return null
    if (typeof edge['from'] !== 'string') return null
    if (typeof edge['to'] !== 'string') return null
    // label is optional — only validate type if present
    if ('label' in edge && edge['label'] !== undefined && typeof edge['label'] !== 'string') return null
    // status is optional — only validate type/enum if present
    if ('status' in edge && edge['status'] !== undefined) {
      if (typeof edge['status'] !== 'string' || !NODE_STATUSES.has(edge['status'] as string)) return null
    }
  }

  return x as unknown as Graph
}

// ---------------------------------------------------------------------------
// TestInsight
// ---------------------------------------------------------------------------

export interface TestInsight {
  covered: { behavior: string; test: string; file: string }[]
  gaps: string[]
}

/**
 * Validate an unknown value as TestInsight.
 * Returns the typed value or null if the shape is invalid.
 *
 * Strict on required fields and array element shapes; tolerant of extra keys.
 */
export function validateTestInsight(x: unknown): TestInsight | null {
  if (!isObject(x)) return null

  // covered — required array of {behavior: string; test: string; file: string}
  if (!Array.isArray(x['covered'])) return null
  for (const item of x['covered']) {
    if (!isObject(item)) return null
    if (typeof item['behavior'] !== 'string') return null
    if (typeof item['test'] !== 'string') return null
    if (typeof item['file'] !== 'string') return null
  }

  // gaps — required array of strings
  if (!Array.isArray(x['gaps'])) return null
  for (const item of x['gaps']) {
    if (typeof item !== 'string') return null
  }

  return x as unknown as TestInsight
}

// ---------------------------------------------------------------------------
// CommentReview / CoachResult
// ---------------------------------------------------------------------------

/**
 * Coach dimensions, in display order. Each can carry a one-line rationale in
 * CommentReview.reasons (v9).
 */
export const COACH_DIMENSIONS = [
  'clarity',
  'tone',
  'actionable',
  'accuracy',
  'duplicate',
  'specificity',
  'grounded',
] as const

export type CoachDimension = (typeof COACH_DIMENSIONS)[number]

/**
 * One-line rationale per dimension (v9). All entries optional — responses
 * from older prompt versions (or models that omit them) lack these and must
 * still render without crashing.
 */
export type CoachReasons = Partial<Record<CoachDimension, string>>

export interface CommentReview {
  index: number
  clarity: 1 | 2 | 3 | 4 | 5
  actionable: boolean
  tone: 'ok' | 'blunt' | 'harsh'
  biasQuestion: string | null
  suggestion: string | null
  /** Does the comment's claim match what the diff actually shows? */
  accuracy: 'consistent' | 'questionable' | 'contradicted'
  /** When accuracy is 'contradicted', explains why. Otherwise null. */
  accuracyNote: string | null
  /** True when the comment substantially repeats an existing PR comment. */
  duplicate: boolean
  /**
   * v9 (optional — older shapes lack it): true when the comment points at
   * concrete code (identifiers, functions, lines) rather than vague vibes.
   */
  specificity?: boolean
  /**
   * v9 (optional — older shapes lack it): true when every claim the comment
   * makes is verifiable in the diff/hunk context provided to the coach.
   */
  grounded?: boolean
  /**
   * v9 (optional — older shapes lack it): one-line rationale per dimension,
   * for passing AND failing grades.
   */
  reasons?: CoachReasons | null
}

/**
 * v9: one per coaching run — do the drafted comments collectively match the
 * reviewer's chosen verdict?
 */
export interface VerdictCoherence {
  coherent: boolean
  note: string
}

export interface CoachResult {
  reviews: CommentReview[]
  /** v9 (optional — older shapes lack it): comments-vs-verdict coherence check. */
  verdictCoherence?: VerdictCoherence | null
}

const TONE_VALUES = new Set<string>(['ok', 'blunt', 'harsh'])
const CLARITY_VALUES = new Set<number>([1, 2, 3, 4, 5])
const ACCURACY_VALUES = new Set<string>(['consistent', 'questionable', 'contradicted'])

/**
 * Validate an unknown value as CoachResult.
 * Returns the typed value or null if the shape is invalid.
 *
 * Strict: clarity must be an integer 1–5 (not 0, not 6, not 2.5);
 * tone must be 'ok'|'blunt'|'harsh'; index must be an integer.
 * Tolerant of extra keys on both the top-level object and review objects.
 */
export function validateCoachResult(x: unknown): CoachResult | null {
  if (!isObject(x)) return null

  // reviews — required array of CommentReview
  if (!Array.isArray(x['reviews'])) return null
  for (const review of x['reviews']) {
    if (!isObject(review)) return null

    // index — required integer
    if (typeof review['index'] !== 'number' || !Number.isInteger(review['index'])) return null

    // clarity — required integer in {1,2,3,4,5}
    if (typeof review['clarity'] !== 'number') return null
    if (!Number.isInteger(review['clarity'])) return null
    if (!CLARITY_VALUES.has(review['clarity'] as number)) return null

    // actionable — required boolean
    if (typeof review['actionable'] !== 'boolean') return null

    // tone — required string enum
    if (typeof review['tone'] !== 'string' || !TONE_VALUES.has(review['tone'] as string)) return null

    // biasQuestion — required, must be string or null
    if (!('biasQuestion' in review)) return null
    if (review['biasQuestion'] !== null && typeof review['biasQuestion'] !== 'string') return null

    // suggestion — required, must be string or null
    if (!('suggestion' in review)) return null
    if (review['suggestion'] !== null && typeof review['suggestion'] !== 'string') return null

    // accuracy — required string enum
    if (typeof review['accuracy'] !== 'string' || !ACCURACY_VALUES.has(review['accuracy'] as string)) return null

    // accuracyNote — required, must be string or null
    if (!('accuracyNote' in review)) return null
    if (review['accuracyNote'] !== null && typeof review['accuracyNote'] !== 'string') return null

    // duplicate — required boolean
    if (typeof review['duplicate'] !== 'boolean') return null

    // specificity — OPTIONAL boolean (v9; absent in older shapes)
    if ('specificity' in review && review['specificity'] !== undefined) {
      if (typeof review['specificity'] !== 'boolean') return null
    }

    // grounded — OPTIONAL boolean (v9; absent in older shapes)
    if ('grounded' in review && review['grounded'] !== undefined) {
      if (typeof review['grounded'] !== 'boolean') return null
    }

    // reasons — OPTIONAL object of per-dimension strings (v9).
    // Absent or null is tolerated (older shapes / models that omit it).
    if ('reasons' in review && review['reasons'] !== undefined && review['reasons'] !== null) {
      const reasons = review['reasons']
      if (!isObject(reasons)) return null
      for (const dim of COACH_DIMENSIONS) {
        const value = reasons[dim]
        if (value !== undefined && value !== null && typeof value !== 'string') return null
      }
    }
  }

  // verdictCoherence — OPTIONAL (v9). Absent or null is tolerated; when
  // present it must be { coherent: boolean, note: string }.
  if ('verdictCoherence' in x && x['verdictCoherence'] !== undefined && x['verdictCoherence'] !== null) {
    const vc = x['verdictCoherence']
    if (!isObject(vc)) return null
    if (typeof vc['coherent'] !== 'boolean') return null
    if (typeof vc['note'] !== 'string') return null
  }

  return x as unknown as CoachResult
}

// ---------------------------------------------------------------------------
// AlternativesResult (Plan F)
// ---------------------------------------------------------------------------

export interface Alternative {
  approach: string
  tradeoffs: string
  /**
   * Optional since the salvage path landed: a salvaged alternative whose
   * assessment was missing/invalid keeps its substance (approach/tradeoffs/
   * rationale) and simply omits the chip. Strict validation still requires it.
   */
  assessment?: 'pr-is-better' | 'comparable' | 'alternative-is-better' | 'different-goals'
  rationale: string
}

export interface AlternativesResult {
  problem: string
  alternatives: Alternative[]
}

const ASSESSMENT_VALUES = new Set<string>([
  'pr-is-better',
  'comparable',
  'alternative-is-better',
  'different-goals',
])

/**
 * Validate an unknown value as AlternativesResult.
 * Returns the typed value or null if the shape is invalid.
 *
 * Strict on: problem (string), alternatives (array ≤3), each alternative's
 * required fields and assessment enum. Tolerant of extra keys.
 */
export function validateAlternativesResult(x: unknown): AlternativesResult | null {
  if (!isObject(x)) return null

  // problem — required string
  if (typeof x['problem'] !== 'string') return null

  // alternatives — required array of Alternative (≤3)
  if (!Array.isArray(x['alternatives'])) return null
  for (const alt of x['alternatives']) {
    if (!isObject(alt)) return null
    if (typeof alt['approach'] !== 'string') return null
    if (typeof alt['tradeoffs'] !== 'string') return null
    if (typeof alt['assessment'] !== 'string' || !ASSESSMENT_VALUES.has(alt['assessment'] as string)) return null
    if (typeof alt['rationale'] !== 'string') return null
  }

  return x as unknown as AlternativesResult
}

/**
 * Best-effort salvage of a malformed alternatives payload (mirrors
 * salvageStoryOrder): walk `alternatives[]` leniently and KEEP each element
 * that carries the substance (approach/tradeoffs/rationale strings), dropping
 * only genuinely malformed elements — one truncated/garbled entry no longer
 * nukes the whole result. A missing/invalid `assessment` does NOT drop the
 * element: the field is simply omitted (the UI hides the chip). Returns null
 * when nothing usable survives (`problem` missing or zero valid elements) —
 * the caller then takes the error path.
 */
export function salvageAlternativesResult(x: unknown): AlternativesResult | null {
  if (!isObject(x)) return null
  if (typeof x['problem'] !== 'string') return null
  if (!Array.isArray(x['alternatives'])) return null

  const alternatives: Alternative[] = []
  for (const raw of x['alternatives']) {
    if (!isObject(raw)) continue
    if (typeof raw['approach'] !== 'string') continue
    if (typeof raw['tradeoffs'] !== 'string') continue
    if (typeof raw['rationale'] !== 'string') continue
    const assessment =
      typeof raw['assessment'] === 'string' && ASSESSMENT_VALUES.has(raw['assessment'])
        ? (raw['assessment'] as NonNullable<Alternative['assessment']>)
        : undefined
    alternatives.push({
      approach: raw['approach'],
      tradeoffs: raw['tradeoffs'],
      rationale: raw['rationale'],
      ...(assessment !== undefined ? { assessment } : {}),
    })
  }
  if (alternatives.length === 0) return null
  return { problem: x['problem'], alternatives }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

// ---------------------------------------------------------------------------
// StoryOrderResult (Plan H — Story mode)
// ---------------------------------------------------------------------------

/**
 * Layer taxonomy for story classification, in canonical reading order. Exported
 * so the prompt builder and consumers share the SAME list (single source of
 * truth). 'foundational'/'config' are woven in just before their first consumer
 * by the model — the order here is only the within-layer grouping default.
 */
export const STORY_LAYERS = [
  'data',
  'api',
  'logic',
  'config',
  'tests',
  'ui',
  'foundational',
  // 'other' labels the deterministic catch-all step (Plan K) that sweeps any
  // changed file the model left unplaced, so Story mode provably covers EVERY
  // changed file. It's normally synthesized post-validation (not model-emitted),
  // but including it here keeps the StoryLayer type + LAYER_LABEL in sync (a
  // model echoing 'other' is harmless — it just renders as another step).
  'other',
] as const

export type StoryLayer = (typeof STORY_LAYERS)[number]

export interface StoryStep {
  /** Ordered position, 0-based. The model emits steps already in reading order. */
  index: number
  /** File path(s) this step covers — at least one, all should appear in the PR. */
  files: string[]
  /** One-line narrative caption ("The schema gains a `provider` column…"). */
  caption: string
  /** Which layer this step belongs to. */
  layer: StoryLayer
  /** Related test file paths to show inline for sense-checking (may be empty). */
  relatedTests: string[]
}

export interface StoryOrderResult {
  steps: StoryStep[]
}

const STORY_LAYER_SET = new Set<string>(STORY_LAYERS)

/**
 * Validate an unknown value as StoryOrderResult.
 * Returns the typed value or null if the shape is invalid.
 *
 * Strict on: steps array, each step's index (integer), files (non-empty array
 * of strings), caption (string), layer (enum), relatedTests (array of strings).
 * Tolerant of extra keys. An empty steps array is valid (the consumer falls
 * back to Files mode when there are no usable steps).
 */
export function validateStoryOrder(x: unknown): StoryOrderResult | null {
  if (!isObject(x)) return null

  if (!Array.isArray(x['steps'])) return null
  for (const step of x['steps']) {
    if (!isObject(step)) return null

    // index — required integer
    if (typeof step['index'] !== 'number' || !Number.isInteger(step['index'])) return null

    // files — required non-empty array of strings
    if (!Array.isArray(step['files']) || step['files'].length === 0) return null
    for (const f of step['files']) {
      if (typeof f !== 'string') return null
    }

    // caption — required string
    if (typeof step['caption'] !== 'string') return null

    // layer — required string enum
    if (typeof step['layer'] !== 'string' || !STORY_LAYER_SET.has(step['layer'] as string)) {
      return null
    }

    // relatedTests — required array of strings
    if (!Array.isArray(step['relatedTests'])) return null
    for (const t of step['relatedTests']) {
      if (typeof t !== 'string') return null
    }
  }

  return x as unknown as StoryOrderResult
}

/**
 * Hard cap on the number of steps a story may render. Big PRs that produce a
 * long nested JSON cause DeepSeek to truncate/malform the output; keeping the
 * step count bounded (and instructing the model to GROUP AGGRESSIVELY) keeps
 * the structured output short enough to come back intact. Exported so the
 * prompt builder and the consumer share the same number.
 */
export const STORY_MAX_STEPS = 12

/**
 * Normalize a file path for tolerant matching against the PR's filenames.
 * Strips surrounding whitespace, a leading `./`, and the git `a/` or `b/`
 * diff prefixes. Lowercase is NOT applied — paths are case-sensitive.
 */
export function normalizeStoryPath(p: string): string {
  let s = p.trim()
  if (s.startsWith('./')) s = s.slice(2)
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2)
  return s
}

/**
 * Resolve a story-step path against the PR's real filenames, tolerantly.
 *
 * Match precedence (most specific first):
 *   1. exact (after normalization),
 *   2. unique suffix match (a filename ends with `/<normalized>`),
 *   3. unique basename match (same final path segment).
 *
 * Returns the matched PR filename, or null when nothing matches or a basename
 * is ambiguous (>1 PR file shares it — we refuse to guess).
 */
export function matchStoryPath(p: string, prFilenames: readonly string[]): string | null {
  const norm = normalizeStoryPath(p)
  if (norm === '') return null

  // 1. exact (normalize both sides so `./a/x.ts` matches `x.ts` etc.)
  const exact = prFilenames.find((f) => normalizeStoryPath(f) === norm)
  if (exact) return exact

  // 2. unique suffix: a PR file path ends with `/<norm>`
  const suffixMatches = prFilenames.filter((f) => normalizeStoryPath(f).endsWith('/' + norm))
  if (suffixMatches.length === 1) return suffixMatches[0]

  // 3. unique basename
  const base = norm.split('/').pop() ?? norm
  const baseMatches = prFilenames.filter((f) => (normalizeStoryPath(f).split('/').pop() ?? '') === base)
  if (baseMatches.length === 1) return baseMatches[0]

  return null
}

/**
 * Deterministic anti-overlap post-process for a story result (fixes adjacent
 * steps showing the same code). Enforces the prompt's invariant in code so a
 * non-compliant model can't break it:
 *   - every file appears in EXACTLY ONE step's `files` (kept in the FIRST step
 *     that lists it; stripped from later steps),
 *   - a step's `relatedTests` never duplicates any file shown as a primary
 *     `files` entry anywhere, nor a relatedTest already shown earlier,
 *   - steps left with no `files` after de-duplication are dropped,
 *   - the remaining steps are re-indexed 0..n-1.
 *
 * Paths are compared by their normalized form so `./a/x.ts` and `x.ts` collapse.
 * Pure function — returns a new result, never mutates the input.
 */
export function dedupeStorySteps(story: StoryOrderResult): StoryOrderResult {
  const seenFiles = new Set<string>() // normalized primary-file keys, across all steps
  const out: StoryStep[] = []

  for (const step of story.steps) {
    const files: string[] = []
    for (const f of step.files) {
      const key = normalizeStoryPath(f)
      if (key === '' || seenFiles.has(key)) continue
      seenFiles.add(key)
      files.push(f)
    }
    if (files.length === 0) continue // nothing left to show → drop the step
    out.push({ ...step, files, index: out.length })
  }

  // Second pass: relatedTests must not duplicate ANY primary file (now known)
  // nor a relatedTest already surfaced in an earlier step.
  const seenTests = new Set<string>()
  for (const step of out) {
    const tests: string[] = []
    for (const t of step.relatedTests) {
      const key = normalizeStoryPath(t)
      if (key === '' || seenFiles.has(key) || seenTests.has(key)) continue
      seenTests.add(key)
      tests.push(t)
    }
    step.relatedTests = tests
  }

  return { steps: out }
}

/**
 * Deterministic post-process that sinks GENERATED-file steps to the END of the
 * story, after the narrative — generated artifacts (lockfiles, snapshots, codegen
 * output) are the lowest-priority reading and shouldn't interrupt the data → api
 * → logic → tests → ui flow. The prompt already requests this; this enforces it
 * in code so a non-compliant model can't break it.
 *
 * A step is "generated" when EVERY one of its primary `files` is a generated
 * path. A mixed step (some hand-written files) stays in place — its generated
 * files are incidental to a real change. Stable: preserves relative order within
 * the generated and non-generated groups. Re-indexes 0..n-1. Pure.
 *
 * Path-only detection (story steps carry filenames, not contents) — matches the
 * file-tree's path-only stance.
 */
export function sinkGeneratedSteps(story: StoryOrderResult): StoryOrderResult {
  const stepIsGenerated = (s: StoryStep): boolean =>
    s.files.length > 0 && s.files.every((f) => isGeneratedPath(normalizeStoryPath(f)))

  const normal: StoryStep[] = []
  const generated: StoryStep[] = []
  for (const step of story.steps) {
    if (stepIsGenerated(step)) generated.push(step)
    else normal.push(step)
  }
  const ordered = [...normal, ...generated]
  return { steps: ordered.map((s, i) => ({ ...s, index: i })) }
}

/**
 * Label for the synthetic catch-all step's layer (Plan K). Exported so the
 * caption and any reconciliation copy share one string.
 */
export const STORY_OTHER_LAYER: StoryLayer = 'other'

/**
 * Structural 100% coverage (Plan K). Given the already-shaped steps (paths
 * resolved to REAL PR filenames, deduped, generated-sunk) and the PR's full
 * changed-file list, sweep any changed file NOT placed in some step's primary
 * `files` into a single synthetic catch-all step appended LAST:
 *
 *   { layer: 'other', caption: 'Other changes (N)', files: [...unplaced] }
 *
 * A file is "covered" when it appears as a PRIMARY `files` entry in ANY step OR
 * as a `relatedTests` snippet in any step — both are shown to the reader exactly
 * once (the relatedTest as the inline "Tested by" snippet from #95). Only a file
 * that appears in NEITHER is genuinely unplaced and gets swept into the catch-all
 * (so its diff is shown once). This prevents the #63208 duplicate: a test shown
 * inline on a code step is NOT re-added here as an "Other changes" primary.
 *
 * Order within the catch-all follows prFilenames order (deterministic). Paths
 * are compared by their normalized form (so `./a/x.ts` and `x.ts` collapse),
 * matching dedupeStorySteps.
 *
 * No unplaced files → steps returned unchanged (no empty catch-all step). This
 * is the common single-code-step-plus-inline-test case: nothing left to sweep.
 * `prFilenames` should already be the non-excluded changed files (the caller's
 * `files` list); excluded/binary files the caller never renders aren't passed.
 *
 * Pure. Indices on the input steps are preserved; the catch-all gets index
 * steps.length.
 */
export function appendCatchAllStep(steps: StoryStep[], prFilenames: readonly string[]): StoryStep[] {
  // Covered = union of every step's primary files AND every step's relatedTests.
  // A relatedTest-shown file is already on screen (once), so it must not be
  // re-swept as a catch-all primary (#63208).
  const covered = new Set<string>()
  for (const step of steps) {
    for (const f of step.files) covered.add(normalizeStoryPath(f))
    for (const t of step.relatedTests) covered.add(normalizeStoryPath(t))
  }
  // Preserve prFilenames order; only files genuinely absent (neither a primary
  // nor a relatedTest anywhere) are unplaced.
  const unplaced = prFilenames.filter((f) => !covered.has(normalizeStoryPath(f)))
  if (unplaced.length === 0) return steps

  const catchAll: StoryStep = {
    index: steps.length,
    files: [...unplaced],
    caption: `Other changes (${unplaced.length})`,
    layer: STORY_OTHER_LAYER,
    relatedTests: [],
  }
  return [...steps, catchAll]
}

/**
 * Best-effort salvage of a malformed story-order payload (final guard for big
 * PRs where DeepSeek truncates the long nested JSON). Walks `x.steps` leniently
 * and keeps only the steps that individually validate — dropping malformed ones
 * rather than discarding the whole story. Returns null when nothing usable
 * survives (caller then takes the error path).
 *
 * Unlike validateStoryOrder this is permissive PER STEP: a single bad step no
 * longer nukes an otherwise-good big-PR story.
 */
export function salvageStoryOrder(x: unknown): StoryOrderResult | null {
  if (!isObject(x) || !Array.isArray(x['steps'])) return null
  const steps: StoryStep[] = []
  for (const raw of x['steps']) {
    if (!isObject(raw)) continue
    const files = Array.isArray(raw['files']) ? raw['files'].filter((f) => typeof f === 'string') : []
    if (files.length === 0) continue
    const layer = raw['layer']
    if (typeof layer !== 'string' || !STORY_LAYER_SET.has(layer)) continue
    const caption = typeof raw['caption'] === 'string' ? raw['caption'] : ''
    const relatedTests = Array.isArray(raw['relatedTests'])
      ? raw['relatedTests'].filter((t): t is string => typeof t === 'string')
      : []
    steps.push({ index: steps.length, files: files as string[], caption, layer: layer as StoryLayer, relatedTests })
  }
  if (steps.length === 0) return null
  return { steps }
}

// ---------------------------------------------------------------------------
// SkillFinding / SkillReviewResult (Skill reviewer feature)
// ---------------------------------------------------------------------------

/**
 * One verifier model's verdict on a finding (Plan M cross-model verification).
 */
export interface FindingVerdict {
  /** Provider that cast this vote (the verifier), or 'generator' for the raiser. */
  provider: string
  verdict: 'confirm' | 'refute' | 'uncertain'
  /** ≤1-sentence reason. Empty for the implicit generator confirm. */
  reason: string
  /**
   * Specific model that cast this vote (display name or id) — distinguishes
   * same-provider models. Optional for backward-compat with old cached findings
   * (which lack it); the UI falls back to `provider` when absent.
   */
  model?: string
  /**
   * True for the generator/raiser row(s) — the model RAISED this finding rather
   * than verifying it (an implicit confirm). Drives the tooltip's "raised it"
   * indicator. Optional/absent for verifier rows and old cached findings.
   */
  raised?: boolean
  /**
   * Worth axis (mootness gate): this verifier's independent judgment on whether
   * a busy senior reviewer would ACT on the finding — separate from whether it
   * is real. Absent for raiser rows (raising IS the implicit worth vote), for
   * old cached findings, and for verifiers predating the worth axis.
   */
  worth?: boolean
}

/**
 * Aggregated cross-model verification carried on a finding (Plan M). Absent when
 * verification did not run (single-key / setting off / all verifiers failed) —
 * its absence means "show the finding unverified, no chip, never demote".
 */
export interface FindingVerification {
  /** Confirm votes, including the generator's implicit +1. */
  confirmedBy: number
  /** Total models polled (generator + verifiers that responded). */
  polledModels: number
  /** Decision: true = surface normally, false = demote to lower-confidence group. */
  surfaced: boolean
  /**
   * Worth axis (mootness gate): the panel's AGGREGATE judgment on whether this
   * finding is worth a busy reviewer's time, independent of whether it is real.
   * false = judged moot — a majority of the poll judged it not worth attention
   * (raisers count as implicit "worth", a verifier without an explicit worth
   * vote as a neutral 0.5; ties keep the finding worth) — ranking demotes it
   * to the collapsed secondary tier and risk down-weights it. Absent when NO
   * verifier expressed a worth judgment (old cached findings, verifiers
   * predating the worth axis): no signal, never demote.
   */
  worthFlagging?: boolean
  /** Per-model verdicts (generator first), for the tooltip. */
  perModel: FindingVerdict[]
  /**
   * Grounded verification (repo lookups): what the verifier(s) looked up
   * before voting — e.g. "searched repo for parseConfig callers: 2 found".
   * Distinct verifier notes joined with '; ', capped at 200 chars
   * (GROUNDED_NOTE_MAX_CHARS). Shown as the "✓ verified" chip's hover title.
   * Absent when no verifier used a lookup — and on old cached verifications,
   * which every consumer must tolerate (render without it, never drop).
   */
  groundedNote?: string
  /**
   * Grounded verification: total repo lookups the finding's verification
   * ROUND spent (per-finding attribution inside a set-scoped verifier call is
   * not knowable, so this is the round total — an honest upper bound). Absent
   * when zero and on old cached verifications.
   */
  toolCallsUsed?: number
}

/**
 * One finding ABSORBED into a convergence-merged primary (cross-reviewer
 * convergence pass). Preserved verbatim — reviewer + location + body — so the
 * merge destroys nothing; the card's "also flagged as…" disclosure renders it.
 */
export interface AbsorbedFinding {
  reviewer: string
  path: string
  line: number | null
  severity: 'high' | 'medium' | 'low'
  body: string
  /** The absorbed finding's own concrete fix, preserved verbatim by the merge. */
  suggestedFix?: string
}

export interface SkillFinding {
  path: string
  line: number | null
  severity: 'high' | 'medium' | 'low'
  body: string
  /**
   * The finding's concrete fix (solutions-required): a 1–3 sentence
   * prescription or small code sketch, or an explicit "No clean fix — …"
   * naming the tradeoff. REQUIRED by the skill-review prompt, TOLERATED by the
   * validator: a finding arriving without one (old cached results, a model
   * ignoring the requirement) is kept and simply renders without the Fix
   * block — a missing fix must never drop a real finding.
   */
  suggestedFix?: string
  /** Cross-model verification result (Plan M), attached post-generation. */
  verification?: FindingVerification
  /**
   * Multi-generator provenance (Plan O 'generate' mode): the display names of
   * every ensemble model that independently RAISED this finding. Absent in
   * single-generator ('verify') mode. With ≥2 raisers the UI shows "raised by A,B".
   */
  raisedBy?: string[]
  /**
   * Cross-reviewer convergence: sibling findings (from OTHER reviewers) that
   * described the same underlying issue and were merged into this one. Never
   * produced by the reviewer LLM itself — attached by applyConvergence.
   */
  mergedFrom?: AbsorbedFinding[]
  /** ≤100-char LLM reason the cluster describes one underlying issue. */
  mergedReason?: string
  /**
   * Cross-reviewer convergence: this finding makes the same point as one of the
   * user's OWN draft comments (at the given location). The card renders it
   * collapsed/de-emphasized ("covered by your comment on path:line") instead of
   * deleting it — silent disappearance would look like data loss.
   */
  coveredByDraft?: { path: string; line: number }
  /**
   * SIMPLIFY pass: the plain-English rewrite of `body`. Display-only — the
   * card shows it by default (with a "Show original" toggle) and add-as-draft
   * uses whichever text is displayed. Never produced by the reviewer LLM
   * itself — attached at render time by applySimplify. Every non-display
   * consumer (risk, convergence, verification, "Copy as LLM prompt") keeps
   * reading the original `body`.
   */
  simpleBody?: string
}

export interface SkillReviewResult {
  skillName: string
  findings: SkillFinding[]
}

const SEVERITY_VALUES = new Set<string>(['high', 'medium', 'low'])
const SKILL_FINDINGS_CAP = 15

/**
 * Validate an unknown value as SkillReviewResult.
 * Returns the typed value or null if the shape is invalid.
 *
 * - element-checked: each finding must have path (string), line (number|null),
 *   severity (high|medium|low), body (string)
 * - findings capped at 15; more than 15 → null
 * - suggestedFix is REQUIRED-BY-PROMPT but TOLERATED here: a non-empty string
 *   is kept; anything else (absent, null, empty, wrong type) is stripped from
 *   the finding — the finding itself is NEVER dropped over a missing fix (it
 *   just renders without the Fix block).
 */
export function validateSkillReviewResult(x: unknown): SkillReviewResult | null {
  if (!isObject(x)) return null

  // skillName — required string
  if (typeof x['skillName'] !== 'string') return null

  // findings — required array
  if (!Array.isArray(x['findings'])) return null

  // Cap: >15 findings → null
  if (x['findings'].length > SKILL_FINDINGS_CAP) return null

  for (const finding of x['findings']) {
    if (!isObject(finding)) return null

    // path — required string
    if (typeof finding['path'] !== 'string') return null

    // line — required: number or null
    if (finding['line'] !== null && typeof finding['line'] !== 'number') return null

    // severity — required string enum
    if (typeof finding['severity'] !== 'string' || !SEVERITY_VALUES.has(finding['severity'] as string)) return null

    // body — required string
    if (typeof finding['body'] !== 'string') return null

    // suggestedFix — optional-tolerant normalization: keep only a usable
    // non-empty string; strip anything else (null/empty/wrong type) rather
    // than rejecting the finding or the result.
    const fix = finding['suggestedFix']
    if (fix !== undefined && (typeof fix !== 'string' || fix.trim().length === 0)) {
      delete finding['suggestedFix']
    }
  }

  return x as unknown as SkillReviewResult
}
