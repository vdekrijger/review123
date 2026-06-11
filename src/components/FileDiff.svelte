<script lang="ts">
  import { DiffView, DiffModeEnum } from '@git-diff-view/svelte'
  import '@git-diff-view/svelte/styles/diff-view.css'
  import { buildDiffFile, classifyFile } from '../lib/diff/diffFile'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'

  let { file, mode }: { file: PrFile; mode: DiffMode } = $props()
  const kind = $derived(classifyFile(file))
  const diffFile = $derived(kind === 'diff' ? buildDiffFile(file, mode) : null)
</script>

<article class="file-diff">
  <header>
    <code>{file.previousFilename ? `${file.previousFilename} → ` : ''}{file.filename}</code>
    <span class="stats">+{file.additions} −{file.deletions}</span>
  </header>
  {#if kind === 'rename-only'}
    <p class="note">Rename only — no content changes.</p>
  {:else if kind === 'binary-or-too-large' || !diffFile}
    <p class="note">Binary or too large to display.</p>
  {:else}
    <DiffView {diffFile} diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified} diffViewHighlight={true} diffViewWrap={true} />
  {/if}
</article>

<style>
  .file-diff { border: 1px solid #8884; border-radius: 6px; margin-bottom: 1rem; overflow: hidden; }
  header { display: flex; justify-content: space-between; padding: 0.4rem 0.8rem; background: #8881; }
  .note { padding: 0.8rem; opacity: 0.7; }
</style>
