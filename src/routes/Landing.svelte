<script lang="ts">
  import { parsePrUrl } from '../lib/github/parse'
  import { parseAnyUrl } from '../lib/provider/registry'
  import { navigate } from '../lib/router/router.svelte'
  import { getHistory, clearHistory, type HistoryEntry } from '../lib/history/history'

  let input = $state('')
  let error = $state<string | null>(null)
  let history = $state<HistoryEntry[]>(getHistory())

  const MESSAGES: Record<string, string> = {
    empty: 'Please enter a GitHub, GitLab, or Bitbucket pull request URL.',
    'not-github': 'That URL is not on github.com.',
    'not-a-pr-url': 'That does not look like a pull request URL (expected …/owner/repo/pull/123).',
  }

  function submit(e: SubmitEvent) {
    e.preventDefault()
    const result = parseAnyUrl(input)
    if (!result) {
      // Fall back to GitHub-specific parse to get a user-friendly error message
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
