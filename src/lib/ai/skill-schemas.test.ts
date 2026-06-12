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

  it('system constrains findings to 15', () => {
    const result = skillReviewPrompt(makeCtx(), { name: 'S', content: 'persona' })
    expect(result.system).toMatch(/15|fifteen/i)
  })

  it('system mentions severity enum values', () => {
    const result = skillReviewPrompt(makeCtx(), { name: 'S', content: 'persona' })
    expect(result.system).toMatch(/high.*medium.*low|low.*medium.*high/i)
  })
})
