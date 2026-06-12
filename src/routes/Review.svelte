<script lang="ts">
  import { createPrLoad } from '../lib/review/loadPr.svelte'
  import Stepper, { type Step } from '../components/Stepper.svelte'
  import InspectStep from '../components/InspectStep.svelte'
  import RevisionPicker from '../components/RevisionPicker.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import { getSettings, setDiffMode, setRailCollapsed, type DiffMode } from '../lib/settings/settings'
  import ReviewProgress from '../components/ReviewProgress.svelte'
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
  import { navigate as navigateTo, STEP_PATHS, router } from '../lib/router/router.svelte'
  import { addToHistory } from '../lib/history/history'
  import { createViewedStore } from '../lib/viewed/viewed.svelte'
  import { recordVisit, lastVisit } from '../lib/visits/visits'
  import { compareCommits } from '../lib/github/compare'
  import { getPrCommits } from '../lib/github/commits'
  import { GithubApiError } from '../lib/github/types'
  import type { CiSummary } from '../lib/github/checks'
  import type { AttentionResult } from '../lib/ai/schemas'
  import type { PrFile } from '../lib/github/types'
  import type { PrCommit } from '../lib/github/commits'
  import { getPrComments } from '../lib/github/comments'
  import type { PrComment } from '../lib/github/comments'
  import { getResolvedCommentIds } from '../lib/github/threads'
  import { slugify } from '../lib/slug'

  const RETURN_KEY = 'review123:returnTo'

  let { owner, repo, number, step: stepProp }: {
    owner: string
    repo: string
    number: number
    step?: 1 | 2 | 3
  } = $props()
  // Relies on the {#key} remount in App.svelte: props never change within a
  // mount, so createPrLoad is called exactly once per PR navigation. Removing
  // the key would cause duplicate fetches + stale draft store.
  const load = $derived.by(() => createPrLoad({ owner, repo, number }))
  // When App.svelte passes step={route.step} we use it directly. When Review is
  // rendered without a parent (e.g. integration tests), fall back to router.route
  // so navigate() calls are reflected here reactively.
  const step = $derived<Step>(
    stepProp !== undefined
      ? stepProp
      : (router.route.name === 'review' ? router.route.step : 1)
  )
  let mode = $state<DiffMode>(getSettings().diffMode)
  function setMode(m: DiffMode) { mode = m; setDiffMode(m) }

  /** Clamp n to 1..3 and navigate to the corresponding step URL */
  function goStep(n: number) {
    const clamped = Math.max(1, Math.min(3, n)) as Step
    navigateTo(`/review/${owner}/${repo}/${number}/${STEP_PATHS[clamped]}`)
  }
  const canPrev = $derived(step > 1)
  const canNext = $derived(step < 3)

  // ---- Viewed store — keyed by owner/repo#number (NO sha — survives pushes) ---
  const prId = $derived(`${owner}/${repo}#${number}`)
  const viewedStore = $derived(createViewedStore(prId))

  // ---- Draft store — created once per PR+headSha (after the PR loads) -----
  // We keep a single store instance; it persists across step switches.
  let draftStore: ReturnType<typeof createDraftStore> | null = $state(null)
  let storeInitialized = false

  // ---- Since-last-visit interdiff state ----
  // The headSha from the PREVIOUS visit (null = first visit or same sha)
  let prevVisitSha: string | null = $state(null)
  let prevVisitedAt: number | null = $state(null)

  // ---- Unified compare-mode state ----
  // Serves both since-last-visit (banner) AND revision picker.
  // null = not active; { files, label } = compare active with those files + label
  let compareMode: { files: PrFile[]; label: string } | null = $state(null)
  // 'idle' | 'loading' | 'error' — transient loading state
  let compareStatus: 'idle' | 'loading' | 'error' = $state('idle')
  let compareError: string | null = $state(null)
  // Source of the active compare: 'banner' | 'picker'
  let compareSource: 'banner' | 'picker' | null = $state(null)

  // Picker active selection (what's applied, reflected back from compareMode)
  let pickerActive: { from: string; to: string } | null = $state(null)

  // ---- Revision picker commits ----
  // Lazily fetched on first step-2 activation; null = not yet fetched; [] = loaded (may be empty)
  let prCommits: PrCommit[] | null = $state(null)
  // Whether the picker is hidden due to commit fetch failure
  let pickerHidden = $state(false)
  let commitsInitializedForStep2 = false

  $effect(() => {
    // Initialise the store once the PR is ready and we have the headSha
    if (load.state.status === 'ready' && !storeInitialized) {
      storeInitialized = true
      const meta = load.state.meta
      const prKey = `${owner}/${repo}#${number}@${meta.headSha}`
      const store = createDraftStore(prKey)
      draftStore = store
      // Un-awaited intentionally: causes a cosmetic 0-count flash on mount
      // but avoids blocking render. Load completes asynchronously.
      store.load()

      // Record this PR in the recent-reviews history
      addToHistory({ owner, repo, number, title: meta.title })

      // Read last visit BEFORE recording the new one
      const prior = lastVisit(prId)
      if (prior !== null && prior.headSha !== meta.headSha) {
        prevVisitSha = prior.headSha
        prevVisitedAt = prior.visitedAt
      }
      recordVisit(prId, meta.headSha)
    }
  })

  // Lazily fetch commits when step 2 is first activated (non-blocking)
  $effect(() => {
    if (step === 2 && load.state.status === 'ready' && !commitsInitializedForStep2) {
      commitsInitializedForStep2 = true
      getPrCommits({ owner, repo, number }).then(
        (commits) => { prCommits = commits },
        () => { pickerHidden = true },
      )
    }
  })

  // ---- Since-last-visit banner actions ----

  async function fetchCompare() {
    if (!prevVisitSha || load.state.status !== 'ready') return
    compareStatus = 'loading'
    compareSource = 'banner'
    compareError = null
    try {
      const files = await compareCommits({ owner, repo }, prevVisitSha, load.state.meta.headSha)
      compareMode = { files, label: 'since your last visit' }
      compareStatus = 'idle'
      // Push a flagged history entry so browser back exits compare instead of leaving the PR
      history.pushState({ review123Compare: true }, '', location.pathname)
    } catch (e) {
      if (e instanceof GithubApiError && e.detail.kind === 'not-found') {
        compareError = "Couldn't compare — the previous revision may have been force-pushed away."
      } else {
        compareError = 'Comparison failed. Please try again.'
      }
      compareStatus = 'error'
    }
  }

  // ---- Picker actions ----

  async function handlePickerSelect(from: string, to: string) {
    if (load.state.status !== 'ready') return
    compareStatus = 'loading'
    compareSource = 'picker'
    compareError = null
    const fromShort = from === load.state.meta.baseSha ? 'base' : from.slice(0, 7)
    const toShort = to.slice(0, 7)
    try {
      const files = await compareCommits({ owner, repo }, from, to)
      compareMode = { files, label: `${fromShort}…${toShort}` }
      pickerActive = { from, to }
      compareStatus = 'idle'
      // Push a flagged history entry so browser back exits compare instead of leaving the PR
      history.pushState({ review123Compare: true }, '', location.pathname)
    } catch (e) {
      if (e instanceof GithubApiError && e.detail.kind === 'not-found') {
        compareError = "Couldn't compare commits — one revision may no longer exist."
      } else {
        compareError = 'Comparison failed. Please try again.'
      }
      compareStatus = 'error'
    }
  }

  function handlePickerClear() {
    exitCompareMode()
  }

  // ---- Shared exit / dismiss ----

  /**
   * Clear compare state. When called from a UI button ("Full diff"), if the
   * current history entry is the compare-flagged one, call history.back() so
   * the stack stays clean. When called from the popstate handler (fromPopstate
   * = true), skip history.back() — the pop already consumed the entry.
   */
  function exitCompareMode(fromPopstate = false) {
    compareMode = null
    compareStatus = 'idle'
    compareError = null
    compareSource = null
    pickerActive = null
    if (!fromPopstate && history.state?.review123Compare) {
      history.back()
    }
  }

  // Listen for browser back while compare is active: consume the pop and exit
  // compare mode instead of navigating away.
  $effect(() => {
    function handlePopstate(e: PopStateEvent) {
      // Only intercept when compare is active. The router's own listener will
      // re-match the same pathname (same route, no remount) — exitCompareMode
      // here runs in the same microtask and clears state before any re-render.
      if (compareMode !== null) {
        exitCompareMode(true)
      }
    }
    window.addEventListener('popstate', handlePopstate)
    return () => { window.removeEventListener('popstate', handlePopstate) }
  })

  function dismissBanner() {
    prevVisitSha = null
    prevVisitedAt = null
    exitCompareMode()
  }

  function formatVisitDate(ts: number): string {
    const d = new Date(ts)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  async function handleGrantPrivateAccess() {
    sessionStorage.setItem(RETURN_KEY, location.pathname)
    location.assign(await beginSignIn('repo'))
  }

  // ---- AI run ----
  let aiRun: ReturnType<typeof createAiRun> | null = $state(null)

  // Ask AI gating for the inline widget — mirrors ContextRail's askDisabledReason
  function getInlineAskDisabledReason(): string | null {
    if (aiRun === null) return null
    return aiRun.summary.status === 'no-key'
      ? 'No API key configured. Add your DeepSeek key in Settings to use Ask AI.'
      : null
  }
  const inlineAskDisabledReason = $derived(getInlineAskDisabledReason())

  let railCollapsed = $state(getSettings().railCollapsed)

  // Narrow viewport detection: below 1100px the rail auto-collapses and
  // expansions are transient (not persisted to settings).
  const NARROW_BREAKPOINT = 1100
  let isNarrow = $state(
    typeof window !== 'undefined' && window.innerWidth < NARROW_BREAKPOINT
  )

  $effect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`)
    function handleChange(e: MediaQueryListEvent) {
      isNarrow = e.matches
      // When entering narrow mode, force collapse (overlay behaviour)
      if (e.matches) {
        railCollapsed = true
      }
    }
    mq.addEventListener('change', handleChange)
    // Initialize: if currently narrow, force collapse regardless of stored pref
    if (mq.matches) {
      isNarrow = true
      railCollapsed = true
    }
    return () => mq.removeEventListener('change', handleChange)
  })

  // showProgress: read once at mount (same pattern as railCollapsed).
  // To pick up changes from SettingsPanel without re-mounting Review, the
  // SettingsPanel checkbox calls setShowProgress immediately (like theme),
  // but Review itself does not re-read. A page reload or a remount via the
  // {#key} block in App.svelte will pick up the new value.
  let showProgress = $state(getSettings().showProgress)

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

  // File contents — fetched once, shared by AI pack() and InspectStep diff expansion.
  // null = not yet fetched; Map = ready (may be empty if fetch failed).
  let contentsMap: Map<string, { before: string | null; after: string | null }> | null = $state(null)
  let contentsPromise: Promise<Map<string, { before: string | null; after: string | null }>> | null = null

  function getContents(
    files: PrFile[],
    meta: { baseSha: string; headSha: string },
  ): Promise<Map<string, { before: string | null; after: string | null }>> {
    if (!contentsPromise) {
      contentsPromise = fetchContents({ owner, repo }, files, meta).catch(() => new Map())
      contentsPromise.then((map) => { contentsMap = map })
    }
    return contentsPromise
  }

  // PR comments state
  let prComments: PrComment[] = $state([])
  let resolvedCommentIds: Set<number> = $state(new Set())
  let commentsError = $state(false)
  let commentsDismissed = $state(false)
  let commentsLoaded = $state(false)

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

      // Start fetching file contents immediately — shared with InspectStep for
      // context-line expansion (up to 30 files, concurrency cap 4).
      getContents(files, meta)

      const run = createAiRun({
        prKey,
        repo: repoStr,
        isPrivate: meta.private,
        pack: async () => {
          const contents = await getContents(files, meta)
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

  // Fetch PR comments + resolved thread state once when PR is ready (non-blocking, silent on failure)
  let commentsInitialized = false
  $effect(() => {
    if (load.state.status === 'ready' && !commentsInitialized) {
      commentsInitialized = true
      Promise.all([
        getPrComments({ owner, repo, number }),
        getResolvedCommentIds({ owner, repo, number }),
      ]).then(
        ([comments, resolved]) => {
          prComments = comments
          resolvedCommentIds = resolved
          commentsLoaded = true
        },
        () => {
          commentsError = true
          commentsLoaded = true
        },
      )
    }
  })

  // Canonicalize bare /review/o/r/n → /review/o/r/n/understand (replaceState, not push)
  $effect(() => {
    const bare = `/review/${owner}/${repo}/${number}`
    if (location.pathname === bare || location.pathname === bare + '/') {
      history.replaceState(history.state, '', `${bare}/understand`)
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
      document.getElementById(`file-${slugify(path)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  // Whether compare mode is currently active (either source)
  const isCompareActive = $derived(compareMode !== null)
  // Files to show in InspectStep
  const inspectFiles = $derived(isCompareActive ? compareMode!.files : (load.state.status === 'ready' ? load.state.files : []))
  const inspectChangedFiles = $derived(isCompareActive ? compareMode!.files.length : (load.state.status === 'ready' ? load.state.meta.changedFiles : 0))
</script>

{#if consentDialogVisible}
  <ConsentDialog repo={consentDialogRepo} onresult={handleConsentResult} />
{/if}

<section class="review" data-rail-collapsed={String(railCollapsed)}>
  {#if load.state.status === 'loading'}
    <div class="pr-loading" role="status">
      <Skeleton header lines={1} />
      <div class="skeleton-stepper-ghost" aria-hidden="true">
        <span class="skeleton-step-btn"></span>
        <span class="skeleton-step-btn"></span>
        <span class="skeleton-step-btn"></span>
      </div>
      <Skeleton lines={3} />
      <Skeleton lines={3} />
      <Skeleton lines={3} />
      <p class="loading-caption">Loading pull request from GitHub…</p>
    </div>
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
    <Stepper {step} onstep={(s) => goStep(s)} />

    <!-- ContextRail outside step switch (all steps) -->
    {#if aiRun}
      <ContextRail
        run={aiRun}
        onhotspot={handleHotspot}
        collapsed={railCollapsed}
        oncollapse={(c) => {
          railCollapsed = c
          // At narrow widths, the expanded state is transient — don't persist it
          if (!isNarrow) {
            setRailCollapsed(c)
          }
        }}
        onbackdropclick={() => { railCollapsed = true }}
      />
    {/if}

    {#if step === 1}
      <UnderstandStep
        meta={load.state.meta}
        files={load.state.files}
        ci={ciData}
        {ciError}
        run={aiRun ?? { summary: {status:'idle'}, attention: {status:'idle'}, diagrams: {status:'idle'}, verdict: {status:'idle'}, tests: {status:'idle'}, alternatives: {status:'idle'}, start: async()=>{}, retry: async()=>{}, coach: async()=>({error:'no-key'}) } as any}
        onhotspot={handleHotspot}
      />
    {:else if step === 2}
      <!-- Since-last-visit banner -->
      {#if prevVisitSha !== null}
        <div class="visit-banner" role="alert">
          {#if compareStatus === 'idle' && compareSource !== 'banner'}
            This PR changed since your last visit ({prevVisitedAt !== null ? formatVisitDate(prevVisitedAt) : 'previously'}).
            <button class="banner-btn" onclick={fetchCompare}>Show only changes since then</button>
            <button class="banner-dismiss" onclick={dismissBanner} aria-label="Dismiss">×</button>
          {:else if compareStatus === 'loading' && compareSource === 'banner'}
            Loading changes since your last visit…
            <button class="banner-dismiss" onclick={dismissBanner} aria-label="Dismiss">×</button>
          {:else if compareStatus === 'error' && compareSource === 'banner'}
            {compareError}
            <button class="banner-dismiss" onclick={dismissBanner} aria-label="Dismiss">×</button>
          {:else if isCompareActive && compareSource === 'banner'}
            Showing {compareMode!.files.length} file{compareMode!.files.length === 1 ? '' : 's'} changed since your last visit
            · <button class="banner-btn" onclick={() => exitCompareMode()}>Show full diff</button>
            <button class="banner-dismiss" onclick={dismissBanner} aria-label="Dismiss">×</button>
          {:else}
            <!-- Banner is idle but picker is active — show simplified banner with dismiss -->
            This PR changed since your last visit ({prevVisitedAt !== null ? formatVisitDate(prevVisitedAt) : 'previously'}).
            <button class="banner-btn" onclick={fetchCompare}>Show only changes since then</button>
            <button class="banner-dismiss" onclick={dismissBanner} aria-label="Dismiss">×</button>
          {/if}
        </div>
      {/if}

      <!-- Revision picker (shown when commits loaded and not hidden due to error) -->
      {#if prCommits !== null && !pickerHidden && prCommits.length > 0}
        {#if compareStatus === 'loading' && compareSource === 'picker'}
          <div class="picker-loading" role="status" aria-live="polite">
            Loading commit comparison…
          </div>
        {:else if compareStatus === 'error' && compareSource === 'picker'}
          <div class="picker-error" role="alert">
            {compareError}
            <button class="banner-btn" onclick={() => exitCompareMode()}>Dismiss</button>
          </div>
        {:else}
          <RevisionPicker
            commits={prCommits}
            baseSha={load.state.meta.baseSha}
            active={compareSource === 'picker' ? pickerActive : null}
            onselect={handlePickerSelect}
            onclear={handlePickerClear}
          />
        {/if}
      {/if}

      {#if commentsError && !commentsDismissed}
        <div class="comments-error-note" role="alert">
          Couldn't load existing comments.
          <button
            class="comments-dismiss-btn"
            aria-label="Dismiss comments error"
            onclick={() => { commentsDismissed = true }}
          >×</button>
        </div>
      {/if}
      <InspectStep
        files={inspectFiles}
        changedFiles={inspectChangedFiles}
        {mode}
        onmode={setMode}
        {draftStore}
        attention={isCompareActive ? null : (aiRun?.attention.status === 'done' ? aiRun.attention.value as AttentionResult : null)}
        readingOrder={isCompareActive ? [] : readingOrder}
        {viewedStore}
        prComments={isCompareActive ? [] : prComments}
        resolvedCommentIds={isCompareActive ? new Set() : resolvedCommentIds}
        {contentsMap}
        skillReviews={aiRun?.skillReviews ?? []}
        runSkillReviewsFn={aiRun != null ? (() => { void aiRun!.runSkillReviews() }) : null}
        askFn={aiRun ? aiRun.ask : null}
        askDisabledReason={inlineAskDisabledReason}
      />
    {:else}
      <VerdictStep
        prRef={{ owner, repo, number }}
        commitId={load.state.meta.headSha}
        store={draftStore ?? createDraftStore(`${owner}/${repo}#${number}`)}
        prUrl={`https://github.com/${owner}/${repo}/pull/${number}`}
        coachFn={aiRun ? aiRun.coach : undefined}
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
        <span class="draft-count text-muted">
          {draftStore?.count ?? 0} comment{(draftStore?.count ?? 0) === 1 ? '' : 's'} drafted{#if viewedStore.count > 0}&nbsp;&middot; viewed {viewedStore.count}/{load.state.files.length}{/if}
        </span>
      </span>
      {#if showProgress}
        <ReviewProgress
          viewedCount={viewedStore.count}
          fileCount={load.state.files.length}
          draftCount={draftStore?.count ?? 0}
          {step}
          inline
        />
      {/if}
      <div class="step-nav">
        <button
          class="btn"
          disabled={!canPrev}
          onclick={() => goStep(step - 1)}
          aria-label="Previous step"
        >
          ← Prev
        </button>
        <button
          class="btn"
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

  /*
   * Medium regime (1100–1443px): rail is 300px fixed, but the viewport doesn't have
   * enough free space for it without covering content. Push content right so the
   * expanded rail never overlaps interactive elements (e.g. the "Full diff" button).
   * Only applies when the rail is expanded (data-rail-collapsed="false").
   */
  @media (max-width: 1443px) and (min-width: 1100px) {
    .review:not([data-rail-collapsed="true"]) {
      padding-right: calc(300px + 1rem);
    }
  }
  .muted { opacity: 0.6; }

  .comments-error-note {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: #1a1a2e;
    border: 1px solid #8883;
    border-left: 3px solid #9a6700;
    border-radius: 4px;
    padding: 0.4rem 0.75rem;
    font-size: 0.85rem;
    color: #c8d0e0;
    margin-bottom: 0.5rem;
  }

  .comments-dismiss-btn {
    background: none;
    border: none;
    color: #6a8090;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.25rem;
    margin-left: auto;
  }

  .comments-dismiss-btn:hover {
    color: #90a8b8;
  }

  .visit-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    background: var(--surface-banner, #1a3050);
    border: 1px solid var(--border-banner, #2a5080);
    border-left: 3px solid var(--border-banner-accent, #4a90d0);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    margin-bottom: 0.75rem;
    color: var(--text-banner, #c8dff0);
  }

  .banner-btn {
    background: none;
    border: none;
    color: #6ab4f0;
    cursor: pointer;
    font-size: 0.875rem;
    text-decoration: underline;
    padding: 0;
  }

  .banner-btn:hover {
    color: #90ccff;
  }

  .banner-dismiss {
    background: none;
    border: none;
    color: #6a8090;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.25rem;
    margin-left: auto;
  }

  .banner-dismiss:hover {
    color: #90a8b8;
  }

  .picker-loading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--surface-raised, #1a1a2e);
    border: 1px solid var(--border, #3a4060);
    border-left: 3px solid var(--border-banner-accent, #4a90d0);
    border-radius: 4px;
    padding: 0.4rem 0.75rem;
    font-size: 0.85rem;
    color: #c8dff0;
    margin-bottom: 0.5rem;
  }

  .picker-error {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: #1a1a2e;
    border: 1px solid #8883;
    border-left: 3px solid #cf222e;
    border-radius: 4px;
    padding: 0.4rem 0.75rem;
    font-size: 0.85rem;
    color: #c8d0e0;
    margin-bottom: 0.5rem;
  }

  /* EC-07i: Sticky bottom bar */
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

  .draft-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }

  .draft-count {
    font-size: 0.85rem;
    font-weight: 400;
    white-space: nowrap;
    color: var(--text-muted);
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
    flex-shrink: 0;
  }

  .pr-loading {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem 0;
  }

  .skeleton-stepper-ghost {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }

  .skeleton-step-btn {
    display: inline-block;
    width: 5rem;
    height: 1.5rem;
    background: var(--surface-raised, #2a2a3e);
    border-radius: 4px;
    opacity: 0.5;
  }

  .loading-caption {
    font-size: 0.875rem;
    color: var(--text-muted);
    opacity: 0.75;
    margin: 0;
    text-align: center;
  }
</style>
