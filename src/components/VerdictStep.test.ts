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
import { setGithubPat, saveGithubAuth, setDeepseekKey, setShowTokenCost } from '../lib/settings/settings'
import { _resetAuthStateForTest } from '../lib/auth/authState.svelte'
import { createDraftStore } from '../lib/drafts/drafts.svelte'
import type { PrRef } from '../lib/github/parse'
import type { SubmitOutcome } from '../lib/github/review'
import type { CoachResult, CommentReview } from '../lib/ai/schemas'
import type { Draft } from '../lib/drafts/drafts.svelte'
import type { ReviewProvider } from '../lib/provider/types'
import { _setCaptureForTest } from '../lib/analytics/analytics'

/** No-op capture restored after analytics assertions to avoid cross-test leakage. */
const noopCapture = () => {}

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
        // v9 label clarifies the dimension: "tone: blunt" instead of bare "blunt"
        expect(screen.getByText('tone: blunt')).toBeInTheDocument()
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

    // --- Spinner spacing (cosmetic): the in-progress indicator must keep a
    //     gap between the spinner and the "Coaching…" label. ---

    it('coaching indicator wraps the label in its own element (spacing seam)', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      const { container } = render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: hangingCoach() },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        const label = container.querySelector('.coach-btn-label')
        expect(label).not.toBeNull()
        expect(label!.textContent).toBe('Coaching…')
        // The spinner is a separate element from the label — not jammed together.
        const btn = container.querySelector('.coach-btn')!
        expect(btn.querySelector('.coach-btn-label')).not.toBeNull()
      })
    })

    // --- Partial failure: graded results + an honest note + retry ---

    it('partial failure: shows graded results AND a notCoached note with retry', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      const partialCoach = vi.fn().mockResolvedValue({
        reviews: [makeCoachResult().reviews[0]],
        notCoached: { indices: [1, 2], message: "Couldn't coach 2 comments (Rate limited by DeepSeek. Please try again in a moment.) — retry to grade them." },
      })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: partialCoach },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        // Graded result is rendered.
        expect(screen.getByLabelText(/clarity/i)).toBeInTheDocument()
        // Honest note for the uncoached comments.
        const note = screen.getByTestId('coach-partial-note')
        expect(note.textContent).toMatch(/couldn't coach 2 comments/i)
        expect(note.textContent).toMatch(/Rate limited/)
      })
      // Retry affordance present.
      expect(screen.getByRole('button', { name: /^retry$/i })).toBeInTheDocument()
    })

    it('partial-failure Retry re-runs the coach', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      const coach = vi.fn()
        .mockResolvedValueOnce({
          reviews: [makeCoachResult().reviews[0]],
          notCoached: { indices: [1], message: "Couldn't coach 1 comment (network) — retry to grade it." },
        })
        .mockResolvedValueOnce(makeCoachResult()) // clean second run

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: coach },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))
      await waitFor(() => expect(screen.getByTestId('coach-partial-note')).toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: /^retry$/i }))

      await waitFor(() => {
        // After a clean retry, the partial note is gone.
        expect(screen.queryByTestId('coach-partial-note')).toBeNull()
      })
      expect(coach).toHaveBeenCalledTimes(2)
    })

    it('coach error shows the SPECIFIC message, not the catch-all', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: errorCoach('Rate limited by DeepSeek. Please try again in a moment.') },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => {
        const alert = screen.getByRole('alert')
        expect(alert.textContent).toMatch(/Rate limited/)
        expect(alert.textContent).not.toMatch(/An unexpected error occurred/)
      })
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
        // Self-evident label instead of the bare enum value
        expect(chip.textContent).toContain('matches the diff')
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
        expect(chip.textContent).toContain('hard to verify against the diff')
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
        expect(chip.textContent).toContain('contradicted by the diff')
        expect(chip.className).toMatch(/accuracy-contradicted/)
        // The why should be in the chip title (accuracyNote fallback when no reasons)
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

    // --- v9: per-dimension rationales (pass AND fail) ---

    const FULL_REASONS = {
      clarity: 'clear and complete ask',
      tone: 'matches the tone of your other comments',
      actionable: 'asks for a concrete rename',
      accuracy: 'matches the change shown in the diff',
      duplicate: 'no overlap with existing comments',
      specificity: 'names the exact function and line',
      grounded: 'every claim is visible in the provided hunk',
    }

    async function renderAndCoach(result: CoachResult) {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn: okCoach(result) },
      })

      await user.click(screen.getByRole('button', { name: /coach my comments/i }))
      await waitFor(() => {
        expect(screen.getByTestId('accuracy-chip')).toBeInTheDocument()
      })
      return user
    }

    it('passing chips carry their reason in the title so the user knows the check ran', async () => {
      await renderAndCoach(makeCoachResult({ reasons: FULL_REASONS }))

      expect(screen.getByTestId('tone-chip')).toHaveAttribute('title', FULL_REASONS.tone)
      expect(screen.getByTestId('actionable-chip')).toHaveAttribute('title', FULL_REASONS.actionable)
      expect(screen.getByTestId('accuracy-chip')).toHaveAttribute('title', FULL_REASONS.accuracy)
    })

    it('renders the expandable rationale list with one line per provided reason', async () => {
      await renderAndCoach(makeCoachResult({ specificity: true, grounded: true, reasons: FULL_REASONS }))

      const details = screen.getByTestId('coach-reasons')
      expect(details).toBeInTheDocument()
      expect(details.textContent).toContain('Why these grades?')
      expect(details.textContent).toContain(FULL_REASONS.clarity)
      expect(details.textContent).toContain(FULL_REASONS.tone)
      expect(details.textContent).toContain(FULL_REASONS.specificity)
      expect(details.textContent).toContain(FULL_REASONS.grounded)
    })

    it('rationale list shows only the reasons present (partial reasons tolerated)', async () => {
      await renderAndCoach(makeCoachResult({ reasons: { tone: 'just the tone reason' } }))

      const details = screen.getByTestId('coach-reasons')
      expect(details.textContent).toContain('just the tone reason')
      expect(details.textContent).not.toContain(FULL_REASONS.clarity)
    })

    it('old v8 shape (no reasons/specificity/grounded) renders without rationale list and without crashing', async () => {
      // makeCoachResult default carries none of the v9 fields
      await renderAndCoach(makeCoachResult())

      expect(screen.queryByTestId('coach-reasons')).not.toBeInTheDocument()
      expect(screen.queryByTestId('specificity-chip')).not.toBeInTheDocument()
      expect(screen.queryByTestId('grounded-chip')).not.toBeInTheDocument()
      // Existing chips still render
      expect(screen.getByTestId('tone-chip')).toBeInTheDocument()
      expect(screen.getByTestId('accuracy-chip')).toBeInTheDocument()
    })

    // --- v9: specificity + grounded chips ---

    it('specificity chip: true renders the concrete-code pass label', async () => {
      await renderAndCoach(makeCoachResult({ specificity: true, reasons: FULL_REASONS }))

      const chip = screen.getByTestId('specificity-chip')
      expect(chip.textContent).toMatch(/points at concrete code/i)
      expect(chip.className).toMatch(/specificity-true/)
      expect(chip).toHaveAttribute('title', FULL_REASONS.specificity)
    })

    it('specificity chip: false renders the vague warning label', async () => {
      await renderAndCoach(makeCoachResult({ specificity: false }))

      const chip = screen.getByTestId('specificity-chip')
      expect(chip.textContent).toMatch(/vague/i)
      expect(chip.className).toMatch(/specificity-false/)
    })

    it('grounded chip: true renders the verifiable-in-diff pass label', async () => {
      await renderAndCoach(makeCoachResult({ grounded: true, reasons: FULL_REASONS }))

      const chip = screen.getByTestId('grounded-chip')
      expect(chip.textContent).toMatch(/claims verifiable in diff/i)
      expect(chip.className).toMatch(/grounded-true/)
      expect(chip).toHaveAttribute('title', FULL_REASONS.grounded)
    })

    it('grounded chip: false renders the not-verifiable warning label', async () => {
      await renderAndCoach(makeCoachResult({ grounded: false }))

      const chip = screen.getByTestId('grounded-chip')
      expect(chip.textContent).toMatch(/not verifiable in diff/i)
      expect(chip.className).toMatch(/grounded-false/)
    })

    // --- v9: clarified labels for the existing chips ---

    it('tone chip is labelled "tone: ok" instead of a bare "ok"', async () => {
      await renderAndCoach(makeCoachResult({ tone: 'ok' }))
      expect(screen.getByTestId('tone-chip').textContent).toBe('tone: ok')
    })

    it('actionable=false chip reads "not actionable"', async () => {
      await renderAndCoach(makeCoachResult({ actionable: false }))
      expect(screen.getByTestId('actionable-chip').textContent).toMatch(/✗ not actionable/)
    })

    // --- v9: verdict-coherence flag card ---

    it('coherence card shown at the top when comments do not match the verdict', async () => {
      const note = 'Two harsh blocking comments but the verdict is Approve.'
      await renderAndCoach({ ...makeCoachResult(), verdictCoherence: { coherent: false, note } })

      const card = screen.getByTestId('coherence-card')
      expect(card).toBeInTheDocument()
      expect(card.textContent).toContain("Comments don't match your verdict")
      expect(card.textContent).toContain(note)
    })

    it('coherence card NOT shown when comments match the verdict', async () => {
      await renderAndCoach({
        ...makeCoachResult(),
        verdictCoherence: { coherent: true, note: 'Comments match the chosen verdict.' },
      })

      expect(screen.queryByTestId('coherence-card')).not.toBeInTheDocument()
    })

    it('coherence card NOT shown when verdictCoherence is absent (old shape)', async () => {
      await renderAndCoach(makeCoachResult())

      expect(screen.queryByTestId('coherence-card')).not.toBeInTheDocument()
    })

    // --- v9: verdict passed into coachFn ---

    it('coachFn receives the currently-selected verdict as its third argument', async () => {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })

      const coachFn = vi.fn().mockResolvedValue(makeCoachResult())
      render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn },
      })

      await user.click(screen.getByRole('radio', { name: /approve/i }))
      await user.click(screen.getByRole('button', { name: /coach my comments/i }))

      await waitFor(() => expect(coachFn).toHaveBeenCalledOnce())
      expect(coachFn.mock.calls[0][2]).toBe('APPROVE')
    })

    // --- v16: token-cost footer on coach result (opt-in: settings.showTokenCost) ---

    const USAGE = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }

    /** coachFn stub returning a result WITH usage attached. */
    function okCoachWithUsage() {
      return vi.fn().mockResolvedValue({ ...makeCoachResult(), usage: USAGE })
    }

    async function coachOnce(coachFn: ReturnType<typeof okCoachWithUsage>) {
      signIn()
      setDeepseek()
      const user = userEvent.setup()
      const store = makeStore()
      await store.upsert({ path: 'src/a.ts', line: 1, side: 'RIGHT', body: 'looks good' })
      const { container } = render(VerdictStep, {
        props: { prRef, commitId, store, prUrl, submitFn: okSubmit, coachFn },
      })
      await user.click(screen.getByRole('button', { name: /coach my comments/i }))
      await waitFor(() => expect(screen.getByLabelText(/clarity/i)).toBeInTheDocument())
      return container
    }

    it('renders the token-cost footer when showTokenCost is on and usage present', async () => {
      setShowTokenCost(true)
      const container = await coachOnce(okCoachWithUsage())
      const footer = container.querySelector('.coach-usage-footer')
      expect(footer).not.toBeNull()
      expect(footer!.textContent).toMatch(/1\.2k tokens/)
      setShowTokenCost(false)
    })

    it('renders NOTHING when showTokenCost is off even with usage present', async () => {
      setShowTokenCost(false)
      const container = await coachOnce(okCoachWithUsage())
      expect(container.querySelector('.coach-usage-footer')).toBeNull()
    })

    it('renders NOTHING when usage is absent even with showTokenCost on', async () => {
      setShowTokenCost(true)
      // okCoach() returns no usage field.
      const container = await coachOnce(okCoach() as ReturnType<typeof okCoachWithUsage>)
      expect(container.querySelector('.coach-usage-footer')).toBeNull()
      setShowTokenCost(false)
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
        capabilities: { atomicReview, resolvedThreads: true, checks: true, suggestions: true, compare: true, commentReplies: true, selfReviewBlocked: false },
        parseUrl: vi.fn(),
        prWebUrl: vi.fn(() => ""),
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
      prWebUrl: vi.fn(() => ""),
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

// ---------------------------------------------------------------------------
// Copy as LLM prompt — deterministic export (no submit, no key)
// ---------------------------------------------------------------------------

describe('VerdictStep — Copy as LLM prompt', () => {
  beforeEach(() => {
    signIn()
    _setCaptureForTest(vi.fn())
  })
  afterEach(() => {
    _setCaptureForTest(noopCapture)
  })

  it('is disabled when there are no drafts and no overall comment', () => {
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit },
    })
    expect(screen.getByRole('button', { name: /copy as llm prompt/i })).toBeDisabled()
  })

  it('copies the prompt to the clipboard, shows confirmation, and does not submit or clear drafts', async () => {
    const user = userEvent.setup()
    const copyFn = vi.fn().mockResolvedValue(undefined)
    const submitFn = vi.fn().mockResolvedValue({ ok: true } as SubmitOutcome)
    const capture = vi.fn()
    _setCaptureForTest(capture)

    const store = makeStore()
    await store.upsert({ path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Rename this variable.' })

    render(VerdictStep, {
      props: {
        prRef,
        commitId,
        store,
        prUrl,
        prTitle: 'My PR title',
        submitFn,
        copyFn,
      },
    })

    const btn = screen.getByRole('button', { name: /copy as llm prompt/i })
    expect(btn).toBeEnabled()
    await user.click(btn)

    // Clipboard received a prompt containing the file:line and the request.
    expect(copyFn).toHaveBeenCalledTimes(1)
    const text = copyFn.mock.calls[0][0] as string
    expect(text).toContain('src/a.ts:7')
    expect(text).toContain('Rename this variable.')
    expect(text).toContain('PR #42 — My PR title')

    // Transient confirmation appears.
    await waitFor(() => {
      expect(screen.getByText(/copied ✓/i)).toBeInTheDocument()
    })

    // Analytics: counts only, no content.
    expect(capture).toHaveBeenCalledWith('review_prompt_copied', { item_count: 1 })

    // Copying must NOT submit or clear drafts.
    expect(submitFn).not.toHaveBeenCalled()
    expect(store.count).toBe(1)
  })

  it('enables the button when only an overall comment is present', async () => {
    const user = userEvent.setup()
    const copyFn = vi.fn().mockResolvedValue(undefined)

    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, copyFn },
    })

    // Type an overall comment.
    const editor = screen.getByRole('textbox')
    await user.click(editor)
    await user.type(editor, 'Overall this looks good.')

    const btn = screen.getByRole('button', { name: /copy as llm prompt/i })
    await waitFor(() => expect(btn).toBeEnabled())
    await user.click(btn)

    expect(copyFn).toHaveBeenCalledTimes(1)
    expect(copyFn.mock.calls[0][0] as string).toContain('## Overall comment')
  })
})

