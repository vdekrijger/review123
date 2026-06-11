<script lang="ts">
  import { parsePrUrl } from '../lib/github/parse'
  import { navigate } from '../lib/router/router.svelte'
  import { getHistory, clearHistory, type HistoryEntry } from '../lib/history/history'

  let input = $state('')
  let error = $state<string | null>(null)
  let history = $state<HistoryEntry[]>(getHistory())

  const MESSAGES: Record<string, string> = {
    empty: 'Please enter a GitHub PR URL.',
    'not-github': 'That URL is not on github.com.',
    'not-a-pr-url': 'That does not look like a pull request URL (expected …/owner/repo/pull/123).',
  }

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const result = parsePrUrl(input)
    if (!result.ok) { error = MESSAGES[result.error]; return }
    error = null
    const { owner, repo, number } = result.value
    navigate(`/review/${owner}/${repo}/${number}`)
  }

  function navigateToPr(entry: HistoryEntry) {
    navigate(`/review/${entry.owner}/${entry.repo}/${entry.number}`)
  }

  function handleClearHistory() {
    clearHistory()
    history = []
  }
</script>

<section class="landing">
  <h1>Review 1‑2‑3</h1>
  <p>Paste a GitHub pull request URL to start a guided review.</p>
  <form onsubmit={submit}>
    <input type="text" bind:value={input} placeholder="https://github.com/owner/repo/pull/123" aria-label="Pull request URL" />
    <button type="submit">Review</button>
  </form>
  {#if error}<p role="alert" class="error">{error}</p>{/if}

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
  .landing { max-width: 40rem; margin: 15vh auto 0; padding: 0 1rem; text-align: center; }
  form { display: flex; gap: 0.5rem; }
  input { flex: 1; padding: 0.6rem; font-size: 1rem; }
  button[type="submit"] { padding: 0.6rem 1.2rem; }
  .error { color: #c33; }

  .recent-reviews {
    margin-top: 2rem;
    text-align: left;
  }

  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .recent-title {
    font-size: 0.9rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.6;
    margin: 0;
  }

  .clear-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    opacity: 0.5;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }

  .clear-btn:hover {
    opacity: 0.8;
    background: #8881;
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
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
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    width: 100%;
    color: inherit;
  }

  .recent-link:hover {
    background: #8881;
  }

  .recent-ref {
    font-family: monospace;
    font-size: 0.85rem;
    opacity: 0.8;
    flex-shrink: 0;
  }

  .recent-sep {
    opacity: 0.4;
    margin: 0 0.2rem;
    flex-shrink: 0;
  }

  .recent-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
