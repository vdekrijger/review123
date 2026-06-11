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
  import CommentEditor from './CommentEditor.svelte'
  import type { PrRef } from '../lib/github/parse'
  import type { createDraftStore } from '../lib/drafts/drafts.svelte'

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
  }

  let { prRef, commitId, store, prUrl, submitFn = submitReview }: Props = $props()

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
      <button type="button" class="signin-btn" onclick={handleSignIn}>Sign in with GitHub</button>
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

  .signin-btn {
    padding: 0.5rem 1.25rem;
    border: none;
    border-radius: 6px;
    background: #24292f;
    color: #fff;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
  }

  .signin-btn:hover {
    background: #1c2128;
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
    border: 1px solid #8883;
    border-radius: 6px;
    margin-bottom: 0.75rem;
  }

  .file-path {
    padding: 0.4rem 0.75rem;
    font-family: monospace;
    font-size: 0.85rem;
    cursor: pointer;
    background: #8881;
    border-radius: 5px 5px 0 0;
  }

  .draft-item {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid #8882;
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
    color: #d97706;
    font-size: 0.9rem;
    margin: 0;
  }

  .error-msg {
    color: #dc2626;
    font-size: 0.9rem;
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: 4px;
    padding: 0.6rem 0.75rem;
    margin: 0;
  }

  .verdict-group {
    border: 1px solid #8883;
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
    border: none;
    border-radius: 6px;
    background: #1a7f37;
    color: #fff;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }

  .submit-btn:hover:not(:disabled) {
    background: #156c30;
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
    color: #15803d;
    margin: 0;
  }

  .view-link {
    display: inline-block;
    padding: 0.4rem 1rem;
    border-radius: 6px;
    background: #1a7f37;
    color: #fff;
    text-decoration: none;
    font-size: 0.9rem;
  }

  .view-link:hover {
    background: #156c30;
  }
</style>
