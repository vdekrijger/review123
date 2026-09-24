/**
 * src/lib/skills/skills.ts — Reviewer skill store (bring-your-own persona).
 *
 * Persists to localStorage under `review123:reviewer-skills`.
 * Cap: 25 skills (SKILLS_CAP); content cap: 20_000 chars.
 * id = djb2(name + addedAt) — content-addressed enough for our purposes.
 *
 * PHASE SCOPE. A reviewer is not simply on or off: the review flow has two
 * phases (implementation, then tests — src/lib/guide/phase.svelte.ts), and most
 * reviewers only have something to say about one of them. A Resiliency & SRE
 * lens has nothing to tell you about a test file; a Test Quality & Coverage
 * lens is the entire point of the tests phase. Running every reviewer on both
 * costs tokens and wall-clock, and — worse — produces moot findings the user
 * then has to read and dismiss. So each skill carries a `scope`.
 */

import { djb2 } from '../viewed/viewed.svelte'
import type { ReviewPhase } from '../guide/phase.svelte'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SKILLS_KEY = 'review123:reviewer-skills'
export const SKILLS_CAP = 25
export const SKILL_CONTENT_CAP = 20_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Which review phases a reviewer runs in.
 *
 *  - 'both'           — runs in the implementation pass AND the tests pass.
 *  - 'implementation' — implementation pass only (silent in the Tests phase).
 *  - 'tests'          — tests pass only (silent in the Implementation phase).
 *  - 'off'            — never runs, in either phase. Unambiguous: there is no
 *                       second "enabled" flag that could disagree with it.
 *
 * The two phase values are deliberately spelled the SAME as `ReviewPhase` /
 * `ReviewerPass`, so `scope === phase` is the whole membership test.
 */
export type SkillScope = 'both' | 'implementation' | 'tests' | 'off'

/** Every scope, in the order the settings UI and any picker should present them. */
export const SKILL_SCOPES = ['both', 'implementation', 'tests', 'off'] as const

/** What a skill the user wrote themselves gets: we never guess their phase for them. */
export const DEFAULT_SKILL_SCOPE: SkillScope = 'both'

/** The fields that have nothing to do with scope. */
interface SkillIdentity {
  id: string
  name: string
  content: string
  addedAt: number
}

/**
 * A stored reviewer skill.
 *
 * `scope` is the SOURCE OF TRUTH. `enabled` is a DERIVED mirror — "runs in at
 * least one phase" — recomputed from `scope` on every read (see `scopedSkill`),
 * never trusted from storage. The union below is what makes the pair
 * unfalsifiable: `{ scope: 'off', enabled: true }` is not a value this type can
 * hold, so no call site can be handed a skill that claims to be both off and
 * enabled. Construct one only through `scopedSkill`.
 */
export type ReviewerSkill = SkillIdentity &
  (
    | { scope: 'off'; enabled: false }
    | { scope: Exclude<SkillScope, 'off'>; enabled: true }
  )

/** The only way to build a ReviewerSkill — keeps `enabled` pinned to `scope`. */
export function scopedSkill(identity: SkillIdentity, scope: SkillScope): ReviewerSkill {
  return scope === 'off'
    ? { ...identity, scope, enabled: false }
    : { ...identity, scope, enabled: true }
}

/** True when `raw` is one of the four scopes. */
export function isSkillScope(raw: unknown): raw is SkillScope {
  return raw === 'both' || raw === 'implementation' || raw === 'tests' || raw === 'off'
}

/** Does this reviewer run in `phase`? The one membership rule, used everywhere. */
export function skillRunsIn(skill: ReviewerSkill, phase: ReviewPhase): boolean {
  return skill.scope === 'both' || skill.scope === phase
}

// ---------------------------------------------------------------------------
// Shape validator + migration — element-level, tolerant of extra keys
// ---------------------------------------------------------------------------

/**
 * Read one stored record into a ReviewerSkill, or null when it is not one.
 *
 * MIGRATION (silent, on read, no prompt, no reset). Records written by the
 * released boolean version carry `enabled` and no `scope`:
 *
 *     enabled: true  → scope 'both'  (it ran everywhere before; it still does)
 *     enabled: false → scope 'off'
 *
 * A record carrying a valid `scope` wins outright — including one that also
 * still carries a stale `enabled`, whose value is ignored and recomputed. That
 * is what keeps the derived mirror from ever drifting, even if some other tab,
 * an older build, or a hand-edited localStorage wrote a contradiction.
 *
 * Nothing is written back here: `listSkills()` is called from render paths, and
 * a read must not have a storage side effect. The new shape lands on the next
 * ordinary mutation.
 */
