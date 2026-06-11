<script lang="ts">
  import { parsePrUrl } from '../lib/github/parse'
  import { navigate } from '../lib/router/router.svelte'

  let input = $state('')
  let error = $state<string | null>(null)

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
</script>

<section class="landing">
  <h1>Review 1‑2‑3</h1>
  <p>Paste a GitHub pull request URL to start a guided review.</p>
  <form onsubmit={submit}>
    <input type="text" bind:value={input} placeholder="https://github.com/owner/repo/pull/123" aria-label="Pull request URL" />
    <button type="submit">Review</button>
  </form>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</section>

<style>
  .landing { max-width: 40rem; margin: 15vh auto 0; padding: 0 1rem; text-align: center; }
  form { display: flex; gap: 0.5rem; }
  input { flex: 1; padding: 0.6rem; font-size: 1rem; }
  button { padding: 0.6rem 1.2rem; }
  .error { color: #c33; }
</style>
