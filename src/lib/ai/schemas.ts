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

import type { Graph, GraphResult } from '../diagram/types'

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

  return { before, after, kind: x['kind'] as 'flow' | 'module' }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateGraph(x: unknown): Graph | null {
  if (!isObject(x)) return null

  // nodes — required array of {id: string, label: string}
  if (!Array.isArray(x['nodes'])) return null
  for (const node of x['nodes']) {
    if (!isObject(node)) return null
    if (typeof node['id'] !== 'string') return null
    if (typeof node['label'] !== 'string') return null
  }

  // edges — required array of {from: string, to: string, label?: string}
  if (!Array.isArray(x['edges'])) return null
  for (const edge of x['edges']) {
    if (!isObject(edge)) return null
    if (typeof edge['from'] !== 'string') return null
    if (typeof edge['to'] !== 'string') return null
    // label is optional — only validate type if present
    if ('label' in edge && edge['label'] !== undefined && typeof edge['label'] !== 'string') return null
  }

  return x as unknown as Graph
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
