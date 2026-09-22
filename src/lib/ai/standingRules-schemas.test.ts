/**
 * standingRules-schemas.test.ts — the standing-rules payload contract.
 *
 * Two jobs, held to the #224/#231 standard:
 *   validateStandingRules — STRICT. A shape that is not the shape is null, so
 *     the repair pass gets a chance at the real thing.
 *   salvageStandingRules  — PER-ELEMENT. One garbled rule must not discard a
 *     distillation the user paid an LLM call (or minutes of local CLI) for.
 */

import { describe, it, expect } from 'vitest'
import {
  validateStandingRules,
  salvageStandingRules,
  STANDING_RULES_MAX,
  STANDING_RULE_TEXT_MAX,
  STANDING_RULE_EVIDENCE_MAX,
  STANDING_RULE_EXCERPT_MAX,
} from './schemas'

function rule(overrides: Record<string, unknown> = {}) {
  return {
    rule: 'Put domain logic in the domain module, never in a route handler.',
    kind: 'do',
    occurrences: 4,
    evidence: [{ source: 'review-comment', excerpt: 'this belongs in the domain layer' }],
    ...overrides,
  }
}

describe('validateStandingRules (strict)', () => {
  it('accepts a well-formed payload and returns it normalized', () => {
    const result = validateStandingRules({ rules: [rule()] })
    expect(result).toEqual({
      rules: [
        {
          rule: 'Put domain logic in the domain module, never in a route handler.',
          kind: 'do',
          occurrences: 4,
          evidence: [{ source: 'review-comment', excerpt: 'this belongs in the domain layer' }],
        },
      ],
    })
  })

  it('accepts an EMPTY rules array — "no repeated pattern" is an honest answer', () => {
    expect(validateStandingRules({ rules: [] })).toEqual({ rules: [] })
  })

  it('accepts both kinds and all three evidence sources', () => {
    const result = validateStandingRules({
      rules: [
        rule({ kind: 'avoid', evidence: [{ source: 'dismissal', excerpt: 'missing jsdoc' }] }),
        rule({ evidence: [{ source: 'draft', excerpt: 'extract this' }] }),
      ],
    })
    expect(result?.rules.map((r) => r.kind)).toEqual(['avoid', 'do'])
    expect(result?.rules.map((r) => r.evidence[0].source)).toEqual(['dismissal', 'draft'])
  })

  it('rejects a non-object, a missing rules array, and a non-array rules', () => {
    expect(validateStandingRules(null)).toBeNull()
    expect(validateStandingRules('rules')).toBeNull()
    expect(validateStandingRules({})).toBeNull()
    expect(validateStandingRules({ rules: 'nope' })).toBeNull()
  })

  it('rejects a rule with no text, an unknown kind, or a sub-1 occurrence count', () => {
    expect(validateStandingRules({ rules: [rule({ rule: '   ' })] })).toBeNull()
    expect(validateStandingRules({ rules: [rule({ rule: 42 })] })).toBeNull()
    expect(validateStandingRules({ rules: [rule({ kind: 'maybe' })] })).toBeNull()
    expect(validateStandingRules({ rules: [rule({ occurrences: 0 })] })).toBeNull()
    expect(validateStandingRules({ rules: [rule({ occurrences: 'four' })] })).toBeNull()
    expect(validateStandingRules({ rules: [rule({ occurrences: Number.NaN })] })).toBeNull()
  })

  it('rejects malformed evidence — an unknown source or an empty excerpt', () => {
    expect(validateStandingRules({ rules: [rule({ evidence: 'nope' })] })).toBeNull()
    expect(
      validateStandingRules({ rules: [rule({ evidence: [{ source: 'slack', excerpt: 'x' }] })] }),
    ).toBeNull()
    expect(
      validateStandingRules({ rules: [rule({ evidence: [{ source: 'draft', excerpt: '  ' }] })] }),
    ).toBeNull()
  })

  it('rounds a fractional occurrence count rather than rejecting the rule', () => {
    expect(validateStandingRules({ rules: [rule({ occurrences: 3.6 })] })?.rules[0].occurrences).toBe(4)
  })

  it('caps rules at STANDING_RULES_MAX and evidence at STANDING_RULE_EVIDENCE_MAX (truncate, never reject)', () => {
    const many = Array.from({ length: STANDING_RULES_MAX + 5 }, (_, i) => rule({ rule: `Rule number ${i}.` }))
    expect(validateStandingRules({ rules: many })?.rules).toHaveLength(STANDING_RULES_MAX)

    const lots = Array.from({ length: STANDING_RULE_EVIDENCE_MAX + 3 }, (_, i) => ({
      source: 'draft',
      excerpt: `excerpt ${i}`,
    }))
    expect(validateStandingRules({ rules: [rule({ evidence: lots })] })?.rules[0].evidence).toHaveLength(
      STANDING_RULE_EVIDENCE_MAX,
    )
  })

  it('collapses whitespace and cuts over-long text at its cap', () => {
    const result = validateStandingRules({
      rules: [
        rule({
          rule: `  Keep   it\n short.  ${'x'.repeat(STANDING_RULE_TEXT_MAX)}`,
          evidence: [{ source: 'draft', excerpt: `y`.repeat(STANDING_RULE_EXCERPT_MAX + 50) }],
        }),
      ],
    })
    const r = result!.rules[0]
    expect(r.rule.length).toBeLessThanOrEqual(STANDING_RULE_TEXT_MAX + 1) // +1 for the ellipsis
    expect(r.rule).toContain('Keep it short.')
    expect(r.rule.endsWith('…')).toBe(true)
    expect(r.evidence[0].excerpt.length).toBeLessThanOrEqual(STANDING_RULE_EXCERPT_MAX + 1)
  })
})

