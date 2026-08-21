/**
 * Unit tests for src/lib/ai/simplify.ts — the pure logic of the post-review
 * SIMPLIFY pass: enumeration + fingerprint, per-item salvage validation, and
 * the loss-proof fingerprint-guarded application.
 */

import { describe, it, expect } from 'vitest'
import {
  enumerateForSimplify,
  validateSimplify,
  applySimplify,
  SIMPLIFY_MAX_CHARS,
  type ReviewerFindings,
  type SimplifyValue,
} from './simplify'
import { enumerateFindings } from './convergence'
import type { SkillFinding } from './schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function finding(over: Partial<SkillFinding> = {}): SkillFinding {
  return { path: 'src/a.ts', line: 10, severity: 'medium', body: 'It is worth noting that a potential inconsistency wherein the cache may possibly become stale could arise', ...over }
}

function reviewers(): ReviewerFindings[] {
  return [
    { skillId: 'sec', name: 'Security', findings: [finding(), finding({ path: 'src/b.ts', line: 5, severity: 'high', body: 'SQL injection via `query`' })] },
    { skillId: 'perf', name: 'Performance', findings: [finding({ path: 'src/c.ts', line: 7, severity: 'low', body: 'N+1 in `loadAll` at src/c.ts:7' })] },
  ]
}

// ---------------------------------------------------------------------------
// Enumeration + fingerprint
// ---------------------------------------------------------------------------

