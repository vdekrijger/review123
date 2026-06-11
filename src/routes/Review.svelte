<script lang="ts">
  import { createPrLoad } from '../lib/review/loadPr.svelte'
  import Stepper, { type Step } from '../components/Stepper.svelte'
  import FileDiff from '../components/FileDiff.svelte'
  import { getSettings, setDiffMode, type DiffMode } from '../lib/settings/settings'
  import { beginSignIn, needsScopeUpgrade } from '../lib/auth/auth'
  import { createDraftStore, draftKey } from '../lib/drafts/drafts.svelte'
  import { track } from '../lib/analytics/analytics'

  const RETURN_KEY = 'review123:returnTo'

  let { owner, repo, number }: { owner: string; repo: string; number: number } = $props()
  const load = $derived.by(() => createPrLoad({ owner, repo, number }))
  let step = $state<Step>(1)
  let mode = $state<DiffMode>(getSettings().diffMode)
  function setMode(m: DiffMode) { mode = m; setDiffMode(m) }

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
      store.load()
    }
  })

  /** Drafts for a given file path */
  function draftsForFile(path: string) {
    return draftStore?.drafts.filter((d) => d.path === path) ?? []
  }

  async function handleAddDraft(path: string, line: number, side: 'LEFT' | 'RIGHT', body: string) {
    if (!draftStore) return
    await draftStore.upsert({ path, line, side, body })
    track('comment_drafted')
  }

  async function handleRemoveDraft(path: string, line: number, side: 'LEFT' | 'RIGHT') {
    if (!draftStore) return
    const draft = draftStore.drafts.find((d) => d.path === path && d.line === line && d.side === side)
    if (draft) {
      await draftStore.remove(draftKey(draft))
    }
  }

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
      <div class="mode-toggle" role="group" aria-label="Diff mode">
        <button class:active={mode === 'unified'} aria-pressed={mode === 'unified'} onclick={() => setMode('unified')}>Unified</button>
        <button class:active={mode === 'split'} aria-pressed={mode === 'split'} onclick={() => setMode('split')}>Side-by-side</button>
      </div>
      {#if load.state.files.length < load.state.meta.changedFiles}
        <p role="alert">Showing {load.state.files.length} of {load.state.meta.changedFiles} changed files — the list was truncated.</p>
      {/if}
      {#if load.state.files.length === 0}
        <p>This PR has no changed files.</p>
      {:else}
        {#each load.state.files as file (file.filename)}
          <FileDiff
            {file}
            {mode}
            drafts={draftsForFile(file.filename)}
            onAddDraft={(line, side, body) => handleAddDraft(file.filename, line, side, body)}
            onRemoveDraft={(line, side) => handleRemoveDraft(file.filename, line, side)}
          />
        {/each}
      {/if}
    {:else}
      <p class="muted">Review submission arrives in the next milestone. For now, submit on GitHub.</p>
    {/if}
  {/if}
</section>

<!-- EC-07i: Sticky bottom bar — shown once the PR is loaded -->
{#if load.state.status === 'ready'}
  <div class="draft-bar" role="status" aria-live="polite">
    <div class="draft-bar-inner">
      {#if draftStore && !draftStore.persistent}
        <span class="storage-warning" role="alert">
          Drafts won't survive closing this tab (browser storage unavailable)
        </span>
      {/if}
      <span class="draft-count">
        {draftStore?.count ?? 0} comment{(draftStore?.count ?? 0) === 1 ? '' : 's'} drafted
      </span>
      <div class="step-nav">
        <button
          class="step-btn"
          disabled={step === 1}
          onclick={() => step = (step - 1) as Step}
          aria-label="Previous step"
        >
          ← Prev
        </button>
        <button
          class="step-btn"
          disabled={step === 3}
          onclick={() => step = (step + 1) as Step}
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
  .mode-toggle button.active { font-weight: 700; }

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