describe('salvageStandingRules (per-element)', () => {
  it('keeps the good rules and drops only the garbled ones', () => {
    const result = salvageStandingRules({
      rules: [
        rule({ rule: 'Keep the first rule.' }),
        null,
        { rule: '   ' },
        { nope: true },
        rule({ rule: 'Keep the last rule.' }),
      ],
    })
    expect(result?.rules.map((r) => r.rule)).toEqual(['Keep the first rule.', 'Keep the last rule.'])
  })

  it('degrades an unknown kind to "do" — an authoring instruction, the lower-stakes reading', () => {
    expect(salvageStandingRules({ rules: [rule({ kind: 'sideways' })] })?.rules[0].kind).toBe('do')
    expect(salvageStandingRules({ rules: [rule({ kind: undefined })] })?.rules[0].kind).toBe('do')
    // A VALID kind is preserved — the degrade must not flatten 'avoid'.
    expect(salvageStandingRules({ rules: [rule({ kind: 'avoid' })] })?.rules[0].kind).toBe('avoid')
  })

  it('degrades a missing occurrence count to the evidence count, floored at 1 — never fabricated upward', () => {
    const twoEv = [
      { source: 'draft', excerpt: 'a' },
      { source: 'draft', excerpt: 'b' },
    ]
    expect(salvageStandingRules({ rules: [rule({ occurrences: undefined, evidence: twoEv })] })?.rules[0].occurrences).toBe(2)
    expect(salvageStandingRules({ rules: [rule({ occurrences: 'lots', evidence: [] })] })?.rules[0].occurrences).toBe(1)
  })

  it('drops malformed evidence entries individually; a rule may survive with none', () => {
    const result = salvageStandingRules({
      rules: [
        rule({
          evidence: [{ source: 'draft', excerpt: 'kept' }, null, { excerpt: '' }, 'nope'],
        }),
        rule({ rule: 'No evidence at all.', evidence: 'garbage' }),
      ],
    })
    expect(result?.rules[0].evidence).toEqual([{ source: 'draft', excerpt: 'kept' }])
    expect(result?.rules[1].evidence).toEqual([])
  })

  it('degrades an unknown evidence source to review-comment (the largest stream)', () => {
    const result = salvageStandingRules({
      rules: [rule({ evidence: [{ source: 'telepathy', excerpt: 'x' }] })],
    })
    expect(result?.rules[0].evidence[0].source).toBe('review-comment')
  })

  it('returns null for a non-object or a missing rules array', () => {
    expect(salvageStandingRules(null)).toBeNull()
    expect(salvageStandingRules({})).toBeNull()
    expect(salvageStandingRules({ rules: 7 })).toBeNull()
  })

  it('returns null when a NON-EMPTY list salvages to nothing (garbage, not "no rules")', () => {
    expect(salvageStandingRules({ rules: [null, { nope: 1 }, { rule: '' }] })).toBeNull()
  })

  it('an EMPTY list still salvages to an empty result — that answer is legitimate', () => {
    expect(salvageStandingRules({ rules: [] })).toEqual({ rules: [] })
  })

  it('still applies the caps', () => {
    const many = Array.from({ length: STANDING_RULES_MAX + 4 }, (_, i) => rule({ rule: `R${i}.` }))
    expect(salvageStandingRules({ rules: many })?.rules).toHaveLength(STANDING_RULES_MAX)
  })
})
