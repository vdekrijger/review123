<script lang="ts">
  /**
   * VerdictStep — review recap, verdict selection, and submission.
   *
   * Props:
   *   prRef     - The PR to submit the review on.
   *   commitId  - The commit SHA to anchor the review to.
   *   store     - The reactive draft store for this PR.
   *   prUrl     - Full GitHub PR URL for the success link.
   *   submitFn  - (optional) Override submitReview — used in tests for prop injection.
   *   coachFn   - (optional) Override run.coach — DI seam for tests.
   *
   * EC-09a: APPROVE allows empty body/no drafts.
   * EC-09c, EC-19b: Signed out → sign-in prompt only, no form.
   * EC-09d/e/f: errors rendered verbatim in role=alert, drafts NOT cleared.
   * EC-09g: drafts cleared ONLY on success.
   */
  import { authState } from '../lib/auth/authState.svelte'
  import { beginSignIn } from '../lib/auth/auth'
  import { submitReview, type Verdict, type SubmitOutcome } from '../lib/github/review'
  import { renderMarkdown } from '../lib/markdown/render'
  import { track } from '../lib/analytics/analytics'
  import { getSettings } from '../lib/settings/settings'
  import CommentEditor from './CommentEditor.svelte'
  import GitHubSignInButton from './GitHubSignInButton.svelte'
  import type { PrRef } from '../lib/github/parse'
  import type { createDraftStore } from '../lib/drafts/drafts.svelte'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import type { CoachResult } from '../lib/ai/schemas'

  const RETURN_KEY = 'review123:returnTo'

  interface Props {
    prRef: PrRef
    commitId: string
    store: ReturnType<typeof createDraftStore>
    prUrl: string
    /**
     * Override the submit function — allows tests to inject a stub without
     * module-level mocking. Defaults to the real submitReview.
     */
    submitFn?: (
      ref: PrRef,
      verdict: Verdict,
      bodyText: string,
      drafts: ReturnType<typeof createDraftStore>['drafts'],
      commitId: string,
    ) => Promise<SubmitOutcome>
    /**
     * Override the coach function — DI seam for tests. In production,
     * Review.svelte passes run.coach.
     */
    coachFn?: (drafts: Draft[]) => Promise<CoachResult | { error: string }>
  }

  let { prRef, commitId, store, prUrl, submitFn = submitReview, coachFn }: Props = $props()

  // Derive signed-in status reactively from authState so the UI flips live
  // when the user completes OAuth (EC-REACT: no reload required).
  const isSignedIn = $derived(authState.auth !== null)

  const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined

  async function handleSignIn() {
    sessionStorage.setItem(RETURN_KEY, location.pathname)
    location.assign(await beginSignIn('public_repo'))
  }

  // ---- Local state ----
  let verdict = $state<Verdict>('COMMENT')
  let body = $state('')
  let pending = $state(false)
  let errorMsg = $state<string | null>(null)
  let success = $state(false)
  let clientHint = $state<string | null>(null)

  // ---- Coach state ----
  let coachPending = $state(false)
  let coachResult = $state<CoachResult | null>(null)
  let coachError = $state<string | null>(null)
  // Track dismissed suggestions by draft index
  let dismissedSuggestions = $state<Set<number>>(new Set())

  // Show coach button: signed in + has drafts + key configured + coachFn provided
  const showCoachButton = $derived(
    isSignedIn && store.count > 0 && !!getSettings().deepseekKey && !!coachFn
  )

  async function handleCoach() {
    if (!coachFn) return
    coachPending = true
    coachError = null
    coachResult = null
    dismissedSuggestions = new Set()
    try {
      const result = await coachFn([...store.drafts])
      if ('error' in result) {
        coachError = result.error
      } else {
        coachResult = result
        track('ai_task_completed', { task: 'coach', cached: false })
      }
    } finally {
      coachPending = false
    }
  }

  async function applyCoachSuggestion(draftIndex: number, suggestion: string) {
    const draft = store.drafts[draftIndex]
    if (!draft) return
    await store.upsert({ path: draft.path, line: draft.line, side: draft.side, body: suggestion })
    // Dismiss the suggestion card after applying
    dismissedSuggestions = new Set([...dismissedSuggestions, draftIndex])
  }

  function dismissSuggestion(draftIndex: number) {
    dismissedSuggestions = new Set([...dismissedSuggestions, draftIndex])
  }

  /** Render clarity as N filled + (5-N) empty stars */
  function clarityStars(n: number): string {
    return '★'.repeat(n) + '☆'.repeat(5 - n)
  }

  // Group drafts by path for the recap section
  const draftsByPath = $derived.by(() => {
    const map = new Map<string, typeof store.drafts>()
    for (const draft of store.drafts) {
      const arr = map.get(draft.path) ?? []
      arr.push(draft)
      map.set(draft.path, arr)
    }
    return map
  })

  // ---- Submit handler ----

  async function handleSubmit() {
    // Client-side guard (EC-09a): APPROVE is always allowed; REQUEST_CHANGES/COMMENT
    // need at least an overall body or at least one draft.
    if (verdict !== 'APPROVE' && !body.trim() && store.count === 0) {
      clientHint = 'Add a comment or draft at least one line comment first.'
      return
    }
    clientHint = null

    const countBeforeSubmit = store.count
    const currentDrafts = [...store.drafts]

    pending = true
    errorMsg = null

    let result: SubmitOutcome
    try {
      result = await submitFn(prRef, verdict, body, currentDrafts, commitId)
    } finally {
      pending = false
    }

    if (result.ok) {
      // EC-09g: clear drafts ONLY on success
      await store.clearAll()
      track('review_submitted', { verdict, comment_count: countBeforeSubmit })
      success = true
    } else {
      // EC-09d/e/f: render message verbatim; drafts NOT cleared
      errorMsg = result.message
    }
  }
