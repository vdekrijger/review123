<script lang="ts">
  import { createPrLoad } from '../lib/review/loadPr.svelte'
  import Stepper, { type Step } from '../components/Stepper.svelte'
  import InspectStep from '../components/InspectStep.svelte'
  import RevisionPicker from '../components/RevisionPicker.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import CraftedLoader from '../components/CraftedLoader.svelte'
  import ProviderIcon from '../components/ProviderIcon.svelte'
  import { getSettings, setDiffMode, setHideWhitespace, setRailCollapsed, setStoryMode, type DiffMode } from '../lib/settings/settings'
  import { activeProviderHasKey } from '../lib/llm/config'
  import type { GraphResult, StoryOrderResult } from '../lib/ai/schemas'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import ReviewProgress from '../components/ReviewProgress.svelte'
  import { beginSignIn, needsScopeUpgrade } from '../lib/auth/auth'
  import { createDraftStore } from '../lib/drafts/drafts.svelte'
  import { createDecisionStore } from '../lib/eval/decisions'
  import VerdictStep from '../components/VerdictStep.svelte'
  import { createAiRun } from '../lib/ai/run.svelte'
  import { listSkills } from '../lib/skills/skills'
  import { shouldAutoStartReviewers } from '../lib/review/autoStartReviewers'
  import { buildCoachCodeContext } from '../lib/ai/coachContext'
  import { packContext, fetchContents } from '../lib/context/pack'
  import { LLM_CONFIG } from '../lib/llm/config'
  import { getProvider } from '../lib/llm/providers'
  import { parseReadingOrder } from '../lib/ai/tasks'
  import ConsentDialog from '../components/ConsentDialog.svelte'
  import UnderstandStep from '../components/UnderstandStep.svelte'
  import ContextRail from '../components/ContextRail.svelte'
  import { navigate as navigateTo, STEP_PATHS, router } from '../lib/router/router.svelte'
  import { addToHistory } from '../lib/history/history'
  import { createViewedStore } from '../lib/viewed/viewed.svelte'
  import { recordVisit, lastVisit } from '../lib/visits/visits'
  import { GithubApiError } from '../lib/github/types'
  import type { CiSummary } from '../lib/github/checks'
  import type { AttentionResult } from '../lib/ai/schemas'
  import type { PrFile } from '../lib/github/types'
  import type { PrComment } from '../lib/github/comments'
  import type { PrCommit } from '../lib/github/commits'
  import { jumpToFileDiff } from '../lib/diff/jumpToFile'
  import { migrateLegacyVisits, migrateLegacyViewed } from '../lib/provider/storeKeys'
  import { providerFor } from '../lib/provider/registry'
  import type { PrRefX, ReplyOutcome } from '../lib/provider/types'
  import { track } from '../lib/analytics/analytics'

  const RETURN_KEY = 'review123:returnTo'

  let { owner, repo, number, step: stepProp, provider: providerProp }: {
    owner: string
    repo: string
    number: number
    step?: 1 | 2 | 3
    provider?: string
  } = $props()
  // Resolve provider id — defaults to 'github' for backward compat.
  // $derived so Svelte tracks it reactively (avoids state_referenced_locally warning).
  // In practice this never changes within a mount because App.svelte uses {#key} with provider.
  const providerId = $derived(providerProp ?? 'github')
  // Derive the provider instance so provider-specific API methods can be used.
  const activeProvider = $derived(providerFor(providerId))
  // PrRefX for provider-aware API calls
  const prRefX = $derived<PrRefX>({
    provider: providerId as PrRefX['provider'],
    owner,
    repo,
    number,
  })

  // Run silent key migration once on mount — copies legacy "owner/repo#n" keys to
  // "github:owner/repo#n" in localStorage so old visit/viewed data is not lost.
  migrateLegacyVisits()
  migrateLegacyViewed()
  // Relies on the {#key} remount in App.svelte: props never change within a
  // mount, so createPrLoad is called exactly once per PR navigation. Removing
  // the key would cause duplicate fetches + stale draft store.
  //
  // IMPORTANT: this must be a plain const, NOT $derived. Prop reads here track
  // the parent's `router.route`, which is reassigned (new object, same values)
  // on EVERY navigate() — including step-only changes (understand → inspect →
  // verdict and browser back/forward). A $derived.by would re-run on each step
  // change, recreating the load → duplicate fetch + loading-skeleton flash.
  // Step changes must be instant; only a PR identity change ({#key} remount)
  // or a hard page load may fetch.
  // Capturing the initial prop values is intentional (see above) — silence the
  // "only captures the initial value" warning.
  // svelte-ignore state_referenced_locally
  const load = createPrLoad(
    { owner, repo, number },
    {
      getPrMeta: (ref) => activeProvider.getPrMeta({ ...ref, provider: providerId as PrRefX['provider'] }),
      getPrFiles: (ref) => activeProvider.getPrFiles({ ...ref, provider: providerId as PrRefX['provider'] }),
    },
  )
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

  // Hide-whitespace toggle — same persistence pattern as diffMode
  let hideWhitespace = $state<boolean>(getSettings().hideWhitespace)
  function setHideWs(hide: boolean) { hideWhitespace = hide; setHideWhitespace(hide) }

  // Story mode (Plan H) — per-browser flow choice, same persistence pattern.
  let storyMode = $state<boolean>(getSettings().storyMode)
  function setStory(on: boolean) { storyMode = on; setStoryMode(on) }

  // Track step changes — fires on initial render and whenever step changes.
  $effect(() => {
    track('step_viewed', { step: String(step) })
  })

  /** Clamp n to 1..3 and navigate to the corresponding step URL */
  function goStep(n: number) {
    const clamped = Math.max(1, Math.min(3, n)) as Step
    navigateTo(`/review/${providerId}/${owner}/${repo}/${number}/${STEP_PATHS[clamped]}`)
  }
  const canPrev = $derived(step > 1)
  const canNext = $derived(step < 3)

  // ---- Viewed store — keyed by provider:owner/repo#number (NO sha — survives pushes) ---
  const prId = $derived(`${providerId}:${owner}/${repo}#${number}`)
  const viewedStore = $derived(createViewedStore(prId))
  // Explicit $derived for the count so Svelte 5 always tracks the entries $state
  // signal through the $derived boundary. Without this, reading viewedStore.count
  // directly in the template may not re-render when entries updates (the $derived
  // caches the object reference; the inner $state getter is read outside a tracked
  // derived node). The explicit derived creates a proper signal dependency chain:
  // entries → viewedCount → footer progressbar + draft-status text.
  const viewedCountDerived = $derived(viewedStore.count)

  // ---- Draft store — created once per PR+headSha (after the PR loads) -----
  // We keep a single store instance; it persists across step switches.
  let draftStore: ReturnType<typeof createDraftStore> | null = $state(null)
  // ---- Decision store — accept/dismiss ground-truth (telemetry loop) -------
  // Records each AI finding's accept/dismiss outcome locally so the eval capture
  // flow can pre-label a golden case. Created alongside the draft store, same PR key.
  let decisionStore: ReturnType<typeof createDecisionStore> | null = $state(null)
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
      // Drafts are keyed by stable PR IDENTITY (no head sha), so a new commit
      // never orphans them. The current head sha is passed as the maker-sha so
      // newly created drafts record the commit they were made on; load() also
      // migrates any legacy `@sha`-keyed drafts into this identity key.
      const prKey = prId
      const store = createDraftStore(prKey, undefined, meta.headSha)
      draftStore = store
      // Decision store keeps its head-sha-scoped key (unrelated to draft re-key).
      const decisions = createDecisionStore(`${providerId}:${owner}/${repo}#${number}@${meta.headSha}`)
      decisionStore = decisions
      void decisions.load()
      // Un-awaited intentionally: causes a cosmetic 0-count flash on mount
      // but avoids blocking render. Load completes asynchronously (and absorbs
      // any legacy sha-keyed drafts via the re-key migration in load()).
      void store.load()

      // Record this PR in the recent-reviews history. The full file stats are
      // already loaded here, so persist the diff size too — the landing page
      // shows it on history rows without any extra network.
      const files = load.state.files
      addToHistory({
        provider: prRefX.provider,
        owner,
        repo,
        number,
        title: meta.title,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      })

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
      activeProvider.getCommits(prRefX).then(
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
      const files = await activeProvider.compareCommits({ owner, repo }, prevVisitSha, load.state.meta.headSha)
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
      const files = await activeProvider.compareCommits({ owner, repo }, from, to)
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

  // Ask AI gating for the inline widget — mirrors ContextRail's askDisabledReason.
  // Names the ACTIVE provider (Plan F) — reactive via settingsState.
  function getInlineAskDisabledReason(): string | null {
    if (aiRun === null) return null
    const providerName = getProvider(settingsState.current.aiProvider)?.displayName ?? 'provider'
    return aiRun.summary.status === 'no-key'
      ? `No API key configured. Add your ${providerName} key in Settings to use Ask AI.`
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

  // showProgress: derived from settingsState so it updates live when the user
  // toggles the setting on the Settings page without needing a remount.
  const showProgress = $derived(settingsState.current.showProgress)

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
  function getCi(_ref: { owner: string; repo: string; number: number }, headSha: string) {
    if (!ciPromise) {
      ciPromise = activeProvider.getCiSummary(prRefX, headSha).catch(() => null)
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
      const prKey = `${providerId}:${owner}/${repo}#${number}@${meta.headSha}`
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
        // Deep review (Plan G): verification tools wired from the active VCS
        // provider. Only used when the aiDeepReview setting is on; search is
        // capability-gated by provider method presence (GitHub-only in v1).
        deepReview: {
          getFileAtHead: (path: string) => activeProvider.getFileAtRef({ owner, repo }, path, meta.headSha),
          getFileAtBase: (path: string) => activeProvider.getFileAtRef({ owner, repo }, path, meta.baseSha),
          ...(activeProvider.searchCode
            ? { searchCode: (query: string) => activeProvider.searchCode!({ owner, repo }, query) }
            : {}),
          ...(activeProvider.findReferences
            ? { findReferences: (symbol: string) => activeProvider.findReferences!({ owner, repo }, symbol) }
            : {}),
        },
        // Per-comment code context for the coach (v16): the actual code at each
        // commented file:line — hunk excerpt + a wider window from the file
        // contents we already fetched (contentsMap). Lets the coach verify
        // rather than default to "cannot verify against the diff".
        coachCodeContext: (drafts) => buildCoachCodeContext(drafts, files, contentsMap),
        // Per-finding code context for cross-model verification (Plan M): the
        // actual code at each finding's file:line so verifier models judge
        // against real code. Same source as the coach context above.
        verifyCodeContext: (anchors) => buildCoachCodeContext(anchors, files, contentsMap),
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
        activeProvider.getComments(prRefX),
        activeProvider.getResolvedCommentIds(prRefX),
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

  // ---- Auto-start skill reviewers early (opt-out, default ON) ----
  // While the user is still on step 1 (Understand), kick the reviewers off so
  // findings are ready by the Inspect step. Fires ONCE per loaded PR REGARDLESS
  // of the current step — guarded by a one-shot flag keyed to the PR identity so
  // step navigation / re-renders / back-forward never re-trigger it (calling
  // runSkillReviews again RESETS every entry to 'queued'). The guard resets when
  // the PR identity (provider/owner/repo/number) changes — App.svelte's {#key}
  // remount also makes a fresh aiRun per PR, so a new PR auto-starts cleanly.
  let autoStartedFor = $state<string | null>(null)
  $effect(() => {
    const enabledCount = listSkills().filter((s) => s.enabled).length
    if (
      shouldAutoStartReviewers({
        autoRunReviewers: settingsState.current.autoRunReviewers,
        aiRunReady: aiRun != null,
        loadReady: load.state.status === 'ready',
        hasKey: activeProviderHasKey(),
        skillsMode: settingsState.current.aiTaskModes.skills,
        enabledSkillCount: enabledCount,
        alreadyStartedFor: autoStartedFor,
        prId,
      })
    ) {
      // Local const re-narrows aiRun for TS (the predicate hides the null check).
      const run = aiRun
      if (run == null) return
      autoStartedFor = prId
      track('reviewers_auto_started', { count: enabledCount })
      // prComments is lazily fetched (may still be empty on step 1) — pass
      // whatever is available; the existing-comments list is only a dedupe aid,
      // never a blocker. autoRetry: 3 so transient failures settle on their own.
      void run.runSkillReviews(undefined, prComments?.map((c) => c.body) ?? [], { autoRetry: 3 })
    }
  })

  // Reply to an existing comment thread — posts IMMEDIATELY (not queued with
  // the review). On success the created comment is appended to prComments so
  // the reply shows up in its thread right away.
  async function postReply(root: PrComment, body: string): Promise<ReplyOutcome> {
    if (!activeProvider.replyToThread) {
      return { ok: false, message: `${activeProvider.displayName} does not support replying to threads.` }
    }
    const result = await activeProvider.replyToThread(prRefX, root, body)
    if (result.ok) {
      prComments = [...prComments, result.comment]
    }
    return result
  }

  // Canonicalize bare /review/.../n (no step) → /review/.../n/understand (replaceState, not push)
  // Also canonicalize legacy /review/o/r/n → /review/github/o/r/n/understand
  $effect(() => {
    const canonicalBase = `/review/${providerId}/${owner}/${repo}/${number}`
    const legacyBase = `/review/${owner}/${repo}/${number}`
    const path = location.pathname
    if (path === canonicalBase || path === canonicalBase + '/') {
      history.replaceState(history.state, '', `${canonicalBase}/understand`)
    } else if (path === legacyBase || path === legacyBase + '/') {
      history.replaceState(history.state, '', `${canonicalBase}/understand`)
    } else if (path === `${legacyBase}/understand` || path === `${legacyBase}/inspect` || path === `${legacyBase}/verdict`) {
      // Legacy step path — upgrade to canonical provider form
      const step = path.slice(legacyBase.length + 1)
      history.replaceState(history.state, '', `${canonicalBase}/${step}`)
    }
  })

  // Reading order from summary
  const readingOrder = $derived.by(() => {
    if (!aiRun || aiRun.summary.status !== 'done') return []
    return parseReadingOrder(aiRun.summary.value as string)
  })

  // Jump to a file's diff card: SPA-navigate to the Inspect step when not
  // already there (router pushState — never location.href, no page reload),
  // then scroll to / expand the card via the shared file-tree mechanism.
  function handleHotspot(path: string) {
    jumpToFileDiff(path, {
      isInspectActive: step === 2,
      navigateToInspect: () => goStep(2),
    })
  }

  // Whether compare mode is currently active (either source)
  const isCompareActive = $derived(compareMode !== null)
  // Story mode requires an LLM key (it's a classification task) and is
  // unavailable while comparing revisions (the story is built for the PR diff).
  const storyAvailable = $derived(activeProviderHasKey() && !isCompareActive)
  // Files to show in InspectStep
  const inspectFiles = $derived(isCompareActive ? compareMode!.files : (load.state.status === 'ready' ? load.state.files : []))
  const inspectChangedFiles = $derived(isCompareActive ? compareMode!.files.length : (load.state.status === 'ready' ? load.state.meta.changedFiles : 0))

  // ---- Scroll-based inspect progress (step 2 only) ----
  // Tracks vertical scroll progress through the inspect content container.
  // 0% = container top at/above viewport top; 100% = scrolled to container bottom.
  let scrollPercent = $state(0)

  $effect(() => {
    // Only active on step 2
    if (step !== 2) {
      scrollPercent = 0
      return
    }

    let rafId = 0

    function updateScroll() {
      const container = document.querySelector('.review') as HTMLElement | null
      if (!container) return
      const rect = container.getBoundingClientRect()
      const scrollable = container.scrollHeight - window.innerHeight
      if (scrollable <= 0) {
        scrollPercent = 100
        return
      }
      // How far from the top of the page to the top of the container
      const containerTop = container.offsetTop
      const scrolled = window.scrollY - containerTop
      const raw = scrolled / scrollable
      scrollPercent = Math.round(Math.max(0, Math.min(1, raw)) * 100)
    }

    function onScroll() {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updateScroll)
    }

    updateScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(rafId)
    }
  })
</script>

{#if consentDialogVisible}
  <ConsentDialog repo={consentDialogRepo} onresult={handleConsentResult} />
{/if}

<section class="review" data-rail-collapsed={String(railCollapsed)}>
  {#if load.state.status === 'loading'}
    <div class="pr-loading" aria-busy="true" aria-label="Loading pull request">
      <CraftedLoader />
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
    <div class="pr-header">
      <h1>{load.state.meta.title} <small>{owner}/{repo}#{number}</small></h1>
      <a
        class="view-on-provider"
        href={activeProvider.prWebUrl(prRefX)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View on ${activeProvider.displayName} (opens in a new tab)`}
        onclick={() => track('original_pr_opened', { provider: providerId })}
      >
        <ProviderIcon provider={providerId as PrRefX['provider']} size={13} />
        <span>View on {activeProvider.displayName}</span>
        <span class="ext" aria-hidden="true">↗</span>
      </a>
    </div>
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
        ci={ciData}
        meta={load.state.meta}
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
        {hideWhitespace}
        onhidewhitespace={setHideWs}
        whitespaceDisabledReason={isCompareActive ? 'Hide whitespace is unavailable in compare view — file contents are fetched for the PR base/head, not the compared revisions' : null}
        {draftStore}
        currentHeadSha={load.state.meta.headSha}
        {decisionStore}
        attention={isCompareActive ? null : (aiRun?.attention.status === 'done' ? aiRun.attention.value as AttentionResult : null)}
        readingOrder={isCompareActive ? [] : readingOrder}
        {viewedStore}
        prComments={isCompareActive ? [] : prComments}
        resolvedCommentIds={isCompareActive ? new Set() : resolvedCommentIds}
        {contentsMap}
        skillReviews={aiRun?.skillReviews ?? []}
        runSkillReviewsFn={aiRun != null ? (() => { void aiRun!.runSkillReviews(undefined, prComments.map((c) => c.body)) }) : null}
        onRetrySkill={aiRun != null ? ((skillId) => { void aiRun!.retrySkill(skillId, undefined, prComments.map((c) => c.body)) }) : null}
        askFn={aiRun ? aiRun.ask : null}
        askDisabledReason={inlineAskDisabledReason}
        replyFn={activeProvider.capabilities.commentReplies && !isCompareActive ? postReply : null}
        {storyAvailable}
        {storyMode}
        onstorymode={setStory}
        story={isCompareActive ? null : (aiRun?.story.status === 'done' ? aiRun.story.value as StoryOrderResult : null)}
        storyStatus={aiRun?.story.status ?? 'idle'}
        storyActivity={aiRun?.story.activity}
        storyError={aiRun?.story.error ?? null}
        storyFallback={isCompareActive ? false : (aiRun?.story.fallback ?? false)}
        storyFallbackReason={aiRun?.story.fallbackReason ?? null}
        onRetryStory={aiRun != null ? (() => { void aiRun!.retry('story') }) : null}
        diagrams={isCompareActive ? null : (aiRun?.diagrams.status === 'done' ? aiRun.diagrams.value as GraphResult : null)}
      />
    {:else}
      <VerdictStep
        prRef={{ owner, repo, number }}
        commitId={load.state.meta.headSha}
        store={draftStore ?? createDraftStore(`${providerId}:${owner}/${repo}#${number}`)}
        prUrl={activeProvider.prWebUrl(prRefX)}
        prTitle={load.state.meta.title}
        files={load.state.files}
        {contentsMap}
        coachFn={aiRun ? aiRun.coach : undefined}
        modelPerformance={aiRun ? aiRun.modelPerformance : []}
        modelCostBreakdown={aiRun ? aiRun.modelCostBreakdown : []}
        totalUsage={aiRun ? aiRun.totalUsage : undefined}
        {prComments}
        provider={activeProvider}
        authorLogin={load.state.meta.authorLogin}
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
          {draftStore?.count ?? 0} comment{(draftStore?.count ?? 0) === 1 ? '' : 's'} drafted{#if viewedCountDerived > 0}&nbsp;&middot; viewed {viewedCountDerived}/{load.state.files.length}{/if}
        </span>
      </span>
      {#if showProgress}
        <ReviewProgress
          viewedCount={viewedCountDerived}
          fileCount={load.state.files.length}
          {step}
          percent={scrollPercent}
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

  .pr-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .pr-header h1 {
    margin: 0;
    min-width: 0;
  }

  /* Utility/secondary link — muted, not a primary action */
  .view-on-provider {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
    align-self: center;
    font-size: 0.85rem;
    font-weight: 500;
    text-decoration: none;
    color: var(--text-muted);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    white-space: nowrap;
    transition: color 0.12s ease, border-color 0.12s ease;
  }

  .view-on-provider:hover,
  .view-on-provider:focus-visible {
    color: var(--text, #e8eef8);
    border-color: var(--accent, #4a90d0);
  }

  .view-on-provider .ext {
    font-size: 0.8em;
    opacity: 0.8;
  }

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

</style>
