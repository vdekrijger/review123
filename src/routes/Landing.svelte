<script lang="ts">
  import { onMount } from 'svelte'
  import { parsePrUrl } from '../lib/github/parse'
  import { parseAnyUrl, PROVIDERS } from '../lib/provider/registry'
  import { navigate } from '../lib/router/router.svelte'
  import { getHistory, clearHistory, type HistoryEntry } from '../lib/history/history'
  import { fetchAllQueues, _resetQueueCacheForTest } from '../lib/provider/queue'
  import { relativeTime } from '../lib/time'
  import type { QueueItem } from '../lib/provider/types'

  let input = $state('')
  let error = $state<string | null>(null)
  let history = $state<HistoryEntry[]>(getHistory())

  // Queue state
  let queueLoading = $state(true)
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
    await loadQueue()
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
        <h2 class="section-title">Your review queue</h2>
        <button type="button" class="refresh-btn" onclick={handleRefreshQueue} aria-label="Refresh queue">Refresh</button>
      </div>

      {#if queueLoading}
        <p class="queue-status">Loading your queue…</p>
      {:else if !anyAuthConfigured}
        <p class="queue-status">Sign in to see your queue.</p>
      {:else if queueItems.length === 0}
        <p class="queue-status">No PRs in your queue.</p>
      {:else}
        {#if awaitingReview.length > 0}
          <h3 class="queue-group-title">Awaiting your review</h3>
          <ul class="queue-list">
            {#each awaitingReview as item (item.ref.provider + item.ref.owner + item.ref.repo + item.ref.number)}
              <li class="queue-item">
                <button
                  type="button"
                  class="queue-link"
                  onclick={() => navigateToQueueItem(item)}
                  aria-label="{item.ref.owner}/{item.ref.repo}#{item.ref.number}"
                >
                  <span class="queue-badge">{item.ref.provider === 'github' ? 'GH' : 'GL'}</span>
                  <span class="queue-ref">{item.ref.owner}/{item.ref.repo}#{item.ref.number}</span>
                  <span class="queue-sep"> — </span>
                  <span class="queue-title-text">{item.title}</span>
                  <span class="queue-time">{relativeTime(item.updatedAt)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        {#if myOpenPrs.length > 0}
          <h3 class="queue-group-title">Your open PRs</h3>
          <ul class="queue-list">
            {#each myOpenPrs as item (item.ref.provider + item.ref.owner + item.ref.repo + item.ref.number)}
              <li class="queue-item">
                <button
                  type="button"
                  class="queue-link"
                  onclick={() => navigateToQueueItem(item)}
                  aria-label="{item.ref.owner}/{item.ref.repo}#{item.ref.number}"
                >
                  <span class="queue-badge">{item.ref.provider === 'github' ? 'GH' : 'GL'}</span>
                  <span class="queue-ref">{item.ref.owner}/{item.ref.repo}#{item.ref.number}</span>
                  <span class="queue-sep"> — </span>
                  <span class="queue-title-text">{item.title}</span>
                  <span class="queue-time">{relativeTime(item.updatedAt)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}

  {#if history.length > 0}
    <div class="recent-reviews">
      <div class="recent-header">
        <h2 class="recent-title">Recent reviews</h2>
        <button type="button" class="clear-btn" onclick={handleClearHistory} aria-label="Clear history">Clear</button>
      </div>
      <ul class="recent-list">
        {#each history as entry (entry.owner + '/' + entry.repo + '#' + entry.number)}
          <li class="recent-item">
            <button
              type="button"
              class="recent-link"
              onclick={() => navigateToPr(entry)}
            >
              <span class="recent-ref">{entry.owner}/{entry.repo}#{entry.number}</span>
              <span class="recent-sep"> — </span>
              <span class="recent-title-text">{entry.title}</span>
            </button>
          </li>
        {/each}
      </ul>
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

  .queue-badge {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 0 0.3em;
    margin-right: 0.4rem;
    color: var(--text-muted);
    flex-shrink: 0;
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
