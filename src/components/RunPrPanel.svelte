<script lang="ts">
  /**
   * RunPrPanel — check this pull request out locally, and get back.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * WHAT IT IS FOR
   *
   * A deploy preview shows the change on someone else's infrastructure. This
   * shows it in the reviewer's OWN app — their database, their flags, their
   * seeded org, their debugger — by checking the PR out in the checkout whose
   * dev server is already running. Vite hot-reloads, Django autoreloads, and
   * localhost is the pull request seconds later.
   *
   * ──────────────────────────────────────────────────────────────────────────
   * WHY THIS COMPONENT IS MOSTLY GUARDS
   *
   * It is the only surface in review123 that moves the user's working tree. So
   * it never has a bare disabled button: every state it can be in renders the
   * REASON (from `decideCheckout`), and the two irreversible-looking steps —
   * moving uncommitted work, and running a stranger's code — are separate,
   * explicit confirmations that name exactly what they are about to do. A
   * stash prompt lists the files. A fork prompt says the code will run.
   *
   * Renders NOTHING when no bridge has ever been paired — zero-cost absence,
   * the same idiom PreviewButton uses for an undetected preview.
   */
  import Spinner from './Spinner.svelte'
  import { bridgeState } from '../lib/bridge/bridge.svelte'
  import {
    checkoutPr,
    currentCheckoutReadiness,
    decideCheckoutTrust,
    describeCheckout,
    describeCheckoutTrust,
    refreshStack,
    restoreCheckout,
    short,
    stackState,
    trustNeedsConfirmation,
    type CheckoutTrust,
  } from '../lib/bridge/runPr.svelte'
  import type { PrRepoRelation } from '../lib/github/types'

  interface Props {
    /** The PR's head sha — what the bridge's head must equal to be "on" it. */
    headSha: string
    /**
     * The provider-agnostic ref to fetch, e.g. "refs/pull/42/head". Null when
     * the provider does not expose one, which disables the action honestly
     * rather than guessing a ref shape.
     */
    prRef: string | null
    /**
     * The PR's head and base repository identities, when the caller holds the
     * raw pair rather than the provider's derived answer. See
     * `decideCheckoutTrust`.
     */
    repos?: { head: string | null; base: string | null }
    /**
     * `PrMeta.repoRelation` — the provider's own, provider-agnostic answer to
     * "is this branch in this repository?". This is how Review wires it.
     *
     * Absent is NOT same-repo: a `PrMeta` from a build older than the field
     * has no such key, and reads as `unverified` — the fork-grade
     * confirmation, unchanged.
     */
    relation?: PrRepoRelation
    /**
     * Whether the embedded preview panel is open (the toggle state lives in
     * Review, beside the deploy preview's). Offered here as well as on
     * PreviewButton because a repo with NO deploy previews still has something
     * to frame once the PR is running locally — and PreviewButton renders
     * nothing at all in that case.
     */
    panelOpen?: boolean
    onTogglePanel?: () => void
  }

  let { headSha, prRef, repos, relation, panelOpen = false, onTogglePanel }: Props = $props()

  const readiness = $derived(currentCheckoutReadiness(headSha))
  const onPr = $derived(stackState.onPrBranch(headSha))
  const trust = $derived<CheckoutTrust>(
    decideCheckoutTrust({
      ...(repos === undefined ? {} : { repos }),
      ...(relation === undefined ? {} : { relation }),
    }),
  )
  const app = $derived(stackState.app)

  /**
   * The panel appears only when the user has a bridge paired. Telling someone
   * who has never heard of the bridge that they "cannot check this PR out" is
   * noise, not honesty — the same rule GroundingIndicator applies.
   */
  const visible = $derived(bridgeState.paired)

  /** Which confirmation is open, if any. One at a time, always explicit. */
  let pending = $state<'trust' | 'stash' | 'restore-conflict' | null>(null)
  /** Set when a restore came back needing an extra answer. */
  let restoreIssue = $state<'prior-gone' | 'moved-since' | 'tree-dirty' | null>(null)

  let probed = false
  $effect(() => {
    // One probe once a bridge is connected. `refreshStack` itself makes no
    // request at all when nothing is paired, so an unpaired user still pays
    // nothing.
    if (bridgeState.status === 'connected' && !probed) {
      probed = true
      // `refreshStack` never rejects — it resolves to null on every failure —
      // so there is nothing here for a catch to do. Probing on mount rather
      // than trusting a cached answer is deliberate: the user may have
      // switched branches or started editing since the last one.
      void refreshStack()
    }
  })

  function beginCheckout() {
    if (prRef === null) return
    // The two confirmations are ordered so the user is asked the scarier
    // question first: whether to run this code at all comes before what to do
    // with their edits.
    if (trustNeedsConfirmation(trust)) {
      pending = 'trust'
      return
    }
    if (readiness.reason === 'tree-dirty') {
      pending = 'stash'
      return
    }
    void doCheckout(false)
  }

  /** The trust confirmation was accepted; ask about the tree next if needed. */
  function trustAccepted() {
    pending = null
    if (readiness.reason === 'tree-dirty') {
      pending = 'stash'
      return
    }
    void doCheckout(false)
  }

  async function doCheckout(stashDirty: boolean) {
    pending = null
    if (prRef === null) return
    const outcome = await checkoutPr({ ref: prRef, stashDirty })
    // A dirty-tree refusal can still arrive here if the tree changed between
    // the probe and the click. Offer the stash rather than just complaining.
    if (!outcome.ok && outcome.failure.kind === 'tree-dirty') pending = 'stash'
  }

  async function doRestore(extra: { stashDirty?: boolean; detachToSha?: boolean; acknowledgeMoved?: boolean } = {}) {
    pending = null
    restoreIssue = null
    const outcome = await restoreCheckout({ ...extra, restoreStash: true })
    if (outcome.ok) return
    // Each irregular case gets its own follow-up question, never a guess.
    if (outcome.failure.kind === 'prior-gone') {
      restoreIssue = 'prior-gone'
      pending = 'restore-conflict'
    } else if (outcome.failure.kind === 'moved-since') {
      restoreIssue = 'moved-since'
      pending = 'restore-conflict'
    } else if (outcome.failure.kind === 'tree-dirty') {
      restoreIssue = 'tree-dirty'
      pending = 'restore-conflict'
    }
  }

  const restoreLabel = $derived(
    stackState.prior?.branch != null
      ? `Restore ${stackState.prior.branch}`
      : stackState.prior != null
        ? `Restore ${short(stackState.prior.head)}`
        : 'Restore',
  )

  const dirtyPaths = $derived(stackState.state?.dirtyPaths ?? readiness.dirtyPaths)
  const dirtyCount = $derived(stackState.state?.dirtyCount ?? readiness.dirtyCount)