// ---------------------------------------------------------------------------
// Copy review command — GitHub-only export (no submit) of a browser / gh / curl
// command that posts the whole review to the PR without installing the app.
// ---------------------------------------------------------------------------

describe('VerdictStep — Copy review command', () => {
  function makeCmdProvider(id: 'github' | 'gitlab' | 'bitbucket', displayName: string): ReviewProvider {
    return {
      id,
      displayName,
      capabilities: {
        resolvedThreads: true, checks: true, suggestions: true, atomicReview: true,
        compare: true, commentReplies: true, selfReviewBlocked: false,
      },
      parseUrl: vi.fn(),
      prWebUrl: vi.fn(() => ''),
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
    } as unknown as ReviewProvider
  }

  beforeEach(() => {
    signOut()
    signIn()
    _setCaptureForTest(vi.fn())
  })
  afterEach(() => {
    _setCaptureForTest(noopCapture)
  })

  it('renders the format picker + copy button for a GitHub PR (provider absent → GitHub)', () => {
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit },
    })
    expect(screen.getByRole('button', { name: /copy review command/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/review command format/i)).toBeInTheDocument()
  })

  it('renders for an explicit GitHub provider', () => {
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, provider: makeCmdProvider('github', 'GitHub') },
    })
    expect(screen.getByRole('button', { name: /copy review command/i })).toBeInTheDocument()
  })

  it('is ABSENT for non-GitHub providers (GitLab)', () => {
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, provider: makeCmdProvider('gitlab', 'GitLab') },
    })
    expect(screen.queryByRole('button', { name: /copy review command/i })).toBeNull()
    expect(screen.queryByLabelText(/review command format/i)).toBeNull()
  })

  it('is ABSENT for Bitbucket', () => {
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, provider: makeCmdProvider('bitbucket', 'Bitbucket') },
    })
    expect(screen.queryByRole('button', { name: /copy review command/i })).toBeNull()
  })

  it('is disabled when there are no drafts and no overall comment', () => {
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit },
    })
    expect(screen.getByRole('button', { name: /copy review command/i })).toBeDisabled()
  })

  it('default format is Browser console — copies the JS snippet', async () => {
    const user = userEvent.setup()
    const copyFn = vi.fn().mockResolvedValue(undefined)
    const store = makeStore()
    await store.upsert({ path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Rename this.' })

    render(VerdictStep, {
      props: { prRef, commitId, store, prUrl, submitFn: okSubmit, copyFn },
    })

    await user.click(screen.getByRole('button', { name: /copy review command/i }))
    expect(copyFn).toHaveBeenCalledTimes(1)
    const text = copyFn.mock.calls[0][0] as string
    expect(text).toContain('prompt(')
    expect(text).toContain('https://api.github.com/repos/alice/widgets/pulls/42/reviews')
    expect(text).toContain('Rename this.')
  })

  it('switching the format then copying copies THAT format (gh)', async () => {
    const user = userEvent.setup()
    const copyFn = vi.fn().mockResolvedValue(undefined)
    const store = makeStore()
    await store.upsert({ path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Rename this.' })

    render(VerdictStep, {
      props: { prRef, commitId, store, prUrl, submitFn: okSubmit, copyFn },
    })

    await user.selectOptions(screen.getByLabelText(/review command format/i), 'gh')
    await user.click(screen.getByRole('button', { name: /copy review command/i }))

    const text = copyFn.mock.calls[0][0] as string
    expect(text).toContain('gh api --method POST')
    expect(text).toContain('/repos/alice/widgets/pulls/42/reviews')
    expect(text).not.toContain('Bearer')
  })

  it('curl format references $GITHUB_TOKEN', async () => {
    const user = userEvent.setup()
    const copyFn = vi.fn().mockResolvedValue(undefined)
    const store = makeStore()
    await store.upsert({ path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Rename this.' })

    render(VerdictStep, {
      props: { prRef, commitId, store, prUrl, submitFn: okSubmit, copyFn },
    })

    await user.selectOptions(screen.getByLabelText(/review command format/i), 'curl')
    await user.click(screen.getByRole('button', { name: /copy review command/i }))

    const text = copyFn.mock.calls[0][0] as string
    expect(text).toContain('GITHUB_TOKEN')
    expect(text).toContain('curl')
  })

  it('copying the command does NOT submit or clear drafts', async () => {
    const user = userEvent.setup()
    const copyFn = vi.fn().mockResolvedValue(undefined)
    const submitFn = vi.fn().mockResolvedValue({ ok: true } as SubmitOutcome)
    const store = makeStore()
    await store.upsert({ path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Rename this.' })

    render(VerdictStep, {
      props: { prRef, commitId, store, prUrl, submitFn, copyFn },
    })

    await user.click(screen.getByRole('button', { name: /copy review command/i }))

    expect(submitFn).not.toHaveBeenCalled()
    expect(store.count).toBe(1)
  })

  it('emits review_command_copied analytics with format + item_count only', async () => {
    const user = userEvent.setup()
    const copyFn = vi.fn().mockResolvedValue(undefined)
    const capture = vi.fn()
    _setCaptureForTest(capture)
    const store = makeStore()
    await store.upsert({ path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Rename this.' })

    render(VerdictStep, {
      props: { prRef, commitId, store, prUrl, submitFn: okSubmit, copyFn },
    })

    await user.click(screen.getByRole('button', { name: /copy review command/i }))
    expect(capture).toHaveBeenCalledWith('review_command_copied', { format: 'browser', item_count: 1 })
  })

  it('the LLM-prompt button still works alongside the command picker', async () => {
    const user = userEvent.setup()
    const copyFn = vi.fn().mockResolvedValue(undefined)
    const store = makeStore()
    await store.upsert({ path: 'src/a.ts', line: 7, side: 'RIGHT', body: 'Rename this.' })

    render(VerdictStep, {
      props: { prRef, commitId, store, prUrl, prTitle: 'My PR', submitFn: okSubmit, copyFn },
    })

    await user.click(screen.getByRole('button', { name: /copy as llm prompt/i }))
    const text = copyFn.mock.calls[0][0] as string
    expect(text).toContain('PR #42 — My PR')
    expect(text).toContain('src/a.ts:7')
  })
})

describe('VerdictStep — consolidated review cost panel', () => {
  beforeEach(() => {
    signOut()
    signIn()
    _setCaptureForTest(noopCapture)
  })
  afterEach(() => {
    _setCaptureForTest(noopCapture)
    setShowTokenCost(false)
  })

  // Reconciling breakdown: the generator row's total (3.0k) covers BOTH the
  // verdict generation AND a single-pass task (Summary), so the rows now sum to
  // the aggregate total. Each row carries a per-task drilldown (byTask).
  const modelCostBreakdown = [
    {
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
      role: 'generator' as const,
      total: { prompt_tokens: 2000, completion_tokens: 1000, total_tokens: 3000 },
      surfaced: 4,
      uniqueCatch: 0,
      byTask: [
        { task: 'Verdict', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } },
        { task: 'Summary', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } },
      ],
    },
    {
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      role: 'verifier' as const,
      total: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
      impact: { confirms: 1, refutes: 1, uncertains: 0, decisive: 1 },
      byTask: [
        { task: 'Verdict', usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 } },
      ],
    },
  ]

  const totalUsage = { prompt_tokens: 2800, completion_tokens: 1200, total_tokens: 4000 }

  it('shows the per-model impact readout (NOT gated on showTokenCost)', () => {
    setShowTokenCost(false)
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, modelCostBreakdown, totalUsage },
    })
    expect(screen.getByText('Model performance')).toBeInTheDocument()
    // Generator impact
    expect(screen.getByText('4 surfaced findings')).toBeInTheDocument()
    // Verifier decisive impact
    expect(screen.getByText(/1 decisive refute \(removed a finding\)/)).toBeInTheDocument()
    // Cost + aggregate total hidden when showTokenCost off
    expect(screen.queryByText(/This review used/)).not.toBeInTheDocument()
  })

  it('adds the aggregate total + per-model cost when showTokenCost is on', () => {
    setShowTokenCost(true)
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, modelCostBreakdown, totalUsage },
    })
    // Aggregate headline from totalUsage (4.0k tokens). The label is interpolated
    // into separate text nodes, so match on the labelled element's text content.
    const total = screen.getByLabelText('Total token usage for this review')
    expect(total.textContent).toMatch(/This review used .*4\.0k tokens.* total/)
    // claude-opus-4-8's TOTAL row covers verdict + summary = 3.0k (proving
    // single-pass spend is now folded in). Match on the token portion only — the
    // cost cell is dollar-first ("$… · 3.0k tokens") after the #155 pricing backfill.
    expect(screen.getByText(/3\.0k tokens/)).toBeInTheDocument()
  })

  it('expands a model row to its per-task drilldown', async () => {
    setShowTokenCost(true)
    const user = userEvent.setup()
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, modelCostBreakdown, totalUsage },
    })
    // The generator row's toggle is collapsed by default — no per-task entries yet.
    const toggle = screen.getAllByRole('button', { name: /claude-opus-4-8/ })[0]
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Summary')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Drilldown shows which task spent what. Scope to the task-name nodes (the word
    // "Verdict" also appears in the assessment heading; entries use .task-name).
    const taskNames = document.querySelectorAll('.task-name')
    const taskLabels = Array.from(taskNames).map((n) => n.textContent)
    expect(taskLabels).toContain('Verdict')
    expect(taskLabels).toContain('Summary')
    // Each Verdict + Summary slice is 1.5k tokens (token portion of the cell).
    expect(screen.getAllByText(/1\.5k tokens/).length).toBeGreaterThanOrEqual(2)
  })

  it('renders nothing when no models ran and no usage to show', () => {
    render(VerdictStep, {
      props: { prRef, commitId, store: makeStore(), prUrl, submitFn: okSubmit, modelCostBreakdown: [], totalUsage: undefined },
    })
    expect(screen.queryByText('Model performance')).not.toBeInTheDocument()
    expect(screen.queryByText(/This review used/)).not.toBeInTheDocument()
  })
})
