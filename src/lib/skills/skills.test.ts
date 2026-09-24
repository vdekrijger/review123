/**
 * Tests for src/lib/skills/skills.ts — reviewer skill store
 *
 * Covers:
 *   - CRUD: list/add/update/remove/re-scope
 *   - Cap: max 25 skills (SKILLS_CAP)
 *   - Content cap: 20_000 chars max
 *   - Corrupt localStorage is tolerated
 *   - Shape validation on load
 *   - id is deterministic djb2(name+addedAt)
 *   - SAMPLE_SKILL_NAME / SAMPLE_SKILL_CONTENT exports
 *   - installed sample skill is enabled and behaves like any skill
 *   - PHASE SCOPE: the four states, the phase membership rule, and the silent
 *     migration off the released `enabled: boolean` shape
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  listSkills,
  listSkillsForPhase,
  addSkill,
  updateSkill,
  removeSkill,
  setSkillScope,
  setSkillPhase,
  scopeFromPhases,
  skillRunsIn,
  isSkillScope,
  scopedSkill,
  SKILL_SCOPES,
  DEFAULT_SKILL_SCOPE,
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

  it('ignores entries that carry neither a valid scope nor a legacy boolean', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'x', name: 'a', content: 'c', enabled: 'yes', addedAt: 1 },
      { id: 'y', name: 'b', content: 'c', scope: 'sometimes', addedAt: 1 },
    ]))
    expect(listSkills()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Phase scope + migration off the released boolean shape
// ---------------------------------------------------------------------------

describe('scope migration (records written by the released boolean version)', () => {
  it('enabled:true migrates to scope "both" — the reviewer keeps running everywhere', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'a', name: 'Security', content: 'check for XSS', enabled: true, addedAt: 1700000000000 },
    ]))
    const [skill] = listSkills()
    expect(skill.scope).toBe('both')
    expect(skill.enabled).toBe(true)
  })

  it('enabled:false migrates to scope "off"', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'a', name: 'Security', content: 'check for XSS', enabled: false, addedAt: 1700000000000 },
    ]))
    const [skill] = listSkills()
    expect(skill.scope).toBe('off')
    expect(skill.enabled).toBe(false)
  })

  it('migrates a whole released-shape store — custom skills included — losing nothing', () => {
    // Byte-for-byte what the CURRENT released version writes: no `scope` key
    // anywhere, a mix of enabled/disabled, and a skill the user wrote.
    const released = [
      { id: '1a2b', name: 'Security Reviewer (OWASP-minded)', content: '# Security\n...', enabled: true, addedAt: 1700000000000 },
      { id: '3c4d', name: 'Resiliency & SRE Reviewer', content: '# SRE\n...', enabled: true, addedAt: 1700000000001 },
      { id: '5e6f', name: 'My own house-style reviewer', content: 'we never use barrel files', enabled: false, addedAt: 1700000000002 },
    ]
    localStorage.setItem(SKILLS_KEY, JSON.stringify(released))

    const skills = listSkills()
    expect(skills).toHaveLength(3)
    // Nothing is dropped, renamed, reordered or reset.
    expect(skills.map((s) => s.id)).toEqual(['1a2b', '3c4d', '5e6f'])
    expect(skills.map((s) => s.name)).toEqual(released.map((r) => r.name))
    expect(skills.map((s) => s.content)).toEqual(released.map((r) => r.content))
    expect(skills.map((s) => s.addedAt)).toEqual(released.map((r) => r.addedAt))
    expect(skills.map((s) => s.scope)).toEqual(['both', 'both', 'off'])
  })

  it('migration is read-only: listSkills() does not rewrite localStorage', () => {
    const released = JSON.stringify([
      { id: 'a', name: 'S', content: 'c', enabled: true, addedAt: 1 },
    ])
    localStorage.setItem(SKILLS_KEY, released)
    listSkills()
    expect(localStorage.getItem(SKILLS_KEY)).toBe(released)
  })

  it('the new shape persists on the next ordinary mutation', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'a', name: 'S', content: 'c', enabled: true, addedAt: 1 },
    ]))
    setSkillScope('a', 'tests')
    const stored = JSON.parse(localStorage.getItem(SKILLS_KEY)!)
    expect(stored[0].scope).toBe('tests')
  })

  it('a stored `scope` wins over a stale `enabled`, so the mirror can never drift', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      // A contradiction another tab / an older build / a hand edit could leave.
      { id: 'a', name: 'S', content: 'c', scope: 'off', enabled: true, addedAt: 1 },
      { id: 'b', name: 'T', content: 'c', scope: 'both', enabled: false, addedAt: 2 },
    ]))
    const [off, both] = listSkills()
    expect(off.enabled).toBe(false)
    expect(both.enabled).toBe(true)
  })

  it('a record with a scope and no enabled key at all loads fine', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'a', name: 'S', content: 'c', scope: 'implementation', addedAt: 1 },
    ]))
    expect(listSkills()[0].scope).toBe('implementation')
  })
})

describe('scope helpers', () => {
  it('SKILL_SCOPES lists all four states', () => {
    expect([...SKILL_SCOPES]).toEqual(['both', 'implementation', 'tests', 'off'])
  })

  it('DEFAULT_SKILL_SCOPE is "both" — we never guess a phase for a user-written skill', () => {
    expect(DEFAULT_SKILL_SCOPE).toBe('both')
  })

  it('isSkillScope accepts the four scopes and rejects anything else', () => {
    for (const scope of SKILL_SCOPES) expect(isSkillScope(scope)).toBe(true)
    for (const bad of ['', 'BOTH', 'impl', null, undefined, 1, {}]) {
      expect(isSkillScope(bad)).toBe(false)
    }
  })

  it('scopedSkill pins enabled to scope', () => {
    const identity = { id: 'a', name: 'n', content: 'c', addedAt: 1 }
    expect(scopedSkill(identity, 'both').enabled).toBe(true)
    expect(scopedSkill(identity, 'implementation').enabled).toBe(true)
    expect(scopedSkill(identity, 'tests').enabled).toBe(true)
    expect(scopedSkill(identity, 'off').enabled).toBe(false)
  })

  it('skillRunsIn implements the membership rule for all 4x2 combinations', () => {
    const identity = { id: 'a', name: 'n', content: 'c', addedAt: 1 }
    const table: [Parameters<typeof scopedSkill>[1], boolean, boolean][] = [
      ['both', true, true],
      ['implementation', true, false],
      ['tests', false, true],
      ['off', false, false],
    ]
    for (const [scope, impl, tests] of table) {
      const skill = scopedSkill(identity, scope)
      expect(skillRunsIn(skill, 'implementation'), scope).toBe(impl)
      expect(skillRunsIn(skill, 'tests'), scope).toBe(tests)
    }
  })

  it('scopeFromPhases maps the four checkbox combinations onto the four scopes', () => {
    expect(scopeFromPhases(true, true)).toBe('both')
    expect(scopeFromPhases(true, false)).toBe('implementation')
    expect(scopeFromPhases(false, true)).toBe('tests')
    expect(scopeFromPhases(false, false)).toBe('off')
  })
})

describe('listSkillsForPhase', () => {
  it('returns only the reviewers scoped to that phase', () => {
    const both = addSkill('Both', 'c', 'both')
    const impl = addSkill('Impl', 'c', 'implementation')
    const tests = addSkill('Tests', 'c', 'tests')
    addSkill('Off', 'c', 'off')

    expect(listSkillsForPhase('implementation').map((s) => s.id)).toEqual([both.id, impl.id])
    expect(listSkillsForPhase('tests').map((s) => s.id)).toEqual([both.id, tests.id])
  })

  it('an off skill appears in NEITHER phase', () => {
    addSkill('Off', 'c', 'off')
    expect(listSkillsForPhase('implementation')).toEqual([])
    expect(listSkillsForPhase('tests')).toEqual([])
  })

  it('preserves the stored order', () => {
    addSkill('A', 'c', 'both')
    addSkill('B', 'c', 'both')
    addSkill('C', 'c', 'both')
    expect(listSkillsForPhase('implementation').map((s) => s.name)).toEqual(['A', 'B', 'C'])
  })

  it('migrated legacy records are visible in both phases (enabled:true → both)', () => {
    localStorage.setItem(SKILLS_KEY, JSON.stringify([
      { id: 'a', name: 'Legacy', content: 'c', enabled: true, addedAt: 1 },
    ]))
    expect(listSkillsForPhase('implementation')).toHaveLength(1)
    expect(listSkillsForPhase('tests')).toHaveLength(1)
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

  it('throws when skills cap reached (SKILLS_CAP)', () => {
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

  it('defaults to scope "both" — a skill the USER wrote gets no phase guessed for it', () => {
    const skill = addSkill('My own reviewer', 'house style')
    expect(skill.scope).toBe('both')
    expect(skill.enabled).toBe(true)
  })

  it('accepts an explicit scope (what the built-in library passes)', () => {
    expect(addSkill('A', 'c', 'implementation').scope).toBe('implementation')
    expect(addSkill('B', 'c', 'tests').scope).toBe('tests')
    const off = addSkill('C', 'c', 'off')
    expect(off.scope).toBe('off')
    expect(off.enabled).toBe(false)
  })

  it('persists the scope it was given', () => {
    const skill = addSkill('A', 'c', 'tests')
    expect(listSkills().find(s => s.id === skill.id)?.scope).toBe('tests')
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

  it('preserves the scope — editing the persona never silently re-enables it', () => {
    const skill = addSkill('X', 'ok', 'tests')
    updateSkill(skill.id, { name: 'Y', content: 'new' })
    expect(listSkills()[0].scope).toBe('tests')
  })

  it('preserves an OFF scope across an edit', () => {
    const skill = addSkill('X', 'ok', 'off')
    updateSkill(skill.id, { content: 'new' })
    expect(listSkills()[0].scope).toBe('off')
    expect(listSkills()[0].enabled).toBe(false)
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

describe('setSkillScope', () => {
  it('sets each of the four scopes', () => {
    const skill = addSkill('Test', 'content')
    for (const scope of SKILL_SCOPES) {
      setSkillScope(skill.id, scope)
      expect(listSkills().find(x => x.id === skill.id)?.scope).toBe(scope)
    }
  })

  it('scoping off sets the derived enabled mirror to false', () => {
    const skill = addSkill('Test', 'content')
    expect(skill.enabled).toBe(true)
    setSkillScope(skill.id, 'off')
    expect(listSkills().find(x => x.id === skill.id)?.enabled).toBe(false)
  })

  it('scoping back on from off restores the exact scope asked for — nothing is guessed', () => {
    const skill = addSkill('Test', 'content')
    setSkillScope(skill.id, 'off')
    setSkillScope(skill.id, 'tests')
    expect(listSkills().find(x => x.id === skill.id)?.scope).toBe('tests')
  })

  it('leaves name, content, id and addedAt untouched', () => {
    const skill = addSkill('Test', 'content')
    setSkillScope(skill.id, 'implementation')
    const after = listSkills().find(x => x.id === skill.id)!
    expect(after.name).toBe('Test')
    expect(after.content).toBe('content')
    expect(after.addedAt).toBe(skill.addedAt)
  })

  it('is a no-op for unknown id', () => {
    addSkill('X', 'ok')
    expect(() => setSkillScope('nonexistent', 'off')).not.toThrow()
    expect(listSkills()).toHaveLength(1)
    expect(listSkills()[0].scope).toBe('both')
  })
})

describe('setSkillPhase', () => {
  it('turning one phase off leaves the other alone', () => {
    const skill = addSkill('Test', 'content', 'both')
    setSkillPhase(skill.id, 'tests', false)
    expect(listSkills()[0].scope).toBe('implementation')
  })

  it('clearing BOTH phases lands on off', () => {
    const skill = addSkill('Test', 'content', 'both')
    setSkillPhase(skill.id, 'tests', false)
    setSkillPhase(skill.id, 'implementation', false)
    expect(listSkills()[0].scope).toBe('off')
    expect(listSkills()[0].enabled).toBe(false)
  })

  it('checking a phase on an off skill scopes it to exactly that phase', () => {
    const skill = addSkill('Test', 'content', 'off')
    setSkillPhase(skill.id, 'tests', true)
    expect(listSkills()[0].scope).toBe('tests')
  })

  it('checking the second phase lands on both', () => {
    const skill = addSkill('Test', 'content', 'implementation')
    setSkillPhase(skill.id, 'tests', true)
    expect(listSkills()[0].scope).toBe('both')
  })

  it('is a no-op for unknown id', () => {
    addSkill('X', 'ok')
    expect(() => setSkillPhase('nonexistent', 'tests', false)).not.toThrow()
    expect(listSkills()[0].scope).toBe('both')
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

  it('installed sample skill can be re-scoped like any other skill', () => {
    const skill = addSkill(SAMPLE_SKILL_NAME, SAMPLE_SKILL_CONTENT)
    setSkillScope(skill.id, 'off')
    const updated = listSkills().find(s => s.id === skill.id)
    expect(updated?.enabled).toBe(false)
    expect(updated?.scope).toBe('off')
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
