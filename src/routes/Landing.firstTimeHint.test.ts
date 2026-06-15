/**
 * src/routes/Landing.firstTimeHint.test.ts — first-run "tailor the app" footnote.
 *
 * A subtle, muted single-line hint rendered directly under the PR URL input —
 * NOT a bordered card/section like the queue / recent / in-flight blocks. It
 * only shows the very first time (no review history yet) and its content varies
 * by auth state:
 *   - signed out  → nudge to sign in AND open Settings
 *   - signed in   → nudge to open Settings only
 * It disappears once the user has any recent-review history.
 *
 * The registry mock here mirrors authState() off the REAL settings store so we
 * can drive the signed-out → signed-in copy through actual settings saves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import Landing from './Landing.svelte'
import { addToHistory } from '../lib/history/history'
import { saveGithubAuth } from '../lib/settings/settings'
import { _resetSettingsStateForTest } from '../lib/settings/settingsState.svelte'
import * as queueModule from '../lib/provider/queue'

vi.mock('../lib/router/router.svelte', () => ({
  navigate: vi.fn(),
}))

vi.mock('../lib/provider/registry', async () => {
  const { getSettings } = await import('../lib/settings/settings')
  const CAPS = {
    resolvedThreads: false,
    checks: false,
    suggestions: false,
    atomicReview: false,
    compare: false,
    commentReplies: false,
    selfReviewBlocked: false,
  }
  return {
    PROVIDERS: new Map([
      ['github', {
        id: 'github',
        displayName: 'GitHub',
        authState: () => ({ configured: getSettings().githubAuth !== null, hint: '' }),
        getMyQueue: vi.fn(async () => []),
        capabilities: CAPS,
      }],
      ['gitlab', {
        id: 'gitlab',
        displayName: 'GitLab',
        authState: () => ({ configured: getSettings().gitlabToken !== null, hint: '' }),
        getMyQueue: vi.fn(async () => []),
        capabilities: CAPS,
      }],
    ]),
    parseAnyUrl: vi.fn().mockReturnValue(null),
  }
})

describe('Landing first-time hint', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetSettingsStateForTest()
    queueModule._resetQueueCacheForTest()
  })

  it('renders a subtle footnote (not a card/section) when history is empty', () => {
    const { container } = render(Landing)

    const hint = container.querySelector('.input-hint')
    expect(hint).not.toBeNull()
    expect(hint?.tagName).toBe('P')

    // It is NOT one of the bordered section/card blocks.
    expect(hint?.closest('.queue-section')).toBeNull()
    expect(hint?.closest('.recent-reviews')).toBeNull()
    expect(hint?.closest('.inflight-section')).toBeNull()
    expect(container.querySelector('.recent-reviews')).toBeNull()
  })

  it('is hidden once the user has any recent-review history', () => {
    addToHistory({ owner: 'alice', repo: 'widgets', number: 42, title: 'Add feature' })
    const { container } = render(Landing)

    expect(container.querySelector('.input-hint')).toBeNull()
  })

  it('signed-out copy nudges to sign in AND open Settings', () => {
    const { container } = render(Landing)

    const hint = container.querySelector('.input-hint')
    expect(hint?.textContent ?? '').toMatch(/new here/i)
    expect(hint?.textContent ?? '').toMatch(/sign in/i)

    // Settings link → /settings (SPA nav target).
    const links = Array.from(hint?.querySelectorAll('a') ?? [])
    const settingsLink = links.find((a) => /settings/i.test(a.textContent ?? ''))
    expect(settingsLink).toBeTruthy()
    expect(settingsLink?.getAttribute('href')).toBe('/settings')

    // A sign-in pointer link is present (deep link to the providers section).
    const signInLink = links.find((a) => /sign in/i.test(a.textContent ?? ''))
    expect(signInLink).toBeTruthy()
    expect(signInLink?.getAttribute('href')).toBe('/settings/providers')
  })

  it('signed-in copy nudges to open Settings only (no sign-in prompt)', async () => {
    saveGithubAuth({ token: 'ghp_test', method: 'pat', scopes: [] })
    const { container } = render(Landing)

    const hint = container.querySelector('.input-hint')
    expect(hint).not.toBeNull()
    expect(hint?.textContent ?? '').not.toMatch(/sign in/i)
    expect(hint?.textContent ?? '').toMatch(/settings/i)

    const settingsLink = hint?.querySelector('a')
    expect(settingsLink?.getAttribute('href')).toBe('/settings')
  })

  it('Settings link points to /settings', () => {
    render(Landing)
    const link = screen.getByRole('link', { name: /^settings$/i })
    expect(link.getAttribute('href')).toBe('/settings')
  })
})
