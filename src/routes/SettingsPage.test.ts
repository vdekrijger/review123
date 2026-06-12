/**
 * SettingsPage.test.ts
 *
 * Tests for the dedicated /settings page route.
 * Verifies composition of section components and Back navigation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import SettingsPage from './SettingsPage.svelte'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'
import { navigate } from '../lib/router/router.svelte'

// Stub applyAppearance so tests don't need real DOM env for it
vi.mock('../lib/settings/appearance.svelte', () => ({
  applyAppearance: vi.fn(),
}))

// Stub navigate to avoid real history mutations in tests
vi.mock('../lib/router/router.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/router/router.svelte')>()
  return { ...actual, navigate: vi.fn() }
})

// Mock the IntersectionObserver seam (jsdom has none). pickActiveSection
// and isAtBottom stay real so observer-driven tests exercise the actual
// selection logic; tests capture the onChange callback to simulate the
// observer firing.
vi.mock('../lib/settings/scrollspy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/settings/scrollspy')>()
  return { ...actual, observeSections: vi.fn(() => vi.fn()) }
})

import { observeSections } from '../lib/settings/scrollspy'

beforeEach(() => {
  localStorage.clear()
  _resetAuthStateForTest()
  _resetSettingsStateForTest()
  sessionStorage.clear()
  vi.clearAllMocks()
})

/** Place a section's bounding rect at the given viewport-relative top. */
function stubSectionTop(id: string, top: number) {
  const el = document.getElementById(id)
  if (!el) throw new Error(`section #${id} not found`)
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top,
    bottom: top + 400,
    left: 0,
    right: 800,
    width: 800,
    height: 400,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect)
}

/** Grab the onChange callback the page registered with observeSections. */
function getObserverCallback(): () => void {
  const calls = vi.mocked(observeSections).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][1]
}

describe('SettingsPage', () => {
  it('renders the settings page heading', () => {
    render(SettingsPage)
    expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument()
  })

  it('renders a Back button', () => {
    render(SettingsPage)
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
  })

  it('renders the Appearance section', () => {
    render(SettingsPage)
    expect(screen.getByRole('region', { name: /appearance/i })).toBeInTheDocument()
  })

  it('renders the Providers & access section', () => {
    render(SettingsPage)
    expect(screen.getByRole('region', { name: /providers and access/i })).toBeInTheDocument()
  })

  it('renders the AI models section', () => {
    render(SettingsPage)
    expect(screen.getByRole('region', { name: /ai models/i })).toBeInTheDocument()
  })

  it('renders the Reviewer skills section', () => {
    render(SettingsPage)
    expect(screen.getByRole('region', { name: /reviewer skills/i })).toBeInTheDocument()
  })

  it('renders the section nav', () => {
    render(SettingsPage)
    expect(screen.getByRole('navigation', { name: /settings sections/i })).toBeInTheDocument()
  })

  it('Back button navigates to returnTo path from sessionStorage', async () => {
    sessionStorage.setItem('review123:settingsReturnTo', '/review/github/owner/repo/42')
    render(SettingsPage)
    const backBtn = screen.getByRole('button', { name: /back/i })
    await userEvent.click(backBtn)
    expect(navigate).toHaveBeenCalledWith('/review/github/owner/repo/42')
  })

  it('Back button navigates to / when no returnTo stored', async () => {
    render(SettingsPage)
    const backBtn = screen.getByRole('button', { name: /back/i })
    await userEvent.click(backBtn)
    expect(navigate).toHaveBeenCalledWith('/')
  })
})

