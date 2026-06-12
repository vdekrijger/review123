/**
 * Tests for SettingsPanel "Built-in reviewers" group
 *
 * Covers:
 *   - Built-in reviewers group renders all 6 entries (5 curated + pragmatic)
 *   - Each entry shows name + tagline
 *   - Each entry shows an [Add] button
 *   - [Add] installs the skill (addable)
 *   - [Add] is hidden when a skill with that name already exists in localStorage (hides-after-add)
 *   - [Add] is disabled when at SKILLS_CAP (cap behavior)
 *   - Content sanity: < 20_000 chars, non-empty, contains 'Priorities' or 'Discipline'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPanel from './SettingsPanel.svelte'
import { addSkill, listSkills, SKILLS_CAP } from '../lib/skills/skills'
import { BUILTIN_SKILLS } from '../lib/skills/builtinSkills'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
})

describe('SettingsPanel — Built-in reviewers group', () => {
  it('renders a "Built-in reviewers" heading', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(screen.getByText(/built-in reviewers/i)).toBeInTheDocument()
  })

  it('renders exactly 6 builtin entries', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    // Each builtin entry has a data-builtin-id attribute
    const entries = document.querySelectorAll('[data-builtin-id]')
    expect(entries).toHaveLength(6)
  })

  it('renders each builtin skill name', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    for (const skill of BUILTIN_SKILLS) {
      expect(screen.getByText(skill.name)).toBeInTheDocument()
    }
  })

  it('renders each builtin skill tagline', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    for (const skill of BUILTIN_SKILLS) {
      expect(screen.getByText(skill.tagline)).toBeInTheDocument()
    }
  })

  it('renders an [Add] button for each builtin skill when none installed', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    for (const skill of BUILTIN_SKILLS) {
      const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(skill.name)}`, 'i') })
      expect(btn).toBeInTheDocument()
    }
  })

  it('clicking [Add] installs the skill into localStorage', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const securitySkill = BUILTIN_SKILLS.find((s) => s.name === 'Security Reviewer (OWASP-minded)')!
    const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(securitySkill.name)}`, 'i') })
    await userEvent.click(btn)
    await waitFor(() => {
      expect(listSkills().some((s) => s.name === securitySkill.name)).toBe(true)
    })
  })

  it('installed skill is enabled after clicking [Add]', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const archSkill = BUILTIN_SKILLS.find((s) => s.name === 'Architecture & Design Reviewer')!
    const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(archSkill.name)}`, 'i') })
    await userEvent.click(btn)
    await waitFor(() => {
      const installed = listSkills().find((s) => s.name === archSkill.name)
      expect(installed?.enabled).toBe(true)
    })
  })

  it('[Add] button is hidden after the skill is installed', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
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
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(screen.queryByRole('button', { name: new RegExp(`add ${escapeRegex(uxSkill.name)}`, 'i') })).not.toBeInTheDocument()
  })

  it('[Add] button is disabled when at SKILLS_CAP', () => {
    // Pre-seed SKILLS_CAP skills
    for (let i = 0; i < SKILLS_CAP; i++) {
      addSkill(`Skill ${i}`, 'content')
    }
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    // All builtin Add buttons that are still visible should be disabled
    const sreSkill = BUILTIN_SKILLS.find((s) => s.name === 'Resiliency & SRE Reviewer')!
    const btn = screen.queryByRole('button', { name: new RegExp(`add ${escapeRegex(sreSkill.name)}`, 'i') })
    if (btn) {
      expect((btn as HTMLButtonElement).disabled).toBe(true)
    }
    // Otherwise acceptable: button is not present when cap is hit
  })

  it('installed skill appears in the reviewer skills list', async () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const secSkill = BUILTIN_SKILLS.find((s) => s.name === 'Security Reviewer (OWASP-minded)')!
    const btn = screen.getByRole('button', { name: new RegExp(`add ${escapeRegex(secSkill.name)}`, 'i') })
    await userEvent.click(btn)
    await waitFor(() => {
      // The name should appear in the skill-name class (the installed skills list)
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
