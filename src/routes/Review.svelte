<script lang="ts">
  import { createPrLoad } from '../lib/review/loadPr.svelte'
  import Stepper, { type Step } from '../components/Stepper.svelte'
  import InspectStep from '../components/InspectStep.svelte'
  import { getSettings, setDiffMode, setRailCollapsed, type DiffMode } from '../lib/settings/settings'
  import { beginSignIn, needsScopeUpgrade } from '../lib/auth/auth'
  import { createDraftStore } from '../lib/drafts/drafts.svelte'
  import VerdictStep from '../components/VerdictStep.svelte'
  import { createAiRun } from '../lib/ai/run.svelte'
  import { packContext, fetchContents } from '../lib/context/pack'
  import { getCiSummary } from '../lib/github/checks'
  import { LLM_CONFIG } from '../lib/llm/config'
  import { parseReadingOrder } from '../lib/ai/tasks'
  import ConsentDialog from '../components/ConsentDialog.svelte'
  import UnderstandStep from '../components/UnderstandStep.svelte'
  import ContextRail from '../components/ContextRail.svelte'
  import type { CiSummary } from '../lib/github/checks'
  import type { AttentionResult } from '../lib/ai/schemas'

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

  // ---- AI run ----
  let aiRun: ReturnType<typeof createAiRun> | null = $state(null)
  let railCollapsed = $state(getSettings().railCollapsed)

  // ConsentDialog: stored promise resolver
  let consentDialogVisible = $state(false)
  let consentDialogRepo = $state('')
  let consentResolve: ((v: boolean) => void) | null = null

  function showConsentDialog(): Promise<boolean> {
    return new Promise((resolve) => {
      consentResolve = resolve
      consentDialogVisible = true
    })
  }

  function handleConsentResult(accepted: boolean) {
    consentDialogVisible = false
    consentResolve?.(accepted)
    consentResolve = null
  }

  // CI fetch — memoized
  let ciPromise: Promise<CiSummary | null> | null = null
  function getCi(ref: { owner: string; repo: string; number: number }, headSha: string) {
    if (!ciPromise) {
      ciPromise = getCiSummary(ref, headSha).catch(() => null)
    }
    return ciPromise
  }

  // CI display state (for UnderstandStep)
  let ciData: CiSummary | null = $state(null)
  let ciError = $state(false)

  // Initialize AI run when PR becomes ready
  let aiInitialized = false
  $effect(() => {
    if (load.state.status === 'ready' && !aiInitialized) {
      aiInitialized = true
      const meta = load.state.meta
      const files = load.state.files
      const prKey = `${owner}/${repo}#${number}@${meta.headSha}`
      const repoStr = `${owner}/${repo}`
      consentDialogRepo = repoStr

      const budgetTokens = LLM_CONFIG.contextWindowTokens - LLM_CONFIG.maxOutputTokens - 2000

      const run = createAiRun({
        prKey,
        repo: repoStr,
        isPrivate: meta.private,
        pack: async () => {
          const contents = await fetchContents({ owner, repo }, files, meta)
          const ci = await getCi({ owner, repo, number }, meta.headSha)
          return packContext({ files, contents, ci, budgetTokens })
        },
        ci: () => getCi({ owner, repo, number }, meta.headSha),
        ask: showConsentDialog,
      })
      aiRun = run

      // Start AI (non-blocking)
      run.start()

      // Also load CI for display (non-blocking)
      getCi({ owner, repo, number }, meta.headSha).then(
        (ci) => { ciData = ci },
        () => { ciError = true },
      )
    }
  })

  // Reading order from summary
  const readingOrder = $derived.by(() => {
    if (!aiRun || aiRun.summary.status !== 'done') return []
    return parseReadingOrder(aiRun.summary.value as string)
  })

  function handleHotspot(path: string) {
    goStep(2)
    // Scroll to file after step switch (next tick)
    requestAnimationFrame(() => {
      const slug = path.replace(/[^a-zA-Z0-9]/g, '-')
      document.getElementById(`file-${slug}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
</script>

{#if consentDialogVisible}
  <ConsentDialog repo={consentDialogRepo} onresult={handleConsentResult} />
{/if}

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

    <!-- ContextRail outside step switch (all steps) -->
    {#if aiRun}
      <ContextRail
        run={aiRun}
        onhotspot={handleHotspot}
        collapsed={railCollapsed}
        oncollapse={(c) => { railCollapsed = c; setRailCollapsed(c) }}
      />
    {/if}

    {#if step === 1}
      <UnderstandStep
        meta={load.state.meta}
        ci={ciData}
        {ciError}
        run={aiRun ?? { summary: {status:'idle'}, attention: {status:'idle'}, diagrams: {status:'idle'}, verdict: {status:'idle'}, start: async()=>{}, retry: async()=>{} } as any}
      />
    {:else if step === 2}
      <InspectStep
        files={load.state.files}
        changedFiles={load.state.meta.changedFiles}
        {mode}
        onmode={setMode}
        {draftStore}
        attention={aiRun?.attention.status === 'done' ? aiRun.attention.value as AttentionResult : null}
        {readingOrder}
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
