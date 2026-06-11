<script lang="ts">
  import { createPrLoad } from '../lib/review/loadPr.svelte'
  import Stepper, { type Step } from '../components/Stepper.svelte'
  import InspectStep from '../components/InspectStep.svelte'
  import { getSettings, setDiffMode, type DiffMode } from '../lib/settings/settings'
  import { beginSignIn, needsScopeUpgrade } from '../lib/auth/auth'
  import { createDraftStore } from '../lib/drafts/drafts.svelte'
  import VerdictStep from '../components/VerdictStep.svelte'

  const RETURN_KEY = 'review123:returnTo'

  let { owner, repo, number }: { owner: string; repo: string; number: number } = $props()
  // Relies on the {#key} remount in App.svelte: props never change within a
  // mount, so createPrLoad is called exactly once per PR navigation. Removing
  // the key would cause duplicate fetches + stale draft store.
  const load = $derived.by(() => createPrLoad({ owner, repo, number }))
  let step = $state<Step>(1)
  let mode = $state<DiffMode>(getSettings().diffMode)
  function setMode(m: DiffMode) { mode = m; setDiffMode(m) }

  /** Clamp n to 1..3 and assign to step */
  function goStep(n: number) {
    step = Math.max(1, Math.min(3, n)) as Step
  }
  const canPrev = $derived(step > 1)
  const canNext = $derived(step < 3)

  // ---- Draft store — created once per PR+headSha (after the PR loads) -----
  // We keep a single store instance; it persists across step switches.
  let draftStore: ReturnType<typeof createDraftStore> | null = $state(null)
  let storeInitialized = false

  $effect(() => {
    // Initialise the store once the PR is ready and we have the headSha
    if (load.state.status === 'ready' && !storeInitialized) {
      storeInitialized = true
      const prKey = `${owner}/${repo}#${number}@${load.state.meta.headSha}`
      const store = createDraftStore(prKey)
      draftStore = store
      // Un-awaited intentionally: causes a cosmetic 0-count flash on mount
      // but avoids blocking render. Load completes asynchronously.
      store.load()
    }
  })

  async function handleGrantPrivateAccess() {
    sessionStorage.setItem(RETURN_KEY, location.pathname)
    location.assign(await beginSignIn('repo'))
  }
</script>

<section class="review">
  {#if load.state.status === 'loading'}
    <p>Loading {owner}/{repo}#{number}…</p>
  {:else if load.state.status === 'error'}
    {#if load.state.error === 'not-found'}
      {#if needsScopeUpgrade()}
        <p role="alert">PR not found. This may be a private repository.</p>
        <button onclick={handleGrantPrivateAccess}>Grant access to private repositories</button>
        <p class="muted">Or add a GitHub token in <a href="#settings">Settings</a> (PAT with repo scope).</p>
      {:else}
        <p role="alert">PR not found. If this repo is private, add a GitHub token in Settings (sign-in arrives soon).</p>
      {/if}
    {:else if load.state.error === 'rate-limited'}
      <p role="alert">GitHub rate limit reached. Resets at {load.state.resetAt.toLocaleTimeString()}. Add a token in Settings to raise the limit.</p>
    {:else if load.state.error === 'unauthorized'}
      <p role="alert">Your GitHub token was rejected. Update it in Settings.</p>
    {:else if load.state.error === 'network'}
      <p role="alert">Could not reach GitHub. Check your connection and try again.</p>
    {:else}
      <p role="alert">GitHub returned an error. Wait a moment and try again.</p>
    {/if}
  {:else}
    <h1>{load.state.meta.title} <small>{owner}/{repo}#{number}</small></h1>
    <Stepper {step} onstep={(s) => (step = s)} />
    {#if step === 1}
      <p>{load.state.meta.body ?? 'No description.'}</p>
      <p class="muted">AI summary, behavior verdict, diagrams and CI signals arrive in upcoming milestones.</p>
    {:else if step === 2}
      <InspectStep
        files={load.state.files}
        changedFiles={load.state.meta.changedFiles}
        {mode}
        onmode={setMode}
        {draftStore}
      />
    {:else}
      <VerdictStep
        prRef={{ owner, repo, number }}
        commitId={load.state.meta.headSha}
        store={draftStore ?? createDraftStore(`${owner}/${repo}#${number}`)}
        prUrl={`https://github.com/${owner}/${repo}/pull/${number}`}
      />
    {/if}
  {/if}
</section>

<!-- EC-07i: Sticky bottom bar — shown once the PR is loaded -->
{#if load.state.status === 'ready'}
  <div class="draft-bar">
    <div class="draft-bar-inner">
      <span role="status" aria-live="polite" class="draft-status">
        {#if draftStore && !draftStore.persistent}
          <span class="storage-warning" role="alert">
            Drafts won't survive closing this tab (browser storage unavailable)
          </span>
        {/if}
        <span class="draft-count">
          {draftStore?.count ?? 0} comment{(draftStore?.count ?? 0) === 1 ? '' : 's'} drafted
        </span>
      </span>
      <div class="step-nav">
        <button
          class="step-btn"
          disabled={!canPrev}
          onclick={() => goStep(step - 1)}
          aria-label="Previous step"
        >
          ← Prev
        </button>
        <button
          class="step-btn"
          disabled={!canNext}
          onclick={() => goStep(step + 1)}
          aria-label="Next step"
        >
          Next →
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .review { max-width: 70rem; margin: 0 auto; padding: 1rem; padding-bottom: 5rem; }
  .muted { opacity: 0.6; }

  /* EC-07i: Sticky bottom bar */
  .draft-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
    background: #1a1a2e;
    color: #e8e8f0;
    border-top: 1px solid #4444;
    padding: 0.5rem 1rem;
  }

  .draft-bar-inner {
    max-width: 70rem;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .draft-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .draft-count {
    font-size: 0.9rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .storage-warning {
    font-size: 0.8rem;
    color: #f0b444;
    white-space: nowrap;
  }

  .step-nav {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .step-btn {
    background: #4444;
    border: 1px solid #6666;
    color: inherit;
    border-radius: 4px;
    padding: 0.25rem 0.75rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .step-btn:hover:not(:disabled) {
    background: #6666;
  }

  .step-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
