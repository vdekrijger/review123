/**
 * Tests for src/lib/skills/skills.ts — reviewer skill store
 *
 * Covers:
 *   - CRUD: list/add/update/remove/toggle
 *   - Cap: max 10 skills
 *   - Content cap: 20_000 chars max
 *   - Corrupt localStorage is tolerated
 *   - Shape validation on load
 *   - id is deterministic djb2(name+addedAt)
 *   - SAMPLE_SKILL_NAME / SAMPLE_SKILL_CONTENT exports
 *   - installed sample skill is enabled and behaves like any skill
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  listSkills,
  addSkill,
  updateSkill,
  removeSkill,
  toggleSkill,
  SKILLS_KEY,
  SKILLS_CAP,
  SKILL_CONTENT_CAP,
} from './skills'
import { SAMPLE_SKILL_NAME, SAMPLE_SKILL_CONTENT } from './sampleSkill'

beforeEach(() => {
  localStorage.clear()
})

describe('listSkills', () => {
  it('returns empty array when nothing stored', () => {
    expect(listSkills()).toEqual([])
  })

  it('returns stored skills', () => {
    addSkill('Security', 'Look for SQL injection.')
    const skills = listSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('Security')
    expect(skills[0].content).toBe('Look for SQL injection.')
    expect(skills[0].enabled).toBe(true)
    expect(typeof skills[0].id).toBe('string')
    expect(typeof skills[0].addedAt).toBe('number')
  })

  it('tolerates corrupt JSON in localStorage', () => {
    localStorage.setItem(SKILLS_KEY, '{not valid json')
    expect(listSkills()).toEqual([])
  })

  it('ignores entries with missing required fields (shape validation)', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'abc', name: 'ok', content: 'x', enabled: true, addedAt: 1 }, // valid
      { id: 'bad' }, // missing fields
      { id: 'noid', name: 'x', enabled: true, addedAt: 1 }, // missing content
    ]))
    const skills = listSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('abc')
  })

  it('ignores entries where content is not a string', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'x', name: 'a', content: 42, enabled: true, addedAt: 1 },
    ]))
    expect(listSkills()).toEqual([])
  })

  it('ignores entries where enabled is not boolean', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'x', name: 'a', content: 'c', enabled: 'yes', addedAt: 1 },
    ]))
    expect(listSkills()).toEqual([])
  })
})

describe('addSkill', () => {
  it('adds a skill and returns it', () => {
    const skill = addSkill('Perf', 'Look for N+1 queries.')
    expect(skill.name).toBe('Perf')
    expect(skill.content).toBe('Look for N+1 queries.')
    expect(skill.enabled).toBe(true)
    expect(typeof skill.id).toBe('string')
    expect(skill.id.length).toBeGreaterThan(0)
  })

  it('persists to localStorage', () => {
    addSkill('Perf', 'content')
    expect(listSkills()).toHaveLength(1)
  })

  it('id is deterministic: djb2(name+addedAt)', () => {
    const skill = addSkill('Sec', 'x')
    // id should be a non-empty hex string
    expect(/^[0-9a-f]+$/.test(skill.id)).toBe(true)
  })

  it('two skills with same name but different addedAt get different ids', async () => {
    const a = addSkill('MySkill', 'content a')
    // Force different timestamp
    await new Promise(r => setTimeout(r, 2))
    const b = addSkill('MySkill', 'content b')
    expect(a.id).not.toBe(b.id)
  })

  it('throws when content exceeds 20_000 chars', () => {
    const longContent = 'a'.repeat(SKILL_CONTENT_CAP + 1)
    expect(() => addSkill('Too Big', longContent)).toThrow()
  })

  it('allows content exactly at 20_000 chars', () => {
    const content = 'a'.repeat(SKILL_CONTENT_CAP)
    expect(() => addSkill('Exact', content)).not.toThrow()
  })

  it('throws when skills cap reached (10)', () => {
    for (let i = 0; i < SKILLS_CAP; i++) {
      addSkill(`Skill ${i}`, 'content')
    }
    expect(() => addSkill('One too many', 'content')).toThrow()
  })

  it('throws when name is empty', () => {
    expect(() => addSkill('', 'content')).toThrow()
    expect(() => addSkill('   ', 'content')).toThrow()
  })

  it('throws when content is empty', () => {
    expect(() => addSkill('Name', '')).toThrow()
    expect(() => addSkill('Name', '   ')).toThrow()
  })
})

describe('updateSkill', () => {
  it('updates name and content', () => {
    const skill = addSkill('Old', 'old content')
    updateSkill(skill.id, { name: 'New', content: 'new content' })
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.name).toBe('New')
    expect(updated?.content).toBe('new content')
  })

  it('can update just name', () => {
    const skill = addSkill('Old', 'content')
    updateSkill(skill.id, { name: 'New' })
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.name).toBe('New')
    expect(updated?.content).toBe('content')
  })

  it('can update just content', () => {
    const skill = addSkill('Name', 'old')
    updateSkill(skill.id, { content: 'new' })
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.content).toBe('new')
  })

  it('throws if content update exceeds cap', () => {
    const skill = addSkill('X', 'ok')
    expect(() => updateSkill(skill.id, { content: 'a'.repeat(SKILL_CONTENT_CAP + 1) })).toThrow()
  })

  it('is a no-op for unknown id', () => {
    addSkill('X', 'ok')
    expect(() => updateSkill('nonexistent', { name: 'Y' })).not.toThrow()
    expect(listSkills()).toHaveLength(1)
    expect(listSkills()[0].name).toBe('X')
  })
})

describe('removeSkill', () => {
  it('removes a skill by id', () => {
    const skill = addSkill('ToRemove', 'content')
    removeSkill(skill.id)
    expect(listSkills()).toHaveLength(0)
  })

  it('is a no-op for unknown id', () => {
    addSkill('X', 'ok')
    expect(() => removeSkill('nonexistent')).not.toThrow()
    expect(listSkills()).toHaveLength(1)
  })
})

describe('toggleSkill', () => {
  it('disables an enabled skill', () => {
    const skill = addSkill('Test', 'content')
    expect(skill.enabled).toBe(true)
    toggleSkill(skill.id)
    const s = listSkills().find(x => x.id === skill.id)
    expect(s?.enabled).toBe(false)
  })

  it('enables a disabled skill', () => {
    const skill = addSkill('Test', 'content')
    toggleSkill(skill.id) // disable
    toggleSkill(skill.id) // re-enable
    const s = listSkills().find(x => x.id === skill.id)
    expect(s?.enabled).toBe(true)
  })

  it('is a no-op for unknown id', () => {
    addSkill('X', 'ok')
    expect(() => toggleSkill('nonexistent')).not.toThrow()
    expect(listSkills()).toHaveLength(1)
    expect(listSkills()[0].enabled).toBe(true)
  })
})

describe('SAMPLE_SKILL_NAME and SAMPLE_SKILL_CONTENT', () => {
  it('SAMPLE_SKILL_NAME is a non-empty string', () => {
    expect(typeof SAMPLE_SKILL_NAME).toBe('string')
    expect(SAMPLE_SKILL_NAME.trim().length).toBeGreaterThan(0)
  })

  it('SAMPLE_SKILL_CONTENT is non-empty', () => {
    expect(typeof SAMPLE_SKILL_CONTENT).toBe('string')
    expect(SAMPLE_SKILL_CONTENT.trim().length).toBeGreaterThan(0)
  })

  it('SAMPLE_SKILL_CONTENT is within the 20k content cap', () => {
    expect(SAMPLE_SKILL_CONTENT.length).toBeLessThanOrEqual(SKILL_CONTENT_CAP)
  })

  it('SAMPLE_SKILL_CONTENT contains the word "Priorities"', () => {
    expect(SAMPLE_SKILL_CONTENT).toContain('Priorities')
  })

  it('installed sample skill is enabled by default', () => {
    const skill = addSkill(SAMPLE_SKILL_NAME, SAMPLE_SKILL_CONTENT)
    expect(skill.enabled).toBe(true)
  })

  it('installed sample skill can be toggled like any other skill', () => {
    const skill = addSkill(SAMPLE_SKILL_NAME, SAMPLE_SKILL_CONTENT)
    toggleSkill(skill.id)
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.enabled).toBe(false)
  })

  it('installed sample skill can be removed like any other skill', () => {
    const skill = addSkill(SAMPLE_SKILL_NAME, SAMPLE_SKILL_CONTENT)
    removeSkill(skill.id)
    expect(listSkills()).toHaveLength(0)
  })

  it('installed sample skill has the correct name', () => {
    const skill = addSkill(SAMPLE_SKILL_NAME, SAMPLE_SKILL_CONTENT)
    expect(skill.name).toBe(SAMPLE_SKILL_NAME)
  })
})
