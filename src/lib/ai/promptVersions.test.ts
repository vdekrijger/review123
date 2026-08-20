/**
 * Per-task prompt versioning (H6 — cache-invalidation hygiene).
 *
 * Proofs:
 *   1. Key stability — at the migration from the single global
 *      `PROMPT_VERSION = 26` to the per-task PROMPT_VERSIONS map, every cache
 *      key STRING stayed byte-identical: the `…|v26` literals below are
 *      exactly the keys the old global produced, built here through the exact
 *      task-segment expressions run.svelte.ts uses. So NO cached result was
 *      invalidated by the switch itself.
 *   2. Bump isolation — bumping ONE task's entry changes only that task's
 *      key; every other task's key is untouched (the point of the map: no
 *      thundering herd of cold re-runs across all tasks after one prompt
 *      tweak).
 *
 * Maintenance: when you bump a task's entry in PROMPT_VERSIONS, update ONLY
 * that task's `…|v<N>` literal(s) below. Every other literal must stay
 * unchanged — that unchanged remainder is the bump-isolation guarantee this
 * file enforces.
 */

import { describe, it, expect } from 'vitest'
import { cacheKey } from '../cache/aiCache'
import { PROMPT_VERSIONS, promptVersionFor, type PromptVersionedTaskId } from './tasks'
import { djb2 } from '../viewed/viewed.svelte'

const PR = 'owner/repo#1@abc123'

const ALL_TASKS = Object.keys(PROMPT_VERSIONS) as PromptVersionedTaskId[]

describe('PROMPT_VERSIONS map', () => {
  it('covers exactly the cached tasks — no more, no less', () => {
    expect(ALL_TASKS.sort()).toEqual(
      [
        'summary',
        'attention',
        'diagrams',
        'tests',
        'alternatives',
        'verdict',
        'skills',
        'story',
        'riskJudge',
        'convergence',
      ].sort(),
    )
  })

  it('promptVersionFor returns the map entry for every task', () => {
    for (const task of ALL_TASKS) {
      expect(promptVersionFor(task), task).toBe(PROMPT_VERSIONS[task])
    }
  })

  it('no task is below the migration value 26 (versions only move forward)', () => {
    for (const task of ALL_TASKS) {
      expect(PROMPT_VERSIONS[task], task).toBeGreaterThanOrEqual(26)
    }
  })
})

describe('cache-key stability (migration: global v26 → per-task map)', () => {
  // Each block builds the key through the same task-segment expression the
  // orchestrator (run.svelte.ts) uses, and asserts the byte-exact string the
  // old global PROMPT_VERSION = 26 produced.

  it('summary', () => {
    expect(cacheKey(PR, 'summary', promptVersionFor('summary'))).toBe('owner/repo#1@abc123|summary|v26')
  })

  it('attention (single-pass + deep)', () => {
    expect(cacheKey(PR, 'attention', promptVersionFor('attention'))).toBe('owner/repo#1@abc123|attention|v26')
    expect(cacheKey(PR, 'attention|deep', promptVersionFor('attention'))).toBe('owner/repo#1@abc123|attention|deep|v26')
  })

  it('diagrams (single-pass + deep)', () => {
    expect(cacheKey(PR, 'diagrams', promptVersionFor('diagrams'))).toBe('owner/repo#1@abc123|diagrams|v26')
    expect(cacheKey(PR, 'diagrams|deep', promptVersionFor('diagrams'))).toBe('owner/repo#1@abc123|diagrams|deep|v26')
  })

  it('tests (single-pass + deep)', () => {
    expect(cacheKey(PR, 'tests', promptVersionFor('tests'))).toBe('owner/repo#1@abc123|tests|v26')
    expect(cacheKey(PR, 'tests|deep', promptVersionFor('tests'))).toBe('owner/repo#1@abc123|tests|deep|v26')
  })

  it('alternatives (single-pass + deep)', () => {
    expect(cacheKey(PR, 'alternatives', promptVersionFor('alternatives'))).toBe('owner/repo#1@abc123|alternatives|v26')
    expect(cacheKey(PR, 'alternatives|deep', promptVersionFor('alternatives'))).toBe(
      'owner/repo#1@abc123|alternatives|deep|v26',
    )
  })

  it('story (single-pass + deep)', () => {
    expect(cacheKey(PR, 'story', promptVersionFor('story'))).toBe('owner/repo#1@abc123|story|v26')
    expect(cacheKey(PR, 'story|deep', promptVersionFor('story'))).toBe('owner/repo#1@abc123|story|deep|v26')
  })

  it('risk judge (cache segment "risk-judge")', () => {
    expect(cacheKey(PR, 'risk-judge', promptVersionFor('riskJudge'))).toBe('owner/repo#1@abc123|risk-judge|v26')
  })

  it('verdict (single-pass + deep + |models companions)', () => {
    expect(cacheKey(PR, 'verdict', promptVersionFor('verdict'))).toBe('owner/repo#1@abc123|verdict|v26')
    expect(cacheKey(PR, 'verdict|deep', promptVersionFor('verdict'))).toBe('owner/repo#1@abc123|verdict|deep|v26')
    expect(cacheKey(PR, 'verdict' + '|models', promptVersionFor('verdict'))).toBe(
      'owner/repo#1@abc123|verdict|models|v26',
    )
    expect(cacheKey(PR, 'verdict|deep' + '|models', promptVersionFor('verdict'))).toBe(
      'owner/repo#1@abc123|verdict|deep|models|v26',
    )
  })

  it('skill reviews (content-hashed segment composes with the version)', () => {
    const content = '# Persona\nYou review for security.'
    const hash = djb2(content)
    expect(cacheKey(PR, 'skill:' + hash, promptVersionFor('skills'))).toBe(`owner/repo#1@abc123|skill:${hash}|v26`)
    expect(cacheKey(PR, 'skill:' + hash + '|deep', promptVersionFor('skills'))).toBe(
      `owner/repo#1@abc123|skill:${hash}|deep|v26`,
    )
    expect(cacheKey(PR, 'skill:' + hash + '|models', promptVersionFor('skills'))).toBe(
      `owner/repo#1@abc123|skill:${hash}|models|v26`,
    )
  })

  it('convergence (finding+draft fingerprint hash composes with the version)', () => {
    const fingerprint = 'f0:src/a.ts:10'
    const draftFingerprint = 'd0:src/a.ts:11'
    const hash = djb2(fingerprint + '||' + draftFingerprint)
    expect(cacheKey(PR, 'convergence:' + hash, promptVersionFor('convergence'))).toBe(
      `owner/repo#1@abc123|convergence:${hash}|v26`,
    )
  })
})

describe('bump isolation', () => {
  it("bumping one task's version changes that task's key and leaves every other task's key unchanged", () => {
    const bumped: Record<PromptVersionedTaskId, number> = {
      ...PROMPT_VERSIONS,
      verdict: PROMPT_VERSIONS.verdict + 1,
    }
    // The bumped task's key diverges → its cache cold-invalidates.
    expect(cacheKey(PR, 'verdict', bumped.verdict)).not.toBe(cacheKey(PR, 'verdict', PROMPT_VERSIONS.verdict))
    // Every OTHER task's key is byte-identical → their caches stay warm.
    for (const task of ALL_TASKS) {
      if (task === 'verdict') continue
      expect(cacheKey(PR, task, bumped[task]), task).toBe(cacheKey(PR, task, PROMPT_VERSIONS[task]))
    }
  })
})
