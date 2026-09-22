/**
 * standingRulesStore.test.ts — propose-never-auto-apply, held to the ledger
 * standard set by calibration.ts (#230): visible, per-entry, clearable, and
 * incapable of writing anything to the user's machine.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { StandingRule } from '../ai/schemas'
import {
  STANDING_RULES_KEY,
  STANDING_RULE_DECISIONS_KEY,
  STANDING_RULE_DECISIONS_MAX,
  STANDING_RULES_HEADING,
  STANDING_RULES_FILENAME,
  normalizeRule,
  ruleId,
  loadDecisions,
  decideRule,
  clearDecision,
  clearAllDecisions,
  withoutRejected,
  loadStandingRules,
  saveStandingRules,
  clearStandingRules,
  isRecordStale,
  exportStandingRules,
  acceptedCount,
  provenanceLine,
  type StandingRulesRecord,
} from './standingRulesStore'

const COUNTS = { reviewComments: 84, dismissals: 12, drafts: 9, acceptedFindings: 3 }

function rule(text: string, kind: 'do' | 'avoid' = 'do'): StandingRule {
  return { rule: text, kind, occurrences: 3, evidence: [{ source: 'draft', excerpt: 'x' }] }
}

function record(overrides: Partial<StandingRulesRecord> = {}): StandingRulesRecord {
  return {
    promptVersion: 1,
    distilledAt: Date.parse('2026-09-22T10:00:00Z'),
    source: 'bridge',
    sourceLabel: 'Claude Code on this machine',
    counts: COUNTS,
    rules: [rule('Alpha rule.')],
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('rule identity', () => {
  it('normalizes case, whitespace and trailing punctuation', () => {
    expect(normalizeRule('  Keep   IT   short.  ')).toBe('keep it short')
    expect(normalizeRule('Keep it short!')).toBe('keep it short')
  })

  it('gives the same id to rules that differ only in casing or a final period', () => {
    expect(ruleId('Keep it short.')).toBe(ruleId('keep it short'))
    expect(ruleId('Keep it short')).not.toBe(ruleId('Keep it long'))
  })
})

describe('decisions', () => {
  it('starts empty and round-trips an accept', () => {
    expect(loadDecisions()).toEqual({})
    const entry = decideRule(rule('Alpha rule.'), 'accepted')
    expect(entry.status).toBe('accepted')
    expect(entry.edited).toBe(false)
    expect(loadDecisions()[ruleId('Alpha rule.')].text).toBe('Alpha rule.')
  })

  it('an EDIT is stored verbatim and flagged as edited — the user\'s words win', () => {
    const entry = decideRule(rule('Alpha rule.'), 'accepted', 'Alpha rule, but sharper.')
    expect(entry.edited).toBe(true)
    expect(entry.text).toBe('Alpha rule, but sharper.')
    expect(loadDecisions()[ruleId('Alpha rule.')].text).toBe('Alpha rule, but sharper.')
  })

  it('a whitespace-only "edit" is not an edit', () => {
    expect(decideRule(rule('Alpha rule.'), 'accepted', '  Alpha   rule.  ').edited).toBe(false)
  })

  it('an empty edit falls back to the proposed text rather than storing nothing', () => {
    const entry = decideRule(rule('Alpha rule.'), 'accepted', '   ')
    expect(entry.text).toBe('Alpha rule.')
  })

  it('re-deciding the same rule overwrites rather than duplicating', () => {
    decideRule(rule('Alpha rule.'), 'accepted')
    decideRule(rule('Alpha rule.'), 'rejected')
    const decisions = loadDecisions()
    expect(Object.keys(decisions)).toHaveLength(1)
    expect(decisions[ruleId('Alpha rule.')].status).toBe('rejected')
  })

  it('clearDecision removes ONE entry; clearAllDecisions removes the ledger', () => {
    decideRule(rule('Alpha rule.'), 'accepted')
    decideRule(rule('Beta rule.'), 'rejected')
    clearDecision(ruleId('Alpha rule.'))
    expect(Object.keys(loadDecisions())).toEqual([ruleId('Beta rule.')])
    clearDecision('not-a-real-id') // no-op
    expect(Object.keys(loadDecisions())).toHaveLength(1)
    clearAllDecisions()
    expect(loadDecisions()).toEqual({})
  })

  it('is LRU-bounded — oldest decisions evicted beyond the cap', () => {
    const now = Date.now()
    const overflowing: Record<string, unknown> = {}
    for (let i = 0; i < STANDING_RULE_DECISIONS_MAX + 10; i++) {
      overflowing[`id${i}`] = {
        status: 'accepted',
        text: `Rule ${i}.`,
        kind: 'do',
        edited: false,
        decidedAt: now + i,
      }
    }
    localStorage.setItem(STANDING_RULE_DECISIONS_KEY, JSON.stringify(overflowing))
    // A write re-applies the cap.
    decideRule(rule('Newest rule.'), 'accepted')
    const kept = loadDecisions()
    expect(Object.keys(kept)).toHaveLength(STANDING_RULE_DECISIONS_MAX)
    expect(kept[ruleId('Newest rule.')]).toBeDefined()
    expect(kept['id0']).toBeUndefined() // oldest evicted
  })

  it('tolerates corrupt storage — garbage JSON, a non-object, and bad entries', () => {
    localStorage.setItem(STANDING_RULE_DECISIONS_KEY, '{not json')
    expect(loadDecisions()).toEqual({})
    localStorage.setItem(STANDING_RULE_DECISIONS_KEY, '[1,2,3]')
    expect(loadDecisions()).toEqual({})
    localStorage.setItem(
      STANDING_RULE_DECISIONS_KEY,
      JSON.stringify({
        good: { status: 'accepted', text: 'ok', kind: 'do', edited: false, decidedAt: 1 },
        badStatus: { status: 'maybe', text: 'x', kind: 'do', edited: false, decidedAt: 1 },
        badKind: { status: 'accepted', text: 'x', kind: 'sideways', edited: false, decidedAt: 1 },
        emptyText: { status: 'accepted', text: '  ', kind: 'do', edited: false, decidedAt: 1 },
        notAnObject: 7,
      }),
    )
    expect(Object.keys(loadDecisions())).toEqual(['good'])
  })
})

describe('withoutRejected — a rejected rule is never re-proposed', () => {
  it('drops rejected rules and keeps undecided and accepted ones', () => {
    decideRule(rule('Rejected rule.'), 'rejected')
    decideRule(rule('Accepted rule.'), 'accepted')
    const proposed = [rule('Rejected rule.'), rule('Accepted rule.'), rule('New rule.')]
    expect(withoutRejected(proposed, loadDecisions()).map((r) => r.rule)).toEqual([
      'Accepted rule.',
      'New rule.',
    ])
  })

  it('matches on NORMALIZED text, so a re-run that only re-punctuates is still rejected', () => {
    decideRule(rule('Do not add a dependency for this.'), 'rejected')
    const reproposed = [rule('do not add a dependency for this')]
    expect(withoutRejected(reproposed, loadDecisions())).toEqual([])
  })
})

describe('the distillation record', () => {
  it('round-trips through localStorage', () => {
    const r = record()
    saveStandingRules(r)
    expect(loadStandingRules()).toEqual(r)
    expect(localStorage.getItem(STANDING_RULES_KEY)).toBeTruthy()
  })

  it('returns null when absent, corrupt, or missing a required field', () => {
    expect(loadStandingRules()).toBeNull()
    localStorage.setItem(STANDING_RULES_KEY, '{oops')
    expect(loadStandingRules()).toBeNull()
    localStorage.setItem(STANDING_RULES_KEY, JSON.stringify({ ...record(), source: 'telepathy' }))
    expect(loadStandingRules()).toBeNull()
    localStorage.setItem(STANDING_RULES_KEY, JSON.stringify({ ...record(), counts: { nope: 1 } }))
    expect(loadStandingRules()).toBeNull()
  })

  it('drops individual garbled rules rather than discarding the whole run', () => {
    localStorage.setItem(
      STANDING_RULES_KEY,
      JSON.stringify({ ...record(), rules: [rule('Kept.'), null, { rule: '' }, { nope: 1 }] }),
    )
    expect(loadStandingRules()?.rules.map((r) => r.rule)).toEqual(['Kept.'])
  })

  it('clearStandingRules discards it', () => {
    saveStandingRules(record())
    clearStandingRules()
    expect(loadStandingRules()).toBeNull()
  })

  it('isRecordStale compares against the CURRENT prompt version', () => {
    expect(isRecordStale(record({ promptVersion: 1 }), 1)).toBe(false)
    expect(isRecordStale(record({ promptVersion: 1 }), 2)).toBe(true)
  })
})

describe('export', () => {
  it('renders a pasteable section with a ONE-LINE provenance header', () => {
    decideRule(rule('Put domain logic in the domain module.'), 'accepted')
    const text = exportStandingRules(loadDecisions(), record())
    const lines = text.split('\n')
    expect(lines[0]).toBe(STANDING_RULES_HEADING)
    expect(lines[2]).toBe(provenanceLine(record()))
    expect(lines[2].split('\n')).toHaveLength(1)
    expect(lines[2]).toContain('2026-09-22')
    expect(lines[2]).toContain('84 review comments')
    expect(lines[2]).toContain('12 dismissals')
    expect(lines[2]).toContain('9 drafts')
  })

  it('splits the two kinds into subsections that read differently', () => {
    decideRule(rule('Put domain logic in the domain module.', 'do'), 'accepted')
    decideRule(rule('Do not flag missing JSDoc on internal helpers.', 'avoid'), 'accepted')
    const text = exportStandingRules(loadDecisions(), record())
    expect(text).toContain('### Always\n\n- Put domain logic in the domain module.')
    expect(text).toContain('### Never\n\n- Do not flag missing JSDoc on internal helpers.')
  })

  it('exports ONLY accepted rules — rejected and undecided never appear', () => {
    decideRule(rule('Accepted.'), 'accepted')
    decideRule(rule('Rejected.'), 'rejected')
    const text = exportStandingRules(loadDecisions(), record())
    expect(text).toContain('- Accepted.')
    expect(text).not.toContain('Rejected.')
    expect(acceptedCount(loadDecisions())).toBe(1)
  })

  it('exports the EDITED text, not the proposal', () => {
    decideRule(rule('Original wording.'), 'accepted', 'My wording.')
    const text = exportStandingRules(loadDecisions(), record())
    expect(text).toContain('- My wording.')
    expect(text).not.toContain('Original wording.')
  })

  it('says so plainly when nothing is accepted — no empty bullet list', () => {
    const text = exportStandingRules({}, record())
    expect(text).toContain('_No rules accepted yet._')
    expect(text).not.toContain('### Always')
  })

  it('omits a subsection entirely when that kind has no accepted rules', () => {
    decideRule(rule('Only a do rule.', 'do'), 'accepted')
    const text = exportStandingRules(loadDecisions(), record())
    expect(text).toContain('### Always')
    expect(text).not.toContain('### Never')
  })

  it('the download filename is a plain .md — the module returns TEXT, never writes a file', () => {
    expect(STANDING_RULES_FILENAME).toBe('standing-rules.md')
    // The module surface has no write/fs/bridge affordance at all: the only
    // way out is the string exportStandingRules returns.
    const text = exportStandingRules(loadDecisions(), record())
    expect(typeof text).toBe('string')
  })

  it('singularizes the provenance counts honestly', () => {
    expect(
      provenanceLine({ distilledAt: Date.parse('2026-01-02T00:00:00Z'), counts: { reviewComments: 1, dismissals: 1, drafts: 1, acceptedFindings: 0 } }),
    ).toContain('1 review comment, 1 dismissal, 1 draft')
  })
})
