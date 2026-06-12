<script lang="ts">
  import { onMount } from 'svelte'
  import { parsePrUrl } from '../lib/github/parse'
  import { parseAnyUrl, PROVIDERS } from '../lib/provider/registry'
  import { navigate } from '../lib/router/router.svelte'
  import { getHistory, clearHistory, type HistoryEntry } from '../lib/history/history'
  import { fetchAllQueues, _resetQueueCacheForTest } from '../lib/provider/queue'
  import { relativeTime } from '../lib/time'
  import { isSectionCollapsed, setSectionCollapsed, type LandingSectionId } from '../lib/landing/collapse'
  import { groupByRepo, isMultiRepo } from '../lib/landing/groupQueue'
  import { track } from '../lib/analytics/analytics'
  import ProviderIcon from '../components/ProviderIcon.svelte'
  import Skeleton from '../components/Skeleton.svelte'
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

  function toggleSection(id: LandingSectionId) {
    const collapsed = id === 'queue' ? !queueCollapsed : !recentCollapsed
    if (id === 'queue') queueCollapsed = collapsed
    else recentCollapsed = collapsed
    setSectionCollapsed(id, collapsed)
    // Fire only on collapsed → expanded; ids only — never content.
    if (!collapsed) track('section_expanded', { section: id, surface: 'landing' })
  }

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
  const anyAuthConfigured = allProviders.some(
    (p) => typeof p.getMyQueue === 'function' && p.authState().configured,
  )

  // Derived groups
  let awaitingReview = $derived(queueItems.filter((i) => !i.authorIsMe))
  let myOpenPrs = $derived(queueItems.filter((i) => i.authorIsMe))

  async function loadQueue() {
    queueLoading = true
    queueItems = await fetchAllQueues(allProviders)
    queueLoading = false
  }

  async function handleRefreshQueue() {
    _resetQueueCacheForTest()
    if (queueItems.length > 0) {
      // Refresh with rows on screen: keep them visible but dimmed (same
      // content-stays-visible treatment as AiPanel's streaming state).
      queueRefreshing = true
      try {
        queueItems = await fetchAllQueues(allProviders)
      } finally {
        queueRefreshing = false
      }
    } else {
      // Nothing on screen — behave like the initial load (skeletons).
      await loadQueue()
    }
  }

  onMount(() => {
    loadQueue()
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
  Multi-repo lists are grouped under compact repo headers (provider icon +
  owner/repo) with rows showing just #number · title; single-repo lists stay
  flat with a provider icon per row.
-->
{#snippet queueRows(items: QueueItem[])}
  {@const groups = groupByRepo(items)}
  {#if isMultiRepo(groups)}
    {#each groups as group (group.key)}
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
              <span class="queue-time">{relativeTime(item.updatedAt)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/each}
  {:else}
    <ul class="queue-list">
      {#each items as item (item.ref.provider + item.ref.owner + item.ref.repo + item.ref.number)}
        <li class="queue-item">
          <button
            type="button"
            class="queue-link"
            onclick={() => navigateToQueueItem(item)}
            aria-label="{item.ref.owner}/{item.ref.repo}#{item.ref.number} on {PROVIDER_NAMES[item.ref.provider]}"
          >
            <span class="queue-icon"><ProviderIcon provider={item.ref.provider} size={14} /></span>
            <span class="queue-ref">{item.ref.owner}/{item.ref.repo}#{item.ref.number}</span>
            <span class="queue-sep"> — </span>
            <span class="queue-title-text">{item.title}</span>
            <span class="queue-time">{relativeTime(item.updatedAt)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<section class="landing">
  <h1>Review 1‑2‑3</h1>
  <p>Paste a GitHub, GitLab, or Bitbucket pull request URL to start a guided review.</p>
  <form onsubmit={submit}>
    <input type="text" bind:value={input} placeholder="https://github.com/owner/repo/pull/123 or gitlab.com/…" aria-label="Pull request URL" />
    <button type="submit">Review</button>
  </form>
  {#if error}<p role="alert" class="error">{error}</p>{/if}

  {#if hasQueueProviders}
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
          {#if queueRefreshing}<span class="refresh-spinner" aria-hidden="true"></span>{/if}
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
      {:else if !anyAuthConfigured}
        <p class="queue-status">Sign in to see your queue.</p>
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
            </button>
          </li>
        {/each}
      </ul>
      {/if}
    </div>
  {/if}
</section>

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

  .refresh-spinner {
    display: inline-block;
    width: 0.75em;
    height: 0.75em;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: refresh-spin 0.7s linear infinite;
    vertical-align: middle;
    margin-right: 0.3em;
  }

  @keyframes refresh-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .refresh-spinner {
      animation: none;
    }
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

  .queue-icon {
    align-self: center;
    display: inline-flex;
    margin-right: 0.45rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  /* Compact repo header for multi-repo queue lists — same muted small-caps
     register as the other section labels. */
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
  }
</style>