describe('enumerateForSimplify', () => {
  it('enumerates findings in reviewer order as f0..fN with id + body only', () => {
    const { inputs } = enumerateForSimplify(reviewers())
    expect(inputs.map((i) => i.id)).toEqual(['f0', 'f1', 'f2'])
    expect(inputs[1].body).toBe('SQL injection via `query`')
    expect(Object.keys(inputs[0]).sort()).toEqual(['body', 'id'])
  })

  it('fingerprint is stable across calls and IDENTICAL to the convergence enumeration (one id scheme)', () => {
    const a = enumerateForSimplify(reviewers())
    const b = enumerateForSimplify(reviewers())
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).toBe(enumerateFindings(reviewers()).fingerprint)
  })

  it('fingerprint changes when any body changes', () => {
    const base = enumerateForSimplify(reviewers()).fingerprint
    const changed = reviewers()
    changed[1].findings[0] = { ...changed[1].findings[0], body: 'different text' }
    expect(enumerateForSimplify(changed).fingerprint).not.toBe(base)
  })

  it('empty reviewer lists → no inputs', () => {
    const { inputs } = enumerateForSimplify([{ skillId: 's', name: 'S', findings: [] }])
    expect(inputs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// validateSimplify — per-item salvage
// ---------------------------------------------------------------------------

describe('validateSimplify', () => {
  const ids = new Set(['f0', 'f1', 'f2'])

  it('accepts the documented {rewrites:[...]} shape', () => {
    const v = validateSimplify({ rewrites: [{ id: 'f0', simple: 'Cache goes stale.' }] }, ids)
    expect(v).toEqual({ rewrites: [{ id: 'f0', simple: 'Cache goes stale.' }] })
  })

  it('accepts a bare array too (models emit both)', () => {
    const v = validateSimplify([{ id: 'f1', simple: 'Injection via `query`.' }], ids)
    expect(v).toEqual({ rewrites: [{ id: 'f1', simple: 'Injection via `query`.' }] })
  })

  it('tolerates bare integer ids as fN', () => {
    const v = validateSimplify({ rewrites: [{ id: 2, simple: 'N+1 in `loadAll`.' }] }, ids)
    expect(v).toEqual({ rewrites: [{ id: 'f2', simple: 'N+1 in `loadAll`.' }] })
  })

  it('per-item salvage: bad items are SKIPPED, the rest kept', () => {
    const v = validateSimplify(
      {
        rewrites: [
          { id: 'f0', simple: 'Good rewrite.' },
          { id: 'f9', simple: 'unknown id' }, // not a finding
          { id: 'f1' }, // missing simple
          { id: 'f1', simple: 42 }, // non-string simple
          { id: 'f1', simple: '   ' }, // empty after trim
          { id: 'f2', simple: 'x'.repeat(SIMPLIFY_MAX_CHARS + 1) }, // oversized
          'garbage', // not an object
          { id: 'f0', simple: 'duplicate — first wins' },
        ],
      },
      ids,
    )
    expect(v).toEqual({ rewrites: [{ id: 'f0', simple: 'Good rewrite.' }] })
  })

  it('empty rewrites list is VALID (nothing needed rewriting)', () => {
    expect(validateSimplify({ rewrites: [] }, ids)).toEqual({ rewrites: [] })
  })

  it('whole-result garbage → null (non-object, wrong shape, missing rewrites)', () => {
    expect(validateSimplify(null, ids)).toBeNull()
    expect(validateSimplify('text', ids)).toBeNull()
    expect(validateSimplify({ clusters: [] }, ids)).toBeNull()
    expect(validateSimplify({ rewrites: 'nope' }, ids)).toBeNull()
  })

  it('trims surrounding whitespace on the rewrite text', () => {
    const v = validateSimplify({ rewrites: [{ id: 'f0', simple: '  tidy  ' }] }, ids)
    expect(v).toEqual({ rewrites: [{ id: 'f0', simple: 'tidy' }] })
  })
})

// ---------------------------------------------------------------------------
// applySimplify — fingerprint-guarded, loss-proof
// ---------------------------------------------------------------------------

describe('applySimplify', () => {
  it('attaches simpleBody on matching fingerprint; body stays untouched; input arrays not mutated', () => {
    const input = reviewers()
    const { fingerprint } = enumerateForSimplify(input)
    const value: SimplifyValue = {
      fingerprint,
      rewrites: [
        { id: 'f0', simple: 'The cache can go stale.' },
        { id: 'f2', simple: 'N+1 query in `loadAll` at src/c.ts:7 — batch it.' },
      ],
    }
    const before = JSON.parse(JSON.stringify(input))
    const out = applySimplify(input, value)

    expect(out[0].findings[0].simpleBody).toBe('The cache can go stale.')
    expect(out[0].findings[0].body).toBe(input[0].findings[0].body) // original kept
    expect(out[0].findings[1].simpleBody).toBeUndefined() // no rewrite → untouched
    expect(out[1].findings[0].simpleBody).toBe('N+1 query in `loadAll` at src/c.ts:7 — batch it.')
    // PURE: the input was never mutated.
    expect(input).toEqual(before)
    expect(out).not.toBe(input)
  })

  it('stale fingerprint → input returned UNCHANGED (stale rewrites never applied)', () => {
    const input = reviewers()
    const out = applySimplify(input, { fingerprint: 'not-the-fingerprint', rewrites: [{ id: 'f0', simple: 'stale' }] })
    expect(out).toBe(input)
    expect(input[0].findings[0].simpleBody).toBeUndefined()
  })

  it('empty rewrites → input returned unchanged', () => {
    const input = reviewers()
    const { fingerprint } = enumerateForSimplify(input)
    expect(applySimplify(input, { fingerprint, rewrites: [] })).toBe(input)
  })

  it('already-minimal passthrough: a rewrite identical to the body attaches NO simpleBody (no toggle)', () => {
    const input = reviewers()
    const { fingerprint } = enumerateForSimplify(input)
    const out = applySimplify(input, {
      fingerprint,
      rewrites: [
        { id: 'f1', simple: 'SQL injection via `query`' }, // byte-identical to the original
        { id: 'f0', simple: 'A real rewrite.' },
      ],
    })
    expect(out[0].findings[1].simpleBody).toBeUndefined()
    expect(out[0].findings[0].simpleBody).toBe('A real rewrite.')
  })

  it('preserves every other finding field (severity, verification, mergedFrom…)', () => {
    const input: ReviewerFindings[] = [
      {
        skillId: 'sec',
        name: 'Security',
        findings: [
          finding({
            verification: { confirmedBy: 2, polledModels: 3, surfaced: true, perModel: [] },
            mergedFrom: [{ reviewer: 'Perf', path: 'src/a.ts', line: 11, severity: 'low', body: 'sibling' }],
            mergedReason: 'same root cause',
          }),
        ],
      },
    ]
    const { fingerprint } = enumerateForSimplify(input)
    const out = applySimplify(input, { fingerprint, rewrites: [{ id: 'f0', simple: 'Plainer.' }] })
    const f = out[0].findings[0]
    expect(f.simpleBody).toBe('Plainer.')
    expect(f.verification).toEqual(input[0].findings[0].verification)
    expect(f.mergedFrom).toEqual(input[0].findings[0].mergedFrom)
    expect(f.mergedReason).toBe('same root cause')
    expect(f.severity).toBe('medium')
  })
})