</script>

{#if visible}
  <span class="runpr" data-testid="runpr-panel" data-on-pr={String(onPr)}>
    {#if onPr}
      <!-- THE INDICATOR. Unmissable, because the user's checkout is not where
           they left it and they must never discover that by surprise. -->
      <span class="runpr-live" data-testid="runpr-on-pr">
        <span class="runpr-dot" aria-hidden="true"></span>
        Checked out here
      </span>
      {#if app?.reachable && app.url !== null}
        <a
          class="runpr-open"
          href={app.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="runpr-open-app"
        >Open your app <span aria-hidden="true">↗</span></a>
        {#if onTogglePanel}
          <button
            type="button"
            class="runpr-action"
            data-testid="runpr-panel-toggle"
            aria-pressed={panelOpen}
            onclick={onTogglePanel}
          >Preview panel</button>
        {/if}
      {:else}
        <span class="runpr-note" data-testid="runpr-app-down">
          {app?.url == null
            ? 'Dev server location unknown'
            : `Nothing answering at ${app.url}`}
        </span>
      {/if}
      <button
        type="button"
        class="runpr-action"
        data-testid="runpr-restore"
        disabled={stackState.busy}
        onclick={() => doRestore()}
      >
        {#if stackState.busy}<Spinner />{/if}
        {restoreLabel}
      </button>
    {:else if readiness.reason === 'ready' || readiness.reason === 'tree-dirty'}
      <button
        type="button"
        class="runpr-action runpr-primary"
        data-testid="runpr-checkout"
        disabled={stackState.busy || prRef === null}
        title={prRef === null
          ? 'This provider does not expose a pull-request ref the bridge can fetch.'
          : describeCheckout(readiness)}
        onclick={beginCheckout}
      >
        {#if stackState.busy}<Spinner />{/if}
        Check out this PR
      </button>
      {#if readiness.reason === 'tree-dirty'}
        <span class="runpr-note runpr-warn" data-testid="runpr-dirty-note">
          {dirtyCount} uncommitted change{dirtyCount === 1 ? '' : 's'}
        </span>
      {/if}
      {#if trust === 'same-repo'}
        <!-- The smooth path still SAYS why it is smooth. It makes one claim —
             where the branch lives — and never the claim the user would
             actually like to hear, that the code is safe: a same-repo branch
             is still code about to run on this machine. -->
        <span class="runpr-note" data-testid="runpr-trust-note">
          {describeCheckoutTrust(trust)}
        </span>
      {/if}
    {:else}
      <!-- NEVER a bare disabled button: the reason is always on screen. -->
      <span class="runpr-note" data-testid="runpr-reason" data-reason={readiness.reason}>
        {describeCheckout(readiness)}
      </span>
    {/if}

    {#if stackState.error !== null}
      <span class="runpr-error" role="status" data-testid="runpr-error">{stackState.error}</span>
    {/if}

    {#if stackState.stash !== null}
      <span class="runpr-note" data-testid="runpr-stash-note">
        {stackState.stash.action === 'created'
          ? 'Your uncommitted work is stashed and safe.'
          : 'Your stashed work is back.'}
        <code>{stackState.stash.dropCommand}</code> removes the entry when you are done with it.
      </span>
    {/if}
  </span>

  <!-- ---- Confirmation: whose code is about to run ---- -->
  {#if pending === 'trust'}
    <div class="runpr-dialog" role="dialog" aria-modal="true" aria-label="Run this pull request's code" data-testid="runpr-trust-dialog">
      <div class="runpr-dialog-box">
        <h2>Run this pull request's code?</h2>
        <p data-testid="runpr-trust-text">{describeCheckoutTrust(trust)}</p>
        <div class="runpr-dialog-actions">
          <button type="button" class="btn btn-primary" data-testid="runpr-trust-accept" onclick={trustAccepted}>
            I've read the diff — check it out
          </button>
          <button type="button" class="btn" data-testid="runpr-trust-cancel" onclick={() => (pending = null)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ---- Confirmation: what happens to the uncommitted work ---- -->
  {#if pending === 'stash'}
    <div class="runpr-dialog" role="dialog" aria-modal="true" aria-label="Stash your uncommitted changes" data-testid="runpr-stash-dialog">
      <div class="runpr-dialog-box">
        <h2>Stash your uncommitted changes?</h2>
        <p>
          These {dirtyCount} file{dirtyCount === 1 ? '' : 's'} will be moved into a
          <code>git stash</code> entry so the pull request can be checked out. Nothing is
          deleted, and restoring puts them back.
        </p>
        <!-- NAMING THE FILES IS THE POINT. A prompt that says "you have
             uncommitted changes" without listing them asks the user to trust a
             claim they cannot check. -->
        <ul class="runpr-dirty-list" data-testid="runpr-dirty-list">
          {#each dirtyPaths as path (path)}
            <li><code>{path}</code></li>
          {/each}
        </ul>
        {#if dirtyCount > dirtyPaths.length}
          <p class="runpr-note">…and {dirtyCount - dirtyPaths.length} more.</p>
        {/if}
        <div class="runpr-dialog-actions">
          <button type="button" class="btn btn-primary" data-testid="runpr-stash-accept" onclick={() => doCheckout(true)}>
            Stash and check out
          </button>
          <button type="button" class="btn" data-testid="runpr-stash-cancel" onclick={() => (pending = null)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ---- Confirmation: the restore hit something unexpected ---- -->
  {#if pending === 'restore-conflict'}
    <div class="runpr-dialog" role="dialog" aria-modal="true" aria-label="Restore needs a decision" data-testid="runpr-restore-dialog">
      <div class="runpr-dialog-box">
        <h2>Restore needs a decision</h2>
        <p data-testid="runpr-restore-detail">{stackState.error}</p>
        <div class="runpr-dialog-actions">
          {#if restoreIssue === 'prior-gone'}
            <button type="button" class="btn btn-primary" data-testid="runpr-restore-detach" onclick={() => doRestore({ detachToSha: true })}>
              Check out {short(stackState.prior?.head ?? null)} instead
            </button>
          {:else if restoreIssue === 'moved-since'}
            <button type="button" class="btn btn-primary" data-testid="runpr-restore-anyway" onclick={() => doRestore({ acknowledgeMoved: true })}>
              Restore anyway
            </button>
          {:else}
            <button type="button" class="btn btn-primary" data-testid="runpr-restore-stash" onclick={() => doRestore({ stashDirty: true })}>
              Stash them and restore
            </button>
          {/if}
          <button type="button" class="btn" data-testid="runpr-restore-cancel" onclick={() => (pending = null)}>Leave it as it is</button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .runpr {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* The on-PR indicator: a live dot, because the user's checkout is not where
     they left it and that must read at a glance. */
  .runpr-live {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--legend-added-color, #3f9142);
    border: 1px solid var(--legend-added-color, #3f9142);
    border-radius: 6px;
    padding: 0.25rem 0.5rem;
    white-space: nowrap;
  }

  .runpr-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: currentColor;
  }

  .runpr-open {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.85rem;
    font-weight: 600;
    text-decoration: none;
    color: var(--accent, #4a90d0);
    border: 1px solid var(--accent, #4a90d0);
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    white-space: nowrap;
  }

  .runpr-open:hover,
  .runpr-open:focus-visible {
    background: #4a90d01a;
  }

  .runpr-action {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.3rem 0.55rem;
    white-space: nowrap;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }

  .runpr-action:hover:not(:disabled),
  .runpr-action:focus-visible:not(:disabled) {
    background: #8881;
    color: var(--text);
  }

  .runpr-action:disabled {
    opacity: var(--disabled-opacity);
    cursor: not-allowed;
  }

  .runpr-primary {
    color: var(--text);
    border-color: var(--accent, #4a90d0);
  }

  .runpr-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    max-width: 46ch;
  }

  .runpr-note code {
    font-family: var(--font-mono, monospace);
    font-size: 0.72rem;
  }

  .runpr-warn {
    color: var(--legend-changed-color, #b08800);
    white-space: nowrap;
  }

  .runpr-error {
    font-size: 0.75rem;
    color: var(--danger, #c0392b);
    max-width: 46ch;
  }

  /* A plain fixed overlay rather than <dialog>: this component renders inside
     the review header, and showModal() there fights the sticky bars for the
     top layer. The box is centred and the backdrop is inert. */
  .runpr-dialog {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    padding: 1rem;
  }

  .runpr-dialog-box {
    background: var(--surface, #0e1420);
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 1.25rem;
    max-width: 34rem;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
  }

  .runpr-dialog-box h2 {
    margin: 0 0 0.6rem;
    font-size: 1.05rem;
  }

  .runpr-dialog-box p {
    margin: 0 0 0.75rem;
    font-size: 0.88rem;
    line-height: 1.5;
    color: var(--text);
  }

  .runpr-dirty-list {
    margin: 0 0 0.75rem;
    padding-left: 1.2rem;
    max-height: 12rem;
    overflow-y: auto;
    font-size: 0.8rem;
  }

  .runpr-dirty-list code {
    font-family: var(--font-mono, monospace);
  }

  .runpr-dialog-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
</style>