describe('SettingsPage — save scope', () => {
  it('exactly ONE plain "Save" button exists on the page, inside the Providers section (no floating/global save)', () => {
    render(SettingsPage)
    const saveButtons = screen.getAllByRole('button', { name: /^save$/i })
    expect(saveButtons).toHaveLength(1)
    const providersSection = screen.getByRole('region', { name: /providers and access/i })
    expect(providersSection.contains(saveButtons[0])).toBe(true)
  })

  it('the Providers Save persists ONLY Providers edits — a pending AI key edit is not saved', async () => {
    render(SettingsPage)

    // Edit a field in the AI models section (do NOT save it)
    await userEvent.type(screen.getByLabelText(/deepseek api key/i), 'sk-should-not-persist')

    // Edit a field in the Providers section and save THAT section
    const providersSection = screen.getByRole('region', { name: /providers and access/i })
    await userEvent.click(screen.getByText(/advanced.*personal access token/i))
    await userEvent.type(screen.getByLabelText(/github token/i), 'github_pat_scoped')
    const { getSettings } = await import('../lib/settings/settings')
    const saveBtn = screen.getAllByRole('button', { name: /^save$/i })[0]
    expect(providersSection.contains(saveBtn)).toBe(true)
    await userEvent.click(saveBtn)

    expect(getSettings().githubPat).toBe('github_pat_scoped')
    expect(getSettings().deepseekKey).toBeNull()
  })

  it('Appearance section advertises immediate apply and has no Save button', () => {
    render(SettingsPage)
    const appearance = screen.getByRole('region', { name: /appearance/i })
    expect(appearance.textContent).toMatch(/applies immediately/i)
    const saveButtons = screen.getAllByRole('button', { name: /^save$/i })
    for (const btn of saveButtons) {
      expect(appearance.contains(btn)).toBe(false)
    }
  })
})

