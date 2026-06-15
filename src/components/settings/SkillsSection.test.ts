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
import { saveTokens, saveGithubAuth, setGitlabToken, setAiProvider } from '../../lib/settings/settings'
import { _resetSettingsStateForTest } from '../../lib/settings/settingsState.svelte'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
  _resetSettingsStateForTest()
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

    it('Save skill and Cancel buttons carry the themed .btn classes', async () => {
      render(SkillsSection)
      await userEvent.click(screen.getByRole('button', { name: /add skill/i }))
      const saveBtn = screen.getByRole('button', { name: /save skill/i })
      const cancelBtn = screen.getByRole('button', { name: /^cancel$/i })
      // Save = primary themed button
      expect(saveBtn).toHaveClass('btn')
      expect(saveBtn).toHaveClass('btn-primary')
      // Cancel = secondary themed button (themed .btn, not primary)
      expect(cancelBtn).toHaveClass('btn')
      expect(cancelBtn).not.toHaveClass('btn-primary')
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

  it('renders one entry per builtin skill', () => {
    render(SkillsSection)
    const entries = document.querySelectorAll('[data-builtin-id]')
    expect(entries).toHaveLength(BUILTIN_SKILLS.length)
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

// ---------------------------------------------------------------------------
// Account-wide mining UI — provider preselection + optional repo filter
// ---------------------------------------------------------------------------

describe('SkillsSection — account-wide mining UI', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetAuthStateForTest()
    saveTokens({ deepseekKey: 'sk-test' })
  })

  function providerSelect(): HTMLSelectElement {
    return document.querySelector('#mine-provider-select') as HTMLSelectElement
  }

  function analyzeButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /analyze my comments/i }) as HTMLButtonElement
  }

  it('preselects GitHub when only GitHub auth is configured', () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    expect(providerSelect().value).toBe('github')
  })

  it('preselects GitLab when only GitLab auth is configured', () => {
    setGitlabToken('glpat_test')
    render(SkillsSection)
    expect(providerSelect().value).toBe('gitlab')
  })

  it('offers a provider choice and preselects GitHub when both are configured', () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    setGitlabToken('glpat_test')
    render(SkillsSection)
    const select = providerSelect()
    expect(select.value).toBe('github')
    const enabledOptions = Array.from(select.options).filter(o => !o.disabled).map(o => o.value)
    expect(enabledOptions).toEqual(expect.arrayContaining(['github', 'gitlab']))
  })

  it('Bitbucket option is present but disabled (honest not-supported)', () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    const bitbucket = Array.from(providerSelect().options).find(o => o.value === 'bitbucket')
    expect(bitbucket).toBeDefined()
    expect(bitbucket!.disabled).toBe(true)
  })

  it('analyze button is enabled with an empty repo filter (account-wide default)', () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    const ownerInput = screen.getByLabelText(/repository owner/i) as HTMLInputElement
    const repoInput = screen.getByLabelText(/repository name/i) as HTMLInputElement
    expect(ownerInput.value).toBe('')
    expect(repoInput.value).toBe('')
    expect(analyzeButton().disabled).toBe(false)
  })

  it('analyze button is disabled when only one filter field is filled', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    const ownerInput = screen.getByLabelText(/repository owner/i)
    await userEvent.type(ownerInput, 'myorg')
    expect(analyzeButton().disabled).toBe(true)
  })

  it('analyze button is enabled again when both filter fields are filled', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    await userEvent.type(screen.getByLabelText(/repository owner/i), 'myorg')
    await userEvent.type(screen.getByLabelText(/repository name/i), 'myrepo')
    expect(analyzeButton().disabled).toBe(false)
  })

  it('repo filter is labelled optional', () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    expect(screen.getByText(/optional: limit to a single repository/i)).toBeInTheDocument()
  })

  it('shows GitLab sign-in guidance when GitLab is selected without auth', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    await userEvent.selectOptions(providerSelect(), 'gitlab')
    expect(screen.getByText(/add a gitlab token or sign in via oauth/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Provider-aware mine gate (user report: the gate copy read "DeepSeek" even
// with another provider active — it derived from a non-reactive getSettings()
// snapshot frozen at mount, which defaulted to DeepSeek).
// ---------------------------------------------------------------------------

describe('SkillsSection — provider-aware mine gate copy', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetAuthStateForTest()
    _resetSettingsStateForTest()
  })

  function gateHint(): HTMLElement | null {
    return document.querySelector('.mine-gate-hint')
  }

  it('names the active provider in the no-key hint and points at the AI models section (default DeepSeek)', () => {
    render(SkillsSection)
    expect(gateHint()).toHaveTextContent('Add an API key for DeepSeek (see AI models above) to use this feature.')
  })

  it('names Anthropic — not DeepSeek — when Anthropic is the active provider', () => {
    setAiProvider('anthropic')
    render(SkillsSection)
    expect(gateHint()).toHaveTextContent(/add an api key for anthropic/i)
    expect(gateHint()).not.toHaveTextContent(/deepseek/i)
  })

  it('ignores keys saved for NON-active providers (gates on the active one)', () => {
    setAiProvider('anthropic')
    saveTokens({ deepseekKey: 'sk-other-provider' })
    render(SkillsSection)
    expect(gateHint()).toHaveTextContent(/add an api key for anthropic/i)
  })

  it('reacts live: switching the active provider updates the hint without a remount', async () => {
    render(SkillsSection)
    expect(gateHint()).toHaveTextContent(/deepseek/i)
    setAiProvider('gemini')
    await waitFor(() => expect(gateHint()).toHaveTextContent(/add an api key for gemini/i))
  })

  it('reacts live: saving a key for the active provider unlocks mining without a remount', async () => {
    setAiProvider('gemini')
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    expect(gateHint()).toHaveTextContent(/add an api key for gemini/i)
    saveTokens({ geminiKey: 'AIza-now-configured' })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /analyze my comments/i })).toBeInTheDocument()
    })
    expect(document.body.textContent).not.toMatch(/add an api key for/i)
  })

  it('the privacy note names the active provider', () => {
    setAiProvider('openai')
    saveTokens({ openaiKey: 'sk-oa-x' })
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    render(SkillsSection)
    expect(screen.getByText(/your comments are sent to openai for analysis/i)).toBeInTheDocument()
  })
})
