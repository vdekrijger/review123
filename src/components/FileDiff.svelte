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
  }

  let { file, mode, drafts = [], onAddDraft, onRemoveDraft }: Props = $props()

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
</article>

<style>
  .file-diff { border: 1px solid #8884; border-radius: 6px; margin-bottom: 1rem; overflow: hidden; }
  header { display: flex; justify-content: space-between; padding: 0.4rem 0.8rem; background: #8881; }
  header code { font-family: var(--font-mono); }
  .note { padding: 0.8rem; opacity: 0.7; }
  /* Apply the --font-mono token to the diff view container */
  :global(.unified-diff-table-wrapper),
  :global(.old-diff-table-wrapper),
  :global(.new-diff-table-wrapper) {
    font-family: var(--font-mono) !important;
  }
  .draft-annotations { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; border-top: 1px solid #f0b44444; }
</style>
