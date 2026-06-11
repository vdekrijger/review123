<script lang="ts">
  import { createPrLoad } from '../lib/review/loadPr.svelte'
  import Stepper, { type Step } from '../components/Stepper.svelte'
  import FileDiff from '../components/FileDiff.svelte'
  import { getSettings, setDiffMode, type DiffMode } from '../lib/settings/settings'
  import { beginSignIn, needsScopeUpgrade } from '../lib/auth/auth'

  const RETURN_KEY = 'review123:returnTo'

  let { owner, repo, number }: { owner: string; repo: string; number: number } = $props()
  const load = $derived.by(() => createPrLoad({ owner, repo, number }))
  let step = $state<Step>(1)
  let mode = $state<DiffMode>(getSettings().diffMode)
  function setMode(m: DiffMode) { mode = m; setDiffMode(m) }

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
          <FileDiff {file} {mode} />
        {/each}
      {/if}
    {:else}
      <p class="muted">Review submission arrives in the next milestone. For now, submit on GitHub.</p>
    {/if}
  {/if}
</section>

<style>
  .review { max-width: 70rem; margin: 0 auto; padding: 1rem; }
  .muted { opacity: 0.6; }
  .mode-toggle button.active { font-weight: 700; }
</style>
