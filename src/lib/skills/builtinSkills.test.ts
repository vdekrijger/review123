/**
 * Tests for src/lib/skills/builtinSkills.ts
 *
 * Covers:
 *   - BUILTIN_SKILLS is an array of 9 entries
 *   - Each entry has id, name, tagline, and content fields
 *   - Content sanity: < 20_000 chars, non-empty, contains 'Priorities' or 'Discipline'
 *   - Each entry has a unique id
 *   - The pragmatic sample skill is re-exported as id 'pragmatic'
 *   - SAMPLE_SKILL_NAME is still exported from sampleSkill.ts for compat
 */

import { describe, it, expect } from 'vitest'
import { BUILTIN_SKILLS } from './builtinSkills'
import { SAMPLE_SKILL_NAME } from './sampleSkill'

describe('BUILTIN_SKILLS', () => {
  it('is an array of exactly 9 entries', () => {
    expect(Array.isArray(BUILTIN_SKILLS)).toBe(true)
    expect(BUILTIN_SKILLS).toHaveLength(9)
  })

  it('includes the Test Quality & Coverage Reviewer', () => {
    const tq = BUILTIN_SKILLS.find((s) => s.id === 'test-quality')
    expect(tq).toBeDefined()
    expect(tq!.name).toMatch(/test quality/i)
  })

  it('each entry has id, name, tagline, and content fields as strings', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(typeof skill.id).toBe('string')
      expect(typeof skill.name).toBe('string')
      expect(typeof skill.tagline).toBe('string')
      expect(typeof skill.content).toBe('string')
    }
  })

  it('all ids are unique', () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(BUILTIN_SKILLS.length)
  })

  it('all names are non-empty', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.name.trim().length).toBeGreaterThan(0)
    }
  })

  it('all taglines are non-empty', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.tagline.trim().length).toBeGreaterThan(0)
    }
  })

  it('each content is non-empty and under 20_000 chars', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content.trim().length).toBeGreaterThan(0)
      expect(skill.content.length).toBeLessThan(20_000)
    }
  })

  it('each content contains "Priorities" or "Discipline"', () => {
    for (const skill of BUILTIN_SKILLS) {
      const has = skill.content.includes('Priorities') || skill.content.includes('Discipline')
      expect(has, `skill "${skill.name}" is missing Priorities/Discipline in content`).toBe(true)
    }
  })

  it('includes an "Architecture & Design Reviewer" entry', () => {
    expect(BUILTIN_SKILLS.some((s) => s.name === 'Architecture & Design Reviewer')).toBe(true)
  })

  it('Architecture & Design Reviewer has correct tagline', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'Architecture & Design Reviewer')
    expect(skill?.tagline).toBe('Coupling, boundaries, patterns — is this the right shape?')
  })

  it('includes a "Security Reviewer (OWASP-minded)" entry', () => {
    expect(BUILTIN_SKILLS.some((s) => s.name === 'Security Reviewer (OWASP-minded)')).toBe(true)
  })

  it('Security Reviewer has correct tagline', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'Security Reviewer (OWASP-minded)')
    expect(skill?.tagline).toBe('Input trust, secrets, authz — the boring failures that hurt')
  })

  it('includes a "UX & Interaction Reviewer" entry', () => {
    expect(BUILTIN_SKILLS.some((s) => s.name === 'UX & Interaction Reviewer')).toBe(true)
  })

  it('UX & Interaction Reviewer has correct tagline', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'UX & Interaction Reviewer')
    expect(skill?.tagline).toBe('States, feedback, flow — what does the user feel?')
  })

  it('includes a "Resiliency & SRE Reviewer" entry', () => {
    expect(BUILTIN_SKILLS.some((s) => s.name === 'Resiliency & SRE Reviewer')).toBe(true)
  })

  it('Resiliency & SRE Reviewer has correct tagline', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'Resiliency & SRE Reviewer')
    expect(skill?.tagline).toBe('Timeouts, retries, blast radius — will it survive contact?')
  })

  it('includes a "Performance Reviewer" entry', () => {
    expect(BUILTIN_SKILLS.some((s) => s.name === 'Performance Reviewer')).toBe(true)
  })

  it('Performance Reviewer has correct tagline', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'Performance Reviewer')
    expect(skill?.tagline).toBe('Work done per unit of value — quietly hot paths')
  })

  it('includes a "Comment Sensibility Reviewer" entry', () => {
    expect(BUILTIN_SKILLS.some((s) => s.name === 'Comment Sensibility Reviewer')).toBe(true)
  })

  it('Comment Sensibility Reviewer has the expected id and tagline', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'Comment Sensibility Reviewer')
    expect(skill?.id).toBe('comment-sensibility')
    expect(skill?.tagline).toBe('Redundant, stale, commented-out — comments that add noise')
  })

  it('Comment Sensibility persona targets low-value/stale/commented-out comments', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === 'comment-sensibility')
    expect(skill?.content).toMatch(/Redundant/i)
    expect(skill?.content).toMatch(/Stale|misleading/i)
    expect(skill?.content).toMatch(/Commented-out code/i)
    // Must NOT push the user to add more comments.
    expect(skill?.content).toMatch(/never demand MORE comments/i)
  })

  it('Comment Sensibility persona carries the shared calibration (not bypassed)', async () => {
    const { SHARED_CALIBRATION } = await import('./builtinSkills')
    const skill = BUILTIN_SKILLS.find((s) => s.id === 'comment-sensibility')
    expect(skill?.content.endsWith(SHARED_CALIBRATION)).toBe(true)
  })

  it('includes a "PostHog Observability Reviewer" entry', () => {
    expect(BUILTIN_SKILLS.some((s) => s.name === 'PostHog Observability Reviewer')).toBe(true)
  })

  it('PostHog Observability Reviewer has the expected id and tagline', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'PostHog Observability Reviewer')
    expect(skill?.id).toBe('posthog-observability')
    expect(skill?.tagline).toBe('Events, flags, errors — what would PostHog want to see?')
  })

  it('PostHog persona references real PostHog capabilities (capture / feature flag / error tracking)', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === 'posthog-observability')
    expect(skill?.content).toMatch(/posthog\.capture/i)
    expect(skill?.content).toMatch(/feature flag/i)
    expect(skill?.content).toMatch(/error tracking/i)
    expect(skill?.content).toMatch(/experiment/i)
    expect(skill?.content).toMatch(/survey/i)
    expect(skill?.content).toMatch(/session replay/i)
  })

  it('PostHog persona stays disciplined — silence on already-instrumented / unfitting code', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === 'posthog-observability')
    expect(skill?.content).toMatch(/already instrumented/i)
    expect(skill?.content).toMatch(/empty result/i)
  })

  it('PostHog persona carries the shared calibration (not bypassed)', async () => {
    const { SHARED_CALIBRATION } = await import('./builtinSkills')
    const skill = BUILTIN_SKILLS.find((s) => s.id === 'posthog-observability')
    expect(skill?.content.endsWith(SHARED_CALIBRATION)).toBe(true)
  })

  it('includes a pragmatic sample skill with id "pragmatic"', () => {
    const pragmatic = BUILTIN_SKILLS.find((s) => s.id === 'pragmatic')
    expect(pragmatic).toBeDefined()
  })

  it('pragmatic skill name matches SAMPLE_SKILL_NAME', () => {
    const pragmatic = BUILTIN_SKILLS.find((s) => s.id === 'pragmatic')
    expect(pragmatic?.name).toBe(SAMPLE_SKILL_NAME)
  })
})