describe('SettingsPage scrollspy', () => {
  // jsdom reports scrollHeight 0 and implements neither scrollY mutation
  // nor scrollIntoView; give the document a real height and stub both so
  // the at-bottom check and the section-prop scroll work in tests.
  beforeEach(() => {
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 3000,
      configurable: true,
    })
    Object.defineProperty(window, 'innerHeight', {
      value: 800,
      configurable: true,
      writable: true,
    })
    setScrollY(0)
    Element.prototype.scrollIntoView = vi.fn()
  })

  function setScrollY(value: number) {
    Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true })
  }

  function navLink(name: RegExp): HTMLElement {
    const nav = screen.getByRole('navigation', { name: /settings sections/i })
    const link = Array.from(nav.querySelectorAll('a')).find((a) => name.test(a.textContent ?? ''))
    if (!link) throw new Error(`nav link ${name} not found`)
    return link
  }

  it('marks the first section active on initial render', () => {
    render(SettingsPage)
    expect(navLink(/appearance/i)).toHaveAttribute('aria-current', 'true')
    expect(navLink(/providers & access/i)).not.toHaveAttribute('aria-current')
    expect(navLink(/ai models/i)).not.toHaveAttribute('aria-current')
    expect(navLink(/reviewer skills/i)).not.toHaveAttribute('aria-current')
  })

  it('marks the section from the section prop active on initial render', () => {
    render(SettingsPage, { props: { section: 'ai-models' } })
    expect(navLink(/ai models/i)).toHaveAttribute('aria-current', 'true')
    expect(navLink(/appearance/i)).not.toHaveAttribute('aria-current')
  })

  it('registers the IntersectionObserver seam over all four sections', () => {
    render(SettingsPage)
    expect(observeSections).toHaveBeenCalledTimes(1)
    const elements = vi.mocked(observeSections).mock.calls[0][0]
    expect(elements.map((el) => el.id)).toEqual(['appearance', 'providers', 'ai-models', 'skills'])
  })

  it('clicking a nav item immediately sets it active', async () => {
    render(SettingsPage)
    await userEvent.click(navLink(/reviewer skills/i))
    expect(navLink(/reviewer skills/i)).toHaveAttribute('aria-current', 'true')
    expect(navLink(/appearance/i)).not.toHaveAttribute('aria-current')
  })

  it('updates the active item when the observer reports a new dominant section', async () => {
    render(SettingsPage)
    // providers crossed the midline (top 100 <= 400); ai-models has not (700)
    stubSectionTop('appearance', -500)
    stubSectionTop('providers', 100)
    stubSectionTop('ai-models', 700)
    stubSectionTop('skills', 1300)
    getObserverCallback()()
    await vi.waitFor(() => {
      expect(navLink(/providers & access/i)).toHaveAttribute('aria-current', 'true')
    })
    expect(navLink(/appearance/i)).not.toHaveAttribute('aria-current')
  })

  it('activates the last section at the page bottom even if it never reaches the midline', async () => {
    render(SettingsPage)
    stubSectionTop('appearance', -1800)
    stubSectionTop('providers', -1000)
    stubSectionTop('ai-models', -200)
    stubSectionTop('skills', 450) // short last section: below midline (400)
    setScrollY(2200) // 2200 + 800 = 3000 = scrollHeight
    getObserverCallback()()
    await vi.waitFor(() => {
      expect(navLink(/reviewer skills/i)).toHaveAttribute('aria-current', 'true')
    })
  })

  // Top-edge regression (user report): at scrollTop ≈ 0 the page header
  // pushes a short Appearance section's successor above the midline and
  // "Providers & access" was highlighted while the user read Appearance.
  it('keeps Appearance active when the observer fires at the very top (short first section under the page header)', async () => {
    render(SettingsPage)
    stubSectionTop('appearance', 130) // page header above it is in view
    stubSectionTop('providers', 350) // already above the midline (400)!
    stubSectionTop('ai-models', 900)
    stubSectionTop('skills', 1500)
    getObserverCallback()()
    await Promise.resolve()
    expect(navLink(/appearance/i)).toHaveAttribute('aria-current', 'true')
    expect(navLink(/providers & access/i)).not.toHaveAttribute('aria-current')
  })

  it('returns to Appearance when scrolling back to the very top (passive scroll listener, not only the observer)', async () => {
    render(SettingsPage)
    // Mid-page: providers dominates
    stubSectionTop('appearance', -500)
    stubSectionTop('providers', 100)
    stubSectionTop('ai-models', 700)
    stubSectionTop('skills', 1300)
    getObserverCallback()()
    await vi.waitFor(() => {
      expect(navLink(/providers & access/i)).toHaveAttribute('aria-current', 'true')
    })
    // Back at the top — only a scroll event fires (no IO threshold crossing)
    stubSectionTop('appearance', 130)
    stubSectionTop('providers', 350)
    stubSectionTop('ai-models', 900)
    stubSectionTop('skills', 1500)
    window.dispatchEvent(new Event('scroll'))
    await vi.waitFor(() => {
      expect(navLink(/appearance/i)).toHaveAttribute('aria-current', 'true')
    })
    expect(navLink(/providers & access/i)).not.toHaveAttribute('aria-current')
  })

  it('suppresses observer updates right after a nav click (no flicker during smooth scroll)', async () => {
    render(SettingsPage)
    await userEvent.click(navLink(/ai models/i))
    expect(navLink(/ai models/i)).toHaveAttribute('aria-current', 'true')
    // Observer fires mid-scroll with an intermediate section dominant
    stubSectionTop('appearance', -500)
    stubSectionTop('providers', 100)
    stubSectionTop('ai-models', 700)
    stubSectionTop('skills', 1300)
    getObserverCallback()()
    await Promise.resolve()
    expect(navLink(/ai models/i)).toHaveAttribute('aria-current', 'true')
    expect(navLink(/providers & access/i)).not.toHaveAttribute('aria-current')
  })

  it('resumes observer updates after the suppression window elapses', async () => {
    vi.useFakeTimers()
    try {
      render(SettingsPage)
      const skillsLink = Array.from(
        screen
          .getByRole('navigation', { name: /settings sections/i })
          .querySelectorAll('a'),
      ).find((a) => /reviewer skills/i.test(a.textContent ?? ''))!
      skillsLink.click()
      await vi.advanceTimersByTimeAsync(0)
      expect(skillsLink).toHaveAttribute('aria-current', 'true')
      stubSectionTop('appearance', -500)
      stubSectionTop('providers', 100)
      stubSectionTop('ai-models', 700)
      stubSectionTop('skills', 1300)
      vi.advanceTimersByTime(1500) // beyond the suppression window
      getObserverCallback()()
      await vi.advanceTimersByTimeAsync(0)
      const nav = screen.getByRole('navigation', { name: /settings sections/i })
      const providersLink = Array.from(nav.querySelectorAll('a')).find((a) =>
        /providers & access/i.test(a.textContent ?? ''),
      )!
      expect(providersLink).toHaveAttribute('aria-current', 'true')
      expect(skillsLink).not.toHaveAttribute('aria-current')
    } finally {
      vi.useRealTimers()
    }
  })
})
