<script lang="ts">
  import { parsePrUrl } from '../lib/github/parse'
  import { parseAnyUrl, PROVIDERS } from '../lib/provider/registry'
  import { navigate } from '../lib/router/router.svelte'
  import { getHistory, clearHistory, type HistoryEntry } from '../lib/history/history'
  import { fetchAllQueues, _resetQueueCacheForTest } from '../lib/provider/queue'
  import { fetchAllQueueSignals } from '../lib/provider/queueSignals'
  import { relativeTime } from '../lib/time'
  import { isSectionCollapsed, setSectionCollapsed, type LandingSectionId } from '../lib/landing/collapse'
  import { groupByRepo } from '../lib/landing/groupQueue'
  import { getCachedSizes, fetchMissingSizes, primeSize, sizeKey, type DiffSize } from '../lib/landing/queueSizes'
  import { listDraftSummaries, clearDraftsForPr, type DraftSummary } from '../lib/drafts/drafts.svelte'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { activeProviderHasKey } from '../lib/llm/config'
  import { getProvider as getLlmProvider } from '../lib/llm/providers'
  import { prepareStore, preparePr, preparePrId, prepareProgress, isPreparedFor, preparedRecord } from '../lib/ai/prepare.svelte'
  import { formatUsageLabel } from '../lib/ai/tokenCost'
  import { track } from '../lib/analytics/analytics'
  import ProviderIcon from '../components/ProviderIcon.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Spinner from '../components/Spinner.svelte'
  import type { QueueItem, QueueSignal, CiState } from '../lib/provider/types'

  // Human-readable provider names for accessible text alternatives.
  // Local map (not the registry) so the component stays renderable when the
  // registry is mocked down to a subset of providers.
  const PROVIDER_NAMES: Record<'github' | 'gitlab' | 'bitbucket', string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket',
  }

  /**
   * CI, as one glyph and one sentence.
   *
   * Three DIFFERENT shapes, not three colours of the same mark: the state has to
   * survive a reader who cannot separate the green from the red (p.146-147), and
   * the label is both the hover title and the screen-reader text.
   *
   * A mixed run — nine green jobs and one red — arrives as 'failing', because
   * that is what the rollup of a mixed run is and it is the actionable read of a
   * PR with a red check on it. The per-check breakdown is one click away on the
   * review page's CI panel; a queue row is not where nine job names belong.
   */
  const CI_GLYPHS: Record<'passing' | 'failing' | 'running', string> = {
    passing: '✓',
    failing: '✕',
    running: '•',
  }
  const CI_LABELS: Record<'passing' | 'failing' | 'running', string> = {
    passing: 'CI passing',
    failing: 'CI failing',
    running: 'CI running',
  }

  let input = $state('')
  let error = $state<string | null>(null)
  let history = $state<HistoryEntry[]>(getHistory())

  // Collapsible sections — per-browser UI state, persisted in localStorage
  let queueCollapsed = $state(isSectionCollapsed('queue'))
  let recentCollapsed = $state(isSectionCollapsed('recent'))
  let inflightCollapsed = $state(isSectionCollapsed('inflight'))

  function toggleSection(id: LandingSectionId) {
    const current =
      id === 'queue' ? queueCollapsed : id === 'recent' ? recentCollapsed : inflightCollapsed
    const collapsed = !current
    if (id === 'queue') queueCollapsed = collapsed
    else if (id === 'recent') recentCollapsed = collapsed
    else inflightCollapsed = collapsed
    setSectionCollapsed(id, collapsed)
    // Fire only on collapsed → expanded; ids only — never content.
    if (!collapsed) track('section_expanded', { section: id, surface: 'landing' })
  }

  // ---- In-flight reviews (unsubmitted drafts) ----------------------------
  // One row per PR IDENTITY (provider+owner+repo+number). A PR with drafts
  // under several head-SHAs collapses to a single row with the SUMMED count;
  // we keep every prKey so discard can reclaim all sha variants.
  interface InflightRow {
    /** Stable identity key: provider:owner/repo#number (sha-independent). */
    id: string
    provider: 'github' | 'gitlab' | 'bitbucket'
    owner: string
    repo: string
    number: number
    /** Every prKey (sha variant) contributing to this row. */
    prKeys: string[]
    /**
     * Notes that will be submitted. Withdrawn ones are NOT in here, because
     * this number is rendered as "N comments drafted" — word for word the
     * sentence Review.svelte renders from the store's live `count`, and the
     * two describing the same PR differently is the bug, not a nuance.
     */
    draftCount: number
    /** Notes taken out of the review and still stored (shown, never dropped). */
    withdrawnCount: number
    lastUpdatedAt: number
    /** Title from history when known, else null (falls back to the ref). */
    title: string | null
    /** True when drafts live under more than one head-SHA. */
    multipleShas: boolean
    /** Internal: distinct head-SHAs seen, to derive multipleShas. */
    _shas: Set<string>
  }

  let inflightRows = $state<InflightRow[]>([])

  function groupInflight(summaries: DraftSummary[], hist: HistoryEntry[]): InflightRow[] {
    const byIdentity = new Map<string, InflightRow>()
    for (const s of summaries) {
      const provider = (s.provider === 'gitlab' || s.provider === 'bitbucket' ? s.provider : 'github') as
        | 'github'
        | 'gitlab'
        | 'bitbucket'
      const id = `${provider}:${s.owner}/${s.repo}#${s.number}`
      const existing = byIdentity.get(id)
      if (existing) {
        existing.prKeys.push(s.prKey)
        existing.draftCount += s.draftCount
        existing.withdrawnCount += s.withdrawnCount
        if (s.lastUpdatedAt > existing.lastUpdatedAt) existing.lastUpdatedAt = s.lastUpdatedAt
        if (s.headSha && !existing._shas.has(s.headSha)) existing._shas.add(s.headSha)
        existing.multipleShas = existing._shas.size > 1
      } else {
        const title =
          hist.find((h) => (h.provider ?? 'github') === provider && h.owner === s.owner && h.repo === s.repo && h.number === s.number)?.title ?? null
        byIdentity.set(id, {
          id,
          provider,
          owner: s.owner,
          repo: s.repo,
          number: s.number,
          prKeys: [s.prKey],
          draftCount: s.draftCount,
          withdrawnCount: s.withdrawnCount,
          lastUpdatedAt: s.lastUpdatedAt,
          title,
          multipleShas: false,
          _shas: new Set(s.headSha ? [s.headSha] : []),
        })
      }
    }
    // Most-recently-edited first.
    return [...byIdentity.values()].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
  }

  async function loadInflight() {
    const summaries = await listDraftSummaries()
    inflightRows = groupInflight(summaries, history)
  }

  function resumeInflight(row: InflightRow) {
    // Navigate to the inspect step, where line comments live. The review flow
    // re-keys drafts to the current head-SHA and the since-last-visit interdiff
    // already scopes the view — we just navigate.
    navigate(`/review/${row.provider}/${row.owner}/${row.repo}/${row.number}/inspect`)
  }

  // Discard-with-confirm: a themed <dialog> (mirrors ConsentDialog) guards the
  // destructive clear of unsubmitted comments.
  let pendingDiscard = $state<InflightRow | null>(null)
  let discardDialogEl = $state<HTMLDialogElement | null>(null)

  // Open as a true modal once the dialog mounts (when pendingDiscard is set).
  // The bare `open` attribute renders a NON-modal dialog with no top layer or
  // backdrop — it appears as an unstyled box in normal flow, so the X looked
  // inert. showModal() gives the centered, backdropped modal (mirrors
  // ConsentDialog, whose base styles live in app.css).
  $effect(() => {
    if (!discardDialogEl) return
    if (!discardDialogEl.open) discardDialogEl.showModal()
  })

  function requestDiscard(row: InflightRow) {
    pendingDiscard = row
  }

  function cancelDiscard() {
    pendingDiscard = null
  }

  async function confirmDiscard() {
    const row = pendingDiscard
    pendingDiscard = null
    if (!row) return
    // Clear every sha variant of this PR, then drop the row reactively.
    await Promise.all(row.prKeys.map((k) => clearDraftsForPr(k)))
    inflightRows = inflightRows.filter((r) => r.id !== row.id)
  }

  // Load on mount (and so the section appears/hides as drafts change).
  $effect(() => {
    void loadInflight()
  })

  // Queue state
  let queueLoading = $state(true) // fetch in flight with nothing to show — skeletons
  let queueRefreshing = $state(false) // refresh in flight with rows on screen — dim + spinner
  let queueItems = $state<QueueItem[]>([])

  const MESSAGES: Record<string, string> = {
    empty: 'Please enter a GitHub, GitLab, or Bitbucket pull request URL.',
    'not-github': 'That URL is not on github.com.',
    'not-a-pr-url': 'That does not look like a pull request URL (expected …/owner/repo/pull/123).',
  }

  // Providers that expose getMyQueue
  const allProviders = [...PROVIDERS.values()]
  const hasQueueProviders = allProviders.some((p) => typeof p.getMyQueue === 'function')
  // Reactive: settingsState.current is refreshed after every settings save
  // (including auth token mutations), so this re-evaluates — and the queue
  // section appears/disappears — when the user signs in or out, no remount.
  const anyAuthConfigured = $derived.by(() => {
    void settingsState.current // establish the reactive dependency
    return allProviders.some(
      (p) => typeof p.getMyQueue === 'function' && p.authState().configured,
    )
  })

  // Cold-start user: nothing configured (no VCS auth, no LLM key). For them the
  // demo CTA is the most valuable path, so it's emphasized as a primary button;
  // once anything is set up it stays available but becomes a quiet secondary link.
  const nothingConfigured = $derived.by(() => {
    void settingsState.current // reactive dependency (mirrors anyAuthConfigured)
    return !anyAuthConfigured && !activeProviderHasKey()
  })

  function goToDemo(e: MouseEvent) {
    e.preventDefault()
    track('demo_opened')
    navigate('/demo')
  }

  // Derived groups
  let awaitingReview = $derived(queueItems.filter((i) => !i.authorIsMe))
  let myOpenPrs = $derived(queueItems.filter((i) => i.authorIsMe))

  // ---- SECTION ORDER IS THE FIRST TOOL, NOT THE ONLY ONE -------------------
  // The page led with "Awaiting your review" and put the user's own PRs second,
  // which inverts what they actually come here for. The order flips; the extra
  // weight the leading group gets is applied by INK and SPACE (see
  // .queue-group-title.lead in the styles), never by a third type size or a
  // fourth weight — #284 fixed this surface at two sizes, two weights and three
  // inks and emphasis has to be earned inside that budget (p.30-34).
  //
  // Building it as a LIST rather than two hard-coded blocks is what keeps the
  // newcomer honest: whichever group is actually first gets the lead treatment,
  // so a user with no open PRs never lands on a page whose most prominent
  // section is an empty one — there simply is no empty section.
  interface QueueGroup {
    id: 'mine' | 'awaiting'
    title: string
    items: QueueItem[]
  }

  const queueGroups = $derived.by<QueueGroup[]>(() => {
    const groups: QueueGroup[] = []
    if (myOpenPrs.length > 0) groups.push({ id: 'mine', title: 'Your open PRs', items: myOpenPrs })
    if (awaitingReview.length > 0) {
      groups.push({ id: 'awaiting', title: 'Awaiting your review', items: awaitingReview })
    }
    return groups
  })

  // Diff sizes per row, keyed by sizeKey(item) — progressive enhancement:
  // cached sizes render with the list; missing ones pop in as batches resolve.
  let queueSizes = $state<Record<string, DiffSize>>({})

  // ---- Per-row signals (CI, unresolved conversations, base standing) -------
  // One batched provider call for the WHOLE queue, keyed by sizeKey(item).
  // A row the provider could not answer for is simply absent — never a zero.
  let queueSignals = $state<Record<string, QueueSignal>>({})

  function refreshQueueSizes(items: QueueItem[], fromSignals: Record<string, DiffSize> = {}) {
    queueSizes = { ...getCachedSizes(items), ...fromSignals }
    // Un-awaited intentionally — sizes must never block or delay the queue render.
    void fetchMissingSizes(items, (key, size) => {
      queueSizes = { ...queueSizes, [key]: size }
    })
  }

  /**
   * Fetch the queue's signals, then its sizes.
   *
   * The signals query ALREADY answers "how big is this diff" for every row, so
   * the sizes it returns are written into the size cache before the REST pass
   * runs — which makes that pass find nothing pending and fetch nothing. That is
   * where the per-row request saving actually lands: the old page cost one REST
   * call per GitHub row for sizes alone.
   *
   * Cached sizes are painted first so a slow or failing signals query costs the
   * chips nothing they already had, and a provider with no getQueueSignals
   * resolves here without a network call at all and falls straight through to
   * the REST path it has always used.
   */
  async function loadQueueSignals(items: QueueItem[]) {
    queueSizes = getCachedSizes(items)
    // Base standing is only resolved for the user's OWN PRs: "update this
    // branch" is only ever offered on a PR they can push to, so asking about
    // anyone else's costs a request to learn something no row will render.
    const signals = await fetchAllQueueSignals(allProviders, items, items.filter((i) => i.authorIsMe))
    queueSignals = signals
    const fromSignals: Record<string, DiffSize> = {}
    for (const item of items) {
      const size = signals[sizeKey(item)]?.size
      if (!size) continue
      primeSize(item, size)
      fromSignals[sizeKey(item)] = size
    }
    refreshQueueSizes(items, fromSignals)
  }

  // ---- Effort gauge (rubric p.30-31: nothing at equal emphasis) -----------
  // Fourteen rows at identical weight give the eye nothing to rank. The ONLY
  // ranking signal this component actually holds is churn — additions +
  // deletions, already fetched for the +/− chip — so that is the only one it
  // claims. The gauge is scaled to the LARGEST churn currently in the queue,
  // which is why it promises nothing absolute: it says "this one is big for
  // your queue today", never "this one is important". No priority is invented.
  const maxChurn = $derived.by(() => {
    let max = 0
    for (const size of Object.values(queueSizes)) {
      const total = size.additions + size.deletions
      if (total > max) max = total
    }
    return max
  })

  /** This row's share of the queue's largest diff, as a 0-100 percentage. */
  function churnPercent(size: DiffSize | undefined): number {
    if (!size || maxChurn <= 0) return 0
    const total = size.additions + size.deletions
    if (total <= 0) return 0
    // A floor so the smallest diff still reads as "present but tiny" rather
    // than as a missing measurement (p.146-147: the gauge must not vanish).
    return Math.max((total / maxChurn) * 100, 4)
  }

  async function loadQueue() {
    queueLoading = true
    queueItems = await fetchAllQueues(allProviders)
    queueLoading = false
    void loadQueueSignals(queueItems)
  }

  async function handleRefreshQueue() {
    _resetQueueCacheForTest()
    if (queueItems.length > 0) {
      // Refresh with rows on screen: keep them visible but dimmed (same
      // content-stays-visible treatment as AiPanel's streaming state).
      queueRefreshing = true
      try {
        queueItems = await fetchAllQueues(allProviders)
        void loadQueueSignals(queueItems)
      } finally {
        queueRefreshing = false
      }
    } else {
      // Nothing on screen — behave like the initial load (skeletons).
      await loadQueue()
    }
  }

  // Load when auth is configured at mount, or later when auth first appears
  // (the derived flips false → true after a settings save). Reruns only when
  // the boolean changes, never on unrelated settings writes.
  $effect(() => {
    if (anyAuthConfigured) loadQueue()
  })

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const result = parseAnyUrl(input)
    if (!result) {
      const ghResult = parsePrUrl(input)
      if (!ghResult.ok) {
        error = MESSAGES[ghResult.error] ?? 'That does not look like a valid pull request URL.'
      } else {
        error = 'That does not look like a valid pull request URL.'
      }
      return
    }
    error = null
    const { provider, ref } = result
    navigate(`/review/${provider.id}/${ref.owner}/${ref.repo}/${ref.number}`)
  }

  function navigateToPr(entry: HistoryEntry) {
    const provider = entry.provider ?? 'github'
    navigate(`/review/${provider}/${entry.owner}/${entry.repo}/${entry.number}`)
  }

  function navigateToQueueItem(item: QueueItem) {
    navigate(`/review/${item.ref.provider}/${item.ref.owner}/${item.ref.repo}/${item.ref.number}`)
  }

  // ---- Prepare-ahead (per-row "Prepare" on the queue) ----------------------
  // Runs the full auto AI pipeline for a PR in the background so opening it
  // later hits warm caches. Explicit per-row action; one at a time.

  function prepareIdOf(item: QueueItem): string {
    return preparePrId(item.ref.provider, item.ref.owner, item.ref.repo, item.ref.number)
  }

  function handlePrepare(item: QueueItem) {
    void preparePr({
      providerId: item.ref.provider,
      owner: item.ref.owner,
      repo: item.ref.repo,
      number: item.ref.number,
      updatedAt: item.updatedAt,
    })
  }

  // BYO-key gate — mirrors Ask AI's askDisabledReason pattern (names the
  // active provider; reactive via settingsState so a key save updates it live).
  const prepareDisabledReason = $derived.by(() => {
    void settingsState.current // establish the reactive dependency
    if (activeProviderHasKey()) return null
    const providerName = getLlmProvider(settingsState.current.aiProvider)?.displayName ?? 'provider'
    return `No API key configured. Add your ${providerName} key in Settings to prepare reviews.`
  })

  // Live "Preparing… (K/N)" label for a row (null-safe around missing progress).
  function preparingLabel(prId: string): string {
    const p = prepareProgress(prId)
    return p && p.total > 0 ? `Preparing… (${p.done}/${p.total})` : 'Preparing…'
  }

  // "Ready ✓" cost suffix — honors the opt-in showTokenCost setting; usage
  // comes from the live row when fresh, else the persisted record.
  function readyCostLabel(prId: string): string | null {
    if (!settingsState.current.showTokenCost) return null
    const usage = prepareStore.rows[prId]?.usage ?? preparedRecord(prId)?.usage
    return formatUsageLabel(usage ?? undefined)
  }

  // ---- Update branch (Deliverable 2) ---------------------------------------
  // GitHub's own "Update branch" button calls PUT …/pulls/{n}/update-branch: the
  // base is merged into the head ON THE SERVER, so this works on a PR the user
  // has never had checked out — which is most of a landing queue. The local
  // bridge is deliberately not involved; it would make an app-wide affordance
  // depend on a paired machine for an operation that needs no working tree.
  type BranchUpdate =
    | { status: 'updating' }
    | { status: 'error'; detail: string }

  let branchUpdates = $state<Record<string, BranchUpdate>>({})

  /** The provider that owns a row, or undefined (registry may be a subset). */
  function providerOf(item: QueueItem) {
    return allProviders.find((p) => p.id === item.ref.provider)
  }

  /**
   * Whether to OFFER the update, which is a stricter question than "is it
   * behind". All three must hold: the base has actually moved on, the viewer can
   * push to the branch, and there is no conflict — a conflict cannot be resolved
   * server-side, so a button there is a button that fails. The conflicting case
   * says so in words instead (see the baseCell snippet).
   */
  function canOfferUpdate(signal: QueueSignal | undefined): boolean {
    const base = signal?.base
    return base?.kind === 'behind' && base.canUpdate
  }

  async function handleUpdateBranch(item: QueueItem) {
    const key = sizeKey(item)
    const provider = providerOf(item)
    if (!provider?.updateBranch) return

    branchUpdates = { ...branchUpdates, [key]: { status: 'updating' } }
    const outcome = await provider.updateBranch(item.ref, queueSignals[key]?.headOid ?? null)

    // Counts and enums only — never the repo, the PR number or the branch.
    track('queue_branch_updated', { outcome: outcome.ok ? 'updated' : outcome.kind })

    if (!outcome.ok) {
      branchUpdates = { ...branchUpdates, [key]: { status: 'error', detail: outcome.message } }
      return
    }

    // The merge puts a NEW commit on the head branch, so the head SHA changes
    // and CI starts over. Rather than assert what the new CI state will be, we
    // re-read the queue's signals and render whatever GitHub actually reports —
    // which is how "CI is running again" ends up on the row honestly.
    branchUpdates = Object.fromEntries(
      Object.entries(branchUpdates).filter(([k]) => k !== key),
    )
    await loadQueueSignals(queueItems)
  }

  function handleClearHistory() {
    clearHistory()
    history = []
  }

  // First-run footnote: a subtle nudge to sign in / open Settings, shown only
  // before the user has reviewed anything (empty history). It fades away
  // naturally on their first review — it's a one-time nicety, not a banner.
  let showFirstTimeHint = $derived(history.length === 0)

  // A newcomer and a returning user want opposite things from this screen, and
  // only the newcomer was being served: the hero's 12vh top margin pushed the
  // queue 355px down the page on EVERY visit. So the hero keeps its generous
  // framing exactly while it IS the page, and stands down the moment the page
  // has real content of its own to lead with (p.30-31 — rank the surface; p.85
  // — space belongs to what it introduces).
  const hasContentBelow = $derived(
    (hasQueueProviders && anyAuthConfigured) || inflightRows.length > 0 || history.length > 0,
  )

  // SPA navigation for the hint's links — real <a href> for accessibility,
  // intercepted so we route in-app instead of a full reload. Mirrors the
  // goToSettings pattern used across the app (AiPanel, InspectStep, …).
  function goTo(path: string) {
    return (e: MouseEvent) => {
      e.preventDefault()
      navigate(path)
    }
  }
