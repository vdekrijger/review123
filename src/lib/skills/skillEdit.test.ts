/**
 * Tests for the skill edit round-trip, validation, and cancel behaviour.
 *
 * These are pure-logic tests over updateSkill (the settings panel delegates
 * to updateSkill for the save action). The UI wiring is tested by the
 * Playwright suite; here we cover the contract that the panel relies on.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { addSkill, updateSkill, listSkills, SKILL_CONTENT_CAP } from './skills'

beforeEach(() => {
  localStorage.clear()
})

describe('skill edit round-trip', () => {
  it('updateSkill persists new name and content', () => {
    const skill = addSkill('Original Name', 'Original content')
    updateSkill(skill.id, { name: 'New Name', content: 'New content' })
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.name).toBe('New Name')
    expect(updated?.content).toBe('New content')
  })

  it('updateSkill can update name only (content unchanged)', () => {
    const skill = addSkill('Old', 'keep this')
    updateSkill(skill.id, { name: 'New' })
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.name).toBe('New')
    expect(updated?.content).toBe('keep this')
  })

  it('updateSkill can update content only (name unchanged)', () => {
    const skill = addSkill('Keep Name', 'old content')
    updateSkill(skill.id, { content: 'new content' })
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.name).toBe('Keep Name')
    expect(updated?.content).toBe('new content')
  })
})

describe('skill edit validation errors', () => {
  it('throws when updating with empty name', () => {
    const skill = addSkill('Name', 'content')
    expect(() => updateSkill(skill.id, { name: '' })).toThrow()
    expect(() => updateSkill(skill.id, { name: '   ' })).toThrow()
  })

  it('throws when updating with content exceeding cap', () => {
    const skill = addSkill('Name', 'content')
    expect(() => updateSkill(skill.id, { content: 'x'.repeat(SKILL_CONTENT_CAP + 1) })).toThrow()
  })

  it('error thrown does not corrupt stored skill', () => {
    const skill = addSkill('Intact', 'safe content')
    try {
      updateSkill(skill.id, { name: '' })
    } catch { /* expected */ }
    const s = listSkills().find(sk => sk.id === skill.id)
    expect(s?.name).toBe('Intact')
    expect(s?.content).toBe('safe content')
  })
})

describe('skill edit cancel (no-op path)', () => {
  it('calling updateSkill with unknown id does not throw and leaves list unchanged', () => {
    addSkill('ExistingSkill', 'content')
    expect(() => updateSkill('nonexistent-id', { name: 'X', content: 'Y' })).not.toThrow()
    expect(listSkills()).toHaveLength(1)
    expect(listSkills()[0].name).toBe('ExistingSkill')
  })

  it('enabled flag is preserved after a name/content update', () => {
    const skill = addSkill('Name', 'content')
    // The skill starts enabled; update should not touch enabled
    updateSkill(skill.id, { name: 'Updated Name' })
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.enabled).toBe(true)
  })
})
