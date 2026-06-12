/**
 * SkillsSection.test.ts
 *
 * Tests for the Reviewer skills settings section component.
 * These replace the skills-related tests from SettingsPanel.skills.test.ts
 * and SettingsPanel.builtins.test.ts, retargeted to the decomposed section component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SkillsSection from './SkillsSection.svelte'
import { addSkill, listSkills, SKILLS_CAP, SKILL_CONTENT_CAP } from '../../lib/skills/skills'
import { BUILTIN_SKILLS } from '../../lib/skills/builtinSkills'
import { SAMPLE_SKILL_NAME } from '../../lib/skills/sampleSkill'
import { _resetAuthStateForTest } from '../../lib/auth/authState.svelte'
import { saveTokens } from '../../lib/settings/settings'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
})

describe('SkillsSection — Reviewer skills section', () => {
  it('shows a "Reviewer skills" heading', () => {
    render(SkillsSection)
    expect(screen.getByText(/reviewer skills/i)).toBeInTheDocument()
  })

  it('shows no skills when none are stored', () => {
    render(SkillsSection)
    expect(document.querySelectorAll('.skill-item')).toHaveLength(0)
  })

  it('lists stored skills with their names', () => {
    addSkill('My Custom Security Reviewer', 'check for XSS')
    addSkill('My Custom Performance Reviewer', 'check for N+1')
    render(SkillsSection)
    expect(screen.getByText('My Custom Security Reviewer')).toBeInTheDocument()
    expect(screen.getByText('My Custom Performance Reviewer')).toBeInTheDocument()
  })

  it('shows enabled toggle for each skill', () => {
    addSkill('Security', 'content')
    render(SkillsSection)
    const toggles = document.querySelectorAll('.skill-item input[type="checkbox"]')
    expect(toggles).toHaveLength(1)
    expect((toggles[0] as HTMLInputElement).checked).toBe(true)
  })

  it('toggling a skill checkbox changes its enabled state in localStorage', async () => {
    addSkill('Security', 'content')
    render(SkillsSection)
    const toggle = document.querySelector('.skill-item input[type="checkbox"]') as HTMLInputElement
    await userEvent.click(toggle)
    const skills = listSkills()
    expect(skills[0].enabled).toBe(false)
  })

  it('delete button removes the skill from localStorage', async () => {
    addSkill('Security', 'content')
    render(SkillsSection)
    const deleteBtn = screen.getByRole('button', { name: /delete|remove/i })
    await userEvent.click(deleteBtn)
    expect(listSkills()).toHaveLength(0)
    expect(screen.queryByText('Security')).not.toBeInTheDocument()
  })

  describe('Add skill form', () => {
    it('shows an "Add skill" button', () => {
      render(SkillsSection)
      expect(screen.getByRole('button', { name: /add skill/i })).toBeInTheDocument()
    })

    it('clicking "Add skill" reveals name input and textarea', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      expect(screen.getByPlaceholderText(/skill name|name/i)).toBeInTheDocument()
      expect(document.querySelector('textarea')).toBeInTheDocument()
    })

    it('saving with empty name shows validation error', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      await userEvent.type(textarea, 'some content')
      await userEvent.click(screen.getByRole('button', { name: /save skill/i }))
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(listSkills()).toHaveLength(0)
    })

    it('saving with empty content shows validation error', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      const nameInput = screen.getByPlaceholderText(/skill name|name/i)
      await userEvent.type(nameInput, 'My Skill')
      await userEvent.click(screen.getByRole('button', { name: /save skill/i }))
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(listSkills()).toHaveLength(0)
    })

    it('saving with valid name and content persists the skill', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      const nameInput = screen.getByPlaceholderText(/skill name|name/i)
      await userEvent.type(nameInput, 'Security Reviewer')
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      await userEvent.type(textarea, 'Check for XSS vulnerabilities.')
      await userEvent.click(screen.getByRole('button', { name: /save skill/i }))
      await waitFor(() => {
        expect(listSkills()).toHaveLength(1)
        expect(listSkills()[0].name).toBe('Security Reviewer')
      })
    })

    it('saved skill name appears in the list', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      const nameInput = screen.getByPlaceholderText(/skill name|name/i)
      await userEvent.type(nameInput, 'Perf Reviewer')
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      await userEvent.type(textarea, 'Check for performance issues.')
      await userEvent.click(screen.getByRole('button', { name: /save skill/i }))
      await waitFor(() => {
        expect(screen.getByText('Perf Reviewer')).toBeInTheDocument()
      })
    })

    it('shows error when content exceeds 20_000 chars', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      const nameInput = screen.getByPlaceholderText(/skill name|name/i)
      await userEvent.type(nameInput, 'Big Skill')
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      await userEvent.clear(textarea)
      Object.defineProperty(textarea, 'value', {
        value: 'a'.repeat(SKILL_CONTENT_CAP + 1),
        writable: true,
        configurable: true,
      })
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await userEvent.click(screen.getByRole('button', { name: /save skill/i }))
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(listSkills()).toHaveLength(0)
    })

    it('add button is disabled or shows error when cap (10) reached', () => {
      for (let i = 0; i < SKILLS_CAP; i++) {
        addSkill(`Skill ${i}`, 'content')
      }
      render(SkillsSection)
      const addBtn = screen.queryByRole('button', { name: /add skill/i })
      if (addBtn) {
        expect((addBtn as HTMLButtonElement).disabled).toBe(true)
      } else {
        expect(addBtn).toBeNull()
      }
    })
  })

  describe('pragmatic sample skill via built-in library', () => {
    const escapedSampleName = SAMPLE_SKILL_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const addPragmaticRegex = new RegExp(`add ${escapedSampleName}`, 'i')

    it('shows an [Add] button for the pragmatic skill when not installed', () => {
      render(SkillsSection)
      expect(screen.getByRole('button', { name: addPragmaticRegex })).toBeInTheDocument()
    })

    it('clicking [Add] for pragmatic installs the sample skill and hides its button', async () => {
      render(SkillsSection)
      const btn = screen.getByRole('button', { name: addPragmaticRegex })
      await userEvent.click(btn)
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: addPragmaticRegex })).not.toBeInTheDocument()
      })
      expect(listSkills().some(s => s.name === SAMPLE_SKILL_NAME)).toBe(true)
    })

    it('installed pragmatic skill is enabled', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: addPragmaticRegex }))
      await waitFor(() => {
        const skills = listSkills()
        const sample = skills.find(s => s.name === SAMPLE_SKILL_NAME)
        expect(sample).toBeDefined()
        expect(sample?.enabled).toBe(true)
      })
    })

    it('pragmatic skill name appears in the installed skills list after install', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: addPragmaticRegex }))
      await waitFor(() => {
        const nameEls = document.querySelectorAll('.skill-name')
        const found = Array.from(nameEls).some(el => el.textContent?.includes(SAMPLE_SKILL_NAME))
        expect(found).toBe(true)
      })
    })

    it('[Add] button for pragmatic reappears after the sample skill is deleted', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: addPragmaticRegex }))
      await waitFor(() => {
        const nameEls = document.querySelectorAll('.skill-name')
        expect(Array.from(nameEls).some(el => el.textContent?.includes(SAMPLE_SKILL_NAME))).toBe(true)
      })
      const deleteBtn = screen.getByRole('button', { name: new RegExp(`delete ${escapedSampleName}`, 'i') })
      await userEvent.click(deleteBtn)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: addPragmaticRegex })).toBeInTheDocument()
      })
    })

    it('[Add] button for pragmatic is absent when the sample skill was pre-seeded', () => {
      addSkill(SAMPLE_SKILL_NAME, 'some content')
      render(SkillsSection)
      expect(screen.queryByRole('button', { name: addPragmaticRegex })).not.toBeInTheDocument()
    })

    it('shows the pragmatic tagline in the built-in library', () => {
      render(SkillsSection)
      expect(screen.getByText(/Correctness, intent, hygiene/i)).toBeInTheDocument()
    })
  })
})

describe('SkillsSection — Built-in reviewers group', () => {
  it('renders a "Built-in reviewers" heading', () => {
    render(SkillsSection)
    expect(screen.getByText(/built-in reviewers/i)).toBeInTheDocument()
  })

  it('renders exactly 6 builtin entries', () => {
    render(SkillsSection)
    const entries = document.querySelectorAll('[data-builtin-id]')
    expect(entries).toHaveLength(6)
  })

  it('renders each builtin skill name', () => {
    render(SkillsSection)
    for (const skill of BUILTIN_SKILLS) {
      expect(screen.getByText(skill.name)).toBeInTheDocument()
    }
  })

  it('renders each builtin skill tagline', () => {
    render(SkillsSection)
    for (const skill of BUILTIN_SKILLS) {
      expect(screen.getByText(skill.tagline)).toBeInTheDocument()
    }
  })

  it('renders an [Add] button for each builtin skill when none installed', () => {
    render(SkillsSection)
    for (const skill of BUILTIN_SKILLS) {
      const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(skill.name)}`, 'i') })
      expect(btn).toBeInTheDocument()
    }
  })

  it('clicking [Add] installs the skill into localStorage', async () => {
    render(SkillsSection)
    const securitySkill = BUILTIN_SKILLS.find((s) => s.name === 'Security Reviewer (OWASP-minded)')!
    const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(securitySkill.name)}`, 'i') })
    await userEvent.click(btn)
    await waitFor(() => {
      expect(listSkills().some((s) => s.name === securitySkill.name)).toBe(true)
    })
  })

  it('installed skill is enabled after clicking [Add]', async () => {
    render(SkillsSection)
    const archSkill = BUILTIN_SKILLS.find((s) => s.name === 'Architecture & Design Reviewer')!
    const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(archSkill.name)}`, 'i') })
    await userEvent.click(btn)
    await waitFor(() => {
      const installed = listSkills().find((s) => s.name === archSkill.name)
      expect(installed?.enabled).toBe(true)
    })
  })

  it('[Add] button is hidden after the skill is installed', async () => {
    render(SkillsSection)
    const perfSkill = BUILTIN_SKILLS.find((s) => s.name === 'Performance Reviewer')!
    const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(perfSkill.name)}`, 'i') })
    await userEvent.click(btn)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: new RegExp(`add ${escapeRegex(perfSkill.name)}`, 'i') })).not.toBeInTheDocument()
    })
  })

  it('[Add] button is absent when the skill was pre-seeded', () => {
    const uxSkill = BUILTIN_SKILLS.find((s) => s.name === 'UX & Interaction Reviewer')!
    addSkill(uxSkill.name, uxSkill.content)
    render(SkillsSection)
    expect(screen.queryByRole('button', { name: new RegExp(`add ${escapeRegex(uxSkill.name)}`, 'i') })).not.toBeInTheDocument()
  })

  it('[Add] button is disabled when at SKILLS_CAP', () => {
    for (let i = 0; i < SKILLS_CAP; i++) {
      addSkill(`Skill ${i}`, 'content')
    }
    render(SkillsSection)
    const sreSkill = BUILTIN_SKILLS.find((s) => s.name === 'Resiliency & SRE Reviewer')!
    const btn = screen.queryByRole('button', { name: new RegExp(`add ${escapeRegex(sreSkill.name)}`, 'i') })
    if (btn) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('installed skill appears in the reviewer skills list', async () => {
    render(SkillsSection)
    const secSkill = BUILTIN_SKILLS.find((s) => s.name === 'Security Reviewer (OWASP-minded)')!
    const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(secSkill.name)}`, 'i') })
    await userEvent.click(btn)
    await waitFor(() => {
      const nameEls = document.querySelectorAll('.skill-name')
      const found = Array.from(nameEls).some((el) => el.textContent?.includes(secSkill.name))
      expect(found).toBe(true)
    })
  })

  it('builtin skill content is under 20_000 chars, non-empty, contains Priorities or Discipline', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content.trim().length).toBeGreaterThan(0)
      expect(skill.content.length).toBeLessThan(20_000)
      const hasPriorities = skill.content.includes('Priorities')
      const hasDiscipline = skill.content.includes('Discipline')
      expect(hasPriorities || hasDiscipline).toBe(true)
    }
  })
})

describe('SkillsSection — mine-skill gate copy', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetAuthStateForTest()
  })

  it('mine-gate hint says "from the top bar" not "(above)"', async () => {
    saveTokens({ deepseekKey: 'sk-test' })
    render(SkillsSection)
    const hint = screen.getByText(/sign in with github from the top bar to use this feature/i)
    expect(hint).toBeInTheDocument()
    expect(screen.queryByText(/sign in with github \(above\)/i)).not.toBeInTheDocument()
  })
})
