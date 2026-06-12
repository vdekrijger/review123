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
import { setGithubPat, saveGithubAuth, setDeepseekKey } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'
import { createDraftStore } from '../lib/drafts/drafts.svelte'
import type { PrRef } from '../lib/github/parse'
import type { SubmitOutcome } from '../lib/github/review'
import type { CoachResult, CommentReview } from '../lib/ai/schemas'
import type { Draft } from '../lib/drafts/drafts.svelte'
import type { ReviewProvider } from '../lib/provider/types'

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
      expect(screen.getByRole('alert').textContent?.trim()).toBe(errorMessage)

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

  // ---- Coach feature tests ----
  describe('comment coach', () => {
    /** Set up a deepseek key so coach button is eligible to show */
    function setDeepseek() {
      setDeepseekKey('sk-test-deep')
    }

    /** Clear deepseek key */
    function clearDeepseek() {
      setDeepseekKey(null)
    }

    /** Make a minimal CoachResult for a single draft */
    function makeCoachResult(overrides: Partial<CommentReview> = {}): CoachResult {
      return {
        reviews: [{
          index: 0,
          clarity: 3,
          actionable: true,
          tone: 'ok',
          biasQuestion: null,
          suggestion: null,
          accuracy: 'consistent',
          accuracyNote: null,
          duplicate: false,
          ...overrides,
        }],
      }
    }

    /** A coachFn stub that returns a successful CoachResult */
    function okCoach(result: CoachResult = makeCoachResult()): (_drafts: Draft[]) => Promise<CoachResult | { error: string }> {
      return vi.fn().mockResolvedValue(result)
    }

    /** A coachFn stub that returns an error */
    function errorCoach(msg: string): (_drafts: Draft[]) => Promise<CoachResult | { error: string }> {
      return vi.fn().mockResolvedValue({ error: msg })
    }

    /** A coachFn stub that never resolves (hanging) */
    function hangingCoach(): (_drafts: Draft[]) => Promise<CoachResult | { error: string }> {
      return vi.fn().mockImplementation(() => new Promise(() => {}))
    }

    afterEach(() => {
      clearDeepseek()
    })

    // --- Button gating ---

    it('Coach button is hidden when there are 0 drafts', async () => {
      signIn()
      setDeepseek()
      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, coachFn: okCoach() },
      })
      expect(screen.queryByRole('button', { name: /coach my comments/i })).toBeNull()
    })

    it('Coach button is hidden when no deepseek key', async () => {
      signIn()
      // No setDeepseek() call
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach() },
      })
      expect(screen.queryByRole('button', { name: /coach my comments/i })).toBeNull()
    })

    it('Coach button is hidden when signed out', async () => {
      // signOut() already called in beforeEach
      setDeepseek()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach() },
      })
      expect(screen.queryByRole('button', { name: /coach my comments/i })).toBeNull()
    })

    it('Coach button is hidden when coachFn is not provided', async () => {
      signIn()
      setDeepseek()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit },
      })
      expect(screen.queryByRole('button', { name: /coach my comments/i })).toBeNull()
    })

    it('Coach button is visible when signed in + drafts > 0 + key + coachFn', async () => {
      signIn()
      setDeepseek()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach() },
      })
      expect(screen.getByRole('button', { name: /coach my comments/i })).toBeInTheDocument()
    })

    // --- Pending state ---

    it('Coach button is disabled while coachFn is in-flight', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: hangingCoach() },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /coaching…/i })).toBeDisabled()
      })
    })

    it('Submit button stays enabled while coaching is in-flight', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: hangingCoach() },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        // Submit button must remain enabled
        expect(screen.getByRole('button', { name: /submit review/i })).not.toBeDisabled()
      })
    })

    // --- Result rendering ---

    it('renders clarity stars with correct aria-label', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach(makeCoachResult({ clarity: 3 })) },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByLabelText(/clarity 3 of 5/i)).toBeInTheDocument()
      })
    })

    it('renders tone chip', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach(makeCoachResult({ tone: 'blunt' })) },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByText('blunt')).toBeInTheDocument()
      })
    })

    it('renders bias callout when biasQuestion present', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      const biasQ = 'Is this a preference or a defect?'
      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach(makeCoachResult({ biasQuestion: biasQ })) },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByText(biasQ)).toBeInTheDocument()
      })
    })

    it('renders suggestion with Apply and Dismiss buttons', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach(makeCoachResult({ suggestion: 'Consider simplifying this.' })) },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByText('Consider simplifying this.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /apply suggestion/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
      })
    })

    // --- Apply suggestion mutates store ---

    it('Apply suggestion replaces the draft body in the store', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'original comment' })
      expect(store.drafts[0].body).toBe('original comment')

      const suggestion = 'Better rewritten comment'
      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach(makeCoachResult({ suggestion })) },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /apply suggestion/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /apply suggestion/i }))

      // Suggestion card should be dismissed after apply
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /apply suggestion/i })).toBeNull()
      })

      // Store draft body should be updated
      expect(store.drafts[0].body).toBe(suggestion)
    })

    it('Dismiss hides the suggestion card without mutating the store', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      const originalBody = 'original comment'
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: originalBody })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach(makeCoachResult({ suggestion: 'A suggestion' })) },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /dismiss/i }))

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull()
      })

      // Store body must be unchanged
      expect(store.drafts[0].body).toBe(originalBody)
    })

    // --- Error path ---

    it('renders error message in role=alert on coachFn error', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: errorCoach('No DeepSeek API key configured.') },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
        expect(screen.getByRole('alert').textContent).toContain('No DeepSeek API key configured.')
      })
    })

    it('Submit button stays enabled after coach error', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: errorCoach('Some error') },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })

      expect(screen.getByRole('button', { name: /submit review/i })).not.toBeDisabled()
    })

    it('Submit button stays enabled after successful coaching', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach() },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByLabelText(/clarity/i)).toBeInTheDocument()
      })

      expect(screen.getByRole('button', { name: /submit review/i })).not.toBeDisabled()
    })

    // --- accuracy chip rendering ---

    it('accuracy chip: consistent shows muted chip', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: {
          prRef, commitId, store, prUrl, submitFn: okSubmit,
          coachFn: okCoach(makeCoachResult({ accuracy: 'consistent', accuracyNote: null, duplicate: false })),
        },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        const chip = screen.getByTestId('accuracy-chip')
        expect(chip).toBeInTheDocument()
        expect(chip.textContent).toContain('consistent')
        expect(chip.className).toMatch(/accuracy-consistent/)
      })
    })

    it('accuracy chip: questionable shows amber chip', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: {
          prRef, commitId, store, prUrl, submitFn: okSubmit,
          coachFn: okCoach(makeCoachResult({ accuracy: 'questionable', accuracyNote: null, duplicate: false })),
        },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        const chip = screen.getByTestId('accuracy-chip')
        expect(chip.textContent).toContain('questionable')
        expect(chip.className).toMatch(/accuracy-questionable/)
      })
    })

    it('accuracy chip: contradicted shows red chip with why in title and below', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      const why = 'The diff shows X returns number not string.'
      render(VerdictStep, {
        props: {
          prRef, commitId, store, prUrl, submitFn: okSubmit,
          coachFn: okCoach(makeCoachResult({ accuracy: 'contradicted', accuracyNote: why, duplicate: false })),
        },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        const chip = screen.getByTestId('accuracy-chip')
        expect(chip.textContent).toContain('contradicted')
        expect(chip.className).toMatch(/accuracy-contradicted/)
        // The why should be in the chip title
        expect(chip).toHaveAttribute('title', why)
        // The why should also appear below as text
        expect(screen.getByTestId('accuracy-note')).toHaveTextContent(why)
      })
    })

    it('accuracy chip: no accuracyNote shown when consistent', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: {
          prRef, commitId, store, prUrl, submitFn: okSubmit,
          coachFn: okCoach(makeCoachResult({ accuracy: 'consistent', accuracyNote: null, duplicate: false })),
        },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByTestId('accuracy-chip')).toBeInTheDocument()
      })

      expect(screen.queryByTestId('accuracy-note')).not.toBeInTheDocument()
    })

    // --- duplicate badge rendering ---

    it('duplicate badge shown when duplicate is true', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: {
          prRef, commitId, store, prUrl, submitFn: okSubmit,
          coachFn: okCoach(makeCoachResult({ accuracy: 'consistent', accuracyNote: null, duplicate: true })),
        },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        const badge = screen.getByTestId('duplicate-badge')
        expect(badge).toBeInTheDocument()
        expect(badge.textContent).toMatch(/similar to an existing comment/i)
      })
    })

    it('duplicate badge NOT shown when duplicate is false', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: {
          prRef, commitId, store, prUrl, submitFn: okSubmit,
          coachFn: okCoach(makeCoachResult({ accuracy: 'consistent', accuracyNote: null, duplicate: false })),
        },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        expect(screen.getByTestId('accuracy-chip')).toBeInTheDocument()
      })

      expect(screen.queryByTestId('duplicate-badge')).not.toBeInTheDocument()
    })
  })

  // ---- Org-access deep-link (forbidden / unauthorized+oauth) ----
  describe('org-access deep-link', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('forbidden outcome renders org-access link with correct href when VITE_GITHUB_CLIENT_ID is set', async () => {
      vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'gh_client_abc')
      signIn()
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'forbidden',
        message: 'Resource not accessible by integration',
      } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })

      const link = screen.getByRole('link', { name: /check or request organization access/i })
      expect(link).toBeInTheDocument()
      expect(link).toHaveAttribute('href', 'https://github.com/settings/connections/applications/gh_client_abc')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener')
    })

    it('unauthorized + oauth method renders org-access link when VITE_GITHUB_CLIENT_ID is set', async () => {
      vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'gh_client_abc')
      // Sign in via OAuth
      saveGithubAuth({ token: 'gho_oauthtoken', method: 'oauth', scopes: ['public_repo'] })
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'unauthorized',
        message: 'Bad credentials',
      } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })

      const link = screen.getByRole('link', { name: /check or request organization access/i })
      expect(link).toBeInTheDocument()
      expect(link).toHaveAttribute('href', 'https://github.com/settings/connections/applications/gh_client_abc')
    })

    it('unauthorized + pat method does NOT render org-access link', async () => {
      vi.stubEnv('VITE_GITHUB_CLIENT_ID', 'gh_client_abc')
      signIn() // PAT sign-in
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'unauthorized',
        message: 'Bad credentials',
      } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })

      expect(screen.queryByRole('link', { name: /check or request organization access/i })).toBeNull()
    })

    it('forbidden outcome does NOT render org-access link when VITE_GITHUB_CLIENT_ID is absent', async () => {
      vi.stubEnv('VITE_GITHUB_CLIENT_ID', '')
      signIn()
      const user = userEvent.setup()
      const submitFn = vi.fn().mockResolvedValue({
        ok: false,
        kind: 'forbidden',
        message: 'Resource not accessible by integration',
      } as SubmitOutcome)

      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn },
      })

      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })

      expect(screen.queryByRole('link', { name: /check or request organization access/i })).toBeNull()
    })
  })

  // ---- Non-atomic note ----
  describe('non-atomic note', () => {
    function makeGitLabProvider(atomicReview: boolean) {
      return {
        id: 'gitlab' as const,
        displayName: 'GitLab',
        capabilities: { atomicReview, resolvedThreads: true, checks: true, suggestions: true, compare: true, selfReviewBlocked: false },
        parseUrl: vi.fn(),
        getPrMeta: vi.fn(),
        getPrFiles: vi.fn(),
        getFileAtRef: vi.fn(),
        getCiSummary: vi.fn(),
        getComments: vi.fn(),
        getResolvedCommentIds: vi.fn(),
        getCommits: vi.fn(),
        compareCommits: vi.fn(),
        submitReview: vi.fn(),
        authState: vi.fn().mockReturnValue({ configured: true, hint: '' }),
      }
    }

    it('non-atomic note: shown when provider.capabilities.atomicReview is false', () => {
      signIn()
      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, provider: makeGitLabProvider(false) },
      })
      expect(screen.getByText(/On GitLab, submitting posts each comment individually/i)).toBeInTheDocument()
    })

    it('non-atomic note: NOT shown when provider.capabilities.atomicReview is true', () => {
      signIn()
      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, provider: makeGitLabProvider(true) },
      })
      expect(screen.queryByText(/On GitLab, submitting posts each comment individually/i)).toBeNull()
    })

    it('non-atomic note: NOT shown when provider prop is absent', () => {
      signIn()
      render(VerdictStep, {
        props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit },
      })
      expect(screen.queryByText(/submitting posts each comment individually/i)).toBeNull()
    })
  })

  // ---- Partial-failure: drafts NOT cleared ----
  describe('partial failure', () => {
    it('partial-failure: drafts NOT cleared, error message shown in alert', async () => {
      signIn()
      const user = userEvent.setup()
      const errorMessage = '2 of 3 inline comment(s) failed to post: src/a.ts:1 — 403 Forbidden; src/b.ts:2 — timeout'
      const submitFn = vi.fn().mockResolvedValue({ ok: false, kind: 'other', message: errorMessage })

      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'Comment A' })
      await store.upsert({ path: 'src/b.ts', line: 2, side: 'RIGHT', body: 'Comment B' })
      await store.upsert({ path: 'src/c.ts', line: 3, side: 'RIGHT', body: 'Comment C' })
      expect(store.count).toBe(3)

      render(VerdictStep, { props: { prRef, commitId, store, prUrl, submitFn } })
      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /submit review/i }))

      await waitFor(() => { expect(screen.getByRole('alert')).toBeInTheDocument() })
      expect(screen.getByRole('alert').textContent).toContain('2 of 3 inline comment(s) failed')
      // Drafts must NOT be cleared
      expect(store.count).toBe(3)
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

