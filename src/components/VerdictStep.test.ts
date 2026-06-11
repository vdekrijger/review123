/**
 * VerdictStep component tests.
 *
 * Seam: submitFn prop injection — avoids vi.mock complexities with Svelte
 * component imports, and makes the seam explicit in the API.
 *
 * Auth seam: setGithubPat / saveGithubAuth on localStorage (jsdom).
 * IndexedDB: undefined in jsdom → createDraftStore falls back to in-memory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import VerdictStep from './VerdictStep.svelte'
import { setGithubPat, saveGithubAuth } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'
import { createDraftStore } from '../lib/drafts/drafts.svelte'
import type { PrRef } from '../lib/github/parse'
import type { SubmitOutcome } from '../lib/github/review'

const prRef: PrRef = { owner: 'alice', repo: 'widgets', number: 42 }
const commitId = 'abc123'
const prUrl = 'https://github.com/alice/widgets/pull/42'

/** Build a minimal in-memory draft store (indexedDB undefined in jsdom → memory mode). */
function makeStore() {
  return createDraftStore('alice/widgets#42@abc123')
}

/** A submitFn that resolves to {ok:true}. */
function okSubmit(): Promise<SubmitOutcome> {
  return Promise.resolve({ ok: true })
}

/** A submitFn that resolves to a failure. */
function failSubmit(message: string): () => Promise<SubmitOutcome> {
  return () => Promise.resolve({ ok: false, kind: 'other', message })
}

