<script lang="ts">
  import { DiffView, DiffModeEnum, SplitSide } from '@git-diff-view/svelte'
  import '@git-diff-view/svelte/styles/diff-view.css'
  import { buildDiffFile, classifyFile } from '../lib/diff/diffFile'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import DraftThread from './DraftThread.svelte'

  interface Props {
    file: PrFile
    mode: DiffMode
    /** Drafts that belong to this file */
    drafts?: Draft[]
    /** Called when the user saves a comment at a given line */
    onAddDraft?: (line: number, side: 'LEFT' | 'RIGHT', body: string) => void
    /** Called when the user deletes a comment at a given line */
    onRemoveDraft?: (line: number, side: 'LEFT' | 'RIGHT') => void
    /** Whether this file has been marked viewed (hash-matched) */
    viewed?: boolean
    /** Whether the file changed since it was last viewed (entry exists, hash differs) */
    changedSinceViewed?: boolean
    /** Called when the user clicks the Viewed checkbox */
    onToggleViewed?: () => void
  }

  let { file, mode, drafts = [], onAddDraft, onRemoveDraft, viewed = false, changedSinceViewed = false, onToggleViewed }: Props = $props()

  // When viewed → collapse diff body; user can re-expand by clicking header or unchecking
  let manuallyExpanded = $state(false)
  const collapsed = $derived(viewed && !manuallyExpanded)

  function handleHeaderClick() {
    if (collapsed) manuallyExpanded = true
  }

  function handleViewedChange(e: Event) {
    // Uncheck → expand + notify parent
    const checked = (e.target as HTMLInputElement).checked
    if (!checked) manuallyExpanded = true
    onToggleViewed?.()
  }

  // Reset manual expansion when viewed state changes (e.g. re-toggled from outside)
  $effect(() => {
    if (!viewed) manuallyExpanded = false
  })

  const filename = $derived(
    file.previousFilename ? `${file.previousFilename} → ${file.filename}` : file.filename
  )

  const kind = $derived(classifyFile(file))
  const diffFile = $derived(kind === 'diff' ? buildDiffFile(file, mode) : null)

  // ---- Widget state -------------------------------------------------------
  // Only one widget open at a time. Cleared after save or cancel.
  let openWidget: { line: number; side: SplitSide } | null = $state(null)

  function handleAddWidgetClick(lineNumber: number, side: SplitSide) {
    // Toggle: clicking the same line again closes the widget
    if (openWidget && openWidget.line === lineNumber && openWidget.side === side) {
      openWidget = null
    } else {
      openWidget = { line: lineNumber, side }
    }
  }

  function splitSideToSide(side: SplitSide): 'LEFT' | 'RIGHT' {
    return side === SplitSide.old ? 'LEFT' : 'RIGHT'
  }

  function sideToSplitSide(side: 'LEFT' | 'RIGHT'): SplitSide {
    return side === 'LEFT' ? SplitSide.old : SplitSide.new
  }

  // ---- extendData — map existing drafts to per-line annotation entries ----
  // NOTE: DiffUnifiedExtendLine only renders for hidden/collapsed lines (library
  // limitation). We use extendData for split mode but render drafts inline below
  // the DiffView for reliable display in both modes (see the draft-annotations
  // section in the template).
  const extendData = $derived.by(() => {
    const oldFile: Record<string, { data: Draft }> = {}
    const newFile: Record<string, { data: Draft }> = {}
    for (const d of drafts) {
      if (d.side === 'LEFT') {
        oldFile[String(d.line)] = { data: d }
      } else {
        newFile[String(d.line)] = { data: d }
      }
    }
    return { oldFile, newFile }
  })

  // ---- Helpers for DraftThread handlers ----------------------------------

  function handleWidgetSave(line: number, side: SplitSide, body: string) {
    const sideStr = splitSideToSide(side)
    onAddDraft?.(line, sideStr, body)
    openWidget = null
  }

  function handleWidgetCancel() {
    openWidget = null
  }

  function handleExtendSave(line: number, side: SplitSide, body: string) {
    const sideStr = splitSideToSide(side)
    onAddDraft?.(line, sideStr, body)
  }

  function handleExtendDelete(line: number, side: SplitSide) {
    const sideStr = splitSideToSide(side)
    onRemoveDraft?.(line, sideStr)
  }
