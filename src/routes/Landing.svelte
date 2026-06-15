<script lang="ts">
  import { parsePrUrl } from '../lib/github/parse'
  import { parseAnyUrl, PROVIDERS } from '../lib/provider/registry'
  import { navigate } from '../lib/router/router.svelte'
  import { getHistory, clearHistory, type HistoryEntry } from '../lib/history/history'
  import { fetchAllQueues, _resetQueueCacheForTest } from '../lib/provider/queue'
  import { relativeTime } from '../lib/time'
  import { isSectionCollapsed, setSectionCollapsed, type LandingSectionId } from '../lib/landing/collapse'
  import { groupByRepo } from '../lib/landing/groupQueue'
  import { getCachedSizes, fetchMissingSizes, sizeKey, type DiffSize } from '../lib/landing/queueSizes'
  import { listDraftSummaries, clearDraftsForPr, type DraftSummary } from '../lib/drafts/drafts.svelte'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { track } from '../lib/analytics/analytics'
  import ProviderIcon from '../components/ProviderIcon.svelte'
  import Skeleton from '../components/Skeleton.svelte'
  import Spinner from '../components/Spinner.svelte'
  import type { QueueItem } from '../lib/provider/types'

  // Human-readable provider names for accessible text alternatives.
  // Local map (not the registry) so the component stays renderable when the
  // registry is mocked down to a subset of providers.
  const PROVIDER_NAMES: Record<'github' | 'gitlab' | 'bitbucket', string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket',
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
    draftCount: number
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

  // Derived groups
  let awaitingReview = $derived(queueItems.filter((i) => !i.authorIsMe))
  let myOpenPrs = $derived(queueItems.filter((i) => i.authorIsMe))

  // Diff sizes per row, keyed by sizeKey(item) — progressive enhancement:
  // cached sizes render with the list; missing ones pop in as batches resolve.
  let queueSizes = $state<Record<string, DiffSize>>({})

  function refreshQueueSizes(items: QueueItem[]) {
    queueSizes = getCachedSizes(items)
    // Un-awaited intentionally — sizes must never block or delay the queue render.
    void fetchMissingSizes(items, (key, size) => {
      queueSizes = { ...queueSizes, [key]: size }
    })
  }

  async function loadQueue() {
    queueLoading = true
    queueItems = await fetchAllQueues(allProviders)
    queueLoading = false
    refreshQueueSizes(queueItems)
  }

  async function handleRefreshQueue() {
    _resetQueueCacheForTest()
    if (queueItems.length > 0) {
      // Refresh with rows on screen: keep them visible but dimmed (same
      // content-stays-visible treatment as AiPanel's streaming state).
      queueRefreshing = true
      try {
        queueItems = await fetchAllQueues(allProviders)
        refreshQueueSizes(queueItems)
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

  function handleClearHistory() {
    clearHistory()
    history = []
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

{#snippet queueRows(items: QueueItem[])}
  {#each groupByRepo(items) as group (group.key)}
    <div class="repo-group-header">
      <ProviderIcon provider={group.provider} size={12} label={PROVIDER_NAMES[group.provider]} />
      <span class="repo-group-name">{group.owner}/{group.repo}</span>
    </div>
    <ul class="queue-list grouped">
      {#each group.items as item (item.ref.provider + item.ref.owner + item.ref.repo + item.ref.number)}
        <li class="queue-item">
          <button
            type="button"
            class="queue-link"
            onclick={() => navigateToQueueItem(item)}
            aria-label="{item.ref.owner}/{item.ref.repo}#{item.ref.number} on {PROVIDER_NAMES[item.ref.provider]}"
          >
            <span class="queue-ref">#{item.ref.number}</span>
            <span class="queue-sep"> · </span>
            <span class="queue-title-text">{item.title}</span>
            {@render queueSize(queueSizes[sizeKey(item)])}
            <span class="queue-time">{relativeTime(item.updatedAt)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/each}
{/snippet}

<section class="landing">
  <h1>Review 1‑2‑3</h1>
  <p>Paste a GitHub, GitLab, or Bitbucket pull request URL to start a guided review.</p>
  <form onsubmit={submit}>
    <input type="text" bind:value={input} placeholder="https://github.com/owner/repo/pull/123 or gitlab.com/…" aria-label="Pull request URL" />
    <button type="submit">Review</button>
  </form>
  {#if error}<p role="alert" class="error">{error}</p>{/if}

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
        <p class="queue-status">No PRs in your queue.</p>
      {:else}
        <div
          class="queue-rows"
          class:refreshing={queueRefreshing}
          aria-busy={queueRefreshing}
          data-testid="queue-rows"
        >
        {#if awaitingReview.length > 0}
          <h3 class="queue-group-title">Awaiting your review</h3>
          {@render queueRows(awaitingReview)}
        {/if}

        {#if myOpenPrs.length > 0}
          <h3 class="queue-group-title">Your open PRs</h3>
          {@render queueRows(myOpenPrs)}
        {/if}
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
                <span class="recent-sep"> — </span>
                <span class="recent-title-text">{row.title}</span>
              {:else}
                <span class="recent-title-text"></span>
              {/if}
              <span class="inflight-count" data-testid="inflight-count">
                {row.draftCount} comment{row.draftCount === 1 ? '' : 's'} drafted
              </span>
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
        <h2 class="recent-title">
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
              <span class="recent-sep"> — </span>
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
  <dialog
    class="discard-dialog"
    aria-label="Discard drafts"
    aria-modal="true"
    open
    oncancel={(e) => { e.preventDefault(); cancelDiscard() }}
    onclick={(e) => { if (e.target === e.currentTarget) cancelDiscard() }}
  >
    <h2>Discard unsubmitted comments?</h2>
    <p>
      Discard {pendingDiscard.draftCount} unsubmitted comment{pendingDiscard.draftCount === 1 ? '' : 's'}
      on {pendingDiscard.owner}/{pendingDiscard.repo}#{pendingDiscard.number}? This can't be undone.
    </p>
    <div class="discard-actions">
      <button type="button" class="discard-confirm" onclick={confirmDiscard}>Discard</button>
      <button type="button" class="discard-cancel" onclick={cancelDiscard}>Cancel</button>
    </div>
  </dialog>
{/if}

<style>
  .landing {
    max-width: 40rem;
    margin: 12vh auto 0;
    padding: 0 1.5rem;
    text-align: center;
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }

  form input[type="text"] {
    flex: 1;
    font-size: 1rem;
  }

  form button[type="submit"] {
    display: inline-flex;
    align-items: center;
    padding: 0.4rem 1.2rem;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: #0a1410;
    font-family: var(--font-ui);
    font-size: 0.9rem;
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
    font-size: 0.9rem;
    margin-top: 0.5rem;
  }

  /* Queue section */
  .queue-section {
    margin-top: 2.5rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }

  .queue-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .section-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 0;
  }

  /* Collapsible section header — mirrors the global details > summary
     editorial pattern (app.css): muted uppercase label + rotating triangle. */
  .section-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
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

  .refresh-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-muted);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    transition: color 150ms;
  }

  .refresh-btn:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .queue-status {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin: 0.25rem 0;
  }

  /* Loading skeleton — same Skeleton-based treatment as AiPanel's loading state */
  .queue-skeleton {
    padding: 0.25rem 0.5rem;
  }

  /* Refresh-in-flight: keep rows visible but dimmed (content-stays-visible,
     mirroring AiPanel's streaming treatment) */
  .queue-rows.refreshing {
    opacity: 0.5;
    pointer-events: none;
    transition: opacity 150ms ease;
  }

  .refresh-btn:disabled {
    cursor: default;
    opacity: 0.6;
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

  .queue-group-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    margin: 0.75rem 0 0.25rem;
    letter-spacing: 0.03em;
  }

  .queue-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .queue-item {
    display: flex;
  }

  .queue-link {
    display: flex;
    align-items: baseline;
    gap: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.9rem;
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    width: 100%;
    color: var(--text);
    transition: background 100ms;
  }

  .queue-link:hover {
    background: var(--surface-raised);
  }

  /* Compact repo header for queue lists — same muted small-caps register as
     the other section labels. Every queue list is grouped under one of these. */
  .repo-group-header {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin: 0.55rem 0 0.15rem;
    padding: 0 0.5rem;
  }

  .repo-group-name {
    font-family: var(--font-mono);
  }

  .queue-list.grouped .queue-link {
    padding-left: 1.1rem;
  }

  .queue-ref {
    font-family: var(--font-mono);
    font-size: 0.83rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .queue-sep {
    color: var(--text-muted);
    margin: 0 0.2rem;
    flex-shrink: 0;
  }

  .queue-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .queue-time {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin-left: 0.5rem;
    flex-shrink: 0;
  }

  /* Compact "+adds −dels" chip — same color tokens as FileDiff's stat chips */
  .queue-size {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    margin-left: 0.5rem;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .queue-size .stat-add { color: var(--diff-add); }
  .queue-size .stat-del { color: var(--diff-del); }

  /* Recent reviews section */
  .recent-reviews {
    margin-top: 2.5rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }

  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .recent-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 0;
  }

  .clear-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-muted);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    transition: color 150ms;
  }

  .clear-btn:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .recent-item {
    display: flex;
  }

  .recent-link {
    display: flex;
    align-items: baseline;
    gap: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.9rem;
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    width: 100%;
    color: var(--text);
    transition: background 100ms;
  }

  .recent-link:hover {
    background: var(--surface-raised);
  }

  .recent-icon {
    align-self: center;
    display: inline-flex;
    margin-right: 0.45rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .recent-ref {
    font-family: var(--font-mono);
    font-size: 0.83rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .recent-sep {
    color: var(--text-muted);
    margin: 0 0.2rem;
    flex-shrink: 0;
  }

  .recent-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1; /* pushes the diff-size chip to the row's right edge */
  }

  /* In-flight reviews — same card register as queue/recent sections */
  .inflight-section {
    margin-top: 2.5rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }

  .inflight-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .inflight-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .inflight-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .inflight-link {
    display: flex;
    align-items: baseline;
    gap: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.9rem;
    text-align: left;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    width: 100%;
    color: var(--text);
    transition: background 100ms;
  }

  .inflight-link:hover {
    background: var(--surface-raised);
  }

  /* Count chip — colored like the other count chips (uses the add token). */
  .inflight-count {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    margin-left: 0.5rem;
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--diff-add);
  }

  .inflight-hint {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-style: italic;
    margin-left: 0.5rem;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .inflight-time {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin-left: 0.5rem;
    flex-shrink: 0;
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
    font-size: 0.85rem;
    line-height: 1;
    padding: 0;
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
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .discard-confirm {
    padding: 0.4rem 1rem;
    border: 1px solid var(--legend-removed-color);
    border-radius: 6px;
    background: var(--legend-removed-color);
    color: #0a1410;
    font-family: var(--font-ui);
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }

  .discard-cancel {
    padding: 0.4rem 1rem;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: none;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 0.9rem;
    cursor: pointer;
  }
</style>
