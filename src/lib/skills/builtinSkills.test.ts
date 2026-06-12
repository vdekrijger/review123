/**
 * Tests for src/lib/skills/builtinSkills.ts
 *
 * Covers:
 *   - BUILTIN_SKILLS is an array of 6 entries
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
  it('is an array of exactly 6 entries', () => {
    expect(Array.isArray(BUILTIN_SKILLS)).toBe(true)
    expect(BUILTIN_SKILLS).toHaveLength(6)
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

  it('includes a pragmatic sample skill with id "pragmatic"', () => {
    const pragmatic = BUILTIN_SKILLS.find((s) => s.id === 'pragmatic')
    expect(pragmatic).toBeDefined()
  })

  it('pragmatic skill name matches SAMPLE_SKILL_NAME', () => {
    const pragmatic = BUILTIN_SKILLS.find((s) => s.id === 'pragmatic')
    expect(pragmatic?.name).toBe(SAMPLE_SKILL_NAME)
  })
})
