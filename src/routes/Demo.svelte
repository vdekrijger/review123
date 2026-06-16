<script lang="ts">
  /**
   * Demo.svelte — the "Try a live demo (no setup)" route (/demo).
   *
   * Mounts the REAL review display components (Stepper, ContextRail,
   * UnderstandStep, InspectStep, VerdictStep) for a BUNDLED fixture PR with
   * PRE-GENERATED AI output. No API key, no auth, no GitHub/LLM network: the AI
   * state comes from createDemoRun() (every panel already 'done') and the
   * draft/viewed stores are local IndexedDB/localStorage only.
   *
   * This route owns its own step state (1/2/3) instead of going through the
   * router's `review` route, so it never touches Review.svelte's live-fetch
   * machinery. It does NOT modify InspectStep / FileDiff internals — it only
   * passes props, exactly as Review.svelte does.
   */
  import Stepper, { type Step } from '../components/Stepper.svelte'
  import ContextRail from '../components/ContextRail.svelte'
  import UnderstandStep from '../components/UnderstandStep.svelte'
  import InspectStep from '../components/InspectStep.svelte'
  import VerdictStep from '../components/VerdictStep.svelte'
  import { createDraftStore } from '../lib/drafts/drafts.svelte'
  import { createViewedStore } from '../lib/viewed/viewed.svelte'
  import { getSettings, setDiffMode, type DiffMode } from '../lib/settings/settings'
  import { navigate } from '../lib/router/router.svelte'
  import { parseReadingOrder } from '../lib/ai/tasks'
  import { jumpToFileDiff } from '../lib/diff/jumpToFile'
  import { createDemoRun } from '../lib/demo/demoRun'
  import {
    demoMeta,
    demoFiles,
    demoCi,
    DEMO_PR_KEY,
  } from '../lib/demo/fixture'
  import type { AttentionResult } from '../lib/ai/schemas'

  const run = createDemoRun()

  // Local stores keyed to the demo PR — IndexedDB/localStorage only, no network.
  const draftStore = createDraftStore(DEMO_PR_KEY)
  const viewedStore = createViewedStore(DEMO_PR_KEY)

  let step = $state<Step>(1)
  function goStep(n: number) {
    step = Math.max(1, Math.min(3, n)) as Step
  }
  const canPrev = $derived(step > 1)
  const canNext = $derived(step < 3)

  let mode = $state<DiffMode>(getSettings().diffMode)
  function setMode(m: DiffMode) {
    mode = m
    setDiffMode(m)
  }

  let railCollapsed = $state(true)
  let bannerDismissed = $state(false)

  const readingOrder = $derived(parseReadingOrder(run.summary.value as string))

  // Jump to a file when a hotspot chip is clicked — reuse the product's shared
  // file-jump helper so the demo behaves exactly like a live review.
  function handleHotspot(path: string) {
    jumpToFileDiff(path, {
      isInspectActive: step === 2,
      navigateToInspect: () => goStep(2),
    })
  }

  function goToSettings(e: MouseEvent) {
    e.preventDefault()
    navigate('/settings/providers')
  }

  // Drafting is allowed (local only) but there is NO real submit in the demo:
  // this stub keeps any submit path entirely client-side.
  const demoSubmit = async () =>
    ({
      ok: false as const,
      kind: 'other' as const,
      message: 'This is a demo — sign in to submit a real review.',
    })
</script>

<section class="review">
  {#if !bannerDismissed}
    <div class="demo-banner" role="note">
      <span class="demo-banner-text">
        <span aria-hidden="true">📋</span>
        <strong>Demo</strong> — these results are pre‑generated for an example PR.
        <a href="/settings/providers" onclick={goToSettings}>Add your API key or sign in</a>
        to review real PRs.
      </span>
      <button
        class="demo-banner-dismiss"
        aria-label="Dismiss demo banner"
        onclick={() => { bannerDismissed = true }}
      >×</button>
    </div>
  {/if}

  <div class="pr-header">
    <h1>{demoMeta.title} <small>acme/web-app#42</small></h1>
    <span class="demo-chip" aria-label="Example pull request">Example PR</span>
  </div>

  <Stepper {step} onstep={(s) => goStep(s)} />

  <ContextRail
    {run}
    onhotspot={handleHotspot}
    collapsed={railCollapsed}
    oncollapse={(c) => { railCollapsed = c }}
    onbackdropclick={() => { railCollapsed = true }}
    ci={demoCi}
    meta={demoMeta}
  />

  {#if step === 1}
    <UnderstandStep
      meta={demoMeta}
      files={demoFiles}
      ci={demoCi}
      ciError={false}
      {run}
      onhotspot={handleHotspot}
    />
  {:else if step === 2}
    <InspectStep
      files={demoFiles}
      changedFiles={demoMeta.changedFiles}
      {mode}
      onmode={setMode}
      {draftStore}
      attention={run.attention.status === 'done' ? (run.attention.value as AttentionResult) : null}
      {readingOrder}
      {viewedStore}
      skillReviews={run.skillReviews}
    />
  {:else}
    <VerdictStep
      prRef={{ owner: 'acme', repo: 'web-app', number: 42 }}
      commitId={demoMeta.headSha}
      store={draftStore}
      prUrl="https://github.com/acme/web-app/pull/42"
      prTitle={demoMeta.title}
      files={demoFiles}
      submitFn={demoSubmit}
      authorLogin={demoMeta.authorLogin}
    />
  {/if}
</section>

<div class="draft-bar">
  <div class="draft-bar-inner">
    <span class="draft-count text-muted">
      {draftStore.count} comment{draftStore.count === 1 ? '' : 's'} drafted
    </span>
    <div class="step-nav">
      <button class="btn" disabled={!canPrev} onclick={() => goStep(step - 1)} aria-label="Previous step">← Prev</button>
      <button class="btn" disabled={!canNext} onclick={() => goStep(step + 1)} aria-label="Next step">Next →</button>
    </div>
  </div>
</div>

<style>
  .review { max-width: 70rem; margin: 0 auto; padding: 1rem; padding-bottom: 5rem; }

  .demo-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    background: var(--surface-banner, #1a3050);
    border: 1px solid var(--border-banner, #2a5080);
    border-left: 3px solid var(--border-banner-accent, #4a90d0);
    border-radius: 6px;
    padding: 0.55rem 0.85rem;
    font-size: 0.875rem;
    margin-bottom: 0.85rem;
    color: var(--text-banner, #c8dff0);
  }
  .demo-banner-text { display: inline; }
  .demo-banner strong { font-weight: 600; }
  .demo-banner a { color: #6ab4f0; }
  .demo-banner a:hover { color: #90ccff; }
  .demo-banner-dismiss {
    background: none;
    border: none;
    color: #6a8090;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.25rem;
    margin-left: auto;
  }
  .demo-banner-dismiss:hover { color: #90a8b8; }

  .pr-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .pr-header h1 { margin: 0; min-width: 0; }

  .demo-chip {
    flex-shrink: 0;
    align-self: center;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.2rem 0.5rem;
    white-space: nowrap;
  }

  .draft-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
    background: var(--surface-raised);
    border-top: 1px solid var(--hairline);
    padding: 0.5rem 1rem;
  }
  .draft-bar-inner {
    max-width: 70rem;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .draft-count {
    font-size: 0.85rem;
    white-space: nowrap;
    color: var(--text-muted);
  }
  .step-nav {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-shrink: 0;
    margin-left: auto;
  }
</style>