/** A submitFn that never resolves (for the pending/disabled test). */
function hangingSubmit(): Promise<SubmitOutcome> {
  return new Promise(() => {})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signIn() {
  setGithubPat('ghp_test_token')
}

function signOut() {
  localStorage.clear()
  _resetAuthStateForTest()
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  signOut()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerdictStep', () => {
  // EC-09c, EC-19b
  describe('signed out', () => {
    it('shows sign-in prompt, no submit button', () => {
      render(VerdictStep, {
        props: {
          prRef,
          commitId,
          store: makeStore(),
          prUrl,
          submitFn: okSubmit,
        },
      })

      expect(screen.getByText(/sign in with github/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /submit/i })).toBeNull()
    })

    it('does not render the verdict radio group when signed out', () => {
      render(VerdictStep, {
        props: {
          prRef,
          commitId,
          store: makeStore(),
          prUrl,
          submitFn: okSubmit,
        },
      })

      // No radio inputs
      expect(screen.queryByRole('radio')).toBeNull()
    })
  })

  // EC-09a: APPROVE allows empty body + 0 drafts → submit called
  describe('signed in — APPROVE with empty body', () => {
    it('calls submitFn even with no body and no drafts', async () => {
      signIn()
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({ ok: true } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      // Select APPROVE radio
      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      await waitFor(() => expect(submitFn).toHaveBeenCalledOnce())
    })
  })

  // Client-side guard: REQUEST_CHANGES + empty body + 0 drafts → hint, no call
  describe('client-side guard', () => {
    it('REQUEST_CHANGES + empty body + 0 drafts shows hint, does NOT call submitFn', async () => {
      signIn()
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({ ok: true } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      // Select REQUEST_CHANGES (body is empty, no drafts)
      await user.click(screen.getByRole('radio', { name: /request changes/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      expect(submitFn).not.toHaveBeenCalled()
      expect(screen.getByText(/add a comment or draft at least one line comment first/i)).toBeInTheDocument()
    })

    it('COMMENT + empty body + 0 drafts shows hint, does NOT call submitFn', async () => {
      signIn()
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({ ok: true } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      // Default verdict is COMMENT, body is empty, no drafts
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      expect(submitFn).not.toHaveBeenCalled()
      expect(screen.getByText(/add a comment or draft at least one line comment first/i)).toBeInTheDocument()
    })

    it('COMMENT with a non-empty body bypasses guard and calls submitFn', async () => {
      signIn()
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({ ok: true } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      const textarea = screen.getByRole('textbox', { name: /comment body/i })
      await user.type(textarea, 'Looks good overall')
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      await waitFor(() => expect(submitFn).toHaveBeenCalledOnce())
    })
  })

  // Failure outcome: message shown verbatim, store NOT cleared
  describe('failure outcome', () => {
    it('renders error message verbatim in role=alert, store NOT cleared', async () => {
      signIn()
      const user = userEvent.setup()
      const errorMessage = 'Can not approve your own pull request'
      const submitFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'self-approve',
        message: errorMessage,
      } as SubmitOutcome)

      const store = makeStore()
      // Pre-seed a draft so we can verify it survives
      await store.upsert({ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Nice catch' })
      expect(store.count).toBe(1)

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn },
      })

      // Select APPROVE so the client guard doesn't fire
      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })
      expect(screen.getByRole('alert').textContent).toBe(errorMessage)

      // Drafts must NOT be cleared
      expect(store.count).toBe(1)
    })

    it('submit button is re-enabled after failure', async () => {
      signIn()
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'other',
        message: 'Network error',
      } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      await user.click(screen.getByRole('radio', { name: /approve/i }))
      const btn = screen.getByRole('button', { name: /submit review/i })
      await user.click(btn)

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })

      // Button must be re-enabled
      expect(screen.getByRole('button', { name: /submit review/i })).not.toBeDisabled()
    })
  })

  // Success outcome: store cleared + success panel with link
  describe('success outcome', () => {
    it('clears store and shows success panel with correct link', async () => {
      signIn()
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({ ok: true } as SubmitOutcome)

      const store = makeStore()
      await store.upsert({ path: 'src/b.ts', line: 10, side: 'RIGHT', body: 'Looks good' })
      expect(store.count).toBe(1)

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn },
      })

      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      // Wait for success panel
      await waitFor(() => {
        expect(screen.getByText(/submitted successfully/i)).toBeInTheDocument()
      })

      // Store should be cleared
      expect(store.count).toBe(0)

      // Success link should point to prUrl
      const link = screen.getByRole('link', { name: /view on github/i })
      expect(link).toHaveAttribute('href', prUrl)
    })
  })

  // Pending state: button disabled while awaiting
  describe('pending state', () => {
    it('disables submit button while submitFn is in-flight', async () => {
      signIn()
      const user = userEvent.setup()
      // A submitFn that never resolves
      const submitFn = vi.fn().mockImplementation(() => hangingSubmit())

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      await user.click(screen.getByRole('radio', { name: /approve/i }))
      const btn = screen.getByRole('button', { name: /submit review/i })
      await user.click(btn)

      // Button should be disabled while pending
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled()
      })
    })
  })

  // Recap section: drafts shown grouped by path
  describe('draft recap', () => {
    it('shows drafted comments grouped by file path', async () => {
      signIn()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'First comment' })
      await store.upsert({ path: 'src/b.ts', line: 5, side: 'LEFT', body: 'Second comment' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit },
      })

      expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument()
      expect(screen.getByText(/src\/b\.ts/)).toBeInTheDocument()
      expect(screen.getByText(/drafted comments \(2\)/i)).toBeInTheDocument()
    })
  })

  // OAuth auth: saveGithubAuth as alternative auth seeding
  describe('auth via saveGithubAuth (OAuth)', () => {
    it('shows form when signed in via OAuth', () => {
      saveGithubAuth({ token: 'gho_oauthtoken', method: 'oauth', scopes: ['public_repo'] })

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit },
      })

      // Should render the submit button (signed in)
      expect(screen.getByRole('button', { name: /submit review/i })).toBeInTheDocument()
      // No sign-in prompt
      expect(screen.queryByText(/sign in with github/i)).toBeNull()
    })
  })

  // EC-REACT: reactive auth — signing in AFTER render flips prompt→form without remount
  describe('reactive auth (EC-REACT)', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('form appears without remount when saveGithubAuth is called after initial signed-out render', async () => {
      // Render signed-out first
      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit },
      })

      // Signed-out prompt is visible
      expect(screen.getByText(/sign in with github/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /submit review/i })).toBeNull()

      // Now sign in reactively (simulates OAuth callback completing)
      await act(async () => {
        saveGithubAuth({ token: 'gho_reactive_token', method: 'oauth', scopes: ['public_repo'] })
      })

      // Form must appear without re-render
      expect(screen.getByRole('button', { name: /submit review/i })).toBeInTheDocument()
      // Prompt must be gone
      expect(screen.queryByText(/sign in with github/i)).toBeNull()
    })

    it('shows a real "Sign in with GitHub" button (not just text) when VITE_GITHUB_CLIENT_ID is set', () => {
      vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'test_client_id')

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit },
      })

      // Should be an actual button element, not just paragraph text
      expect(screen.getByRole('button', { name: /sign in with github/i })).toBeInTheDocument()
    })

    it('sign-in button sets returnTo to location.pathname so user returns to PR after OAuth', async () => {
      vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'test_client_id')
      // Set the current location to a PR review path
      Object.defineProperty(globalThis, 'location', {
        value: { pathname: '/review/alice/widgets/42', origin: 'http://localhost', assign: vi.fn() },
        writable: true,
        configurable: true,
      })
      sessionStorage.clear()

      const user = userEvent.setup()
      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit },
      })

      const btn = screen.getByRole('button', { name: /sign in with github/i })
      await user.click(btn)

      // returnTo must be stored in sessionStorage so AuthCallback navigates back
      expect(sessionStorage.getItem('review123:returnTo')).toBe('/review/alice/widgets/42')
    })
  })
})