</script>

<!--
  queueRows — renders one queue list (awaiting / my open PRs).
  Every list is grouped under compact repo headers (provider icon + owner/repo)
  with rows showing just #number · title. A single-repo list shows one header;
  multi-repo lists show one header per repo. This keeps both queue sections
  consistent and avoids repeating the owner/repo prefix on every row.
-->
<!--
  queueSize — compact "+adds −dels" chip, colored like the diff stat chips
  elsewhere (FileDiff header). Rendered only once the size is known: rows
  appear immediately and sizes pop in (progressive enhancement).
-->
{#snippet queueSize(size: DiffSize | undefined)}
  {#if size}
    <span class="queue-size" data-testid="queue-size">
      <span class="stat-add">+{size.additions}</span>
      <span class="stat-del">−{size.deletions}</span>
    </span>
  {/if}
{/snippet}

<!--
  sizeCell — the queue row's diff-stat COLUMN. The cell is always rendered so
  the column reserves its width before the lazy size fetch lands (rubric C5:
  nothing may reflow under the reader when a late result arrives); the chip
  inside it still appears only once a size is actually known, which is what
  every "no chip when the size is unknown" test asserts.

  Inside, the effort gauge precedes the numbers: length is the ranking signal,
  the +/− figures are the exact value, and the two never disagree because both
  read the same DiffSize.
-->
<!--
  THE THREE SIGNAL CELLS — CI, unresolved conversations, base standing.

  All three follow sizeCell's rule: the CELL is always rendered so the column
  reserves its width before the batched signals query lands (rubric C5 — nothing
  may reflow under the reader when a late result arrives), and the CONTENT inside
  appears only once there is something true to say.

  "Nothing to say" covers four different facts that all render as an empty cell,
  and they are genuinely different: the provider has no getQueueSignals at all
  (GitLab, Bitbucket), the query could not answer for this row, the PR has no CI
  configured, and there are zero unresolved conversations. None of them is a
  state the reader can act on, so none of them gets ink — but the module keeps
  them apart (CiState 'none' vs a null ci) so a test can tell, and so nobody
  later reads an empty cell as a green one.
-->
{#snippet ciCell(signal: QueueSignal | undefined)}
  {@const state = signal?.ci ?? null}
  <span class="queue-cell ci-cell">
    {#if state === 'passing' || state === 'failing' || state === 'running'}
      <!-- p.146-147: the state is carried by the GLYPH first — a tick, a cross
           and a dot are three different shapes — with colour only reinforcing
           it, so the row still reads with colour vision that cannot separate
           the green from the red, and reads aloud through the sr-only text. -->
      <span class="ci-chip ci-{state}" data-testid="queue-ci" data-ci={state} title={CI_LABELS[state]}>
        <span aria-hidden="true">{CI_GLYPHS[state]}</span>
        <span class="sr-only">{CI_LABELS[state]}</span>
      </span>
    {/if}
  </span>
{/snippet}

{#snippet unresolvedCell(signal: QueueSignal | undefined)}
  {@const count = signal?.unresolved ?? 0}
  {@const more = signal?.unresolvedTruncated === true}
  <span class="queue-cell threads-cell">
    {#if count > 0}
      <!-- "N open" rather than "N unresolved": at --text-xs the long word costs
           ~12ch of a row that has six other columns to seat, and the phrase the
           number actually means rides on the title and the accessible name,
           where it is read in full. -->
      <span
        class="threads-chip"
        data-testid="queue-unresolved"
        title="{count}{more ? '+' : ''} unresolved conversation{count === 1 && !more ? '' : 's'}"
      >
        <span aria-hidden="true">{count}{more ? '+' : ''} open</span>
        <span class="sr-only">{count}{more ? ' or more' : ''} unresolved conversation{count === 1 && !more ? '' : 's'}</span>
      </span>
    {/if}
  </span>
{/snippet}

<!--
  baseCell — where the PR stands against its base, and the one place on this row
  that is also an ACTION.

  The signal IS the affordance: a PR that is behind and that you can push to
  offers "Update", link-styled exactly like Prepare (p.52-53 — a bordered button
  on every row is thirty-five boxes competing with the content they annotate).
  A PR that is behind and that you cannot push to says so and stops there. A
  CONFLICTING PR gets words, not a button, because the server-side merge cannot
  resolve a conflict and an affordance that is going to fail is worse than none.
-->
{#snippet baseCell(item: QueueItem, signal: QueueSignal | undefined)}
  {@const update = branchUpdates[sizeKey(item)]}
  {@const base = signal?.base}
  <span class="queue-cell base-cell">
    {#if update?.status === 'updating'}
      <span class="base-chip base-working" data-testid="queue-base">Updating…</span>
    {:else if update?.status === 'error'}
      <button
        type="button"
        class="base-btn base-error"
        data-testid="queue-base"
        onclick={() => handleUpdateBranch(item)}
        title={update.detail}
        aria-label="Updating {item.ref.owner}/{item.ref.repo}#{item.ref.number} failed: {update.detail}. Retry."
      >Retry</button>
    {:else if canOfferUpdate(signal)}
      <button
        type="button"
        class="base-btn"
        data-testid="queue-base"
        onclick={() => handleUpdateBranch(item)}
        title="Merge the base branch in, on the server. CI will start over."
        aria-label="Update the branch of {item.ref.owner}/{item.ref.repo}#{item.ref.number} with its base"
      >Update</button>
    {:else if base?.kind === 'behind'}
      <span class="base-chip" data-testid="queue-base" title="Behind its base branch — you don't have push access to update it from here">behind</span>
    {:else if base?.kind === 'conflicted'}
      <span
        class="base-chip base-conflict"
        data-testid="queue-base"
        title="Conflicts with the base branch. A conflict can't be merged on the server — this one needs a checkout."
      >conflicts</span>
    {/if}
  </span>
{/snippet}

{#snippet sizeCell(size: DiffSize | undefined)}
  <span class="queue-cell size-cell">
    <span class="churn" aria-hidden="true">
      {#if size}
        <span class="churn-fill" style:width="{churnPercent(size)}%">
          <span class="churn-add" style:flex-grow={size.additions}></span>
          <span class="churn-del" style:flex-grow={size.deletions}></span>
        </span>
      {/if}
    </span>
    {@render queueSize(size)}
  </span>
{/snippet}

<!--
  prepareControl — the per-row Prepare-ahead affordance. States:
    idle      → "Prepare" button (disabled while keyless or another prepare runs)
    preparing → live "Preparing… (K/N)" status
    ready     → "Ready ✓" chip (persisted per PR+updatedAt; · cost when
                showTokenCost is on and usage was captured)
    error     → calm retry button; the concrete detail rides the title (hover idiom)
-->
{#snippet prepareControl(item: QueueItem)}
  {@const prId = prepareIdOf(item)}
  {@const row = prepareStore.rows[prId]}
  {#if row?.status === 'preparing'}
    <span class="prepare-status preparing" data-testid="prepare-status">{preparingLabel(prId)}</span>
  {:else if row?.status === 'error'}
    <button
      type="button"
      class="prepare-btn prepare-error"
      data-testid="prepare-btn"
      onclick={() => handlePrepare(item)}
      disabled={prepareStore.activeId !== null}
      title={row.errorDetail ?? row.error}
      aria-label="Retry preparing the AI review for pull request {item.ref.number} in {item.ref.owner}/{item.ref.repo}"
    >Prepare failed — retry</button>
  {:else if row?.status === 'ready' || isPreparedFor(prId, item.updatedAt)}
    {@const cost = readyCostLabel(prId)}
    <span
      class="prepare-status ready"
      data-testid="prepare-status"
      title="AI review prepared — opening this PR starts warm"
    >Ready ✓{#if cost}<span class="prepare-cost"> · {cost}</span>{/if}</span>
  {:else}
    <button
      type="button"
      class="prepare-btn"
      data-testid="prepare-btn"
      onclick={() => handlePrepare(item)}
      disabled={prepareDisabledReason !== null || prepareStore.activeId !== null}
      title={prepareDisabledReason ??
        (prepareStore.activeId !== null
          ? 'One prepare runs at a time — wait for the current one to finish'
          : 'Run the AI review in the background so opening this PR starts instantly')}
      aria-label="Prepare the AI review for pull request {item.ref.number} in {item.ref.owner}/{item.ref.repo}"
    >Prepare</button>
  {/if}
{/snippet}

{#snippet queueRows(items: QueueItem[])}
  {#each groupByRepo(items) as group (group.key)}
    <h4 class="repo-group-header">
      <ProviderIcon provider={group.provider} size={12} label={PROVIDER_NAMES[group.provider]} />
      <span class="repo-group-name">{group.owner}/{group.repo}</span>
    </h4>
    <ul class="queue-list grouped">
      {#each group.items as item (item.ref.provider + item.ref.owner + item.ref.repo + item.ref.number)}
        <li class="queue-item">
          <button
            type="button"
            class="queue-link"
            onclick={() => navigateToQueueItem(item)}
            aria-label="{item.ref.owner}/{item.ref.repo}#{item.ref.number} on {PROVIDER_NAMES[item.ref.provider]}"
          >
            <span class="queue-cell queue-ref">#{item.ref.number}</span>
            <span class="queue-title-text">{item.title}</span>
            {@render ciCell(queueSignals[sizeKey(item)])}
            {@render unresolvedCell(queueSignals[sizeKey(item)])}
            {@render sizeCell(queueSizes[sizeKey(item)])}
            <span class="queue-cell queue-time">{relativeTime(item.updatedAt)}</span>
          </button>
          <!-- Outside the navigating <button>: both are controls, and a button
               inside a button is not markup a browser will honour. -->
          {@render baseCell(item, queueSignals[sizeKey(item)])}
          <span class="queue-cell prepare-cell">{@render prepareControl(item)}</span>
        </li>
      {/each}
    </ul>
  {/each}
{/snippet}

<section class="landing" class:has-content={hasContentBelow}>
  <h1>Review 1‑2‑3</h1>
  <p>Paste a GitHub, GitLab, or Bitbucket pull request URL to start a guided review.</p>
  <form onsubmit={submit}>
    <input type="text" bind:value={input} placeholder="https://github.com/owner/repo/pull/123 or gitlab.com/…" aria-label="Pull request URL" />
    <button type="submit">Review</button>
  </form>
  {#if error}<p role="alert" class="error">{error}</p>{/if}

  <!-- One-click demo path: shows the FULL review experience on a bundled example
       PR with pre-generated AI output — no setup, no key, no auth, no network.
       It's an ONBOARDING affordance for people still exploring, so it's HIDDEN
       once the user is signed in to a VCS (anyAuthConfigured). For signed-out
       visitors it's emphasized as the primary action at cold-start, and demotes
       to a quiet link once they've added an LLM key (but still no sign-in). -->
  {#if !anyAuthConfigured}
    <div class="demo-cta" class:emphasized={nothingConfigured}>
      {#if nothingConfigured}
        <button type="button" class="demo-cta-btn" onclick={goToDemo}>
          Try a live demo — no setup needed
        </button>
        <p class="demo-cta-sub">See a full review on an example PR. No API key or sign‑in required.</p>
      {:else}
        <a href="/demo" class="demo-cta-link" onclick={goToDemo}>Try a live demo — no setup needed</a>
      {/if}
    </div>
  {/if}

  <!-- First-run footnote: a single muted line directly under the input — NOT a
       bordered card/section. Shown only before the first review (empty
       history); content adapts to auth state. -->
  {#if showFirstTimeHint}
    {#if anyAuthConfigured}
      <p class="input-hint">
        Tip: open <a href="/settings" onclick={goTo('/settings')}>Settings</a> to tune reviewers, AI models, and appearance.
      </p>
    {:else}
      <p class="input-hint">
        New here? <a href="/settings/providers" onclick={goTo('/settings/providers')}>Sign in</a> with GitHub or GitLab and open <a href="/settings" onclick={goTo('/settings')}>Settings</a> to tune reviewers, AI models, and appearance.
      </p>
    {/if}
  {/if}

  <!-- Whole section (header included) only exists when at least one queue
       provider has auth configured — signed-out users see no queue at all.
       anyAuthConfigured is reactive, so signing in renders it immediately. -->
  {#if hasQueueProviders && anyAuthConfigured}
    <div class="queue-section">
      <div class="queue-header">
        <h2 class="section-title">
          <button
            type="button"
            class="section-toggle"
            onclick={() => toggleSection('queue')}
            aria-expanded={!queueCollapsed}
            aria-controls="landing-queue-body"
          >
            <span class="section-chevron" class:expanded={!queueCollapsed} aria-hidden="true"></span>
            Your review queue
          </button>
        </h2>
        <button
          type="button"
          class="refresh-btn"
          onclick={handleRefreshQueue}
          disabled={queueLoading || queueRefreshing}
          aria-label="Refresh queue"
        >
          {#if queueRefreshing}<Spinner size="0.75em" />{/if}
          Refresh
        </button>
      </div>

      {#if !queueCollapsed}
      <div id="landing-queue-body">
      {#if queueLoading}
        <div class="queue-skeleton" aria-busy="true" data-testid="queue-skeleton">
          <Skeleton lines={3} />
          <span class="sr-only">Loading your queue…</span>
        </div>
      {:else if queueItems.length === 0}
        <!-- p.203-204: an empty state is a designed state. A bare "no results"
             line is the failure the rubric names, so the line is kept (it is
             the honest answer) and given the one next step that actually
             exists on this page — the URL field above. Nothing is implied that
             the app does not already do (p.15-16). -->
        <div class="queue-empty">
          <span class="queue-empty-mark" aria-hidden="true">✓</span>
          <p class="queue-status">
            No PRs in your queue.
            <span class="queue-empty-next">Nothing is waiting on you. Paste a pull request URL above to review one anyway.</span>
          </p>
        </div>
      {:else}
        <div
          class="queue-rows"
          class:refreshing={queueRefreshing}
          aria-busy={queueRefreshing}
          data-testid="queue-rows"
        >
        <!-- Order comes from queueGroups (own PRs first). The FIRST group gets
             the lead treatment whichever one it is, so a user with no open PRs
             is led by a section that has rows in it. -->
        {#each queueGroups as group, i (group.id)}
          <h3 class="queue-group-title" class:lead={i === 0} data-testid="queue-group-{group.id}">
            {group.title}
          </h3>
          {@render queueRows(group.items)}
        {/each}
        </div>
      {/if}
      </div>
      {/if}
    </div>
  {/if}

  <!-- In-flight reviews: PRs with UNSUBMITTED draft comments. Surfaced ABOVE
       Recent reviews (unfinished work ranks higher) and hidden entirely when
       there are no drafts. Grouped by PR identity so multiple head-SHA variants
       collapse to a single discardable row. -->
  {#if inflightRows.length > 0}
    <div class="inflight-section" data-testid="inflight-section">
      <div class="inflight-header">
        <h2 class="section-title">
          <button
            type="button"
            class="section-toggle"
            onclick={() => toggleSection('inflight')}
            aria-expanded={!inflightCollapsed}
            aria-controls="landing-inflight-body"
          >
            <span class="section-chevron" class:expanded={!inflightCollapsed} aria-hidden="true"></span>
            In-flight reviews
          </button>
        </h2>
      </div>
      {#if !inflightCollapsed}
      <ul class="inflight-list" id="landing-inflight-body">
        {#each inflightRows as row (row.id)}
          <li class="inflight-item">
            <button
              type="button"
              class="inflight-link"
              onclick={() => resumeInflight(row)}
              aria-label="Resume review of {row.owner}/{row.repo}#{row.number} on {PROVIDER_NAMES[row.provider]}"
            >
              <span class="recent-icon">
                <ProviderIcon provider={row.provider} size={14} label={PROVIDER_NAMES[row.provider]} />
              </span>
              <span class="recent-ref">{row.owner}/{row.repo}#{row.number}</span>
              {#if row.title}
                <span class="recent-title-text">{row.title}</span>
              {:else}
                <span class="recent-title-text"></span>
              {/if}
              <!-- Always rendered, including at zero: the cell is a COLUMN
                   (#284), and "0 comments drafted" is already the phrase the
                   review's own draft bar uses, so it reads the same here. -->
              <span class="inflight-count" data-testid="inflight-count">
                {row.draftCount} comment{row.draftCount === 1 ? '' : 's'} drafted
              </span>
              <!-- Withdrawn notes are named rather than folded into the count.
                   Folding them in is what made this number disagree with the
                   review's; dropping them silently would make a withdrawal
                   look like a deletion, which is the one thing it must never
                   look like. So they get their own word. -->
              {#if row.withdrawnCount > 0}
                <span
                  class="inflight-withdrawn"
                  data-testid="inflight-withdrawn"
                  title="Taken out of this review — still written down, and reversible"
                >{row.withdrawnCount} withdrawn</span>
              {/if}
              {#if row.multipleShas}
                <span class="inflight-hint" title="Some drafts were made on an earlier commit">from an earlier commit</span>
              {/if}
              <span class="inflight-time">{relativeTime(new Date(row.lastUpdatedAt).toISOString())}</span>
            </button>
            <button
              type="button"
              class="inflight-discard"
              onclick={() => requestDiscard(row)}
              aria-label="Discard drafts for {row.owner}/{row.repo}#{row.number}"
              title="Discard drafts"
            >✕</button>
          </li>
        {/each}
      </ul>
      {/if}
    </div>
  {/if}

  {#if history.length > 0}
    <div class="recent-reviews">
      <div class="recent-header">
        <h2 class="section-title">
          <button
            type="button"
            class="section-toggle"
            onclick={() => toggleSection('recent')}
            aria-expanded={!recentCollapsed}
            aria-controls="landing-recent-body"
          >
            <span class="section-chevron" class:expanded={!recentCollapsed} aria-hidden="true"></span>
            Recent reviews
          </button>
        </h2>
        <button type="button" class="clear-btn" onclick={handleClearHistory} aria-label="Clear history">Clear</button>
      </div>
      {#if !recentCollapsed}
      <ul class="recent-list" id="landing-recent-body">
        {#each history as entry (entry.owner + '/' + entry.repo + '#' + entry.number)}
          <li class="recent-item">
            <button
              type="button"
              class="recent-link"
              onclick={() => navigateToPr(entry)}
            >
              <span class="recent-icon">
                <ProviderIcon
                  provider={entry.provider ?? 'github'}
                  size={14}
                  label={PROVIDER_NAMES[entry.provider ?? 'github']}
                />
              </span>
              <span class="recent-ref">{entry.owner}/{entry.repo}#{entry.number}</span>
              <span class="recent-title-text">{entry.title}</span>
              {#if typeof entry.additions === 'number' && typeof entry.deletions === 'number'}
                {@render queueSize({ additions: entry.additions, deletions: entry.deletions })}
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      {/if}
    </div>
  {/if}
</section>

{#if pendingDiscard}
  <!-- The TOTAL, withdrawn notes included — the one number on this row that
       must NOT be the live subset. confirmDiscard clears every record under
       the PR, so a withdrawn note is destroyed here too, and the sentence that
       says "this can't be undone" has to count it. -->
  {@const doomed = pendingDiscard.draftCount + pendingDiscard.withdrawnCount}
  <dialog
    bind:this={discardDialogEl}
    class="discard-dialog"
    aria-label="Discard drafts"
    aria-modal="true"
    oncancel={(e) => { e.preventDefault(); cancelDiscard() }}
    onclick={(e) => { if (e.target === e.currentTarget) cancelDiscard() }}
  >
    <h2>Discard unsubmitted comments?</h2>
    <p>
      Discard {doomed} unsubmitted comment{doomed === 1 ? '' : 's'}
      on {pendingDiscard.owner}/{pendingDiscard.repo}#{pendingDiscard.number}? This can't be undone.
    </p>
    <div class="discard-actions">
      <button type="button" class="discard-confirm" onclick={confirmDiscard}>Discard</button>
      <button type="button" class="discard-cancel" onclick={cancelDiscard}>Cancel</button>
    </div>
  </dialog>
{/if}

<style>
  /* ---------------------------------------------------------------------
     THE HERO HAS TWO JOBS AND ONLY EVER DID ONE OF THEM.
     A first-time visitor needs the paste-a-URL hero to BE the page. A
     returning user needs their queue. The hero's 12vh top margin served the
     first and billed the second for it on every visit — measured at 1440x1000,
     the queue's first row sat 355px down a 1000px viewport, better than a
     third of the fold spent before any content. `.has-content` is the switch
     (see hasContentBelow): generous framing while the hero IS the page, and a
     plain section heading's worth of space the moment the page has content of
     its own to lead with (p.30-31, p.85).
     --------------------------------------------------------------------- */
  .landing {
    max-width: 40rem;
    /* Viewport-relative deliberately (p.75 — a percentage is right when you
       genuinely want the thing to scale with the viewport): a cold-start hero
       should sit at the same optical height on a laptop and on a 27" display.
       It is the ONLY viewport-relative length on this surface. */
    margin: 12vh auto 0;
    /* Bottom padding so a long recent-reviews list doesn't butt up against the
       global build footer (which lives outside .landing, in App.svelte). */
    padding: 0 var(--space-5) var(--space-7);
    text-align: center;
  }

  /* p.65-67: don't force one section to match another's width for symmetry.
     40rem is the measure a HERO wants — a form plus one line of prose inside
     the 45-75 character band (p.99-100). It is not the measure a five-column
     table wants: at 40rem the aligned queue could only afford a 183px title
     cell, ~25 characters, which buys alignment by throwing away the one field
     that says what the PR is. So the content column widens for content, and
     the hero keeps its own measure inside it (below). */
  /* 52rem seated five trailing columns. The queue now carries seven — CI state
     and the unresolved-conversation count are two more reserved measures, and
     the base-standing cell a third — and the column the widening protects is
     the TITLE: at 52rem those three would have eaten it down to the ~330px
     floor e2e/queue-columns.spec.ts holds, which is the width at which the row
     stops saying which PR it is. The hero keeps its own 40rem measure inside
     (below), so the prose is untouched. */
  .landing.has-content {
    margin-top: var(--space-6);
    max-width: 60rem;
  }

  .landing.has-content > h1,
  .landing.has-content > p,
  .landing.has-content > form,
  .landing.has-content > .demo-cta {
    max-width: 40rem;
    margin-left: auto;
    margin-right: auto;
  }

  form {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-5);
  }

  form input[type="text"] {
    flex: 1;
    /* Without this the input's intrinsic size (default `size=20`) refuses to
       shrink and becomes a source of horizontal overflow on a narrow screen. */
    min-width: 0;
    font-family: var(--font-ui);
    font-size: var(--text-base);
  }

  form button[type="submit"] {
    display: inline-flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: var(--on-accent);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: filter 150ms ease;
  }

  form button[type="submit"]:hover {
    filter: brightness(1.1);
  }

  .error {
    color: var(--legend-removed-color);
    font-size: var(--text-sm);
    margin-top: var(--space-2);
  }

  /* First-run footnote — a single unobtrusive muted line under the input.
     Deliberately NOT a card/section: no border, no background, just text. */
  .input-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: var(--space-2) 0 0;
    line-height: 1.4;
  }

  .input-hint a {
    color: var(--text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: color 150ms ease;
  }

  .input-hint a:hover {
    color: var(--text);
  }

  /* Demo CTA — emphasized as a primary button for cold-start users, a quiet
     link once auth or an LLM key is configured. */
  .demo-cta {
    margin-top: var(--space-3);
  }
  .demo-cta.emphasized {
    margin-top: var(--space-4);
  }
  .demo-cta-btn {
    display: inline-flex;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: transparent;
    color: var(--accent);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background 150ms ease, color 150ms ease;
  }
  .demo-cta-btn:hover,
  .demo-cta-btn:focus-visible {
    background: var(--accent);
    color: var(--on-accent);
  }
  .demo-cta-sub {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: var(--space-1) 0 0;
    line-height: 1.4;
  }
  .demo-cta-link {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: color 150ms ease;
  }
  .demo-cta-link:hover {
    color: var(--text);
  }

  /* ---------------------------------------------------------------------
     THE THREE CARDS. Queue, in-flight and recent were three copies of one
     rule set; they are now one, so the page cannot drift into three slightly
     different cards again.
     --------------------------------------------------------------------- */
  .queue-section,
  .inflight-section,
  .recent-reviews {
    margin-top: var(--space-6);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: var(--space-3) var(--space-4);
  }

  .queue-header,
  .inflight-header,
  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  /* ---------------------------------------------------------------------
     ONE LABEL REGISTER, ONE DATA REGISTER.
     The surface carried three heading treatments for three levels — all-caps
     tracked (h2), sentence case (h3), and all-caps MONO (the repo header) —
     so nothing about a heading's look told you which level it was. The system
     is now: a LABEL is --text-xs, weight 600, uppercase with the +0.05em
     tracking all-caps owes (p.117); levels are told apart by INK, not by a
     third case or a third size (p.32-34). Anything that is DATA is not a label
     and does not get that treatment at all — see .repo-group-header.
     --------------------------------------------------------------------- */
  .section-title,
  .queue-group-title {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    line-height: 1.4;
  }

  .section-title {
    color: var(--text-secondary);
    margin: 0;
  }

  .queue-group-title {
    color: var(--text-muted);
    /* p.85: clearly more space above than below, so the label attaches to the
       rows it introduces instead of floating between two groups. */
    margin: var(--space-5) 0 var(--space-2);
  }

  /* ---------------------------------------------------------------------
     THE LEADING GROUP, PAID FOR IN INK AND SPACE.
     "Your open PRs" is what this page is for and it was second. Order alone
     is a weak instrument once a reader has scrolled, so the lead group is
     also one ink tier brighter (--text-secondary, the tier the card's own
     title already sits at — three inks on this surface, not four) and the
     group after it is pushed down and ruled off, so the first group reads as
     a block that ENDS rather than as the top of one long list (p.30-34, p.85,
     p.101: emphasise by de-emphasising the surroundings).

     No new type size, no new weight, no new colour. `.lead` is applied by
     POSITION, not by section id, which is what makes the newcomer case fall
     out for free: with no open PRs, "Awaiting your review" is first and gets
     the lead treatment itself. Nothing prominent is ever empty.
     --------------------------------------------------------------------- */
  .queue-group-title.lead {
    color: var(--text-secondary);
  }

  /* A second group is a DIFFERENT, lesser thing — separated rather than
     merely spaced. The rule is --hairline, the same decorative rim the card
     itself uses; no new token and no new ink tier. */
  .queue-group-title:not(.lead) {
    margin-top: var(--space-6);
    padding-top: var(--space-5);
    border-top: 1px solid var(--hairline);
  }

  /* The first group heading in the card already has the card's padding above
     it; a second helping would break the "space around > space inside" read. */
  .queue-rows > .queue-group-title:first-child {
    margin-top: 0;
  }

  /* Collapsible section header — mirrors the global details > summary
     editorial pattern (app.css): muted uppercase label + rotating triangle. */
  .section-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    user-select: none;
    font: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    font-weight: inherit;
    color: inherit;
  }

  .section-toggle:hover {
    color: var(--text);
  }

  .section-chevron {
    display: inline-block;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 4px 0 4px 6px;
    border-color: transparent transparent transparent currentColor;
    transition: transform 150ms ease;
    flex-shrink: 0;
  }

  .section-chevron.expanded {
    transform: rotate(90deg);
  }

  .refresh-btn,
  .clear-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    padding: var(--space-1) var(--space-2);
    border-radius: 4px;
    flex-shrink: 0;
    transition: color 150ms;
  }

  .refresh-btn:hover,
  .clear-btn:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .refresh-btn:disabled {
    cursor: default;
    opacity: var(--disabled-opacity);
  }

  /* Empty state (p.203-204): a bare "no results" line is a failure, so the
     line keeps company with the one next step that actually exists here —
     the URL field above. No new capability is implied (p.15-16). */
  .queue-empty {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: var(--space-3) 0 var(--space-2);
    padding: 0 var(--space-2);
  }

  .queue-empty-mark {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--diff-add);
    flex-shrink: 0;
  }

  .queue-status {
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    color: var(--text);
    margin: 0;
  }

  .queue-empty-next {
    display: block;
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-top: var(--space-1);
  }

  /* Loading skeleton — same Skeleton-based treatment as AiPanel's loading state */
  .queue-skeleton {
    padding: var(--space-1) var(--space-2);
  }

  /* Refresh-in-flight. These rows are FINISHED content being re-fetched, so
     they recede by GROUND, not by ink (p.167-168 — darker pushes back). The
     `opacity: 0.5` this replaces took the row metadata down to 2.06:1 light /
     2.45:1 dark, under the 3:1 a receded row still owes (B5, quick-scan 13) —
     which is exactly B5's point that opacity is a poor de-emphasis tool. On
     --bg (darker than --surface in BOTH themes) every ink on the row measures
     4.79:1 or better. The header spinner and aria-busy carry the state, so no
     meaning rides on the colour shift alone (p.146-147). */
  .queue-rows.refreshing {
    background: var(--bg);
    border-radius: 4px;
    pointer-events: none;
    transition: background 150ms ease;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  /* The repo is DATA, not a label, so it is in the data register: mono, and
     its REAL case. `text-transform: uppercase` was rendering `posthog/posthog`
     as `POSTHOG/POSTHOG` — a case-sensitive identifier displayed as something
     it is not (p.41-44: let the data be the data). It is a real <h4> so the
     document outline matches the visual grouping (D1). */
  .repo-group-header {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: none;
    letter-spacing: normal;
    line-height: 1.4;
    color: var(--text-muted);
    /* Between two repo groups, comfortably more than the 4px inside one (p.83),
       and more above than below so it attaches to its own rows (p.85). */
    margin: var(--space-4) 0 var(--space-1);
    padding: 0 var(--space-2);
  }

  .repo-group-name {
    font-family: var(--font-mono);
  }

  .queue-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  /* ---------------------------------------------------------------------
     THE ROW IS A TABLE ROW, NOT A SENTENCE.
     Every column after the title used to ride on the end of a variable-width
     title, so `#ref · title · +a −d · time · Prepare` landed at a different x
     on every row. Measured on a 14-row queue at 1440px: the diff-stat column
     spread 61.7px, the timestamp column 64.9px, the Prepare control 55.2px,
     and the title's own truncation measure varied by 66.8px — raggedness
     precisely where the eye wants a column to scan.

     The same markup had a second, worse consequence: .queue-link was
     `width: 100%` with a non-shrinking Prepare sibling, so on a long title the
     row overflowed its own list item. At 1440px the Prepare button ended 55px
     PAST the card's inner edge (outside the card's border entirely); at 400px
     it pushed the document to 417px wide against a 400px viewport — 17px of
     horizontal page scroll, which is what puts those buttons under the
     scrollbar.

     Fixed measures on the trailing columns fix both: the button now flexes
     (`flex: 1; min-width: 0`) instead of claiming 100%, and because every
     other cell is a known width, the title cell is the SAME width on every
     row — one consistent truncation measure (p.113, p.212-213).
     --------------------------------------------------------------------- */
  .queue-item {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    border-radius: 4px;
    transition: background 100ms;
  }

  /* The whole row lights up, not just the part inside the <button> — the row
     reads as one object, which is the entire point of putting it in columns. */
  .queue-item:hover {
    background: var(--surface-raised);
  }

  .queue-link {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    cursor: pointer;
    /* A <button> does NOT inherit font-family. Without this the queue titles
       rendered in the UA default — measured as Arial — while every other
       string on the page rendered in IBM Plex Sans. Same defect on
       .recent-link and .inflight-link below. */
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    text-align: left;
    padding: var(--space-1) var(--space-2);
    color: var(--text);
  }

  .queue-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 4px;
  }

  .queue-list.grouped .queue-link {
    padding-left: var(--space-4);
  }

  /* Every trailing column is a fixed measure so the columns line up ACROSS
     rows. The widths are in `ch` — a count of characters the column must hold,
     not a hand-picked pixel value (p.24-25). */
  .queue-cell {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .queue-ref {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    /* Room for a six-digit PR number, so every title starts at the same x. */
    min-width: 7ch;
  }

  .queue-title-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  /* ---------------------------------------------------------------------
     CI · UNRESOLVED · BASE — three more fixed measures.

     Each is its own column with its own `ch` measure, for the reason the
     other five are: a cell whose width depends on its content puts the next
     column at a different x on every row, and e2e/queue-columns.spec.ts holds
     the whole set to a spread of zero.

     The measures are what the content actually needs — one glyph, "100+ open",
     "conflicts" — not hand-picked pixels (p.24-25).
     --------------------------------------------------------------------- */
  .ci-cell {
    display: flex;
    align-items: baseline;
    justify-content: center;
    min-width: 2ch;
  }

  .ci-chip {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1;
  }

  /* The CI trio the review page's own CiSummary already speaks (.ci-pass /
     .ci-pending / .ci-failures). Reusing it means the same check reads the
     same on both surfaces; inventing a second CI palette for the queue is how
     two screens end up disagreeing about what amber means. */
  .ci-chip.ci-passing { color: var(--diff-add); }
  .ci-chip.ci-failing { color: var(--diff-del); }
  .ci-chip.ci-running { color: var(--legend-changed-color); }

  .threads-cell {
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    min-width: 8ch;
  }

  /* Metadata ink, like the timestamp beside it. An unresolved conversation is
     a fact about the PR, not an alarm — the row already spends its two loud
     inks on the diff figures and the CI mark, and a third shouting column
     would leave the eye nothing to rank (p.30-31). */
  .threads-chip {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* Wide enough for the longest thing it holds — "conflicts" / "Updating…". */
  .base-cell {
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    padding: var(--space-1) 0;
    min-width: 10ch;
  }

  .base-chip {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .base-chip.base-conflict {
    color: var(--legend-changed-color);
  }

  /* Update — link-styled, exactly like Prepare and for the same reason
     (p.52-53): a bordered button repeated down a queue is a column of boxes
     competing with the rows they annotate. Same ink tier as Prepare too, so
     the row has ONE actionable register rather than two. */
  .base-btn {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--text-secondary);
    white-space: nowrap;
    border-radius: 3px;
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
    transition: color 150ms, text-decoration-color 150ms;
  }

  .base-btn:hover,
  .base-btn:focus-visible {
    color: var(--text);
    text-decoration-color: currentColor;
  }

  .base-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .base-btn.base-error {
    color: var(--legend-removed-color);
  }

  .base-chip.base-working {
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  /* p.86 — the horizontal form of the grouping rule: the gauge and the figures
     are ONE reading ("how big is this?"), so the gap inside the cell (4px) is
     strictly smaller than the gap to the neighbouring columns (8px). At equal
     gaps the gauge read as belonging to the title it sat next to. */
  .size-cell {
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: var(--space-1);
    min-width: 15ch;
  }

  /* Compact "+adds −dels" chip — same color tokens as FileDiff's stat chips.
     p.113: digits only compare at a glance when they are right-aligned, so the
     additions and the deletions each get their own right-aligned measure
     rather than the pair being right-aligned as one blob. */
  .queue-size {
    flex: 0 0 auto;
    display: flex;
    justify-content: flex-end;
    gap: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .queue-size .stat-add {
    min-width: 5ch;
    text-align: right;
    color: var(--diff-add);
  }

  .queue-size .stat-del {
    min-width: 6ch;
    text-align: right;
    color: var(--diff-del);
  }

  /* THE EFFORT GAUGE (p.30-31 — no screen presents everything at equal
     emphasis). Fourteen rows at identical weight give the eye nothing to rank,
     and the only ranking signal this component holds is churn, which it has
     already fetched for the chip. The rail is always drawn so a small value
     reads as small rather than as a missing measurement; the fill is this
     row's share of the LARGEST diff in the queue, split by the add/delete
     balance. Length carries the ranking, the +/− figures carry the exact
     value, and colour carries neither on its own (p.146-147). */
  .churn {
    flex: 0 0 var(--space-6);
    align-self: center;
    display: flex;
    height: var(--space-1);
    border-radius: 2px;
    background: var(--hairline);
    overflow: hidden;
  }

  .churn-fill {
    display: flex;
    height: 100%;
  }

  .churn-add,
  .churn-del {
    flex-basis: 0;
    height: 100%;
  }

  .churn-add { background: var(--diff-add); }
  .churn-del { background: var(--diff-del); }

  .queue-time {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    min-width: 8ch;
    text-align: right;
  }

  /* Vertical padding matches .queue-link's so the row's hover band is one
     even height; the left padding is 0 because the row gap already separates
     this cell from the timestamp. */
  .prepare-cell {
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    padding: var(--space-1) var(--space-2) var(--space-1) 0;
    min-width: 8ch;
  }

  /* PREPARE, FOURTEEN TIMES OVER (p.52-53, p.30-31, p.39-40).
     The same bordered button on every row is fourteen boxes competing with the
     content they annotate, and the fix for a noisy screen is to de-emphasise
     the secondary, not to shout louder. Its border also used --hairline, which
     app.css reserves for DECORATIVE rims: 1.41:1 light / 1.31:1 dark, well
     under the 3:1 a control boundary owes (D5). Both problems have one answer
     — stop drawing a boundary and rank this as what it is, a link-styled
     tertiary. The label stays permanently visible and permanently focusable;
     only the underline waits for hover or focus (p.110). It sits on
     --text-secondary, one ink tier ABOVE the --text-muted metadata beside it,
     so it still reads as the actionable thing in the row. */
  .prepare-btn {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--text-secondary);
    white-space: nowrap;
    border-radius: 3px;
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
    transition: color 150ms, text-decoration-color 150ms;
  }

  .prepare-btn:hover:not(:disabled),
  .prepare-btn:focus-visible {
    color: var(--text);
    text-decoration-color: currentColor;
  }

  .prepare-btn:disabled {
    cursor: default;
    opacity: var(--disabled-opacity);
  }

  .prepare-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .prepare-btn.prepare-error {
    color: var(--legend-removed-color);
  }

  .prepare-status {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .prepare-status.preparing {
    color: var(--text-muted);
  }

  .prepare-status.ready {
    color: var(--diff-add);
  }

  .prepare-status .prepare-cost {
    color: var(--text-muted);
  }

  /* ---------------------------------------------------------------------
     Recent reviews / In-flight reviews. Same row idiom as the queue, one
     column fewer: these lists are flat, so the trailing cells get the same
     fixed measures and the same ink tiers.
     --------------------------------------------------------------------- */
  .recent-list,
  .inflight-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .recent-item,
  .inflight-item {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    border-radius: 4px;
    transition: background 100ms;
  }

  .recent-item:hover,
  .inflight-item:hover {
    background: var(--surface-raised);
  }

  .recent-link,
  .inflight-link {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    text-align: left;
    padding: var(--space-1) var(--space-2);
    color: var(--text);
  }

  .recent-link:focus-visible,
  .inflight-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 4px;
  }

  .recent-icon {
    align-self: center;
    display: inline-flex;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .recent-ref {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .recent-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    color: var(--text);
  }

  /* Count chip — colored like the other count chips (uses the add token). */
  .inflight-count {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    flex-shrink: 0;
    white-space: nowrap;
    text-align: right;
    color: var(--diff-add);
  }

  /* Withdrawn chip — the count's shape (mono, same size, same column rhythm)
     but deliberately NOT the count's green: these notes are not going out, so
     they must not read as part of the figure beside them. */
  .inflight-withdrawn {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    flex-shrink: 0;
    white-space: nowrap;
  }

  .inflight-hint {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-style: italic;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .inflight-time {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-muted);
    flex-shrink: 0;
    min-width: 8ch;
    text-align: right;
  }

  /* Discard ✕ — a fixed square so the glyph centers regardless of the
     surrounding row's mixed font-sizes. align-self centers it to the row;
     flex centering inside places the ✕ dead-center in its own hit area. */
  .inflight-discard {
    align-self: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 1.6rem;
    height: 1.6rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: 1;
    padding: 0;
    margin-right: var(--space-1);
    border-radius: 4px;
    flex-shrink: 0;
    transition: color 150ms, background 100ms;
  }

  .inflight-discard:hover {
    color: var(--legend-removed-color);
    background: var(--surface-raised);
  }

  .inflight-discard:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* Discard confirmation dialog — base dialog styles come from app.css */
  .discard-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .discard-confirm {
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--legend-removed-color);
    border-radius: 6px;
    background: var(--legend-removed-color);
    /* WAS the literal #0a1410, which measures 3.42:1 on the LIGHT theme's
       --legend-removed-color (#cb2431) — a WCAG failure on a destructive
       confirm button, the one control that must be read before it is pressed.
       --on-accent is the app's existing "ink that goes ON a saturated fill"
       token and is the only declared token that carries this fill in both
       themes: 5.47:1 light, 8.37:1 dark. No new palette value. */
    color: var(--on-accent);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .discard-cancel {
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: none;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  /* ---------------------------------------------------------------------
     NARROW: THE TITLE GETS ITS OWN LINE.
     Five reserved columns and a legible title cannot share 400px. Measured:
     with the columns holding their measures the title cell shrank to 0px and
     the row showed everything about the PR except which PR it was. So below
     40rem the row becomes two lines — the title on the first, full width
     (~300px at 400px, against 94-168px before this change), and the ref,
     gauge, figures and timestamp on the second, where they still hold their
     measures and still line up across rows. Nothing is dropped and nothing
     overflows; one row simply costs two lines, which is the honest trade at
     that width (p.68-71 — split into lines rather than cram).
     --------------------------------------------------------------------- */
  @media (max-width: 40rem) {
    .queue-item,
    .recent-item,
    .inflight-item {
      align-items: center;
    }

    .queue-link,
    .recent-link,
    .inflight-link {
      flex-wrap: wrap;
      row-gap: var(--space-1);
    }

    .queue-title-text,
    .recent-title-text {
      flex: 1 0 100%;
      order: -1;
    }

    /* An in-flight row whose PR is not in history has no title to show; it must
       not still pay for the line (C5's sibling — reserve space for what lands,
       never for what cannot). */
    .recent-title-text:empty {
      display: none;
    }

    /* The reserved measures exist to align FIVE columns across a desktop
       table. On the meta line they only force a third line (measured), so they
       stand down and the cells pack. The ref keeps its measure because it is
       the line's left edge and still aligns row to row, and the +/− figures
       keep theirs inside the chip, so the digits still compare (p.113). */
    .size-cell,
    .queue-time,
    .prepare-cell,
    .ci-cell,
    .threads-cell,
    .base-cell,
    .inflight-time {
      min-width: 0;
    }
  }
</style>
