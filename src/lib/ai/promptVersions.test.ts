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

/**
 * Tasks that existed at the global-v26 → per-task-map migration. Tasks added
 * LATER (e.g. `simplify`) start their own version history at 1 — a brand-new
 * cache segment has nothing to invalidate — so the ≥26 floor applies only to
 * the migration-era tasks.
 */
const MIGRATION_ERA_TASKS: PromptVersionedTaskId[] = [
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
]

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
        'intent',
        'outcomes',
        'skills',
        'story',
        'riskJudge',
        'convergence',
        'simplify',
      ].sort(),
    )
  })

  it('promptVersionFor returns the map entry for every task', () => {
    for (const task of ALL_TASKS) {
      expect(promptVersionFor(task), task).toBe(PROMPT_VERSIONS[task])
    }
  })

  it('no migration-era task is below the migration value 26 (versions only move forward)', () => {
    for (const task of MIGRATION_ERA_TASKS) {
      expect(PROMPT_VERSIONS[task], task).toBeGreaterThanOrEqual(26)
    }
  })

  it('post-migration tasks start at ≥1 (simplify, intent and outcomes have their own version history)', () => {
    expect(PROMPT_VERSIONS.simplify).toBeGreaterThanOrEqual(1)
    expect(PROMPT_VERSIONS.intent).toBeGreaterThanOrEqual(1)
    expect(PROMPT_VERSIONS.outcomes).toBeGreaterThanOrEqual(1)
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

  it('verdict (single-pass + deep + |models companions) — v28: grounded verification', () => {
    // Bumped 27 → 28: the shared verifier rubric (crossVerify buildVerifyPrompt)
    // gained GROUNDED verification — verifiers run through the tool loop with
    // repo lookups and report groundedNote — and verdict evidence rows run that
    // same rubric, so cached verified verdicts re-run under the new framing.
    expect(cacheKey(PR, 'verdict', promptVersionFor('verdict'))).toBe('owner/repo#1@abc123|verdict|v28')
    expect(cacheKey(PR, 'verdict|deep', promptVersionFor('verdict'))).toBe('owner/repo#1@abc123|verdict|deep|v28')
    expect(cacheKey(PR, 'verdict' + '|models', promptVersionFor('verdict'))).toBe(
      'owner/repo#1@abc123|verdict|models|v28',
    )
    expect(cacheKey(PR, 'verdict|deep' + '|models', promptVersionFor('verdict'))).toBe(
      'owner/repo#1@abc123|verdict|deep|models|v28',
    )
  })

  it('skill reviews (content-hashed segment composes with the version) — v29: dismissal calibration', () => {
    // Bumped 28 → 29: the skill-review prompt TEMPLATE gained the optional
    // per-reviewer "PAST DISMISSED FINDINGS" calibration section (dismissal
    // calibration). Only `skills` bumps; verdict stays at 28.
    // The content hash is djb2(skill.content + calibrationBlock) — an EMPTY
    // ledger contributes '' so the hash below equals djb2(content) exactly.
    const content = '# Persona\nYou review for security.'
    const emptyCalibration = ''
    const hash = djb2(content + emptyCalibration)
    expect(hash).toBe(djb2(content))
    expect(cacheKey(PR, 'skill:' + hash, promptVersionFor('skills'))).toBe(`owner/repo#1@abc123|skill:${hash}|v29`)
    expect(cacheKey(PR, 'skill:' + hash + '|deep', promptVersionFor('skills'))).toBe(
      `owner/repo#1@abc123|skill:${hash}|deep|v29`,
    )
    expect(cacheKey(PR, 'skill:' + hash + '|models', promptVersionFor('skills'))).toBe(
      `owner/repo#1@abc123|skill:${hash}|models|v29`,
    )
    // A non-empty calibration block re-keys THIS reviewer (same mechanism as a
    // persona edit): the joined hash — and therefore the key — diverges.
    const calibrated = djb2(content + 'PAST DISMISSED FINDINGS — …\n- [noise] nitpick (in a.ts)')
    expect(calibrated).not.toBe(hash)
    expect(cacheKey(PR, 'skill:' + calibrated, promptVersionFor('skills'))).not.toBe(
      cacheKey(PR, 'skill:' + hash, promptVersionFor('skills')),
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

  it('simplify (post-merge finding fingerprint hash composes with its OWN v1 history)', () => {
    const fingerprint = 'f0:src/a.ts:10'
    const hash = djb2(fingerprint)
    expect(cacheKey(PR, 'simplify:' + hash, promptVersionFor('simplify'))).toBe(
      `owner/repo#1@abc123|simplify:${hash}|v1`,
    )
  })

  it('outcomes (title hash composes with its OWN v1 history; a title edit changes the key)', () => {
    const title = 'feat: add feature'
    const hash = djb2(title)
    expect(cacheKey(PR, 'outcomes:' + hash, promptVersionFor('outcomes'))).toBe(
      `owner/repo#1@abc123|outcomes:${hash}|v1`,
    )
    // A title edit changes the folded hash → the cached check re-runs. (The
    // diff side is covered by the PR key's head SHA, like every sibling.)
    const editedHash = djb2('feat: add feature v2')
    expect(editedHash).not.toBe(hash)
  })

  it('intent (title+body hash composes with its OWN v1 history; a body edit changes the key)', () => {
    const title = 'feat: add feature'
    const body = 'This PR adds a feature.'
    const hash = djb2(`${title}\n${body}`)
    expect(cacheKey(PR, 'intent:' + hash, promptVersionFor('intent'))).toBe(
      `owner/repo#1@abc123|intent:${hash}|v1`,
    )
    // A description edit changes the folded hash → the cached check re-runs.
    const editedHash = djb2(`${title}\n${body} Now with tests.`)
    expect(editedHash).not.toBe(hash)
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
