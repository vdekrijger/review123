<script lang="ts">
  import FileDiff from './FileDiff.svelte'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import type { createDraftStore } from '../lib/drafts/drafts.svelte'
  import { draftKey } from '../lib/drafts/drafts.svelte'
  import { track } from '../lib/analytics/analytics'

  let {
    files,
    changedFiles,
    mode,
    onmode,
    draftStore,
  }: {
    files: PrFile[]
    changedFiles: number
    mode: DiffMode
    onmode: (m: DiffMode) => void
    draftStore: ReturnType<typeof createDraftStore> | null
  } = $props()

  function draftsForFile(path: string) {
    return draftStore?.drafts.filter((d) => d.path === path) ?? []
  }

  async function handleAddDraft(path: string, line: number, side: 'LEFT' | 'RIGHT', body: string) {
    if (!draftStore) return
    await draftStore.upsert({ path, line, side, body })
    track('comment_drafted')
  }

  async function handleRemoveDraft(path: string, line: number, side: 'LEFT' | 'RIGHT') {
    if (!draftStore) return
    const draft = draftStore.drafts.find((d) => d.path === path && d.line === line && d.side === side)
    if (draft) {
      await draftStore.remove(draftKey(draft))
    }
  }
</script>

<div class="mode-toggle" role="group" aria-label="Diff mode">
  <button class:active={mode === 'unified'} aria-pressed={mode === 'unified'} onclick={() => onmode('unified')}>Unified</button>
  <button class:active={mode === 'split'} aria-pressed={mode === 'split'} onclick={() => onmode('split')}>Side-by-side</button>
</div>
{#if files.length < changedFiles}
  <p role="alert">Showing {files.length} of {changedFiles} changed files — the list was truncated.</p>
{/if}
{#if files.length === 0}
  <p>This PR has no changed files.</p>
{:else}
  {#each files as file (file.filename)}
    <FileDiff
      {file}
      {mode}
      drafts={draftsForFile(file.filename)}
      onAddDraft={(line, side, body) => handleAddDraft(file.filename, line, side, body)}
      onRemoveDraft={(line, side) => handleRemoveDraft(file.filename, line, side)}
    />
  {/each}
{/if}

<style>
  .mode-toggle button.active { font-weight: 700; }
</style>
