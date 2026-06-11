/**
 * Tests for src/lib/ai/schemas.ts
 *
 * Covers: validateAttention, validateVerdict, validateGraphResult
 * Per-schema: valid / invalid-enum / wrong-type / extra-keys-tolerated / missing-array
 * EC-15a: numeric or percentage level returns null
 */

import { describe, it, expect } from 'vitest'
import {
  validateAttention,
  validateVerdict,
  validateGraphResult,
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
})
