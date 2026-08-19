<script lang="ts">
  /**
   * DraftLifecycleBanner — shown when a PR opens with PRE-EXISTING drafts from
   * an earlier session, so returning reviewers can keep, prune, or clear them
   * before re-reviewing.
   *
   * Rendered by Review.svelte only after the store's load() resolved with ≥1
   * draft (this component never decides "pre-existing" itself). It reads the
   * LIVE store so counts update as drafts are cleared.
   *
   * Actions:
   *   - Keep       → dismiss for this PR for this SESSION (sessionStorage; the
   *                  banner returns on the next visit while old drafts remain —
   *                  intentionally, that's the reminder).
   *   - Clear stale (N) → removes only drafts whose file left the PR's diff.
   *                  Shown only when N > 0. Banner stays with updated counts.
   *   - Clear all  → two-step inline confirm (morphs to "Really clear N?";
   *                  never window.confirm). Clearing empties the store, which
   *                  hides the banner.
   */
  import {
    draftKey,
    isStaleDraft,
    draftTimeLabel,
    type createDraftStore,
  } from '../lib/drafts/drafts.svelte'
  import type { PrFile } from '../lib/github/types'

  interface Props {
    /** The PR's LIVE draft store (already load()ed with pre-existing drafts). */
    store: ReturnType<typeof createDraftStore>
    /** The PR's CURRENT diff file list — staleness is judged against it. */
    files: PrFile[]
    /** The PR's current head sha (the softer older-revision signal). */
    headSha: string
    /** PR identity key — scopes the per-session dismissal. */
    prKey: string
  }

  let { store, files, headSha, prKey }: Props = $props()

  const DISMISS_PREFIX = 'review123:draft-banner-dismissed:'

  function readDismissed(): boolean {
    try {
      return sessionStorage.getItem(DISMISS_PREFIX + prKey) === '1'
    } catch {
      return false
    }
  }

  // Per-PR-per-SESSION dismissal — deliberately not persisted forever: while
  // old drafts remain, the banner should greet the next visit again.
  let dismissed = $state(readDismissed())

  function dismiss() {
    dismissed = true
    try {
      sessionStorage.setItem(DISMISS_PREFIX + prKey, '1')
    } catch {
      // sessionStorage unavailable → in-memory dismissal only, still fine.
    }
  }

  const staleDrafts = $derived(
    store.drafts.filter((d) => isStaleDraft(d, files, headSha).stale),
  )

  // Oldest known creation time — omitted entirely when NO draft carries one
  // (pre-timestamp drafts; we won't fabricate an age).
  const oldestLabel = $derived.by(() => {
    const stamps = store.drafts
      .map((d) => d.createdAt)
      .filter((t): t is number => t != null)
    if (stamps.length === 0) return null
    return draftTimeLabel(Math.min(...stamps))
  })

  // ---- Clear all: two-step inline confirm ----
  let confirmingClearAll = $state(false)

  function handleClearAll() {
    if (!confirmingClearAll) {
      confirmingClearAll = true
      return
    }
    confirmingClearAll = false
    void store.clearAll()
    // Nothing left to manage — treat as handled for this session too.
    dismiss()
  }

  /** Abandon the pending confirm when focus leaves the button or Esc is hit. */
  function resetConfirm() {
    confirmingClearAll = false
  }

  function onClearAllKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && confirmingClearAll) {
      e.preventDefault()
      resetConfirm()
    }
  }

  // ---- Clear stale: single click (each removal is small + visible) ----
  function handleClearStale() {
    // Remove through the LIVE store so both the reactive array and IndexedDB
    // update (module-level clearStaleDrafts is disk-only).
    for (const d of staleDrafts) {
      void store.remove(draftKey(d))
    }
  }
</script>

{#if !dismissed && store.count > 0}
  <div class="draft-banner" role="status" data-testid="draft-lifecycle-banner">
    <span class="draft-banner-text">
      {store.count} draft comment{store.count === 1 ? '' : 's'} from a previous review{#if oldestLabel}&nbsp;· oldest {oldestLabel}{/if}{#if staleDrafts.length > 0}&nbsp;· {staleDrafts.length} on file{staleDrafts.length === 1 ? '' : 's'} no longer in this PR{/if}
    </span>
    <span class="draft-banner-actions">
      <button class="banner-action" type="button" onclick={dismiss}>Keep</button>
      {#if staleDrafts.length > 0}
        <span class="banner-sep" aria-hidden="true">·</span>
        <button class="banner-action" type="button" onclick={handleClearStale}>
          Clear stale ({staleDrafts.length})
        </button>
      {/if}
      <span class="banner-sep" aria-hidden="true">·</span>
      <button
        class="banner-action banner-action-danger"
        class:banner-confirming={confirmingClearAll}
        type="button"
        onclick={handleClearAll}
        onfocusout={resetConfirm}
        onkeydown={onClearAllKeydown}
      >
        {confirmingClearAll ? `Really clear ${store.count}?` : 'Clear all'}
      </button>
    </span>
  </div>
{/if}

<style>
  .draft-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    background: var(--surface-banner, #1a3050);
    border: 1px solid var(--border-banner, #2a5080);
    border-left: 3px solid var(--border-banner-accent, #4a90d0);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    margin: 0.75rem 0;
    color: var(--text-banner, #c8dff0);
  }

  .draft-banner-text {
    flex: 1;
    min-width: 12rem;
  }

  .draft-banner-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .banner-action {
    background: none;
    border: none;
    color: #6ab4f0;
    cursor: pointer;
    font-size: 0.875rem;
    text-decoration: underline;
    padding: 0;
  }

  .banner-action:hover {
    color: #90ccff;
  }

  .banner-action-danger {
    color: var(--legend-removed-color, #ff8080);
  }

  .banner-action-danger:hover {
    filter: brightness(1.15);
  }

  .banner-confirming {
    font-weight: 600;
    text-decoration: none;
    border: 1px solid var(--legend-removed-border, #cf222e);
    border-radius: 4px;
    padding: 0.1rem 0.5rem;
  }

  .banner-sep {
    opacity: 0.5;
  }
</style>
