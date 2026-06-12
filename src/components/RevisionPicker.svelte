<script lang="ts">
  import type { PrCommit } from '../lib/github/commits'
  import { relativeTime } from '../lib/time'

  let {
    commits,
    baseSha,
    active,
    onselect,
    onclear,
  }: {
    commits: PrCommit[]
    baseSha: string
    active: { from: string; to: string } | null
    onselect: (from: string, to: string) => void
    onclear: () => void
  } = $props()

  // Position of a sha in the commit ordering: base = -1, commits by index 0..n-1
  function posOf(sha: string): number {
    if (sha === baseSha) return -1
    return commits.findIndex(c => c.sha === sha)
  }

  // Options for the selects
  const baseOption = $derived({ value: baseSha, label: 'PR base' })
  const commitOptions = $derived(commits.map(c => ({
    value: c.sha,
    label: `${c.shortSha} · ${relativeTime(c.authoredAt)} · ${c.message.length > 40 ? c.message.slice(0, 40) + '…' : c.message}`,
  })))

  // Current selections — use $derived to track active, with local override via $state
  // We use a local $state for the pending selections (before user applies), and sync
  // from the active prop using $effect for external updates.
  let fromSha = $state('')
  let toSha = $state('')

  // Initialise and sync from active prop (or defaults)
  $effect(() => {
    if (active) {
      fromSha = active.from
      toSha = active.to
    } else {
      // Default: from = base, to = head
      if (!fromSha) fromSha = baseSha
      if (!toSha) toSha = commits.length > 0 ? commits[commits.length - 1].sha : baseSha
    }
  })

  // Validation: from must be strictly before to (by position index)
  const isValid = $derived(posOf(fromSha) < posOf(toSha))

  function handleApply() {
    if (isValid) onselect(fromSha, toSha)
  }

  // Quick link: last commit only — second-to-last → head
  function handleLastCommitOnly() {
    if (commits.length < 2) return
    const head = commits[commits.length - 1].sha
    const prev = commits[commits.length - 2].sha
    onselect(prev, head)
  }

  // Quick link: full diff — clears picker
  function handleFullDiff() {
    onclear()
  }

  const canLastCommitOnly = $derived(commits.length >= 2)
</script>

<div class="revision-picker" aria-label="Revision picker">
  <span class="picker-label">Comparing:</span>

  <select
    aria-label="From revision"
    bind:value={fromSha}
  >
    <option value={baseOption.value}>{baseOption.label}</option>
    {#each commitOptions as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>

  <span class="picker-arrow">→</span>

  <select
    aria-label="To revision"
    bind:value={toSha}
  >
    <option value={baseOption.value}>{baseOption.label}</option>
    {#each commitOptions as opt (opt.value)}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>

  {#if fromSha !== baseSha}
    {@const fromCommit = commits.find(c => c.sha === fromSha)}
    {#if fromCommit}
      <span class="picker-age" aria-label="From commit age">{relativeTime(fromCommit.authoredAt)}</span>
    {/if}
  {/if}

  <button
    class="picker-apply"
    onclick={handleApply}
    disabled={!isValid}
    aria-label="Apply revision comparison"
  >
    Compare
  </button>

  <span class="picker-divider">·</span>

  <button
    class="picker-quick"
    onclick={handleLastCommitOnly}
    disabled={!canLastCommitOnly}
    aria-label="Last commit only"
  >
    Last commit only
  </button>

  <button
    class="picker-quick"
    onclick={handleFullDiff}
    aria-label="Full diff"
  >
    Full diff
  </button>
</div>

<style>
  .revision-picker {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    border-left: 3px solid var(--accent);
    border-radius: 4px;
    padding: 0.4rem 0.75rem;
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
    color: var(--text);
  }

  .picker-label {
    font-weight: 500;
    white-space: nowrap;
    color: var(--text-muted);
  }

  .picker-arrow {
    opacity: 0.6;
  }

  select {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 3px;
    color: inherit;
    font-size: 0.82rem;
    padding: 0.15rem 0.3rem;
    max-width: 18rem;
  }

  .picker-age {
    font-size: 0.78rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .picker-apply {
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    color: #0a1410;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 600;
    padding: 0.15rem 0.6rem;
    white-space: nowrap;
    transition: filter 150ms;
  }

  .picker-apply:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .picker-apply:not(:disabled):hover {
    filter: brightness(1.1);
  }

  .picker-divider {
    opacity: 0.4;
  }

  .picker-quick {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.82rem;
    text-decoration: underline;
    padding: 0;
    white-space: nowrap;
  }

  .picker-quick:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .picker-quick:not(:disabled):hover {
    opacity: 0.75;
  }
</style>
