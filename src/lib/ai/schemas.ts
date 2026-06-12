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

import type { Graph, GraphResult, NodeStatus } from '../diagram/types'

// Re-export so consumers can import everything from one place.
export type { Graph, GraphResult }

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
// GraphResult
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as GraphResult.
 * Returns the typed value or null if the shape is invalid.
 *
 * Accepts optional `changeMap` (D1: change-map graph with statuses) and
 * optional `status` on nodes/edges. Absent statuses/changeMap stay valid
 * (backward compatible with cached v3 results).
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

  const result: GraphResult = { before, after, kind: x['kind'] as 'flow' | 'module' }
  if (changeMap !== undefined) result.changeMap = changeMap
  return result
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const NODE_STATUSES = new Set<string>(['added', 'removed', 'changed', 'unchanged'])

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

export interface CommentReview {
  index: number
  clarity: 1 | 2 | 3 | 4 | 5
  actionable: boolean
  tone: 'ok' | 'blunt' | 'harsh'
  biasQuestion: string | null
  suggestion: string | null
}

export interface CoachResult {
  reviews: CommentReview[]
}

const TONE_VALUES = new Set<string>(['ok', 'blunt', 'harsh'])
const CLARITY_VALUES = new Set<number>([1, 2, 3, 4, 5])

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
  }

  return x as unknown as CoachResult
}

// ---------------------------------------------------------------------------
// AlternativesResult (Plan F)
// ---------------------------------------------------------------------------

export interface Alternative {
  approach: string
  tradeoffs: string
  assessment: 'pr-is-better' | 'comparable' | 'alternative-is-better' | 'different-goals'
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

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

// ---------------------------------------------------------------------------
// SkillFinding / SkillReviewResult (Skill reviewer feature)
// ---------------------------------------------------------------------------

export interface SkillFinding {
  path: string
  line: number | null
  severity: 'high' | 'medium' | 'low'
  body: string
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
  }

  return x as unknown as SkillReviewResult
}
