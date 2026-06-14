/**
 * Tests for src/lib/ai/schemas.ts
 *
 * Covers: validateAttention, validateVerdict, validateGraphResult,
 *         validateTestInsight, validateCoachResult
 * Per-schema: valid / invalid-enum / wrong-type / extra-keys-tolerated / missing-array
 * EC-15a: numeric or percentage level returns null
 */

import { describe, it, expect } from 'vitest'
import {
  validateAttention,
  validateVerdict,
  validateGraphResult,
  validateTestInsight,
  validateCoachResult,
  validateAlternativesResult,
} from './schemas'

// ---------------------------------------------------------------------------
// validateAttention
// ---------------------------------------------------------------------------

describe('validateAttention', () => {
  const valid = {
    readingOrder: ['src/index.ts', 'src/utils.ts'],
    hotspots: [
      { path: 'src/index.ts', reason: 'Core logic changed', level: 'high' },
      { path: 'src/utils.ts', reason: 'Minor helper tweak', level: 'low' },
    ],
    testFlags: [
      { path: 'src/utils.ts', note: 'No test covers this change' },
    ],
  }

  it('accepts a valid AttentionResult', () => {
    expect(validateAttention(valid)).toEqual(valid)
  })

  it('accepts valid with empty arrays', () => {
    const x = { readingOrder: [], hotspots: [], testFlags: [] }
    expect(validateAttention(x)).toEqual(x)
  })

  it('accepts extra top-level keys (tolerant of extras)', () => {
    const withExtras = { ...valid, unexpectedField: 'ignored', meta: { v: 1 } }
    const result = validateAttention(withExtras)
    expect(result).not.toBeNull()
    // Core fields must be present
    expect(result?.readingOrder).toEqual(valid.readingOrder)
  })

  it('accepts extra keys on hotspot objects', () => {
    const withExtras = {
      ...valid,
      hotspots: [{ path: 'x.ts', reason: 'r', level: 'medium', extra: 'ok' }],
    }
    expect(validateAttention(withExtras)).not.toBeNull()
  })

  it('accepts extra keys on testFlag objects', () => {
    const withExtras = {
      ...valid,
      testFlags: [{ path: 'x.ts', note: 'n', extra: 'fine' }],
    }
    expect(validateAttention(withExtras)).not.toBeNull()
  })

  // EC-15a: invalid enum for hotspot level
  it('returns null for invalid hotspot level string (EC-15a)', () => {
    const bad = {
      ...valid,
      hotspots: [{ path: 'x.ts', reason: 'r', level: 'critical' }],
    }
    expect(validateAttention(bad)).toBeNull()
  })

  it('returns null for numeric hotspot level (EC-15a)', () => {
    const bad = {
      ...valid,
      hotspots: [{ path: 'x.ts', reason: 'r', level: 3 }],
    }
    expect(validateAttention(bad)).toBeNull()
  })

  it('returns null for percentage hotspot level (EC-15a)', () => {
    const bad = {
      ...valid,
      hotspots: [{ path: 'x.ts', reason: 'r', level: '75%' }],
    }
    expect(validateAttention(bad)).toBeNull()
  })

  it('returns null when readingOrder is missing', () => {
    const { readingOrder: _r, ...rest } = valid
    expect(validateAttention(rest)).toBeNull()
  })

  it('returns null when hotspots is missing', () => {
    const { hotspots: _h, ...rest } = valid
    expect(validateAttention(rest)).toBeNull()
  })

  it('returns null when testFlags is missing', () => {
    const { testFlags: _t, ...rest } = valid
    expect(validateAttention(rest)).toBeNull()
  })

  it('returns null when readingOrder contains non-string', () => {
    const bad = { ...valid, readingOrder: ['ok.ts', 42] }
    expect(validateAttention(bad)).toBeNull()
  })

  it('returns null when hotspots contains a non-object element', () => {
    const bad = { ...valid, hotspots: ['not-an-object'] }
    expect(validateAttention(bad)).toBeNull()
  })

  it('returns null when testFlags contains missing note field', () => {
    const bad = { ...valid, testFlags: [{ path: 'x.ts' }] }
    expect(validateAttention(bad)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(validateAttention(null)).toBeNull()
    expect(validateAttention('string')).toBeNull()
    expect(validateAttention(42)).toBeNull()
    expect(validateAttention([])).toBeNull()
  })

  it('returns null when readingOrder is not an array', () => {
    const bad = { ...valid, readingOrder: 'not-an-array' }
    expect(validateAttention(bad)).toBeNull()
  })

  it('returns null when hotspots is not an array', () => {
    const bad = { ...valid, hotspots: {} }
    expect(validateAttention(bad)).toBeNull()
  })

  it('returns null when testFlags is not an array', () => {
    const bad = { ...valid, testFlags: null }
    expect(validateAttention(bad)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateVerdict
// ---------------------------------------------------------------------------

describe('validateVerdict', () => {
  const valid = {
    level: 'behavior-preserved',
    evidence: ['No external API changes in src/api.ts', 'Only internal refactor'],
    notAnalyzed: ['src/legacy.ts'],
  }

  it('accepts a valid VerdictResult (behavior-preserved)', () => {
    expect(validateVerdict(valid)).toEqual(valid)
  })

  it('accepts minor-changes level', () => {
    const x = { ...valid, level: 'minor-changes' }
    expect(validateVerdict(x)).not.toBeNull()
  })

  it('accepts significant-changes level', () => {
    const x = { ...valid, level: 'significant-changes' }
    expect(validateVerdict(x)).not.toBeNull()
  })

  it('accepts empty arrays for evidence and notAnalyzed', () => {
    const x = { level: 'behavior-preserved', evidence: [], notAnalyzed: [] }
    expect(validateVerdict(x)).toEqual(x)
  })

  it('accepts extra keys (tolerant of extras)', () => {
    const withExtras = { ...valid, confidence: 'high', modelVersion: 'v2' }
    expect(validateVerdict(withExtras)).not.toBeNull()
  })

  // EC-15a: invalid enum values
  it('returns null for invalid level string (EC-15a)', () => {
    expect(validateVerdict({ ...valid, level: 'safe' })).toBeNull()
  })

  it('returns null for numeric level (EC-15a)', () => {
    expect(validateVerdict({ ...valid, level: 1 })).toBeNull()
  })

  it('returns null for percentage level (EC-15a)', () => {
    expect(validateVerdict({ ...valid, level: '50%' })).toBeNull()
  })

  it('returns null when level is missing', () => {
    const { level: _l, ...rest } = valid
    expect(validateVerdict(rest)).toBeNull()
  })

  it('returns null when evidence is missing', () => {
    const { evidence: _e, ...rest } = valid
    expect(validateVerdict(rest)).toBeNull()
  })

  it('returns null when notAnalyzed is missing', () => {
    const { notAnalyzed: _n, ...rest } = valid
    expect(validateVerdict(rest)).toBeNull()
  })

  it('returns null when evidence contains non-string', () => {
    const bad = { ...valid, evidence: ['ok', 42] }
    expect(validateVerdict(bad)).toBeNull()
  })

  it('returns null when notAnalyzed contains non-string', () => {
    const bad = { ...valid, notAnalyzed: [null] }
    expect(validateVerdict(bad)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(validateVerdict(null)).toBeNull()
    expect(validateVerdict('behavior-preserved')).toBeNull()
    expect(validateVerdict([])).toBeNull()
  })

  it('returns null when evidence is not an array', () => {
    const bad = { ...valid, evidence: 'string' }
    expect(validateVerdict(bad)).toBeNull()
  })

  it('returns null when notAnalyzed is not an array', () => {
    const bad = { ...valid, notAnalyzed: {} }
    expect(validateVerdict(bad)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateGraphResult
// ---------------------------------------------------------------------------

describe('validateGraphResult', () => {
  const validGraph = {
    nodes: [
      { id: 'a', label: 'Module A' },
      { id: 'b', label: 'Module B' },
    ],
    edges: [{ from: 'a', to: 'b', label: 'imports' }],
  }

  const valid = {
    kind: 'module',
    before: validGraph,
    after: {
      nodes: [{ id: 'a', label: 'Module A' }],
      edges: [],
    },
  }

  it('accepts a valid GraphResult (module kind)', () => {
    const result = validateGraphResult(valid)
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('module')
  })

  it('accepts flow kind', () => {
    const x = { ...valid, kind: 'flow' }
    expect(validateGraphResult(x)).not.toBeNull()
  })

  it('accepts edges with optional label', () => {
    const x = {
      ...valid,
      before: {
        nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
        edges: [{ from: 'x', to: 'y' }], // no label field
      },
    }
    expect(validateGraphResult(x)).not.toBeNull()
  })

  it('accepts empty nodes and edges arrays', () => {
    const x = { kind: 'flow', before: { nodes: [], edges: [] }, after: { nodes: [], edges: [] } }
    expect(validateGraphResult(x)).not.toBeNull()
  })

  it('accepts extra keys on result and graph objects', () => {
    const withExtras = {
      ...valid,
      generatedAt: '2026-06-11',
      before: { ...validGraph, meta: 'ignored' },
    }
    expect(validateGraphResult(withExtras)).not.toBeNull()
  })

  it('accepts extra keys on node objects', () => {
    const x = {
      ...valid,
      before: {
        nodes: [{ id: 'a', label: 'A', extra: 'ok' }],
        edges: [],
      },
    }
    expect(validateGraphResult(x)).not.toBeNull()
  })

  it('returns null for invalid kind string', () => {
    const bad = { ...valid, kind: 'sequence' }
    expect(validateGraphResult(bad)).toBeNull()
  })

  it('returns null for numeric kind (EC-15a)', () => {
    const bad = { ...valid, kind: 1 }
    expect(validateGraphResult(bad)).toBeNull()
  })

  it('returns null when kind is missing', () => {
    const { kind: _k, ...rest } = valid
    expect(validateGraphResult(rest)).toBeNull()
  })

  it('returns null when before is missing', () => {
    const { before: _b, ...rest } = valid
    expect(validateGraphResult(rest)).toBeNull()
  })

  it('returns null when after is missing', () => {
    const { after: _a, ...rest } = valid
    expect(validateGraphResult(rest)).toBeNull()
  })

  it('returns null when before.nodes is not an array', () => {
    const bad = { ...valid, before: { ...validGraph, nodes: 'not-array' } }
    expect(validateGraphResult(bad)).toBeNull()
  })

  it('returns null when before.edges is not an array', () => {
    const bad = { ...valid, before: { ...validGraph, edges: null } }
    expect(validateGraphResult(bad)).toBeNull()
  })

  it('returns null when a node is missing id', () => {
    const bad = {
      ...valid,
      before: {
        nodes: [{ label: 'Missing id' }],
        edges: [],
      },
    }
    expect(validateGraphResult(bad)).toBeNull()
  })

  it('returns null when a node is missing label', () => {
    const bad = {
      ...valid,
      before: {
        nodes: [{ id: 'a' }],
        edges: [],
      },
    }
    expect(validateGraphResult(bad)).toBeNull()
  })

  it('returns null when an edge has non-string label', () => {
    const bad = {
      ...valid,
      before: {
        nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b', label: 42 }],
      },
    }
    expect(validateGraphResult(bad)).toBeNull()
  })

  it('returns null when an edge is missing from', () => {
    const bad = {
      ...valid,
      before: {
        nodes: [{ id: 'a', label: 'A' }],
        edges: [{ to: 'a' }],
      },
    }
    expect(validateGraphResult(bad)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(validateGraphResult(null)).toBeNull()
    expect(validateGraphResult('graph')).toBeNull()
    expect(validateGraphResult([])).toBeNull()
  })

  // D1: optional status on nodes and edges
  it('accepts nodes with valid status', () => {
    const x = {
      kind: 'flow',
      before: { nodes: [{ id: 'a', label: 'A', status: 'unchanged' }], edges: [] },
      after: { nodes: [{ id: 'b', label: 'B', status: 'added' }], edges: [] },
    }
    expect(validateGraphResult(x)).not.toBeNull()
  })

  it('accepts edges with valid status', () => {
    const x = {
      kind: 'flow',
      before: { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', status: 'changed' }] },
      after: { nodes: [], edges: [] },
    }
    expect(validateGraphResult(x)).not.toBeNull()
  })

  it('accepts all four status enum values on nodes', () => {
    for (const status of ['added', 'removed', 'changed', 'unchanged']) {
      const x = {
        kind: 'flow',
        before: { nodes: [{ id: 'a', label: 'A', status }], edges: [] },
        after: { nodes: [], edges: [] },
      }
      expect(validateGraphResult(x)).not.toBeNull()
    }
  })

  // Deep-diagram (v12): the additive 'context' status — old graphs without it
  // still validate, new graphs that use it pass the strict enum check.
  it('accepts the context status on nodes (deep-diagram neighborhood)', () => {
    const x = {
      kind: 'flow',
      before: { nodes: [{ id: 'n', label: 'app.ts', status: 'context' }], edges: [] },
      after: { nodes: [], edges: [] },
    }
    expect(validateGraphResult(x)).not.toBeNull()
  })

  it('accepts the context status on edges (uses/calls neighbor relationship)', () => {
    const x = {
      kind: 'flow',
      before: {
        nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b', label: 'uses', status: 'context' }],
      },
      after: { nodes: [], edges: [] },
    }
    expect(validateGraphResult(x)).not.toBeNull()
  })

  it('accepts all FIVE status enum values on nodes (four change + context)', () => {
    for (const status of ['added', 'removed', 'changed', 'unchanged', 'context']) {
      const x = {
        kind: 'flow',
        before: { nodes: [{ id: 'a', label: 'A', status }], edges: [] },
        after: { nodes: [], edges: [] },
      }
      expect(validateGraphResult(x)).not.toBeNull()
    }
  })

  it('additive compat: an old cached graph WITHOUT any context node still validates', () => {
    // A pre-v12 cached changeMap (only the original four statuses) must remain valid.
    const oldCached = {
      kind: 'flow',
      before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
      after: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
      changeMap: {
        nodes: [
          { id: 'a', label: 'router.ts', status: 'changed' },
          { id: 'b', label: 'handler.ts', status: 'added' },
        ],
        edges: [{ from: 'b', to: 'a', label: 'calls', status: 'added' }],
      },
    }
    const result = validateGraphResult(oldCached)
    expect(result).not.toBeNull()
    // No context node present — purely the legacy shape.
    expect(result?.changeMap?.nodes.some((n) => n.status === 'context')).toBe(false)
  })

  it('returns null for invalid node status enum value', () => {
    const x = {
      kind: 'flow',
      before: { nodes: [{ id: 'a', label: 'A', status: 'modified' }], edges: [] },
      after: { nodes: [], edges: [] },
    }
    expect(validateGraphResult(x)).toBeNull()
  })

  it('returns null for numeric node status', () => {
    const x = {
      kind: 'flow',
      before: { nodes: [{ id: 'a', label: 'A', status: 1 }], edges: [] },
      after: { nodes: [], edges: [] },
    }
    expect(validateGraphResult(x)).toBeNull()
  })

  it('returns null for invalid edge status enum value', () => {
    const x = {
      kind: 'flow',
      before: { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', status: 'new' }] },
      after: { nodes: [], edges: [] },
    }
    expect(validateGraphResult(x)).toBeNull()
  })

  it('accepts nodes and edges without status (backward compat with cached v3)', () => {
    const x = {
      kind: 'module',
      before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
      after: { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] },
    }
    const result = validateGraphResult(x)
    expect(result).not.toBeNull()
    expect(result?.changeMap).toBeUndefined()
  })

  // D1: optional changeMap
  it('accepts a valid changeMap (D1)', () => {
    const x = {
      kind: 'flow',
      before: { nodes: [], edges: [] },
      after: { nodes: [], edges: [] },
      changeMap: {
        nodes: [
          { id: 'a', label: 'api.ts', status: 'unchanged' },
          { id: 'b', label: 'handler.ts', status: 'added' },
        ],
        edges: [
          { from: 'a', to: 'b', label: 'calls', status: 'added' },
        ],
      },
    }
    const result = validateGraphResult(x)
    expect(result).not.toBeNull()
    expect(result?.changeMap).toBeDefined()
    expect(result?.changeMap?.nodes).toHaveLength(2)
  })

  it('returns null when changeMap has invalid node status', () => {
    const x = {
      kind: 'flow',
      before: { nodes: [], edges: [] },
      after: { nodes: [], edges: [] },
      changeMap: {
        nodes: [{ id: 'a', label: 'A', status: 'brand-new' }],
        edges: [],
      },
    }
    expect(validateGraphResult(x)).toBeNull()
  })

  it('accepts result without changeMap (backward compat with cached v3)', () => {
    const x = {
      kind: 'module',
      before: { nodes: [{ id: 'a', label: 'A' }], edges: [] },
      after: { nodes: [], edges: [] },
    }
    const result = validateGraphResult(x)
    expect(result).not.toBeNull()
    expect(result?.changeMap).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// validateTestInsight (D2)
// ---------------------------------------------------------------------------

describe('validateTestInsight', () => {
  const valid = {
    covered: [
      { behavior: 'validates email format', test: 'it validates email', file: 'src/auth.test.ts' },
      { behavior: 'rejects empty passwords', test: 'rejects empty password', file: 'src/auth.test.ts' },
    ],
    gaps: ['src/mailer.ts — sendWelcome not tested after rewrite'],
  }

  it('accepts a valid TestInsight', () => {
    expect(validateTestInsight(valid)).toEqual(valid)
  })

  it('accepts empty covered and gaps arrays', () => {
    const x = { covered: [], gaps: [] }
    expect(validateTestInsight(x)).toEqual(x)
  })

  it('accepts extra top-level keys (tolerant of extras)', () => {
    const withExtras = { ...valid, version: 1, meta: { ts: '2026' } }
    const result = validateTestInsight(withExtras)
    expect(result).not.toBeNull()
    expect(result?.covered).toEqual(valid.covered)
  })

  it('accepts extra keys on covered item objects', () => {
    const x = {
      covered: [{ behavior: 'b', test: 't', file: 'f.ts', extra: 'ok' }],
      gaps: [],
    }
    expect(validateTestInsight(x)).not.toBeNull()
  })

  it('returns null when covered is missing', () => {
    const { covered: _c, ...rest } = valid
    expect(validateTestInsight(rest)).toBeNull()
  })

  it('returns null when gaps is missing', () => {
    const { gaps: _g, ...rest } = valid
    expect(validateTestInsight(rest)).toBeNull()
  })

  it('returns null when covered is not an array', () => {
    const bad = { ...valid, covered: 'not-array' }
    expect(validateTestInsight(bad)).toBeNull()
  })

  it('returns null when gaps is not an array', () => {
    const bad = { ...valid, gaps: null }
    expect(validateTestInsight(bad)).toBeNull()
  })

  it('returns null when covered item is missing behavior', () => {
    const bad = { covered: [{ test: 't', file: 'f.ts' }], gaps: [] }
    expect(validateTestInsight(bad)).toBeNull()
  })

  it('returns null when covered item is missing test', () => {
    const bad = { covered: [{ behavior: 'b', file: 'f.ts' }], gaps: [] }
    expect(validateTestInsight(bad)).toBeNull()
  })

  it('returns null when covered item is missing file', () => {
    const bad = { covered: [{ behavior: 'b', test: 't' }], gaps: [] }
    expect(validateTestInsight(bad)).toBeNull()
  })

  it('returns null when covered item has non-string behavior', () => {
    const bad = { covered: [{ behavior: 42, test: 't', file: 'f.ts' }], gaps: [] }
    expect(validateTestInsight(bad)).toBeNull()
  })

  it('returns null when gaps contains non-string', () => {
    const bad = { covered: [], gaps: [42] }
    expect(validateTestInsight(bad)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(validateTestInsight(null)).toBeNull()
    expect(validateTestInsight('insight')).toBeNull()
    expect(validateTestInsight([])).toBeNull()
    expect(validateTestInsight(42)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateCoachResult (D4)
// ---------------------------------------------------------------------------

describe('validateCoachResult', () => {
  const validReview = {
    index: 0,
    clarity: 3,
    actionable: true,
    tone: 'ok',
    biasQuestion: null,
    suggestion: null,
    accuracy: 'consistent',
    accuracyNote: null,
    duplicate: false,
  }

  const valid = { reviews: [validReview] }

  it('accepts a valid CoachResult', () => {
    expect(validateCoachResult(valid)).toEqual(valid)
  })

  it('accepts empty reviews array', () => {
    expect(validateCoachResult({ reviews: [] })).toEqual({ reviews: [] })
  })

  it('accepts all tone enum values', () => {
    for (const tone of ['ok', 'blunt', 'harsh']) {
      const x = { reviews: [{ ...validReview, tone }] }
      expect(validateCoachResult(x)).not.toBeNull()
    }
  })

  it('accepts all clarity integer values 1–5', () => {
    for (const clarity of [1, 2, 3, 4, 5]) {
      const x = { reviews: [{ ...validReview, clarity }] }
      expect(validateCoachResult(x)).not.toBeNull()
    }
  })

  it('accepts string biasQuestion and suggestion', () => {
    const x = {
      reviews: [{
        ...validReview,
        biasQuestion: 'Is this a preference or a defect?',
        suggestion: 'Consider rephrasing this.',
      }],
    }
    expect(validateCoachResult(x)).not.toBeNull()
  })

  it('accepts extra keys on result and review objects (tolerant of extras)', () => {
    const x = {
      reviews: [{ ...validReview, extra: 'ok', meta: { ts: '2026' } }],
      modelVersion: 'v4',
    }
    expect(validateCoachResult(x)).not.toBeNull()
  })

  it('returns null for clarity = 0 (out of range)', () => {
    const x = { reviews: [{ ...validReview, clarity: 0 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null for clarity = 6 (out of range)', () => {
    const x = { reviews: [{ ...validReview, clarity: 6 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null for clarity = 2.5 (non-integer)', () => {
    const x = { reviews: [{ ...validReview, clarity: 2.5 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null for clarity as string', () => {
    const x = { reviews: [{ ...validReview, clarity: '3' }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null for invalid tone string', () => {
    const x = { reviews: [{ ...validReview, tone: 'aggressive' }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null for numeric tone', () => {
    const x = { reviews: [{ ...validReview, tone: 1 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when index is a float', () => {
    const x = { reviews: [{ ...validReview, index: 1.5 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when index is a string', () => {
    const x = { reviews: [{ ...validReview, index: '0' }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when actionable is not boolean', () => {
    const x = { reviews: [{ ...validReview, actionable: 'yes' }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when biasQuestion is a number (must be string or null)', () => {
    const x = { reviews: [{ ...validReview, biasQuestion: 42 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when suggestion is a number (must be string or null)', () => {
    const x = { reviews: [{ ...validReview, suggestion: 99 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when biasQuestion is absent (required field)', () => {
    const { biasQuestion: _bq, ...withoutBq } = validReview
    const x = { reviews: [withoutBq] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when suggestion is absent (required field)', () => {
    const { suggestion: _s, ...withoutS } = validReview
    const x = { reviews: [withoutS] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when reviews is not an array', () => {
    const bad = { reviews: {} }
    expect(validateCoachResult(bad)).toBeNull()
  })

  it('returns null when reviews contains a non-object element', () => {
    const bad = { reviews: ['not-an-object'] }
    expect(validateCoachResult(bad)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(validateCoachResult(null)).toBeNull()
    expect(validateCoachResult('coach')).toBeNull()
    expect(validateCoachResult(42)).toBeNull()
    expect(validateCoachResult([])).toBeNull()
  })

  // --- accuracy field (new dimension) ---

  it('accepts all three accuracy enum values', () => {
    for (const accuracy of ['consistent', 'questionable', 'contradicted']) {
      const x = { reviews: [{ ...validReview, accuracy, accuracyNote: null }] }
      expect(validateCoachResult(x)).not.toBeNull()
    }
  })

  it('returns null for invalid accuracy string', () => {
    const x = { reviews: [{ ...validReview, accuracy: 'wrong', accuracyNote: null }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null for numeric accuracy value', () => {
    const x = { reviews: [{ ...validReview, accuracy: 1, accuracyNote: null }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when accuracy is absent (required field)', () => {
    const { accuracy: _a, ...withoutAccuracy } = validReview
    const x = { reviews: [withoutAccuracy] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('accepts accuracyNote as string or null', () => {
    const withNote = { reviews: [{ ...validReview, accuracy: 'contradicted', accuracyNote: 'The diff shows X not Y.' }] }
    expect(validateCoachResult(withNote)).not.toBeNull()
    const nullNote = { reviews: [{ ...validReview, accuracy: 'consistent', accuracyNote: null }] }
    expect(validateCoachResult(nullNote)).not.toBeNull()
  })

  it('returns null when accuracyNote is a number', () => {
    const x = { reviews: [{ ...validReview, accuracy: 'consistent', accuracyNote: 42 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when accuracyNote is absent (required field)', () => {
    const { accuracyNote: _an, ...withoutAccuracyNote } = validReview
    const x = { reviews: [withoutAccuracyNote] }
    expect(validateCoachResult(x)).toBeNull()
  })

  // --- duplicate field (new dimension) ---

  it('accepts duplicate as true or false', () => {
    const trueX = { reviews: [{ ...validReview, duplicate: true }] }
    expect(validateCoachResult(trueX)).not.toBeNull()
    const falseX = { reviews: [{ ...validReview, duplicate: false }] }
    expect(validateCoachResult(falseX)).not.toBeNull()
  })

  it('returns null when duplicate is not boolean', () => {
    const x = { reviews: [{ ...validReview, duplicate: 'yes' }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when duplicate is absent (required field)', () => {
    const { duplicate: _d, ...withoutDuplicate } = validReview
    const x = { reviews: [withoutDuplicate] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('accepts a full valid review with all new fields', () => {
    const fullReview = {
      index: 0,
      clarity: 4,
      actionable: true,
      tone: 'ok',
      biasQuestion: null,
      suggestion: null,
      accuracy: 'consistent',
      accuracyNote: null,
      duplicate: false,
    }
    expect(validateCoachResult({ reviews: [fullReview] })).not.toBeNull()
  })

  // --- v9: specificity / grounded (optional booleans) ---

  it('v8 shape without specificity/grounded/reasons stays valid (old cached shape)', () => {
    // validReview deliberately lacks all v9 fields
    expect(validateCoachResult({ reviews: [validReview] })).not.toBeNull()
  })

  it('accepts specificity as true or false', () => {
    for (const specificity of [true, false]) {
      const x = { reviews: [{ ...validReview, specificity }] }
      expect(validateCoachResult(x)).not.toBeNull()
    }
  })

  it('returns null when specificity is present but not boolean', () => {
    const x = { reviews: [{ ...validReview, specificity: 'yes' }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('accepts grounded as true or false', () => {
    for (const grounded of [true, false]) {
      const x = { reviews: [{ ...validReview, grounded }] }
      expect(validateCoachResult(x)).not.toBeNull()
    }
  })

  it('returns null when grounded is present but not boolean', () => {
    const x = { reviews: [{ ...validReview, grounded: 1 }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  // --- v9: reasons (optional per-dimension rationale object) ---

  const fullReasons = {
    clarity: 'clear and complete',
    tone: 'professional phrasing',
    actionable: 'asks for a concrete rename',
    accuracy: 'matches the change shown in the diff',
    duplicate: 'no overlap with existing comments',
    specificity: 'names the exact function and line',
    grounded: 'every claim visible in the provided context',
  }

  it('accepts a full reasons object with all seven dimensions', () => {
    const x = { reviews: [{ ...validReview, specificity: true, grounded: true, reasons: fullReasons }] }
    expect(validateCoachResult(x)).not.toBeNull()
  })

  it('accepts a partial reasons object (missing entries tolerated)', () => {
    const x = { reviews: [{ ...validReview, reasons: { tone: 'professional phrasing' } }] }
    expect(validateCoachResult(x)).not.toBeNull()
  })

  it('accepts reasons: null (treated as absent)', () => {
    const x = { reviews: [{ ...validReview, reasons: null }] }
    expect(validateCoachResult(x)).not.toBeNull()
  })

  it('returns null when reasons is a string instead of an object', () => {
    const x = { reviews: [{ ...validReview, reasons: 'all fine' }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when reasons is an array', () => {
    const x = { reviews: [{ ...validReview, reasons: ['all fine'] }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when a reason value is a number', () => {
    const x = { reviews: [{ ...validReview, reasons: { clarity: 5 } }] }
    expect(validateCoachResult(x)).toBeNull()
  })

  // --- v9: verdictCoherence (optional run-level check) ---

  it('accepts a result without verdictCoherence (old cached shape)', () => {
    expect(validateCoachResult({ reviews: [validReview] })).not.toBeNull()
  })

  it('accepts verdictCoherence: null', () => {
    const x = { reviews: [validReview], verdictCoherence: null }
    expect(validateCoachResult(x)).not.toBeNull()
  })

  it('accepts a valid verdictCoherence object (coherent true and false)', () => {
    for (const coherent of [true, false]) {
      const x = {
        reviews: [validReview],
        verdictCoherence: { coherent, note: 'Two harsh blocking comments but verdict is Approve.' },
      }
      expect(validateCoachResult(x)).not.toBeNull()
    }
  })

  it('returns null when verdictCoherence.coherent is not boolean', () => {
    const x = { reviews: [validReview], verdictCoherence: { coherent: 'no', note: 'mismatch' } }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when verdictCoherence.note is not a string', () => {
    const x = { reviews: [validReview], verdictCoherence: { coherent: false, note: 42 } }
    expect(validateCoachResult(x)).toBeNull()
  })

  it('returns null when verdictCoherence is a string', () => {
    const x = { reviews: [validReview], verdictCoherence: 'coherent' }
    expect(validateCoachResult(x)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateAlternativesResult (Plan F)
// ---------------------------------------------------------------------------

describe('validateAlternativesResult', () => {
  const validAlt = {
    problem: 'The PR introduces a global mutable singleton for caching.',
    alternatives: [
      {
        approach: 'Use a module-level WeakMap keyed by request context.',
        tradeoffs: 'Better isolation but requires passing context everywhere.',
        assessment: 'alternative-is-better',
        rationale: 'Avoids shared state leaks across requests.',
      },
      {
        approach: 'Keep PR approach but add a reset function for tests.',
        tradeoffs: 'Minimal change but still a singleton.',
        assessment: 'comparable',
        rationale: 'Acceptable if tests are the only concern.',
      },
    ],
  }

  it('accepts a valid AlternativesResult', () => {
    expect(validateAlternativesResult(validAlt)).toEqual(validAlt)
  })

  it('accepts valid with empty alternatives array', () => {
    const x = { problem: 'Nothing obvious.', alternatives: [] }
    expect(validateAlternativesResult(x)).toEqual(x)
  })

  it('accepts all four valid assessment enum values', () => {
    const assessments = ['pr-is-better', 'comparable', 'alternative-is-better', 'different-goals']
    for (const assessment of assessments) {
      const x = {
        problem: 'some problem',
        alternatives: [{ approach: 'a', tradeoffs: 't', assessment, rationale: 'r' }],
      }
      expect(validateAlternativesResult(x)).not.toBeNull()
    }
  })

  it('accepts extra top-level keys (tolerant of extras)', () => {
    const withExtras = { ...validAlt, meta: { v: 1 }, unexpectedField: 'ignored' }
    const result = validateAlternativesResult(withExtras)
    expect(result).not.toBeNull()
    expect(result?.problem).toBe(validAlt.problem)
  })

  it('accepts extra keys on alternative objects', () => {
    const withExtras = {
      problem: 'p',
      alternatives: [
        { approach: 'a', tradeoffs: 't', assessment: 'pr-is-better', rationale: 'r', extra: 'ok' },
      ],
    }
    expect(validateAlternativesResult(withExtras)).not.toBeNull()
  })

  // Strict: invalid assessment enum
  it('returns null for invalid assessment enum string', () => {
    const bad = {
      problem: 'p',
      alternatives: [{ approach: 'a', tradeoffs: 't', assessment: 'better', rationale: 'r' }],
    }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null for numeric assessment value', () => {
    const bad = {
      problem: 'p',
      alternatives: [{ approach: 'a', tradeoffs: 't', assessment: 1, rationale: 'r' }],
    }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null when problem is missing', () => {
    const { problem: _p, ...rest } = validAlt
    expect(validateAlternativesResult(rest)).toBeNull()
  })

  it('returns null when problem is not a string', () => {
    const bad = { ...validAlt, problem: 42 }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null when alternatives is missing', () => {
    const { alternatives: _a, ...rest } = validAlt
    expect(validateAlternativesResult(rest)).toBeNull()
  })

  it('returns null when alternatives is not an array', () => {
    const bad = { ...validAlt, alternatives: {} }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null when an alternative is not an object', () => {
    const bad = { problem: 'p', alternatives: ['not-an-object'] }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null when approach is missing from alternative', () => {
    const bad = {
      problem: 'p',
      alternatives: [{ tradeoffs: 't', assessment: 'pr-is-better', rationale: 'r' }],
    }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null when approach is not a string', () => {
    const bad = {
      problem: 'p',
      alternatives: [{ approach: 123, tradeoffs: 't', assessment: 'pr-is-better', rationale: 'r' }],
    }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null when tradeoffs is missing from alternative', () => {
    const bad = {
      problem: 'p',
      alternatives: [{ approach: 'a', assessment: 'pr-is-better', rationale: 'r' }],
    }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null when rationale is missing from alternative', () => {
    const bad = {
      problem: 'p',
      alternatives: [{ approach: 'a', tradeoffs: 't', assessment: 'pr-is-better' }],
    }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null when assessment is missing from alternative', () => {
    const bad = {
      problem: 'p',
      alternatives: [{ approach: 'a', tradeoffs: 't', rationale: 'r' }],
    }
    expect(validateAlternativesResult(bad)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(validateAlternativesResult(null)).toBeNull()
    expect(validateAlternativesResult('string')).toBeNull()
    expect(validateAlternativesResult(42)).toBeNull()
    expect(validateAlternativesResult([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateStoryOrder (Plan H — Story mode)
// ---------------------------------------------------------------------------

import { validateStoryOrder, STORY_LAYERS } from './schemas'

describe('validateStoryOrder', () => {
  const valid = {
    steps: [
      { index: 0, files: ['src/db/schema.ts'], caption: 'Schema gains a column.', layer: 'data', relatedTests: ['src/db/schema.test.ts'] },
      { index: 1, files: ['src/api/route.ts'], caption: 'API reads the column.', layer: 'api', relatedTests: [] },
    ],
  }

  it('accepts a valid story-order result', () => {
    expect(validateStoryOrder(valid)).toEqual(valid)
  })

  it('accepts an empty steps array (consumer falls back to Files)', () => {
    expect(validateStoryOrder({ steps: [] })).toEqual({ steps: [] })
  })

  it('accepts every layer in the taxonomy', () => {
    for (const layer of STORY_LAYERS) {
      const x = { steps: [{ index: 0, files: ['a.ts'], caption: 'c', layer, relatedTests: [] }] }
      expect(validateStoryOrder(x)).not.toBeNull()
    }
  })

  it('rejects an unknown layer enum', () => {
    const x = { steps: [{ index: 0, files: ['a.ts'], caption: 'c', layer: 'frontend', relatedTests: [] }] }
    expect(validateStoryOrder(x)).toBeNull()
  })

  it('rejects a step with an empty files array', () => {
    const x = { steps: [{ index: 0, files: [], caption: 'c', layer: 'data', relatedTests: [] }] }
    expect(validateStoryOrder(x)).toBeNull()
  })

  it('rejects a non-integer index', () => {
    const x = { steps: [{ index: 1.5, files: ['a.ts'], caption: 'c', layer: 'data', relatedTests: [] }] }
    expect(validateStoryOrder(x)).toBeNull()
  })

  it('rejects a non-array steps', () => {
    expect(validateStoryOrder({ steps: 'nope' })).toBeNull()
    expect(validateStoryOrder({})).toBeNull()
    expect(validateStoryOrder(null)).toBeNull()
    expect(validateStoryOrder([])).toBeNull()
  })

  it('rejects non-string files / relatedTests entries', () => {
    expect(validateStoryOrder({ steps: [{ index: 0, files: [1], caption: 'c', layer: 'data', relatedTests: [] }] })).toBeNull()
    expect(validateStoryOrder({ steps: [{ index: 0, files: ['a.ts'], caption: 'c', layer: 'data', relatedTests: [2] }] })).toBeNull()
  })

  it('tolerates extra keys', () => {
    const x = { steps: [{ index: 0, files: ['a.ts'], caption: 'c', layer: 'data', relatedTests: [], extra: 'x' }], top: 1 }
    expect(validateStoryOrder(x)).not.toBeNull()
  })
})
