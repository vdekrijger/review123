/**
 * src/lib/skills/skills.ts — Reviewer skill store (bring-your-own persona).
 *
 * Persists to localStorage under `review123:reviewer-skills`.
 * Cap: 25 skills (SKILLS_CAP); content cap: 20_000 chars.
 * id = djb2(name + addedAt) — content-addressed enough for our purposes.
 */

import { djb2 } from '../viewed/viewed.svelte'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SKILLS_KEY = 'review123:reviewer-skills'
export const SKILLS_CAP = 25
export const SKILL_CONTENT_CAP = 20_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewerSkill {
  id: string
  name: string
  content: string
  enabled: boolean
  addedAt: number
}

// ---------------------------------------------------------------------------
// Shape validator — element-level, tolerant of extra keys
// ---------------------------------------------------------------------------

function isValidSkill(x: unknown): x is ReviewerSkill {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false
  const obj = x as Record<string, unknown>
  if (typeof obj['id'] !== 'string') return false
  if (typeof obj['name'] !== 'string') return false
  if (typeof obj['content'] !== 'string') return false
  if (typeof obj['enabled'] !== 'boolean') return false
  if (typeof obj['addedAt'] !== 'number') return false
  return true
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
    return parsed.filter(isValidSkill)
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
 * List all stored skills (shape-validated; corrupt/invalid entries are skipped).
 */
export function listSkills(): ReviewerSkill[] {
  return load()
}

/**
 * Add a new skill.
 * Throws when: name/content is empty, content exceeds cap, or skills cap reached.
 */
export function addSkill(name: string, content: string): ReviewerSkill {
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

  const skill: ReviewerSkill = {
    id,
    name: trimmedName,
    content,
    enabled: true,
    addedAt,
  }

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

  const updated = { ...skills[idx] }

  if ('name' in patch) {
    const name = patch.name?.trim() ?? ''
    if (!name) throw new Error('Skill name must not be empty')
    updated.name = name
  }

  if ('content' in patch) {
    const content = patch.content ?? ''
    if (content.length > SKILL_CONTENT_CAP) {
      throw new Error(`Skill content must not exceed ${SKILL_CONTENT_CAP} characters`)
    }
    updated.content = content
  }

  skills[idx] = updated
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
 * Toggle the enabled state of a skill. No-op if not found.
 */
export function toggleSkill(id: string): void {
  const skills = load()
  const idx = skills.findIndex((s) => s.id === id)
  if (idx === -1) return
  skills[idx] = { ...skills[idx], enabled: !skills[idx].enabled }
  save(skills)
}
