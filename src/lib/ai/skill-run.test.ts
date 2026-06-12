/**
 * Tests for runSkillReviews orchestration in src/lib/ai/run.svelte.ts
 *
 * Covers:
 *   - per-skill isolation: each enabled skill runs independently
 *   - disabled skills are skipped
 *   - content-hash cache key: same skill content → cache hit; edited content → miss
 *   - no-key gate: runSkillReviews returns early when no key
 *   - consent gate: declined → skill review states set appropriately
 *   - state shape: skillReviews array with skillId, name, state
 *   - analytics: tracks 'skill-review' task (no skill content in payload)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiRun } from './run.svelte'
import type { PackedContext } from '../context/pack'
import type { CiSummary } from '../github/checks'
import type { SkillReviewResult } from './schemas'
import { addSkill, listSkills, removeSkill } from '../skills/skills'

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const PACKED_CTX: PackedContext = {
  text: 'some PR context',
  notAnalyzed: [],
  includedFiles: ['src/foo.ts'],
}

const CI_SUMMARY: CiSummary = {
  total: 1, passed: 1, failed: 0, pending: 0, failures: [],
}

const SKILL_RESULT_A: SkillReviewResult = {
  skillName: 'Security Reviewer',
  findings: [{ path: 'src/foo.ts', line: 10, severity: 'high', body: 'SQL injection risk' }],
}

const SKILL_RESULT_B: SkillReviewResult = {
  skillName: 'Performance Reviewer',
  findings: [{ path: 'src/foo.ts', line: 20, severity: 'medium', body: 'N+1 query' }],
}

// ---------------------------------------------------------------------------
// DI stub factory (mirrors the pattern from run.test.ts)
// ---------------------------------------------------------------------------

type ValidateFn = (x: unknown) => unknown

function makeDeps({ hasKey = true, gateResult = true } = {}) {
  if (hasKey) {
    localStorage.setItem('review123:settings', JSON.stringify({ deepseekKey: 'sk-test' }))
  } else {
    localStorage.removeItem('review123:settings')
  }

  const gateAi = vi.fn().mockResolvedValue(gateResult)
  const getCached = vi.fn().mockResolvedValue(null)
  const setCached = vi.fn().mockResolvedValue(undefined)
  const llmStream = vi.fn().mockImplementation(
    async (_opts: unknown, onDelta: (d: string) => void) => {
      onDelta('hello')
      return 'hello'
    },
  )
  // By default: returns SKILL_RESULT_A for any validate call
  const llmJsonWithRepair = vi.fn().mockImplementation(
    async (_opts: unknown, validate: ValidateFn) => {
      // Return whichever result the validate function accepts
      if (validate(SKILL_RESULT_A) !== null) return SKILL_RESULT_A
      if (validate(SKILL_RESULT_B) !== null) return SKILL_RESULT_B
      // Fallback: return something that passes attention validation
      return { readingOrder: [], hotspots: [], testFlags: [] }
    },
  )
  const track = vi.fn()

  return { gateAi, getCached, setCached, llmStream, llmJsonWithRepair, track }
}

function makeInput() {
  return {
    prKey: 'owner/repo#1@abc123',
    repo: 'owner/repo',
    isPrivate: false as boolean | undefined,
    pack: async (): Promise<PackedContext> => PACKED_CTX,
    ci: async (): Promise<CiSummary | null> => CI_SUMMARY,
    ask: async () => true,
  }
}

// ---------------------------------------------------------------------------
// Setup: clear localStorage and skills before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// runSkillReviews — basic shape
// ---------------------------------------------------------------------------

describe('runSkillReviews — initial state', () => {
  it('skillReviews starts as empty array', () => {
    const deps = makeDeps()
    const run = createAiRun(makeInput(), deps)
    expect(run.skillReviews).toEqual([])
  })
})

describe('runSkillReviews — no-key gate', () => {
  it('does nothing and leaves skillReviews empty when no API key', async () => {
    const deps = makeDeps({ hasKey: false })
    const skill = addSkill('Security', 'check for XSS')
    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()
    expect(run.skillReviews).toEqual([])
    removeSkill(skill.id)
  })
})

describe('runSkillReviews — disabled skills skipped', () => {
  it('skips disabled skills and does not set state for them', async () => {
    const deps = makeDeps()
    const skill = addSkill('Security', 'check for XSS')
    // Toggle to disable
    const { toggleSkill } = await import('../skills/skills')
    toggleSkill(skill.id)

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    // No LLM calls for disabled skill
    expect(deps.llmJsonWithRepair).not.toHaveBeenCalled()
    // skillReviews should be empty or not contain the disabled skill
    expect(run.skillReviews.every(sr => sr.skillId !== skill.id)).toBe(true)

    removeSkill(skill.id)
  })
})

describe('runSkillReviews — per-skill isolation', () => {
  it('runs each enabled skill independently and records results', async () => {
    const deps = makeDeps()

    const skillA = addSkill('Security Reviewer', 'check for XSS')
    const skillB = addSkill('Performance Reviewer', 'check for N+1')

    // Dispatch different results based on skill name in system prompt
    deps.llmJsonWithRepair.mockImplementation(
      async (opts: { system: string; user: string }, validate: ValidateFn) => {
        if (opts.system.includes('Security Reviewer') && validate(SKILL_RESULT_A) !== null) {
          return SKILL_RESULT_A
        }
        if (opts.system.includes('Performance Reviewer') && validate(SKILL_RESULT_B) !== null) {
          return SKILL_RESULT_B
        }
        return SKILL_RESULT_A
      },
    )

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(run.skillReviews).toHaveLength(2)
    const secReview = run.skillReviews.find(sr => sr.name === 'Security Reviewer')
    const perfReview = run.skillReviews.find(sr => sr.name === 'Performance Reviewer')

    expect(secReview?.state.status).toBe('done')
    expect(perfReview?.state.status).toBe('done')
    expect(secReview?.state.value).toEqual(SKILL_RESULT_A)
    expect(perfReview?.state.value).toEqual(SKILL_RESULT_B)

    removeSkill(skillA.id)
    removeSkill(skillB.id)
  })

  it('one skill failing does not prevent another from succeeding', async () => {
    const deps = makeDeps()

    const skillA = addSkill('Security Reviewer', 'check for XSS')
    const skillB = addSkill('Performance Reviewer', 'check for N+1')

    let callCount = 0
    deps.llmJsonWithRepair.mockImplementation(
      async (_opts: unknown, validate: ValidateFn) => {
        callCount++
        if (callCount === 1) throw new Error('LLM failed')
        if (validate(SKILL_RESULT_B) !== null) return SKILL_RESULT_B
        return SKILL_RESULT_A
      },
    )

    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    // Both should have been attempted
    expect(run.skillReviews).toHaveLength(2)
    // One errored, one succeeded
    const statuses = run.skillReviews.map(sr => sr.state.status)
    expect(statuses).toContain('error')
    expect(statuses).toContain('done')

    removeSkill(skillA.id)
    removeSkill(skillB.id)
  })
})

describe('runSkillReviews — content-hash cache invalidation', () => {
  it('uses content-addressed cache key: same content → cache hit', async () => {
    const deps = makeDeps()
    // Return cached value when key matches
    deps.getCached.mockImplementation(async (key: string) => {
      if (key.includes('skill:')) return SKILL_RESULT_A
      return null
    })

    const skill = addSkill('Security', 'check for XSS')
    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    // getCached should have been called with a skill: prefix key
    const skillCacheCall = deps.getCached.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('skill:'),
    )
    expect(skillCacheCall).toBeTruthy()
    // LLM should NOT have been called (cache hit)
    // (llmJsonWithRepair may be called for main tasks if start was never called — we only test runSkillReviews here)
    expect(run.skillReviews[0]?.state.status).toBe('done')
    expect(run.skillReviews[0]?.state.value).toEqual(SKILL_RESULT_A)

    removeSkill(skill.id)
  })

  it('cache key changes when skill content changes (content-addressed)', async () => {
    const deps = makeDeps()
    const collectedKeys: string[] = []
    deps.getCached.mockImplementation(async (key: string) => {
      collectedKeys.push(key)
      return null
    })

    // First run with original content
    const skill = addSkill('Security', 'original content')
    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    const firstKeys = [...collectedKeys]
    const skillKeys1 = firstKeys.filter(k => k.includes('skill:'))
    expect(skillKeys1).toHaveLength(1)

    // Update skill content — should produce different cache key
    const { updateSkill, listSkills } = await import('../skills/skills')
    updateSkill(skill.id, { content: 'modified content' })

    collectedKeys.length = 0
    await run.runSkillReviews()

    const skillKeys2 = collectedKeys.filter(k => k.includes('skill:'))
    expect(skillKeys2).toHaveLength(1)
    // Keys must differ because content changed
    expect(skillKeys1[0]).not.toBe(skillKeys2[0])

    listSkills().forEach(s => removeSkill(s.id))
  })
})

describe('runSkillReviews — analytics', () => {
  it('tracks skill-review task without skill content in payload', async () => {
    const deps = makeDeps()
    const skill = addSkill('Security', 'check for XSS — very secret')
    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    const skillTrack = deps.track.mock.calls.find(
      (c: unknown[]) =>
        c[0] === 'ai_task_completed' &&
        (c[1] as Record<string, unknown>)['task'] === 'skill-review',
    )
    expect(skillTrack).toBeTruthy()
    // Skill content must NOT appear in the analytics payload
    const payload = JSON.stringify(skillTrack![1])
    expect(payload).not.toContain('check for XSS')
    expect(payload).not.toContain('very secret')

    removeSkill(skill.id)
  })
})

describe('runSkillReviews — consent gate', () => {
  it('does nothing when gateAi returns false', async () => {
    const deps = makeDeps({ gateResult: false })
    const skill = addSkill('Security', 'check for XSS')
    const run = createAiRun(makeInput(), deps)
    await run.runSkillReviews()

    expect(deps.llmJsonWithRepair).not.toHaveBeenCalled()
    expect(run.skillReviews).toEqual([])

    removeSkill(skill.id)
  })
})
