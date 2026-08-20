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
  import { beginOAuth } from '../lib/auth/oauthFlow'
  import { submitReview, type Verdict, type SubmitOutcome, type SubmitBreakdown } from '../lib/github/review'
  import { splitDraftsByAnchor } from '../lib/github/anchorSplit'
  import { resolveViewerLogin } from '../lib/provider/viewer'
  import { isSelfReviewGated } from '../lib/provider/selfReview'
  import { renderMarkdown } from '../lib/markdown/render'
  import { track } from '../lib/analytics/analytics'
  import { activeProviderHasKey } from '../lib/llm/config'
  import CommentEditor from './CommentEditor.svelte'
  import GitHubSignInButton from './GitHubSignInButton.svelte'
  import Spinner from './Spinner.svelte'
  import AiProgress from './AiProgress.svelte'
  import type { PrRef } from '../lib/github/parse'
  import type { createDraftStore } from '../lib/drafts/drafts.svelte'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import { draftKey, isStaleDraft, draftTimeLabel, draftTimeTitle } from '../lib/drafts/drafts.svelte'
  import { COACH_DIMENSIONS, type CoachDimension, type CoachResult, type CommentReview } from '../lib/ai/schemas'
  import type { PrComment } from '../lib/github/comments'
  import type { ReviewProvider } from '../lib/provider/types'
  import type { LlmUsage } from '../lib/llm/llm'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { formatUsageLabel } from '../lib/ai/tokenCost'
  import ReviewCostPanel from './ReviewCostPanel.svelte'
  import type { VerdictModelBreakdown } from '../lib/ai/run.svelte'
  import type { ModelCostRow } from '../lib/ai/modelCostBreakdown'
  import { buildReviewPrompt } from '../lib/ai/reviewPrompt'
  import { buildReviewCommand, type ReviewExportFormat } from '../lib/github/reviewExport'
  import type { PrFile } from '../lib/github/types'

  interface Props {
    prRef: PrRef
    commitId: string
    store: ReturnType<typeof createDraftStore>
    prUrl: string
    /** PR title — for the "Copy as LLM prompt" preamble. */
    prTitle?: string
    /** Changed files (patches) — current-code excerpts in the exported prompt. */
    files?: PrFile[]
    /** Full file contents map, when fetched — wider current-code windows. */
    contentsMap?: Map<string, { before: string | null; after: string | null }> | null
    /**
     * Override clipboard write — DI seam for tests. Defaults to the real
     * navigator.clipboard.writeText.
     */
    copyFn?: (text: string) => Promise<void>
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
      files?: PrFile[],
    ) => Promise<SubmitOutcome>
    /**
     * Override the coach function — DI seam for tests. In production,
     * Review.svelte passes run.coach. The third argument is the verdict
     * selected at coaching time, enabling the verdict-coherence check.
     */
    coachFn?: (drafts: Draft[], prComments?: string[], verdict?: Verdict) => Promise<(CoachResult & { usage?: LlmUsage; notCoached?: { indices: number[]; message: string; detail?: string } }) | { error: string; errorDetail?: string }>
    /**
     * Consolidated per-model cost + performance for the WHOLE review (verdict
     * generator/verifiers + every reviewer's models, aggregated). Drives the
     * Step-3 "Review cost & model performance" panel. The cost column is gated
     * on showTokenCost; the impact readout shows whenever this is non-empty.
     */
    modelPerformance?: VerdictModelBreakdown[]
    /**
     * Per-model cost breakdown that RECONCILES with totalUsage — each row's
     * total sums ALL its task contributions (ensemble verdict/reviewer rows AND
     * the single-pass tasks on the active model). Drives the expandable Step-3
     * cost panel. The cost is gated on showTokenCost; impact always shows.
     */
    modelCostBreakdown?: ModelCostRow[]
    /** Sum of every task's captured usage for this review — the aggregate total. */
    totalUsage?: LlmUsage
    /**
     * Existing PR review comments — passed through to coachFn for duplicate detection.
     * Capped at 30, truncated at 200ch inside coachPrompt.
     */
    prComments?: PrComment[]
    /**
     * The active review provider. Optional — when absent or when atomicReview is true,
     * no non-atomic note is shown (GitHub behaviour).
     */
    provider?: ReviewProvider
    /**
     * The PR author's provider-canonical login (PrMeta.authorLogin). Used with
     * the resolved viewer identity to gate Approve / Request changes on the
     * viewer's own PR. Absent/null → no gating.
     */
    authorLogin?: string | null
    /**
     * Override viewer identity resolution — DI seam for tests. Defaults to the
     * session-cached resolveViewerLogin.
     */
    resolveViewerFn?: (provider: ReviewProvider) => Promise<string | null>
  }

  let {
    prRef,
    commitId,
    store,
    prUrl,
    prTitle = '',
    files = [],
    contentsMap = null,
    copyFn = (text: string) => navigator.clipboard.writeText(text),
    submitFn = submitReview,
    coachFn,
    modelPerformance = [],
    modelCostBreakdown = [],
    totalUsage,
    prComments = [],
    provider,
    authorLogin = null,
    resolveViewerFn = resolveViewerLogin,
  }: Props = $props()

  // Derive signed-in status reactively from authState so the UI flips live
  // when the user completes OAuth (EC-REACT: no reload required).
  // For non-GitHub providers, use the provider's own authState().configured check.
  const isSignedIn = $derived(
    provider && provider.id !== 'github'
      ? provider.authState().configured
      : authState.auth !== null
  )

  const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined

  async function handleSignIn() {
    // Shared helper: clears stale pending sessions + stores returnTo so the
    // user comes back to this PR after the OAuth round-trip.
    location.assign(await beginOAuth('github'))
  }

  // ---- Local state ----
  let verdict = $state<Verdict>('COMMENT')
  let body = $state('')
  let pending = $state(false)
  let submitError = $state<{ kind: string; message: string } | null>(null)
  let success = $state(false)
  // How the successful submission's comments were actually posted — drives
  // the honest post-submit breakdown line. Null when the outcome carried none.
  let successPosted = $state<SubmitBreakdown | null>(null)
  let clientHint = $state<string | null>(null)

  // ---- Own-PR verdict gating ----
  // Resolve the viewer identity only when it can matter: signed in, on a
  // provider that rejects self-review, with a known PR author.
  let viewerLogin = $state<string | null>(null)

  $effect(() => {
    if (!provider || !provider.capabilities.selfReviewBlocked) return
    if (!isSignedIn || authorLogin == null) return
    let cancelled = false
    resolveViewerFn(provider).then((login) => {
      if (!cancelled) viewerLogin = login
    })
    return () => {
      cancelled = true
    }
  })

  const selfReviewGated = $derived(
    isSelfReviewGated(provider?.capabilities.selfReviewBlocked ?? false, viewerLogin, authorLogin),
  )

  // If gating resolves after the user already picked a blocked verdict, fall
  // back to COMMENT so the submit button never sends a doomed request.
  $effect(() => {
    if (selfReviewGated && verdict !== 'COMMENT') verdict = 'COMMENT'
  })

  // ---- Coach state ----
  let coachPending = $state(false)
  let coachResult = $state<CoachResult | null>(null)
  let coachError = $state<string | null>(null)
  // The concrete upstream failure behind coachError (describeTaskError detail)
  // — surfaced as a hover tooltip, same pattern as PanelState.errorDetail.
  let coachErrorDetail = $state<string | null>(null)
  // Partial-failure note: present when SOME comments couldn't be coached (a
  // chunk failed) while others succeeded. We still show the graded results plus
  // this honest note + a Retry affordance — never silently dropping comments.
  // `detail` (when present) is the failing chunk's concrete error, on hover.
  let coachNotCoached = $state<{ indices: number[]; message: string; detail?: string } | null>(null)
  // Token usage from the last coach run (display-only, behind showTokenCost).
  let coachUsage = $state<LlmUsage | undefined>(undefined)
  const coachUsageLabel = $derived(
    settingsState.current.showTokenCost ? formatUsageLabel(coachUsage) : null,
  )
  // Track dismissed suggestions by draft index
  let dismissedSuggestions = $state<Set<number>>(new Set())

  // Show coach button: signed in + has drafts + key configured + coachFn provided
  const showCoachButton = $derived(
    isSignedIn && store.count > 0 && activeProviderHasKey() && !!coachFn
  )

  async function handleCoach() {
    if (!coachFn) return
    coachPending = true
    coachError = null
    coachErrorDetail = null
    coachResult = null
    coachUsage = undefined
    coachNotCoached = null
    dismissedSuggestions = new Set()
    try {
      // Pass existing PR comment bodies for duplicate detection, and the
      // currently-selected verdict for the coherence check.
      const prCommentBodies = prComments.map((c) => c.body)
      const result = await coachFn([...store.drafts], prCommentBodies, verdict)
      if ('error' in result) {
        coachError = result.error
        coachErrorDetail = result.errorDetail ?? null
      } else {
        coachResult = result
        coachUsage = result.usage
        // Partial run: keep the graded results AND surface which comments were
        // not coached + why (the message carries a retry hint).
        coachNotCoached = result.notCoached ?? null
        track('ai_task_completed', { task: 'coach', cached: false })
      }
    } finally {
      coachPending = false
    }
  }

  async function applyCoachSuggestion(draftIndex: number, suggestion: string) {
    const draft = store.drafts[draftIndex]
    if (!draft) return
    // EDIT in place: pass the draft's own ordinal so the suggestion replaces
    // THIS draft (multiple drafts can coexist at one line — omitting n would
    // clobber the n=0 draft or, with append semantics, duplicate the comment).
    await store.upsert({ path: draft.path, line: draft.line, side: draft.side, body: suggestion, n: draft.n ?? 0 })
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

  /**
   * Self-evident accuracy chip labels — "consistent" alone was opaque.
   * The dimension measures the comment's claim against the PR diff.
   */
  const ACCURACY_LABELS: Record<CommentReview['accuracy'], string> = {
    consistent: 'matches the diff',
    questionable: 'hard to verify against the diff',
    contradicted: 'contradicted by the diff',
  }

  /** Friendly per-dimension labels for the expandable rationale list. */
  const DIMENSION_LABELS: Record<CoachDimension, string> = {
    clarity: 'Clarity',
    tone: 'Tone',
    actionable: 'Actionable',
    accuracy: 'Diff accuracy',
    duplicate: 'Duplicate check',
    specificity: 'Specificity',
    grounded: 'Grounded in diff',
  }

  /** One-line rationale for a dimension, or '' when the response omitted it. */
  function reasonFor(review: CommentReview, dim: CoachDimension): string {
    const r = review.reasons?.[dim]
    return typeof r === 'string' ? r : ''
  }

  /** [label, reason] pairs in dimension order — only for reasons present in the response. */
  function reasonEntries(review: CommentReview): [string, string][] {
    return COACH_DIMENSIONS
      .filter((dim) => reasonFor(review, dim).length > 0)
      .map((dim) => [DIMENSION_LABELS[dim], reasonFor(review, dim)])
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

  // ---- Draft lifecycle in the recap ----

  /** Remove ONE draft — single click (it's one visible comment, no confirm). */
  function removeDraft(draft: Draft) {
    void store.remove(draftKey(draft))
  }

  /** Stale = the draft's file is no longer in the PR's current diff. */
  function isDraftStale(draft: Draft): boolean {
    return isStaleDraft(draft, files, commitId).stale
  }

  // ---- Off-diff anchors: pre-submit split -------------------------------
  // Same client-side truth as the submit path (splitDraftsByAnchor): drafts
  // whose line is NOT in the diff hunks can't post as line comments — they'll
  // be re-routed to file-level comments. Surface that BEFORE submitting.
  // With no files (demo/tests) the split is skipped — no chips, no note.
  const offDiffDrafts = $derived(splitDraftsByAnchor([...store.drafts], files).offDiff)
  const offDiffKeys = $derived(new Set(offDiffDrafts.map((d) => draftKey(d))))

  /** Off-diff AND not stale — stale (file gone) already has its own chip. */
  function isDraftOffDiff(draft: Draft): boolean {
    return offDiffKeys.has(draftKey(draft)) && !isDraftStale(draft)
  }

  /** "K posted inline · M posted as file comments (line not in diff) · …" */
  function postedBreakdownLabel(posted: SubmitBreakdown): string {
    const parts = [`${posted.inline} posted inline`]
    if (posted.fileLevel > 0) {
      parts.push(
        posted.fileLevel === 1
          ? '1 posted as a file comment (line not in diff)'
          : `${posted.fileLevel} posted as file comments (line not in diff)`,
      )
    }
    if (posted.bodyFolded > 0) {
      parts.push(`${posted.bodyFolded} included in the review body (line not in diff)`)
    }
    return parts.join(' · ')
  }

  // "Clear all drafts (N)": two-step inline confirm (button morphs to
  // "Really clear N?"; resets on focusout/Escape — never window.confirm).
  let confirmingClearDrafts = $state(false)

  function handleClearAllDrafts() {
    if (!confirmingClearDrafts) {
      confirmingClearDrafts = true
      return
    }
    confirmingClearDrafts = false
    void store.clearAll()
  }

  function resetClearDraftsConfirm() {
    confirmingClearDrafts = false
  }

  function onClearDraftsKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && confirmingClearDrafts) {
      e.preventDefault()
      resetClearDraftsConfirm()
    }
  }

  // ---- Copy as LLM prompt ----
  // Deterministic export: assemble the drafted review into an agent-ready
  // markdown prompt and copy it to the clipboard. No LLM call, no key needed,
  // and it does NOT submit or clear drafts.
  let copied = $state(false)
  let copyError = $state<string | null>(null)
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  // Enabled when there's at least one draft OR a non-empty overall comment.
  const canCopyPrompt = $derived(store.count > 0 || body.trim().length > 0)

  async function handleCopyPrompt() {
    if (!canCopyPrompt) return
    copyError = null
    const itemCount = store.count
    const prompt = buildReviewPrompt({
      pr: {
        owner: prRef.owner,
        repo: prRef.repo,
        number: prRef.number,
        title: prTitle,
        provider: provider?.displayName ?? 'GitHub',
        url: prUrl,
      },
      verdict,
      drafts: [...store.drafts],
      overall: body,
      files,
      contents: contentsMap,
    })
    try {
      await copyFn(prompt)
    } catch {
      copyError = 'Could not copy to clipboard.'
      return
    }
    track('review_prompt_copied', { item_count: itemCount })
    copied = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied = false }, 2000)
  }

  // ---- Copy review command (GitHub only) ----
  // Deterministic export: wrap the SAME GitHub review JSON payload submitReview
  // would send into a paste-ready command in one of three formats. Posts the
  // whole review (overall comment + verdict + every drafted line comment) to the
  // PR WITHOUT installing the OAuth app. Like Copy-as-LLM-prompt, it NEVER
  // submits or clears drafts.
  //
  // GitHub only: the payload + endpoint are GitHub-specific. Hidden for
  // GitLab/Bitbucket. An absent provider is treated as GitHub (the demo route
  // passes no provider but uses a GitHub PR) — mirrors the isSignedIn check.
  const isGithubProvider = $derived(!provider || provider.id === 'github')

  const REVIEW_FORMAT_HINTS: Record<ReviewExportFormat, string> = {
    browser: 'Browser console — paste in devtools, needs a PAT',
    gh: 'gh — uses your gh login (no token needed)',
    curl: 'curl — needs $GITHUB_TOKEN',
  }

  // The export formats, in menu order. Each menu item builds + copies its own
  // format, so there's no separate "picked format" state — one click = copy.
  const REVIEW_FORMATS: { id: ReviewExportFormat; label: string }[] = [
    { id: 'browser', label: 'Browser console' },
    { id: 'gh', label: 'gh CLI' },
    { id: 'curl', label: 'curl' },
  ]

  let commandCopied = $state(false)
  let commandCopyError = $state<string | null>(null)
  let commandCopyTimer: ReturnType<typeof setTimeout> | undefined

  // Split menu-button state (trigger opens a dropdown of the 3 formats).
  let menuOpen = $state(false)
  let menuTriggerEl = $state<HTMLButtonElement | null>(null)
  function openMenu() {
    if (!canCopyPrompt) return
    menuOpen = true
  }
  function closeMenu() { menuOpen = false }
  function toggleMenu() { menuOpen ? closeMenu() : openMenu() }
  function focusFirstItem() {
    queueMicrotask(() => {
      ;(document.querySelector('.review-cmd-dropdown [role="menuitem"]') as HTMLElement | null)?.focus()
    })
  }
  function onTriggerKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(); focusFirstItem() }
    else if (e.key === 'Escape') closeMenu()
  }
  function onMenuKeydown(e: KeyboardEvent) {
    const items = [...(e.currentTarget as HTMLElement).querySelectorAll('[role="menuitem"]')] as HTMLElement[]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); menuTriggerEl?.focus() }
  }
  /** Close when focus leaves the whole menu (trigger + dropdown). */
  function onMenuFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null
    const root = (e.currentTarget as HTMLElement).closest('.review-cmd-menu')
    if (root && next && root.contains(next)) return
    closeMenu()
  }

  async function handleCopyCommand(format: ReviewExportFormat) {
    if (!canCopyPrompt) return
    closeMenu()
    commandCopyError = null
    const itemCount = store.count
    const command = buildReviewCommand(format, {
      owner: prRef.owner,
      repo: prRef.repo,
      number: prRef.number,
      commitId,
      verdict,
      body,
      drafts: [...store.drafts],
      files,
    })
    try {
      await copyFn(command)
    } catch {
      commandCopyError = 'Could not copy to clipboard.'
      return
    }
    track('review_command_copied', { format, item_count: itemCount })
    commandCopied = true
    if (commandCopyTimer) clearTimeout(commandCopyTimer)
    commandCopyTimer = setTimeout(() => { commandCopied = false }, 2000)
  }

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
    submitError = null

    let result: SubmitOutcome
    try {
      result = await submitFn(prRef, verdict, body, currentDrafts, commitId, files)
    } finally {
      pending = false
    }

    if (result.ok) {
      // EC-09g: clear drafts ONLY on success
      await store.clearAll()
      track('review_submitted', { verdict, comment_count: countBeforeSubmit })
      successPosted = result.posted ?? null
      success = true
    } else {
      // EC-09d/e/f: render message verbatim; drafts NOT cleared
      submitError = { kind: result.kind, message: result.message }
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
    {#if successPosted && (successPosted.fileLevel > 0 || successPosted.bodyFolded > 0)}
      <!-- Honest routing readout: some comments couldn't anchor to a diff
           line and were re-routed (file-level comments / review body). -->
      <p class="submit-breakdown" data-testid="submit-outcome-breakdown">
        {postedBreakdownLabel(successPosted)}
      </p>
    {/if}
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
            {#each fileDrafts as draft (draft.path + '|' + draft.line + '|' + draft.side + '|' + (draft.n ?? 0))}
              <div class="draft-item">
                <span class="draft-line-label">Line {draft.line} ({draft.side})</span>
                {#if draft.aiAuthored}
                  <span
                    class="ai-badge"
                    data-testid="recap-ai-badge"
                    title={`Suggested by an AI reviewer (${draft.aiReviewer ?? 'AI reviewer'})`}
                    aria-label={`Suggested by an AI reviewer: ${draft.aiReviewer ?? 'AI reviewer'}`}
                  >🤖 AI</span>
                {/if}
                <span
                  class="draft-time"
                  data-testid="recap-draft-time"
                  title={draftTimeTitle(draft.createdAt)}
                >{draftTimeLabel(draft.createdAt)}</span>
                {#if isDraftStale(draft)}
                  <span
                    class="draft-stale"
                    data-testid="recap-draft-stale"
                    title="This draft's file is not in the PR's current diff — it can't be posted as a line comment"
                  >file no longer in this PR</span>
                {:else if isDraftOffDiff(draft)}
                  <span
                    class="draft-offdiff"
                    data-testid="recap-draft-offdiff"
                    title="This line isn't part of the current diff — the comment will post as a file comment instead of a line comment"
                  >not in this diff</span>
                {/if}
                <button
                  class="draft-remove"
                  type="button"
                  data-testid="recap-draft-remove"
                  aria-label={`Remove draft at ${draft.path} line ${draft.line}${(draft.n ?? 0) > 0 ? ` (comment ${(draft.n ?? 0) + 1})` : ''}`}
                  title="Remove this draft"
                  onclick={() => removeDraft(draft)}
                >×</button>
                <!-- renderMarkdown output is the only acceptable use of {@html} here -->
                <div class="draft-body">{@html renderMarkdown(draft.body)}</div>
              </div>
            {/each}
          </details>
        {/each}
        <button
          class="clear-drafts-btn"
          class:clear-drafts-confirming={confirmingClearDrafts}
          type="button"
          data-testid="recap-clear-all"
          onclick={handleClearAllDrafts}
          onfocusout={resetClearDraftsConfirm}
          onkeydown={onClearDraftsKeydown}
        >
          {confirmingClearDrafts ? `Really clear ${store.count}?` : `Clear all drafts (${store.count})`}
        </button>
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
          {#if coachPending}<Spinner size="0.8em" />{/if}<span class="coach-btn-label">{coachPending ? 'Coaching…' : 'Coach my comments'}</span>
        </button>

        {#if coachPending}
          <!-- Unified AI progress: honest status line for the coach task. -->
          <AiProgress task="coach" state={{ status: 'loading' }} skeleton={false} />
        {/if}

        {#if coachError}
          <!-- title carries the concrete upstream failure (errorDetail) on
               hover — same diagnosability pattern as the task error chips. -->
          <p class="coach-error" role="alert" title={coachErrorDetail}>{coachError}</p>
        {/if}

        {#if coachNotCoached}
          <!-- Partial failure: some chunks failed. Show graded results + an
               honest note for the comments that weren't coached, with retry. -->
          <div class="coach-partial-note" role="alert" data-testid="coach-partial-note">
            <span title={coachNotCoached.detail}>{coachNotCoached.message}</span>
            <button class="coach-retry-btn" type="button" onclick={handleCoach} disabled={coachPending}>
              Retry
            </button>
          </div>
        {/if}

        {#if coachResult}
          <div class="coach-results">
            {#if coachResult.verdictCoherence && !coachResult.verdictCoherence.coherent}
              <div class="coach-coherence-card" role="alert" data-testid="coherence-card">
                <strong>Comments don't match your verdict:</strong> {coachResult.verdictCoherence.note}
              </div>
            {/if}
            {#each coachResult.reviews as review (review.index)}
              {@const draft = store.drafts[review.index]}
              {#if draft}
                <div class="coach-card">
                  <div class="coach-card-header">
                    <span class="coach-draft-ref">{draft.path} line {draft.line}</span>
                    <span
                      class="coach-stars"
                      title={reasonFor(review, 'clarity')}
                      aria-label="clarity {review.clarity} of 5"
                    >{clarityStars(review.clarity)}</span>
                    <span
                      class="coach-chip tone-{review.tone}"
                      title={reasonFor(review, 'tone')}
                      data-testid="tone-chip"
                    >tone: {review.tone}</span>
                    <span
                      class="coach-chip actionable-{review.actionable}"
                      title={reasonFor(review, 'actionable')}
                      data-testid="actionable-chip"
                    >{review.actionable ? '✓ actionable' : '✗ not actionable'}</span>
                    <span
                      class="coach-chip accuracy-{review.accuracy}"
                      title={reasonFor(review, 'accuracy') || (review.accuracyNote ?? '')}
                      data-testid="accuracy-chip"
                    >{ACCURACY_LABELS[review.accuracy]}</span>
                    {#if review.specificity !== undefined}
                      <span
                        class="coach-chip specificity-{review.specificity}"
                        title={reasonFor(review, 'specificity')}
                        data-testid="specificity-chip"
                      >{review.specificity ? '✓ points at concrete code' : '✗ vague — name the code'}</span>
                    {/if}
                    {#if review.grounded !== undefined}
                      <span
                        class="coach-chip grounded-{review.grounded}"
                        title={reasonFor(review, 'grounded')}
                        data-testid="grounded-chip"
                      >{review.grounded ? '✓ claims verifiable in diff' : '✗ claims not verifiable in diff'}</span>
                    {/if}
                    {#if review.duplicate}
                      <span
                        class="coach-chip duplicate-badge"
                        title={reasonFor(review, 'duplicate')}
                        data-testid="duplicate-badge"
                      >similar to an existing comment</span>
                    {/if}
                  </div>

                  {#if reasonEntries(review).length > 0}
                    <details class="coach-reasons" data-testid="coach-reasons">
                      <summary>Why these grades?</summary>
                      <ul>
                        {#each reasonEntries(review) as [label, reason] (label)}
                          <li><strong>{label}:</strong> {reason}</li>
                        {/each}
                      </ul>
                    </details>
                  {/if}

                  {#if review.accuracy === 'contradicted' && review.accuracyNote}
                    <div class="coach-accuracy-note" data-testid="accuracy-note">{review.accuracyNote}</div>
                  {/if}

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
          {#if coachUsageLabel}
            <p class="coach-usage-footer" aria-label="Token usage">·· {coachUsageLabel}</p>
          {/if}
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
    {#if submitError}
      <div class="error-msg" role="alert">
        <p>{submitError.message}</p>
        {#if clientId && (submitError.kind === 'forbidden' || (submitError.kind === 'unauthorized' && authState.auth?.method === 'oauth'))}
          <a
            href="https://github.com/settings/connections/applications/{clientId}"
            target="_blank"
            rel="noopener"
          >Check or request organization access for this app →</a>
        {/if}
      </div>
    {/if}

    <!-- Consolidated "Review cost & model performance": the WHOLE review's
         aggregate token total + per-model breakdown (verdict generator/verifiers
         AND every reviewer's models). The $/token parts are gated on
         showTokenCost; the impact readout always shows. Single place on Step 3
         for "what did this review cost / which models earned their keep". -->
    <ReviewCostPanel {modelCostBreakdown} {totalUsage} />

    <!-- Verdict radio group -->
    <fieldset class="verdict-group">
      <legend>Verdict</legend>
      <label class="verdict-label">
        <input type="radio" name="verdict" value="COMMENT" bind:group={verdict} />
        Comment
      </label>
      <label class="verdict-label" class:verdict-label-disabled={selfReviewGated}>
        <input type="radio" name="verdict" value="APPROVE" bind:group={verdict} disabled={selfReviewGated} />
        Approve
      </label>
      <label class="verdict-label" class:verdict-label-disabled={selfReviewGated}>
        <input type="radio" name="verdict" value="REQUEST_CHANGES" bind:group={verdict} disabled={selfReviewGated} />
        Request changes
      </label>
      {#if selfReviewGated && provider}
        <p class="self-review-note">
          {provider.displayName} doesn't allow reviewing your own PR — you can still comment.
        </p>
      {/if}
    </fieldset>

    {#if provider && !provider.capabilities.atomicReview}
      <p class="non-atomic-note">
        On {provider.displayName}, submitting posts each comment individually plus your approval — not a single atomic review.
      </p>
    {/if}

    {#if offDiffDrafts.length > 0}
      <!-- Pre-submit heads-up: these comments can't anchor to a diff line
           (same "not in this diff" semantics as the per-row chip) — they'll
           be re-routed instead of failing the review. Calm and factual. -->
      <p class="offdiff-note" data-testid="offdiff-presubmit-note">
        {#if offDiffDrafts.length === 1}
          1 comment isn't on a line in the current diff — it'll post as a file comment.
        {:else}
          {offDiffDrafts.length} comments aren't on lines in the current diff — they'll post as file comments.
        {/if}
      </p>
    {/if}

    <!-- Actions: submit (to provider) + copy as LLM prompt (export, no submit) -->
    <div class="actions">
      <!-- Submit -->
      <button
        class="submit-btn"
        onclick={handleSubmit}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? 'Submitting…' : 'Submit review'}
      </button>

      <!-- Copy as LLM prompt — deterministic export, never submits or clears drafts -->
      <button
        class="copy-prompt-btn"
        type="button"
        onclick={handleCopyPrompt}
        disabled={!canCopyPrompt}
        title={canCopyPrompt
          ? 'Copy your review as a prompt to paste into a coding agent'
          : 'Draft a comment or write an overall comment first'}
      >
        {copied ? 'Copied ✓' : 'Copy as LLM prompt'}
      </button>

      {#if isGithubProvider}
        <!-- Copy review command (GitHub only): a split menu button. Pick a format
             and it copies a self-contained command that posts the whole review to
             the PR without installing the OAuth app. All three wrap the SAME review
             JSON. Deterministic export — never submits or clears drafts. -->
        <div class="review-cmd-menu" data-testid="review-command" onfocusout={onMenuFocusOut}>
          <button
            class="copy-command-btn"
            type="button"
            bind:this={menuTriggerEl}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={!canCopyPrompt}
            onclick={toggleMenu}
            onkeydown={onTriggerKeydown}
            title={canCopyPrompt
              ? 'Copy a command that posts this whole review to the GitHub PR — no app install'
              : 'Draft a comment or write an overall comment first'}
          >
            {commandCopied ? 'Copied ✓' : 'Copy review command'}<span class="review-cmd-caret" aria-hidden="true">▾</span>
          </button>
          {#if menuOpen}
            <div class="review-cmd-dropdown" role="menu" tabindex="-1" aria-label="Review command format" onkeydown={onMenuKeydown}>
              {#each REVIEW_FORMATS as f (f.id)}
                <button class="review-cmd-item" type="button" role="menuitem" onclick={() => handleCopyCommand(f.id)}>
                  <span class="review-cmd-item-label">{f.label}</span>
                  <span class="review-cmd-item-hint">{REVIEW_FORMAT_HINTS[f.id]}</span>
                </button>
              {/each}
            </div>
          {/if}
          {#if commandCopyError}
            <span class="copy-error" role="alert">{commandCopyError}</span>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Transient confirmation / error, announced to assistive tech -->
    <p class="copy-status" role="status" aria-live="polite">
      {#if copyError}
        <span class="copy-error">{copyError}</span>
      {:else if copied}
        Review prompt copied to clipboard.
      {/if}
    </p>
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
    display: inline-block;
    margin-bottom: 0.25rem;
  }

  .draft-item .ai-badge {
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1;
    margin-left: 0.4rem;
    padding: 0.1rem 0.38rem;
    border-radius: 999px;
    border: 1px solid var(--hairline);
    background: var(--surface-raised, transparent);
    color: var(--text-muted, inherit);
    opacity: 0.85;
    white-space: nowrap;
    cursor: help;
    vertical-align: middle;
  }

  .draft-body :global(p) { margin: 0.25rem 0; }
  .draft-body :global(pre) { overflow-x: auto; }

  .draft-time {
    font-size: 0.72rem;
    font-weight: 500;
    margin-left: 0.4rem;
    padding: 0.1rem 0.38rem;
    border-radius: 999px;
    border: 1px solid var(--hairline);
    color: var(--text-muted, inherit);
    opacity: 0.85;
    white-space: nowrap;
    cursor: help;
    vertical-align: middle;
  }

  .draft-stale {
    font-size: 0.72rem;
    font-weight: 500;
    margin-left: 0.4rem;
    padding: 0.1rem 0.38rem;
    border-radius: 999px;
    background: var(--legend-changed-bg);
    border: 1px solid var(--legend-changed-border);
    color: var(--legend-changed-color);
    white-space: nowrap;
    cursor: help;
    vertical-align: middle;
  }

  .draft-offdiff {
    font-size: 0.72rem;
    font-weight: 500;
    margin-left: 0.4rem;
    padding: 0.1rem 0.38rem;
    border-radius: 999px;
    background: var(--legend-changed-bg);
    border: 1px solid var(--legend-changed-border);
    color: var(--legend-changed-color);
    white-space: nowrap;
    cursor: help;
    vertical-align: middle;
  }

  .draft-remove {
    float: right;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text-muted, inherit);
    font-size: 1rem;
    line-height: 1;
    padding: 0.05rem 0.35rem;
    cursor: pointer;
    opacity: 0.6;
  }

  .draft-remove:hover,
  .draft-remove:focus-visible {
    opacity: 1;
    color: var(--legend-removed-color);
    border-color: var(--legend-removed-border);
  }

  .clear-drafts-btn {
    align-self: flex-start;
    margin-top: 0.25rem;
    padding: 0.3rem 0.8rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted, inherit);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .clear-drafts-btn:hover {
    background: var(--surface-raised);
    color: var(--legend-removed-color);
  }

  .clear-drafts-confirming {
    border-color: var(--legend-removed-border);
    color: var(--legend-removed-color);
    background: var(--legend-removed-bg);
    font-weight: 600;
  }

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

  .non-atomic-note {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin: 0;
  }

  .offdiff-note {
    font-size: 0.85rem;
    color: var(--legend-changed-color);
    background: var(--legend-changed-bg);
    border: 1px solid var(--legend-changed-border);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    margin: 0;
  }

  .submit-breakdown {
    font-size: 0.88rem;
    color: var(--text-muted);
    margin: 0;
  }

  .verdict-label-disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .self-review-note {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin: 0.25rem 0 0;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .copy-prompt-btn {
    padding: 0.5rem 1.25rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .copy-prompt-btn:hover:not(:disabled) {
    background: var(--surface-raised);
  }

  .copy-prompt-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .copy-status {
    margin: 0;
    min-height: 1.1rem;
    font-size: 0.85rem;
    color: var(--legend-added-color);
  }

  .copy-status .copy-error {
    color: var(--legend-removed-color);
  }

  /* ---- Copy review command (GitHub only) — split menu button ---- */
  .review-cmd-menu {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  .copy-command-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1.25rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .copy-command-btn:hover:not(:disabled) {
    background: var(--surface-raised);
  }

  .copy-command-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .review-cmd-caret {
    font-size: 0.7em;
    color: var(--text-muted);
  }

  .review-cmd-dropdown {
    position: absolute;
    z-index: 30;
    top: calc(100% + 0.35rem);
    left: 0;
    min-width: 16rem;
    max-width: min(24rem, 90vw);
    padding: 0.25rem;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .review-cmd-item {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    width: 100%;
    box-sizing: border-box;
    padding: 0.45rem 0.6rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .review-cmd-item:hover,
  .review-cmd-item:focus-visible {
    background: var(--surface-hover, rgba(127, 127, 127, 0.1));
    outline: none;
  }

  .review-cmd-item-label {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .review-cmd-item-hint {
    font-size: 0.76rem;
    color: var(--text-muted);
  }

  .review-cmd-menu .copy-error {
    margin-left: 0.5rem;
    font-size: 0.82rem;
    color: var(--legend-removed-color);
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
    /* Lay the spinner and label out as a row with a gap so the spinner never
       butts up against the "Coaching…" text (the indicator had no space). */
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
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

  .coach-btn-label {
    line-height: 1;
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

  /* Partial-failure note: graded results shown, but N comments couldn't be
     coached — honest message + retry. Uses the "changed" (warning) palette so
     it reads as a soft warning in both themes, distinct from a hard error. */
  .coach-partial-note {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    background: var(--legend-changed-bg);
    border: 1px solid var(--legend-changed-border);
    color: var(--legend-changed-color);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.88rem;
  }

  .coach-retry-btn {
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--legend-changed-border);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
  }

  .coach-retry-btn:hover:not(:disabled) {
    background: var(--surface-raised);
  }

  .coach-retry-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .coach-usage-footer {
    margin: 0.3rem 0 0;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.5;
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

  /* accuracy chip variants */
  .accuracy-consistent {
    background: var(--surface-raised);
    border-color: var(--hairline);
    color: inherit;
    opacity: 0.7;
  }

  .accuracy-questionable {
    background: #fff8e1;
    border-color: #f9a825;
    color: #e65100;
  }

  .accuracy-contradicted {
    background: var(--legend-removed-bg);
    border-color: var(--legend-removed-border);
    color: var(--legend-removed-color);
  }

  .duplicate-badge {
    background: var(--legend-changed-bg);
    border-color: var(--legend-changed-border);
    color: var(--legend-changed-color);
    font-style: italic;
  }

  .coach-accuracy-note {
    font-size: 0.82rem;
    color: var(--legend-removed-color);
    background: var(--legend-removed-bg);
    border: 1px solid var(--legend-removed-border);
    border-radius: 4px;
    padding: 0.35rem 0.6rem;
  }

  /* specificity chip variants */
  .specificity-true {
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border);
    color: var(--legend-added-color);
  }

  .specificity-false {
    background: var(--legend-changed-bg);
    border-color: var(--legend-changed-border);
    color: var(--legend-changed-color);
  }

  /* grounded chip variants */
  .grounded-true {
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border);
    color: var(--legend-added-color);
  }

  .grounded-false {
    background: var(--legend-changed-bg);
    border-color: var(--legend-changed-border);
    color: var(--legend-changed-color);
  }

  /* per-dimension rationale list */
  .coach-reasons {
    font-size: 0.82rem;
  }

  .coach-reasons summary {
    cursor: pointer;
    opacity: 0.7;
  }

  .coach-reasons summary:hover {
    opacity: 1;
  }

  .coach-reasons ul {
    margin: 0.35rem 0 0;
    padding-left: 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  /* verdict-coherence flag card */
  .coach-coherence-card {
    background: var(--legend-changed-bg);
    border: 1px solid var(--legend-changed-border);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.88rem;
    color: var(--legend-changed-color);
  }
</style>