</script>

{#if !isSignedIn}
  <!-- EC-09c, EC-19b: signed-out state — no form, sign-in prompt only -->
  <div class="signed-out" role="status">
    {#if clientId}
      <p>Authentication required — use OAuth or add a PAT in Settings.</p>
      <GitHubSignInButton onclick={handleSignIn} />
    {:else}
      <p>Add a GitHub PAT in Settings to submit your review.</p>
      <a href="#settings">Open Settings</a>
    {/if}
  </div>
{:else if success}
  <!-- Success state -->
  <div class="success-panel" role="status">
    <p class="success-msg">Your review was submitted successfully.</p>
    <a href={prUrl} target="_blank" rel="noopener nofollow" class="view-link">View on GitHub</a>
  </div>
{:else}
  <!-- Main form -->
  <div class="verdict-step">
    <!-- Recap: drafted line comments grouped by file -->
    {#if store.count > 0}
      <section class="drafts-recap" aria-label="Drafted comments">
        <h3>Drafted comments ({store.count})</h3>
        {#each [...draftsByPath.entries()] as [path, fileDrafts] (path)}
          <details open class="file-group">
            <summary class="file-path">{path}</summary>
            {#each fileDrafts as draft (draft.path + '|' + draft.line + '|' + draft.side)}
              <div class="draft-item">
                <span class="draft-line-label">Line {draft.line} ({draft.side})</span>
                <!-- renderMarkdown output is the only acceptable use of {@html} here -->
                <div class="draft-body">{@html renderMarkdown(draft.body)}</div>
              </div>
            {/each}
          </details>
        {/each}
      </section>
    {:else}
      <p class="no-drafts">No line comments drafted yet. You can still leave an overall comment below.</p>
    {/if}

    <!-- Coach my comments -->
    {#if showCoachButton}
      <section class="coach-section">
        <button
          class="coach-btn"
          onclick={handleCoach}
          disabled={coachPending}
          aria-busy={coachPending}
        >
          {coachPending ? 'Coaching…' : 'Coach my comments'}
        </button>

        {#if coachError}
          <p class="coach-error" role="alert">{coachError}</p>
        {/if}

        {#if coachResult}
          <div class="coach-results">
            {#each coachResult.reviews as review (review.index)}
              {@const draft = store.drafts[review.index]}
              {#if draft}
                <div class="coach-card">
                  <div class="coach-card-header">
                    <span class="coach-draft-ref">{draft.path} line {draft.line}</span>
                    <span
                      class="coach-stars"
                      aria-label="clarity {review.clarity} of 5"
                    >{clarityStars(review.clarity)}</span>
                    <span class="coach-chip tone-{review.tone}">{review.tone}</span>
                    <span class="coach-chip actionable-{review.actionable}">{review.actionable ? '✓ actionable' : '✗ actionable'}</span>
                  </div>

                  {#if review.biasQuestion}
                    <div class="coach-bias-callout">
                      <strong>Bias check:</strong> {review.biasQuestion}
                    </div>
                  {/if}

                  {#if review.suggestion && !dismissedSuggestions.has(review.index)}
                    <blockquote class="coach-suggestion">
                      <p>{review.suggestion}</p>
                      <div class="coach-suggestion-actions">
                        <button
                          class="coach-apply-btn"
                          onclick={() => applyCoachSuggestion(review.index, review.suggestion!)}
                        >Apply suggestion</button>
                        <button
                          class="coach-dismiss-btn"
                          onclick={() => dismissSuggestion(review.index)}
                        >Dismiss</button>
                      </div>
                    </blockquote>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    <!-- Overall comment editor -->
    <section class="overall-comment">
      <h3>Overall comment</h3>
      <CommentEditor
        value={body}
        onchange={(v) => { body = v; clientHint = null }}
        onsubmit={handleSubmit}
      />
    </section>

    <!-- Client-side validation hint -->
    {#if clientHint}
      <p class="client-hint" role="status">{clientHint}</p>
    {/if}

    <!-- Error message from API -->
    {#if errorMsg}
      <p class="error-msg" role="alert">{errorMsg}</p>
    {/if}

    <!-- Verdict radio group -->
    <fieldset class="verdict-group">
      <legend>Verdict</legend>
      <label class="verdict-label">
        <input type="radio" name="verdict" value="COMMENT" bind:group={verdict} />
        Comment
      </label>
      <label class="verdict-label">
        <input type="radio" name="verdict" value="APPROVE" bind:group={verdict} />
        Approve
      </label>
      <label class="verdict-label">
        <input type="radio" name="verdict" value="REQUEST_CHANGES" bind:group={verdict} />
        Request changes
      </label>
    </fieldset>

    <!-- Submit -->
    <button
      class="submit-btn"
      onclick={handleSubmit}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? 'Submitting…' : 'Submit review'}
    </button>
  </div>
{/if}

<style>
  .signed-out {
    padding: 1.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .verdict-step {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 56rem;
  }

  .drafts-recap h3,
  .overall-comment h3 {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
  }

  .file-group {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    margin-bottom: 0.75rem;
  }

  .file-path {
    padding: 0.4rem 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    cursor: pointer;
    background: var(--surface-raised);
    border-radius: 5px 5px 0 0;
  }

  .draft-item {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--hairline);
  }

  .draft-line-label {
    font-size: 0.78rem;
    opacity: 0.6;
    display: block;
    margin-bottom: 0.25rem;
  }

  .draft-body :global(p) { margin: 0.25rem 0; }
  .draft-body :global(pre) { overflow-x: auto; }

  .no-drafts {
    opacity: 0.6;
    font-style: italic;
    margin: 0;
  }

  .client-hint {
    color: var(--legend-changed-color);
    font-size: 0.9rem;
    margin: 0;
  }

  .error-msg {
    color: var(--legend-removed-color);
    font-size: 0.9rem;
    background: var(--legend-removed-bg);
    border: 1px solid var(--legend-removed-border);
    border-radius: 4px;
    padding: 0.6rem 0.75rem;
    margin: 0;
  }

  .verdict-group {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .verdict-group legend {
    font-weight: 600;
    font-size: 0.9rem;
    padding: 0 0.25rem;
  }

  .verdict-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    font-size: 0.95rem;
  }

  .submit-btn {
    align-self: flex-start;
    padding: 0.5rem 1.25rem;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: #0a1410;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: filter 150ms;
  }

  .submit-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .submit-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .success-panel {
    padding: 1.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .success-msg {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--legend-added-color);
    margin: 0;
  }

  .view-link {
    display: inline-block;
    padding: 0.4rem 1rem;
    border-radius: 6px;
    background: var(--accent);
    color: #0a1410;
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 600;
  }

  .view-link:hover {
    filter: brightness(1.1);
  }

  /* ---- Coach ---- */
  .coach-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .coach-btn {
    align-self: flex-start;
    padding: 0.4rem 1rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .coach-btn:hover:not(:disabled) {
    background: var(--surface-raised);
  }

  .coach-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .coach-error {
    color: var(--legend-removed-color);
    font-size: 0.9rem;
    background: var(--legend-removed-bg);
    border: 1px solid var(--legend-removed-border);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    margin: 0;
  }

  .coach-results {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .coach-card {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .coach-card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .coach-draft-ref {
    font-family: var(--font-mono);
    font-size: 0.8rem;
    opacity: 0.7;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .coach-stars {
    font-size: 1rem;
    letter-spacing: 0.05em;
  }

  .coach-chip {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid transparent;
    font-weight: 500;
  }

  .tone-ok {
    background: var(--surface-raised);
    border-color: var(--hairline);
    color: inherit;
    opacity: 0.8;
  }

  .tone-blunt {
    background: var(--legend-changed-bg);
    border-color: var(--legend-changed-border);
    color: var(--legend-changed-color);
  }

  .tone-harsh {
    background: var(--legend-removed-bg);
    border-color: var(--legend-removed-border);
    color: var(--legend-removed-color);
  }

  .actionable-true {
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border);
    color: var(--legend-added-color);
  }

  .actionable-false {
    background: var(--surface-raised);
    border-color: var(--hairline);
    color: var(--text-muted);
  }

  .coach-bias-callout {
    background: var(--legend-changed-bg);
    border: 1px solid var(--legend-changed-border);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.88rem;
    color: var(--legend-changed-color);
  }

  .coach-suggestion {
    border-left: 3px solid var(--hairline);
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: var(--surface-raised);
    border-radius: 0 4px 4px 0;
  }

  .coach-suggestion p {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    font-style: italic;
  }

  .coach-suggestion-actions {
    display: flex;
    gap: 0.5rem;
  }

  .coach-apply-btn {
    font-size: 0.8rem;
    padding: 0.2rem 0.6rem;
    border-radius: 4px;
    border: 1px solid var(--legend-added-border);
    background: transparent;
    color: var(--legend-added-color);
    cursor: pointer;
    font-weight: 500;
  }

  .coach-apply-btn:hover {
    background: var(--legend-added-bg);
  }

  .coach-dismiss-btn {
    font-size: 0.8rem;
    padding: 0.2rem 0.6rem;
    border-radius: 4px;
    border: 1px solid var(--hairline);
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }

  .coach-dismiss-btn:hover {
    opacity: 1;
    background: #8882;
  }
</style>
