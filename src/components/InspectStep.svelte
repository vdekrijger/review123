<script lang="ts">
  import FileDiff from './FileDiff.svelte'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import type { createDraftStore } from '../lib/drafts/drafts.svelte'
  import { draftKey } from '../lib/drafts/drafts.svelte'
  import { track } from '../lib/analytics/analytics'
  import type { AttentionResult } from '../lib/ai/schemas'
  import type { createViewedStore } from '../lib/viewed/viewed.svelte'
  import type { PrComment } from '../lib/github/comments'

  let {
    files,
    changedFiles,
    mode,
    onmode,
    draftStore,
    attention = null,
    readingOrder = [],
    viewedStore = null,
    prComments = [],
    contentsMap = null,
  }: {
    files: PrFile[]
    changedFiles: number
    mode: DiffMode
    onmode: (m: DiffMode) => void
    draftStore: ReturnType<typeof createDraftStore> | null
    attention?: AttentionResult | null
    readingOrder?: string[]
    viewedStore?: ReturnType<typeof createViewedStore> | null
    prComments?: PrComment[]
    /**
     * Map from filename → { before, after } full file contents, used to enable
     * context-line expansion in the diff view. Undefined while loading.
     * Files not in the map (beyond the 30-file cap) render hunk-only.
     */
    contentsMap?: Map<string, { before: string | null; after: string | null }> | null
  } = $props()

  function commentsForFile(path: string): PrComment[] {
    return prComments.filter((c) => c.path === path)
  }

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

  // File ordering per readingOrder (EC-12e)
  const orderedFiles = $derived.by(() => {
    if (!readingOrder.length) return files
    const fileSet = new Set(files.map(f => f.filename))
    // Only use readingOrder entries that exist in files
    const validOrder = readingOrder.filter(p => fileSet.has(p))
    const orderedPaths = new Set(validOrder)
    const listedFiles = validOrder.map(p => files.find(f => f.filename === p)!).filter(Boolean)
    const unlistedFiles = files.filter(f => !orderedPaths.has(f.filename))
    return [...listedFiles, ...unlistedFiles]
  })

  // Hotspot and testFlag lookups (unknown paths ignored — EC-13c)
  const hotspotMap = $derived(
    new Map(
      (attention?.hotspots ?? [])
        .filter(h => files.some(f => f.filename === h.path))
        .map(h => [h.path, h])
    )
  )

  const testFlagSet = $derived(
    new Set(
      (attention?.testFlags ?? [])
        .filter(tf => files.some(f => f.filename === tf.path))
        .map(tf => tf.path)
    )
  )

  function slugify(path: string): string {
    return path.replace(/[^a-zA-Z0-9]/g, '-')
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
  {#each orderedFiles as file (file.filename)}
    <div id="file-{slugify(file.filename)}">
      {#if hotspotMap.has(file.filename)}
        {@const hotspot = hotspotMap.get(file.filename)!}
        <div class="hotspot-badge level-{hotspot.level}">
          <span class="hotspot-level">{hotspot.level}</span>
          <span class="hotspot-reason">{file.filename} — {hotspot.reason}</span>
        </div>
      {/if}
      {#if testFlagSet.has(file.filename)}
        <div class="test-flag-warning" role="note">
          AI-inferred — not measured coverage
        </div>
      {/if}
      <FileDiff
        {file}
        {mode}
        drafts={draftsForFile(file.filename)}
        comments={commentsForFile(file.filename)}
        onAddDraft={(line, side, body) => handleAddDraft(file.filename, line, side, body)}
        onRemoveDraft={(line, side) => handleRemoveDraft(file.filename, line, side)}
        viewed={viewedStore?.isViewed(file.filename, file.patch) ?? false}
        changedSinceViewed={viewedStore?.changedSinceViewed(file.filename, file.patch) ?? false}
        onToggleViewed={() => viewedStore?.toggle(file.filename, file.patch)}
        contents={contentsMap?.get(file.filename)}
      />
    </div>
  {/each}
{/if}

<style>
  .mode-toggle button.active { font-weight: 700; }

  .hotspot-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
    border-left: 3px solid currentColor;
  }

  .hotspot-badge.level-high { color: #cf222e; background: #cf222e0a; }
  .hotspot-badge.level-medium { color: #9a6700; background: #9a67000a; }
  .hotspot-badge.level-low { color: #444; background: #8881; }

  .hotspot-level {
    font-weight: 700;
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .hotspot-reason {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    word-break: break-word;
  }

  .test-flag-warning {
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
    background: #9a67000a;
    color: #9a6700;
    border-left: 3px solid #9a6700;
  }
</style>