</script>

<article class="file-diff" class:is-collapsed={collapsed}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <header onclick={handleHeaderClick} class:clickable={collapsed}>
    <code>{filename}</code>
    <div class="header-right">
      {#if changedSinceViewed}
        <span class="changed-badge" role="status">Changed since you viewed it</span>
      {/if}
      <span class="stats">+{file.additions} −{file.deletions}</span>
      <label class="viewed-label">
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span onclick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            class="viewed-checkbox"
            checked={viewed}
            aria-label="Mark {file.filename} as viewed"
            onchange={handleViewedChange}
          />
        </span>
        Viewed
      </label>
    </div>
  </header>
  {#if !collapsed}
  {#if kind === 'rename-only'}
    <p class="note">Rename only — no content changes.</p>
  {:else if kind === 'binary-or-too-large' || !diffFile}
    <p class="note">Binary or too large to display.</p>
  {:else}
    <DiffView
      {diffFile}
      diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight={true}
      diffViewWrap={true}
      diffViewAddWidget={true}
      {extendData}
      onAddWidgetClick={handleAddWidgetClick}
    >
      {#snippet renderWidgetLine({ lineNumber, side, onClose })}
        {@const existingDraft = drafts.find(
          (d) => d.line === lineNumber && sideToSplitSide(d.side) === side,
        )}
        <DraftThread
          draft={existingDraft ?? null}
          path={file.filename}
          line={lineNumber}
          side={splitSideToSide(side)}
          onsave={(body) => {
            handleWidgetSave(lineNumber, side, body)
            onClose()
          }}
          ondelete={() => {
            handleExtendDelete(lineNumber, side)
            onClose()
          }}
          oncancel={() => {
            handleWidgetCancel()
            onClose()
          }}
        />
      {/snippet}

      {#snippet renderExtendLine({ lineNumber, side, data })}
        <DraftThread
          draft={data}
          path={file.filename}
          line={lineNumber}
          side={splitSideToSide(side)}
          onsave={(body) => handleExtendSave(lineNumber, side, body)}
          ondelete={() => handleExtendDelete(lineNumber, side)}
          oncancel={() => {}}
        />
      {/snippet}
    </DiffView>

    <!-- Draft annotations: rendered outside DiffView so they appear immediately
         after save regardless of diff mode or virtual-scroll state.
         DiffUnifiedExtendLine only fires for hidden/collapsed lines (library v0.1.5
         limitation), so we render saved drafts here as a reliable fallback. -->
    {#if drafts.length > 0}
      <div class="draft-annotations" aria-label="Draft comments on this file">
        {#each drafts as draft (draft.line + '|' + draft.side)}
          <DraftThread
            {draft}
            path={file.filename}
            line={draft.line}
            side={draft.side}
            onsave={(body) => handleExtendSave(draft.line, sideToSplitSide(draft.side), body)}
            ondelete={() => handleExtendDelete(draft.line, sideToSplitSide(draft.side))}
            oncancel={() => {}}
          />
        {/each}
      </div>
    {/if}
  {/if}
  {/if}
</article>

<style>
  .file-diff { border: 1px solid #8884; border-radius: 6px; margin-bottom: 1rem; overflow: hidden; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.8rem; background: #8881; }
  header code { font-family: var(--font-mono); }
  header.clickable { cursor: pointer; }
  header.clickable:hover { background: #8882; }
  .header-right { display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; }
  .note { padding: 0.8rem; opacity: 0.7; }
  .viewed-label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.8rem;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .viewed-checkbox { cursor: pointer; }
  .changed-badge {
    font-size: 0.75rem;
    padding: 0.15rem 0.4rem;
    border-radius: 3px;
    background: #9a67000a;
    color: #9a6700;
    border: 1px solid #9a670033;
    white-space: nowrap;
  }
  .is-collapsed { opacity: 0.85; }
  /* Apply the --font-mono token to the diff view container */
  :global(.unified-diff-table-wrapper),
  :global(.old-diff-table-wrapper),
  :global(.new-diff-table-wrapper) {
    font-family: var(--font-mono) !important;
  }
  .draft-annotations { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; border-top: 1px solid #f0b44444; }
</style>