// ---------------------------------------------------------------------------
// Shared anti-fatigue calibration (v10) — appended to every persona
// ---------------------------------------------------------------------------

describe('BUILTIN_SKILLS — shared calibration (v10)', () => {
  it('exports SHARED_CALIBRATION as a non-empty string', async () => {
    const { SHARED_CALIBRATION } = await import('./builtinSkills')
    expect(typeof SHARED_CALIBRATION).toBe('string')
    expect(SHARED_CALIBRATION.trim().length).toBeGreaterThan(0)
  })

  it('every persona content ends with the shared calibration block', async () => {
    const { SHARED_CALIBRATION } = await import('./builtinSkills')
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content.endsWith(SHARED_CALIBRATION), `skill "${skill.name}" is missing the shared calibration`).toBe(true)
    }
  })

  it('shared calibration appears exactly once per persona (no double-append)', async () => {
    const { SHARED_CALIBRATION } = await import('./builtinSkills')
    for (const skill of BUILTIN_SKILLS) {
      const occurrences = skill.content.split(SHARED_CALIBRATION).length - 1
      expect(occurrences, `skill "${skill.name}"`).toBe(1)
    }
  })

  it('shared calibration encodes the six anti-fatigue rules', async () => {
    const { SHARED_CALIBRATION } = await import('./builtinSkills')
    // 1. Evidence gate
    expect(SHARED_CALIBRATION).toMatch(/Evidence gate/i)
    expect(SHARED_CALIBRATION).toMatch(/what breaks, or who gets hurt/i)
    expect(SHARED_CALIBRATION).toMatch(/couldn't verify/i)
    // 2. Hard cap
    expect(SHARED_CALIBRATION).toMatch(/At most 5 findings/i)
    // 3. Brevity format
    expect(SHARED_CALIBRATION).toMatch(/one sentence of what \+ where/i)
    expect(SHARED_CALIBRATION).toMatch(/no praise padding, no methodology narration/i)
    // 4. Silence is valid
    expect(SHARED_CALIBRATION).toContain('No significant issues from this lens.')
    // 5. No redundancy
    expect(SHARED_CALIBRATION).toMatch(/Never repeat a point an existing PR comment already makes/i)
    // 6. Severity honesty
    expect(SHARED_CALIBRATION).toMatch(/nits are nits/i)
    expect(SHARED_CALIBRATION).toMatch(/never inflate/i)
  })

  it('per-persona priorities remain intact after the append (not rewrites)', () => {
    const security = BUILTIN_SKILLS.find((s) => s.id === 'security')
    expect(security?.content).toContain('Injection surfaces')
    const sre = BUILTIN_SKILLS.find((s) => s.id === 'sre')
    expect(sre?.content).toContain('Unbounded operations')
  })
})
