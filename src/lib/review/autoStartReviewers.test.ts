/**
 * Tests for the early skill-reviewer auto-start gating predicate.
 *
 * Mirrors the gating Review.svelte applies in its one-shot $effect:
 *   - fires once when the setting is on AND all gating holds
 *   - does NOT fire when the setting is off, no key, skills mode off, or no
 *     enabled skills
 *   - does NOT re-fire once it has started for the current PR identity (the
 *     guard blocks step navigation / re-render re-triggers)
 *   - DOES fire again when the PR identity changes (a new PR starts fresh)
 */

import { describe, it, expect } from 'vitest'
import { shouldAutoStartReviewers } from './autoStartReviewers'

const PR_ID = 'github:owner/repo#1'

function base(overrides: Partial<Parameters<typeof shouldAutoStartReviewers>[0]> = {}) {
  return {
    autoRunReviewers: true,
    aiRunReady: true,
    loadReady: true,
    hasKey: true,
    skillsMode: 'standard',
    enabledSkillCount: 2,
    alreadyStartedFor: null,
    prId: PR_ID,
    ...overrides,
  }
}

describe('shouldAutoStartReviewers', () => {
  it('fires when the setting is on and all gating holds', () => {
    expect(shouldAutoStartReviewers(base())).toBe(true)
  })

  it('does not fire when the setting is off', () => {
    expect(shouldAutoStartReviewers(base({ autoRunReviewers: false }))).toBe(false)
  })

  it('does not fire when there is no API key', () => {
    expect(shouldAutoStartReviewers(base({ hasKey: false }))).toBe(false)
  })

  it('does not fire when the skills task mode is off', () => {
    expect(shouldAutoStartReviewers(base({ skillsMode: 'off' }))).toBe(false)
  })

  it('does not fire when no skills are enabled', () => {
    expect(shouldAutoStartReviewers(base({ enabledSkillCount: 0 }))).toBe(false)
  })

  it('does not fire before the AI run exists or the PR load is ready', () => {
    expect(shouldAutoStartReviewers(base({ aiRunReady: false }))).toBe(false)
    expect(shouldAutoStartReviewers(base({ loadReady: false }))).toBe(false)
  })

  it('does not re-fire once it has started for this PR identity', () => {
    expect(shouldAutoStartReviewers(base({ alreadyStartedFor: PR_ID }))).toBe(false)
  })

  it('fires again when the PR identity changes (guard reset)', () => {
    expect(
      shouldAutoStartReviewers(base({ alreadyStartedFor: 'github:owner/repo#1', prId: 'github:owner/repo#2' })),
    ).toBe(true)
  })

  it('fires when deep mode is on (only off is gated out)', () => {
    expect(shouldAutoStartReviewers(base({ skillsMode: 'deep' }))).toBe(true)
  })
})
