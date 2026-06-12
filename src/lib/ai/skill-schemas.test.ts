/**
 * Tests for skill-related schemas and prompt in src/lib/ai/schemas.ts + tasks.ts
 *
 * Covers:
 *   - validateSkillReviewResult: valid, invalid-enum severity, missing fields,
 *     element-level checking, >15 findings capped/rejected
 *   - skillReviewPrompt: system contains persona content, user = ctx.text,
 *     no PROMPT_VERSION reference, system instructs JSON output
 */

import { describe, it, expect } from 'vitest'
import { validateSkillReviewResult } from './schemas'
import { skillReviewPrompt } from './tasks'
import type { PackedContext } from '../context/pack'

// ---------------------------------------------------------------------------
// validateSkillReviewResult
// ---------------------------------------------------------------------------

function makeCtx(text = 'PR context'): PackedContext {
  return { text, notAnalyzed: [], includedFiles: [] }
}

describe('validateSkillReviewResult', () => {
  const validResult = {
    skillName: 'Security Reviewer',
    findings: [
      { path: 'src/api.ts', line: 42, severity: 'high', body: 'SQL injection risk' },
      { path: 'src/utils.ts', line: null, severity: 'low', body: 'No sanitization' },
    ],
  }

  it('accepts a valid SkillReviewResult', () => {
    expect(validateSkillReviewResult(validResult)).toEqual(validResult)
  })

  it('accepts empty findings array', () => {
    const x = { skillName: 'Test', findings: [] }
    expect(validateSkillReviewResult(x)).toEqual(x)
  })

  it('returns null for non-object', () => {
    expect(validateSkillReviewResult(null)).toBeNull()
    expect(validateSkillReviewResult('string')).toBeNull()
    expect(validateSkillReviewResult(42)).toBeNull()
  })

  it('returns null when skillName is missing', () => {
    const x = { findings: [] }
    expect(validateSkillReviewResult(x)).toBeNull()
  })

  it('returns null when skillName is not a string', () => {
    expect(validateSkillReviewResult({ skillName: 42, findings: [] })).toBeNull()
  })

  it('returns null when findings is not an array', () => {
    expect(validateSkillReviewResult({ skillName: 'X', findings: 'bad' })).toBeNull()
  })

  it('returns null when a finding has invalid severity', () => {
    const x = {
      skillName: 'X',
      findings: [{ path: 'a.ts', line: 1, severity: 'critical', body: 'x' }],
    }
    expect(validateSkillReviewResult(x)).toBeNull()
  })

  it('returns null when a finding is missing path', () => {
    const x = {
      skillName: 'X',
      findings: [{ line: 1, severity: 'high', body: 'x' }],
    }
    expect(validateSkillReviewResult(x)).toBeNull()
  })

  it('returns null when a finding is missing body', () => {
    const x = {
      skillName: 'X',
      findings: [{ path: 'a.ts', line: 1, severity: 'high' }],
    }
    expect(validateSkillReviewResult(x)).toBeNull()
  })

  it('accepts line as null', () => {
    const x = {
      skillName: 'X',
      findings: [{ path: 'a.ts', line: null, severity: 'medium', body: 'detail' }],
    }
    expect(validateSkillReviewResult(x)).not.toBeNull()
  })

  it('returns null when line is neither number nor null', () => {
    const x = {
      skillName: 'X',
      findings: [{ path: 'a.ts', line: 'not-a-number', severity: 'high', body: 'x' }],
    }
    expect(validateSkillReviewResult(x)).toBeNull()
  })

  it('tolerates extra keys on the top-level object', () => {
    const x = { skillName: 'X', findings: [], extra: true }
    expect(validateSkillReviewResult(x)).not.toBeNull()
  })

  it('returns null when findings exceed 15 (element count exceeds cap)', () => {
    const findings = Array.from({ length: 16 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i,
      severity: 'low' as const,
      body: `finding ${i}`,
    }))
    expect(validateSkillReviewResult({ skillName: 'X', findings })).toBeNull()
  })

  it('accepts exactly 15 findings', () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i,
      severity: 'low' as const,
      body: `finding ${i}`,
    }))
    expect(validateSkillReviewResult({ skillName: 'X', findings })).not.toBeNull()
  })

  it('returns null for all three invalid severity values', () => {
    for (const sev of ['critical', 'info', 'warning', '', 42]) {
      const x = {
        skillName: 'X',
        findings: [{ path: 'a.ts', line: 1, severity: sev, body: 'x' }],
      }
      expect(validateSkillReviewResult(x)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// skillReviewPrompt
// ---------------------------------------------------------------------------

describe('skillReviewPrompt', () => {
  it('returns system and user strings', () => {
    const result = skillReviewPrompt(makeCtx(), { name: 'Security', content: '## Security\nCheck for XSS.' })
    expect(typeof result.system).toBe('string')
    expect(typeof result.user).toBe('string')
  })

  it('user message equals ctx.text', () => {
    const ctx = makeCtx('some PR diff here')
    const result = skillReviewPrompt(ctx, { name: 'S', content: 'persona' })
    expect(result.user).toBe('some PR diff here')
  })

  it('system contains the skill content fenced', () => {
    const content = '## Security\nLook for SQL injection.'
    const result = skillReviewPrompt(makeCtx(), { name: 'Security', content })
    // Content should appear in the system prompt (possibly fenced)
    expect(result.system).toContain(content)
  })

  it('system instructs JSON output', () => {
    const result = skillReviewPrompt(makeCtx(), { name: 'S', content: 'persona' })
    expect(result.system.toLowerCase()).toContain('json')
  })

  it('system mentions the persona name', () => {
    const result = skillReviewPrompt(makeCtx(), { name: 'SecurityReviewer', content: 'persona text' })
    // The system prompt should contextualise the persona name or say "reviewer persona"
    expect(result.system.toLowerCase()).toMatch(/persona|reviewer/)
  })

  it('system constrains findings to a hard cap of 5 (v10 anti-fatigue)', () => {
    const result = skillReviewPrompt(makeCtx(), { name: 'S', content: 'persona' })
    expect(result.system).toMatch(/at most 5 findings/i)
    expect(result.system).toContain('0–5')
    // The old 15-finding instruction must be gone (the schema's 15 cap is a
    // parse-side backstop only, not a prompt instruction)
    expect(result.system).not.toMatch(/15 findings|0–15/)
  })

  it('system mentions severity enum values', () => {
    const result = skillReviewPrompt(makeCtx(), { name: 'S', content: 'persona' })
    expect(result.system).toMatch(/high.*medium.*low|low.*medium.*high/i)
  })
})

// ---------------------------------------------------------------------------
// skillReviewPrompt — v10 anti-fatigue calibration
// ---------------------------------------------------------------------------

describe('skillReviewPrompt — anti-fatigue calibration (v10)', () => {
  const prompt = () => skillReviewPrompt(makeCtx(), { name: 'S', content: 'persona' })

  it('system carries the evidence gate (cite + concrete harm, no bare "consider...")', () => {
    const { system } = prompt()
    expect(system).toMatch(/Evidence gate/i)
    expect(system).toMatch(/what breaks, or who gets hurt/i)
    expect(system).toMatch(/"consider\.\.\."/)
    expect(system).toMatch(/stated failure mode/i)
  })

  it('system instructs "couldn\'t verify" or silence when harm is not visible in the diff', () => {
    const { system } = prompt()
    expect(system).toMatch(/couldn't verify/i)
    expect(system).toMatch(/never assert/i)
  })

  it('system instructs ranking by severity × confidence and one-line omission note', () => {
    const { system } = prompt()
    expect(system).toMatch(/severity × confidence/i)
    expect(system).toMatch(/lower-confidence observations omitted/i)
  })

  it('system carries the brevity format (what+where / why it matters, no padding)', () => {
    const { system } = prompt()
    expect(system).toMatch(/WHAT \+ WHERE/i)
    expect(system).toMatch(/WHY IT MATTERS/i)
    expect(system).toMatch(/no praise padding, no methodology narration/i)
  })

  it('system states silence is a valid (GOOD) answer with the all-clear sentence', () => {
    const { system } = prompt()
    expect(system).toContain('No significant issues from this lens.')
    expect(system).toMatch(/GOOD and expected outcome on clean code/i)
  })

  it('system carries the severity-honesty rule (nits are nits, never inflate)', () => {
    const { system } = prompt()
    expect(system).toMatch(/nits are nits/i)
    expect(system).toMatch(/never inflate/i)
  })

  it('without existingComments: no redundancy section is present', () => {
    const { system } = prompt()
    expect(system).not.toContain('Existing PR comments')
  })

  it('with existingComments: embeds the comments and the never-repeat instruction', () => {
    const { system } = skillReviewPrompt(
      makeCtx(),
      { name: 'S', content: 'persona' },
      ['Please rename this variable.', 'Missing null check in parser.'],
    )
    expect(system).toContain('Existing PR comments')
    expect(system).toContain('Please rename this variable.')
    expect(system).toContain('Missing null check in parser.')
    expect(system).toMatch(/Never repeat a point an existing comment already makes/i)
  })

  it('caps existing comments at 30 and truncates each to 200 chars (coach policy)', () => {
    const many = Array.from({ length: 40 }, (_, i) => `existing comment number ${i}`)
    const { system } = skillReviewPrompt(makeCtx(), { name: 'S', content: 'p' }, many)
    expect(system).toContain('existing comment number 0')
    expect(system).toContain('existing comment number 29')
    expect(system).not.toContain('existing comment number 30')

    const long = 'y'.repeat(300)
    const { system: sysLong } = skillReviewPrompt(makeCtx(), { name: 'S', content: 'p' }, [long])
    expect(sysLong).toContain('y'.repeat(200))
    expect(sysLong).not.toContain('y'.repeat(201))
  })

  it('empty existingComments array behaves like no comments', () => {
    const { system } = skillReviewPrompt(makeCtx(), { name: 'S', content: 'p' }, [])
    expect(system).not.toContain('Existing PR comments')
  })

  it('body field rule asks for one-sentence what+where and why-it-matters', () => {
    const { system } = prompt()
    expect(system).toMatch(/body: one sentence of WHAT \+ WHERE/i)
  })
})

// ---------------------------------------------------------------------------
// "No findings" fixture — raw model output parses to the empty-findings state
// ---------------------------------------------------------------------------

describe('no-findings fixture parses cleanly', () => {
  it('a raw JSON "no findings" response validates to an empty findings array', () => {
    // Exactly what a calibrated model emits on clean code
    const raw = '{"skillName":"Security Reviewer","findings":[]}'
    const parsed = validateSkillReviewResult(JSON.parse(raw))
    expect(parsed).not.toBeNull()
    expect(parsed?.skillName).toBe('Security Reviewer')
    expect(parsed?.findings).toEqual([])
  })
})
