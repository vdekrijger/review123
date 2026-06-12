<script lang="ts">
  import { buildFileTree, type TreeNode } from '../lib/tree/buildTree'
  import type { PrFile } from '../lib/github/types'
  import type { AttentionResult } from '../lib/ai/schemas'
  import type { createViewedStore } from '../lib/viewed/viewed.svelte'
  import { isTestFile } from '../lib/testFile'

  let {
    files,
    attention,
    viewedStore,
    activePath,
    onselect,
  }: {
    files: PrFile[]
    attention: AttentionResult | null
    viewedStore: ReturnType<typeof createViewedStore> | null
    activePath: string | null
    onselect: (path: string) => void
  } = $props()

  const tree = $derived(buildFileTree(files))

  const hotspotMap = $derived(
    new Map(
      (attention?.hotspots ?? []).map(h => [h.path, h])
    )
  )
</script>

{#snippet renderNode(node: TreeNode)}
  {#if node.file !== null}
    <!-- File leaf -->
    {@const hotspot = hotspotMap.get(node.file.filename)}
    {@const isViewed = viewedStore?.isViewed(node.file.filename, node.file.patch) ?? false}
    {@const isActive = activePath === node.file.filename}
    <div class="file-row" class:active={isActive} class:viewed={isViewed}>
      <button
        class="file-btn"
        onclick={() => onselect(node.file!.filename)}
        title={node.file.filename}
      >
        <span class="file-name">{node.name}</span>
        <span class="file-counts">
          {#if node.file.additions > 0}
            <span class="additions">+{node.file.additions}</span>
          {/if}
          {#if node.file.deletions > 0}
            <span class="deletions">-{node.file.deletions}</span>
          {/if}
        </span>
        {#if hotspot}
          <span class="hotspot-dot level-{hotspot.level}" aria-label="Hotspot: {hotspot.level}" title={hotspot.reason}></span>
        {/if}
        {#if isViewed}
          <span class="viewed-check" aria-label="Viewed">✓</span>
        {/if}
        {#if isTestFile(node.file.filename)}
          <span class="test-glyph" aria-label="Test file" title="Test file">⚗</span>
        {/if}
      </button>
    </div>
  {:else if node.name === ''}
    <!-- Root: render children directly -->
    <ul class="tree-root" role="tree">
      {#each node.children as child (child.path || child.name)}
        <li role="treeitem" aria-selected="false">
          {@render renderNode(child)}
        </li>
      {/each}
    </ul>
  {:else}
    <!-- Directory node -->
    <details class="dir-node" open>
      <summary class="dir-summary" style="text-transform: none; letter-spacing: normal; font-weight: normal; font-family: var(--font-mono); font-size: 12.5px;">
        <span class="dir-name">{node.name}</span>
      </summary>
      <ul class="dir-children" role="group">
        {#each node.children as child (child.path || child.name)}
          <li role="treeitem" aria-selected="false">
            {@render renderNode(child)}
          </li>
        {/each}
      </ul>
    </details>
  {/if}
{/snippet}

{@render renderNode(tree)}

<style>
  .tree-root, .dir-children {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .dir-children {
    padding-left: 0.75rem;
    border-left: 1px solid var(--border-subtle);
    margin-left: 0.5rem;
  }

  .dir-summary {
    cursor: pointer;
    padding: 0.15rem 0.25rem;
    font-size: 0.78rem;
    color: var(--text-muted);
    user-select: none;
    list-style: none;
  }

  .dir-summary::-webkit-details-marker { display: none; }

  .dir-name {
    font-family: var(--font-mono);
    font-size: 0.78rem;
  }

  .file-row {
    display: flex;
    align-items: stretch;
  }

  .file-row.active .file-btn {
    background: var(--accent-subtle, color-mix(in srgb, var(--accent) 15%, transparent));
    color: var(--text);
  }

  .file-row.viewed .file-btn {
    opacity: 0.55;
  }

  .file-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0.15rem 0.25rem;
    text-align: left;
    border-radius: 3px;
    font-size: 0.78rem;
    min-width: 0;
  }

  .file-btn:hover {
    background: var(--surface-raised);
  }

  .file-name {
    font-family: var(--font-mono);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .file-counts {
    display: flex;
    gap: 0.2rem;
    flex-shrink: 0;
    font-size: 10px;
  }

  .additions {
    color: var(--legend-added-color);
  }

  .deletions {
    color: var(--legend-removed-color);
  }

  .hotspot-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
  }

  .hotspot-dot.level-high { background: var(--legend-removed-color); }
  .hotspot-dot.level-medium { background: var(--legend-changed-color); }
  .hotspot-dot.level-low { background: var(--text-muted); }

  .viewed-check {
    font-size: 10px;
    color: var(--legend-added-color);
    opacity: 0.6;
    flex-shrink: 0;
  }

  .test-glyph {
    font-size: 10px;
    opacity: 0.65;
    flex-shrink: 0;
    color: var(--legend-changed-color);
  }
</style>