function readSkill(x: unknown): ReviewerSkill | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null
  const obj = x as Record<string, unknown>
  if (typeof obj['id'] !== 'string') return null
  if (typeof obj['name'] !== 'string') return null
  if (typeof obj['content'] !== 'string') return null
  if (typeof obj['addedAt'] !== 'number') return null

  const scope = isSkillScope(obj['scope'])
    ? obj['scope']
    : typeof obj['enabled'] === 'boolean'
      ? obj['enabled']
        ? 'both'
        : 'off'
      : null
  // Neither a valid scope nor a legacy boolean → not a skill record we wrote.
  if (scope === null) return null

  return scopedSkill(
    {
      id: obj['id'],
      name: obj['name'],
      content: obj['content'],
      addedAt: obj['addedAt'],
    },
    scope,
  )
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function load(): ReviewerSkill[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(readSkill)
      .filter((s): s is ReviewerSkill => s !== null)
  } catch {
    return []
  }
}

function save(skills: ReviewerSkill[]): void {
  localStorage.setItem(SKILLS_KEY, JSON.stringify(skills))
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

/**
 * List all stored skills (shape-validated + migrated; corrupt entries skipped).
 */
export function listSkills(): ReviewerSkill[] {
  return load()
}

/**
 * The skills that run in `phase` — the ONLY list a dispatcher should ever use.
 *
 * A skill scoped out of this phase is simply not here: it is never prompted,
 * never billed, and — because the reviewer chips are rendered from the entries
 * the dispatcher creates — never shows up claiming a clean result it did not
 * earn.
 */
export function listSkillsForPhase(phase: ReviewPhase): ReviewerSkill[] {
  return load().filter((s) => skillRunsIn(s, phase))
}

/**
 * Add a new skill.
 *
 * `scope` defaults to 'both' — a skill the USER wrote gets no guess about which
 * phase it belongs to. The built-in library passes each persona's own
 * `defaultScope` instead (see builtinSkills.ts).
 *
 * Throws when: name/content is empty, content exceeds cap, or skills cap reached.
 */
export function addSkill(
  name: string,
  content: string,
  scope: SkillScope = DEFAULT_SKILL_SCOPE,
): ReviewerSkill {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('Skill name must not be empty')
  const trimmedContent = content.trim()
  if (!trimmedContent) throw new Error('Skill content must not be empty')
  if (content.length > SKILL_CONTENT_CAP) {
    throw new Error(`Skill content must not exceed ${SKILL_CONTENT_CAP} characters`)
  }

  const existing = load()
  if (existing.length >= SKILLS_CAP) {
    throw new Error(`Cannot add more than ${SKILLS_CAP} reviewer skills`)
  }

  const addedAt = Date.now()
  const id = djb2(trimmedName + addedAt)

  const skill = scopedSkill({ id, name: trimmedName, content, addedAt }, scope)

  save([...existing, skill])
  return skill
}

/**
 * Update fields of a skill by id.
 * No-op if id not found. Throws if new content exceeds cap or name is empty.
 */
export function updateSkill(
  id: string,
  patch: { name?: string; content?: string },
): void {
  const skills = load()
  const idx = skills.findIndex((s) => s.id === id)
  if (idx === -1) return

  const current = skills[idx]
  let name = current.name
  let content = current.content

  if ('name' in patch) {
    const next = patch.name?.trim() ?? ''
    if (!next) throw new Error('Skill name must not be empty')
    name = next
  }

  if ('content' in patch) {
    const next = patch.content ?? ''
    if (next.length > SKILL_CONTENT_CAP) {
      throw new Error(`Skill content must not exceed ${SKILL_CONTENT_CAP} characters`)
    }
    content = next
  }

  skills[idx] = scopedSkill({ id: current.id, name, content, addedAt: current.addedAt }, current.scope)
  save(skills)
}

/**
 * Remove a skill by id. No-op if not found.
 */
export function removeSkill(id: string): void {
  const skills = load()
  save(skills.filter((s) => s.id !== id))
}

/**
 * Set which phases a skill runs in. No-op if not found.
 *
 * This REPLACED the old `toggleSkill`: a two-state toggle cannot express four
 * states, and "toggle" over a scope would have to invent what the off→on
 * direction restores. Setting the scope outright is the only unambiguous move.
 */
export function setSkillScope(id: string, scope: SkillScope): void {
  const skills = load()
  const idx = skills.findIndex((s) => s.id === id)
  if (idx === -1) return
  const { id: skillId, name, content, addedAt } = skills[idx]
  skills[idx] = scopedSkill({ id: skillId, name, content, addedAt }, scope)
  save(skills)
}

/**
 * Turn one phase on or off for a skill, keeping the other phase as it is —
 * what the settings UI's two per-row phase checkboxes drive. Clearing both
 * lands on 'off'; setting both lands on 'both'.
 */
export function setSkillPhase(id: string, phase: ReviewPhase, runs: boolean): void {
  const skill = load().find((s) => s.id === id)
  if (!skill) return
  const implementation = phase === 'implementation' ? runs : skillRunsIn(skill, 'implementation')
  const tests = phase === 'tests' ? runs : skillRunsIn(skill, 'tests')
  setSkillScope(id, scopeFromPhases(implementation, tests))
}

/** The scope that runs in exactly the phases named. */
export function scopeFromPhases(implementation: boolean, tests: boolean): SkillScope {
  if (implementation && tests) return 'both'
  if (implementation) return 'implementation'
  if (tests) return 'tests'
  return 'off'
}
