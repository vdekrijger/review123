/**
 * Tests for SettingsPanel "Reviewer skills" section
 *
 * Covers:
 *   - Section appears with heading "Reviewer skills"
 *   - Empty state when no skills
 *   - Lists existing skills with name and toggle
 *   - Delete button removes a skill from localStorage
 *   - "Add skill" button expands name + textarea
 *   - Save validates: empty name → error, empty content → error
 *   - Save with valid data persists skill and collapses form
 *   - Content cap validation error shown when content exceeds 20_000 chars
 *   - Cap validation: 10 skills → save button disabled or shows error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPanel from './SettingsPanel.svelte'
import { addSkill, listSkills, removeSkill, SKILLS_CAP, SKILL_CONTENT_CAP } from '../lib/skills/skills'
import { SAMPLE_SKILL_NAME } from '../lib/skills/sampleSkill'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'

vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
})

describe('SettingsPanel — Reviewer skills section', () => {
  it('shows a "Reviewer skills" heading', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(screen.getByText(/reviewer skills/i)).toBeInTheDocument()
  })

  it('shows no skills when none are stored', () => {
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    // No skill items should be present
    expect(document.querySelectorAll('.skill-item')).toHaveLength(0)
  })

  it('lists stored skills with their names', () => {
    addSkill('My Custom Security Reviewer', 'check for XSS')
    addSkill('My Custom Performance Reviewer', 'check for N+1')
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    expect(screen.getByText('My Custom Security Reviewer')).toBeInTheDocument()
    expect(screen.getByText('My Custom Performance Reviewer')).toBeInTheDocument()
  })

  it('shows enabled toggle for each skill', () => {
    addSkill('Security', 'content')
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    // Should have a checkbox or toggle for the skill
    const toggles = document.querySelectorAll('.skill-item input[type="checkbox"]')
    expect(toggles).toHaveLength(1)
    expect((toggles[0] as HTMLInputElement).checked).toBe(true)
  })

  it('toggling a skill checkbox changes its enabled state in localStorage', async () => {
    addSkill('Security', 'content')
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const toggle = document.querySelector('.skill-item input[type="checkbox"]') as HTMLInputElement
    await userEvent.click(toggle)
    const skills = listSkills()
    expect(skills[0].enabled).toBe(false)
  })

  it('delete button removes the skill from localStorage', async () => {
    addSkill('Security', 'content')
    render(SettingsPanel, { props: { onclose: vi.fn() } })
    const deleteBtn = screen.getByRole('button', { name: /delete|remove/i })
    await userEvent.click(deleteBtn)
    expect(listSkills()).toHaveLength(0)
    expect(screen.queryByText('Security')).not.toBeInTheDocument()
  })

  describe('Add skill form', () => {
    it('shows an "Add skill" button', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      expect(screen.getByRole('button', { name: /add skill/i })).toBeInTheDocument()
    })

    it('clicking "Add skill" reveals name input and textarea', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      expect(screen.getByPlaceholderText(/skill name|name/i)).toBeInTheDocument()
      expect(document.querySelector('textarea')).toBeInTheDocument()
    })

    it('saving with empty name shows validation error', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      // Leave name empty, fill content
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      await userEvent.type(textarea, 'some content')
      // Click the "Save skill" button (inside the skill form, not the main settings Save)
      await userEvent.click(screen.getByRole('button', { name: /save skill/i }))
      // Should show an error about name
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(listSkills()).toHaveLength(0)
    })

    it('saving with empty content shows validation error', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      const nameInput = screen.getByPlaceholderText(/skill name|name/i)
      await userEvent.type(nameInput, 'My Skill')
      // Leave content empty
      await userEvent.click(screen.getByRole('button', { name: /save skill/i }))
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(listSkills()).toHaveLength(0)
    })

    it('saving with valid name and content persists the skill', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
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
      render(SettingsPanel, { props: { onclose: vi.fn() } })
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
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      const nameInput = screen.getByPlaceholderText(/skill name|name/i)
      await userEvent.type(nameInput, 'Big Skill')
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      // Set value directly for performance (avoid typing 20_001 chars)
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
      // Pre-seed 10 skills
      for (let i = 0; i < SKILLS_CAP; i++) {
        addSkill(`Skill ${i}`, 'content')
      }
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      // Either the add button is disabled or absent
      const addBtn = screen.queryByRole('button', { name: /add skill/i })
      if (addBtn) {
        expect((addBtn as HTMLButtonElement).disabled).toBe(true)
      } else {
        // Acceptable: button hidden at cap
        expect(addBtn).toBeNull()
      }
    })
  })

  describe('pragmatic sample skill via built-in library', () => {
    // The sample skill is now the "pragmatic" entry in the Built-in reviewers library.
    // Its Add button is aria-label="Add Pragmatic Senior Reviewer (sample)".
    const escapedSampleName = SAMPLE_SKILL_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const addPragmaticRegex = new RegExp(`add ${escapedSampleName}`, 'i')

    it('shows an [Add] button for the pragmatic skill when not installed', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      expect(screen.getByRole('button', { name: addPragmaticRegex })).toBeInTheDocument()
    })

    it('clicking [Add] for pragmatic installs the sample skill and hides its button', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      const btn = screen.getByRole('button', { name: addPragmaticRegex })
      await userEvent.click(btn)
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: addPragmaticRegex })).not.toBeInTheDocument()
      })
      expect(listSkills().some(s => s.name === SAMPLE_SKILL_NAME)).toBe(true)
    })

    it('installed pragmatic skill is enabled', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('button', { name: addPragmaticRegex }))
      await waitFor(() => {
        const skills = listSkills()
        const sample = skills.find(s => s.name === SAMPLE_SKILL_NAME)
        expect(sample).toBeDefined()
        expect(sample?.enabled).toBe(true)
      })
    })

    it('pragmatic skill name appears in the installed skills list after install', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      await userEvent.click(screen.getByRole('button', { name: addPragmaticRegex }))
      await waitFor(() => {
        // Skill name appears in the .skill-name list (installed skills section)
        const nameEls = document.querySelectorAll('.skill-name')
        const found = Array.from(nameEls).some(el => el.textContent?.includes(SAMPLE_SKILL_NAME))
        expect(found).toBe(true)
      })
    })

    it('[Add] button for pragmatic reappears after the sample skill is deleted', async () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      // Install it
      await userEvent.click(screen.getByRole('button', { name: addPragmaticRegex }))
      await waitFor(() => {
        const nameEls = document.querySelectorAll('.skill-name')
        expect(Array.from(nameEls).some(el => el.textContent?.includes(SAMPLE_SKILL_NAME))).toBe(true)
      })
      // Delete it
      const deleteBtn = screen.getByRole('button', { name: new RegExp(`delete ${escapedSampleName}`, 'i') })
      await userEvent.click(deleteBtn)
      // Add button should reappear in the built-in list
      await waitFor(() => {
        expect(screen.getByRole('button', { name: addPragmaticRegex })).toBeInTheDocument()
      })
    })

    it('[Add] button for pragmatic is absent when the sample skill was pre-seeded', () => {
      addSkill(SAMPLE_SKILL_NAME, 'some content')
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      expect(screen.queryByRole('button', { name: addPragmaticRegex })).not.toBeInTheDocument()
    })

    it('shows the pragmatic tagline in the built-in library', () => {
      render(SettingsPanel, { props: { onclose: vi.fn() } })
      expect(screen.getByText(/Correctness, intent, hygiene/i)).toBeInTheDocument()
    })
  })
})