// ---------------------------------------------------------------------------
// Own-PR verdict gating
// ---------------------------------------------------------------------------

describe('own-PR verdict gating', () => {
  function makeProvider(opts: {
    id?: 'github' | 'gitlab' | 'bitbucket'
    displayName?: string
    selfReviewBlocked?: boolean
  } = {}): ReviewProvider {
    return {
      id: opts.id ?? 'github',
      displayName: opts.displayName ?? 'GitHub',
      capabilities: {
        resolvedThreads: true,
        checks: true,
        suggestions: true,
        atomicReview: true,
        compare: true,
        selfReviewBlocked: opts.selfReviewBlocked ?? true,
      },
      parseUrl: vi.fn(),
      getPrMeta: vi.fn(),
      getPrFiles: vi.fn(),
      getFileAtRef: vi.fn(),
      getCiSummary: vi.fn(),
      getComments: vi.fn(),
      getResolvedCommentIds: vi.fn(),
      getCommits: vi.fn(),
      compareCommits: vi.fn(),
      submitReview: vi.fn(),
      authState: vi.fn().mockReturnValue({ configured: true, hint: '' }),
      getViewerLogin: vi.fn().mockResolvedValue('alice'),
    } as unknown as ReviewProvider
  }

  beforeEach(() => {
    signOut()
  })

  it('disables Approve and Request changes on own PR; Comment stays enabled', async () => {
    signIn()
    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store: makeStore(),
        prUrl,
        submitFn: okSubmit,
        provider: makeProvider(),
        authorLogin: 'alice',
        resolveViewerFn: () => Promise.resolve('alice'),
      },
    })

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /approve/i })).toBeDisabled()
    })
    expect(screen.getByRole('radio', { name: /request changes/i })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /comment/i })).toBeEnabled()
  })

  it('shows the muted own-PR explanation with the provider name', async () => {
    signIn()
    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store: makeStore(),
        prUrl,
        submitFn: okSubmit,
        provider: makeProvider(),
        authorLogin: 'alice',
        resolveViewerFn: () => Promise.resolve('alice'),
      },
    })

    await waitFor(() => {
      expect(
        screen.getByText(/GitHub doesn't allow reviewing your own PR — you can still comment/i),
      ).toBeInTheDocument()
    })
  })

  it('matches viewer and author logins case-insensitively', async () => {
    signIn()
    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store: makeStore(),
        prUrl,
        submitFn: okSubmit,
        provider: makeProvider(),
        authorLogin: 'ALICE',
        resolveViewerFn: () => Promise.resolve('Alice'),
      },
    })

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /approve/i })).toBeDisabled()
    })
  })

  it('does NOT gate when the viewer is not the author', async () => {
    signIn()
    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store: makeStore(),
        prUrl,
        submitFn: okSubmit,
        provider: makeProvider(),
        authorLogin: 'bob',
        resolveViewerFn: () => Promise.resolve('alice'),
      },
    })

    // Give the async resolution a tick to land
    await act(() => Promise.resolve())
    expect(screen.getByRole('radio', { name: /approve/i })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /request changes/i })).toBeEnabled()
    expect(screen.queryByText(/doesn't allow reviewing your own PR/i)).toBeNull()
  })

  it('does NOT gate on providers that allow self-review (GitLab)', async () => {
    signIn()
    const resolveViewerFn = vi.fn().mockResolvedValue('alice')
    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store: makeStore(),
        prUrl,
        submitFn: okSubmit,
        provider: makeProvider({ id: 'gitlab', displayName: 'GitLab', selfReviewBlocked: false }),
        authorLogin: 'alice',
        resolveViewerFn,
      },
    })

    await act(() => Promise.resolve())
    expect(screen.getByRole('radio', { name: /approve/i })).toBeEnabled()
    expect(screen.getByRole('radio', { name: /request changes/i })).toBeEnabled()
    // Identity is never even resolved for non-gating providers
    expect(resolveViewerFn).not.toHaveBeenCalled()
  })

  it('does NOT gate when the author identity is unknown', async () => {
    signIn()
    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store: makeStore(),
        prUrl,
        submitFn: okSubmit,
        provider: makeProvider(),
        authorLogin: null,
        resolveViewerFn: () => Promise.resolve('alice'),
      },
    })

    await act(() => Promise.resolve())
    expect(screen.getByRole('radio', { name: /approve/i })).toBeEnabled()
  })

  it('does NOT gate when the viewer identity cannot be resolved', async () => {
    signIn()
    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store: makeStore(),
        prUrl,
        submitFn: okSubmit,
        provider: makeProvider(),
        authorLogin: 'alice',
        resolveViewerFn: () => Promise.resolve(null),
      },
    })

    await act(() => Promise.resolve())
    expect(screen.getByRole('radio', { name: /approve/i })).toBeEnabled()
  })

  it('resets a selected Approve verdict back to Comment when gating resolves', async () => {
    signIn()
    const user = userEvent.setup()
    let resolveIdentity!: (v: string | null) => void
    const gate = new Promise<string | null>((res) => { resolveIdentity = res })

    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store: makeStore(),
        prUrl,
        submitFn: okSubmit,
        provider: makeProvider(),
        authorLogin: 'alice',
        resolveViewerFn: () => gate,
      },
    })

    // Identity not resolved yet → user can pick APPROVE
    await user.click(screen.getByRole('radio', { name: /approve/i }))
    expect(screen.getByRole('radio', { name: /approve/i })).toBeChecked()

    resolveIdentity('alice')

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /approve/i })).toBeDisabled()
    })
    expect(screen.getByRole('radio', { name: /comment/i })).toBeChecked()
  })
})
