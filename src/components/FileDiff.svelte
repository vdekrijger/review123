<script lang="ts">
  import { DiffView, DiffModeEnum, SplitSide } from '@git-diff-view/svelte'
  import '@git-diff-view/svelte/styles/diff-view.css'
  import { buildDiffFile, classifyFile } from '../lib/diff/diffFile'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import DraftThread from './DraftThread.svelte'
  import CommentThread from './CommentThread.svelte'
  import type { PrComment } from '../lib/github/comments'

  interface Props {
    file: PrFile
    mode: DiffMode
    /** Drafts that belong to this file */
    drafts?: Draft[]
    /** Existing PR comments for this file */
    comments?: PrComment[]
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
    /**
     * Full before/after file contents used to enable GitHub-style context
     * expansion between hunks. When omitted (or while still loading) the
     * diff renders hunk-only without expansion affordances.
     */
    contents?: { before: string | null; after: string | null }
  }

  let { file, mode, drafts = [], comments = [], onAddDraft, onRemoveDraft, viewed = false, changedSinceViewed = false, onToggleViewed, contents }: Props = $props()

  // Group existing comments by line (null-line comments go under a null key)
  const commentsByLine = $derived.by(() => {
    const map = new Map<number | null, PrComment[]>()
    for (const c of comments) {
      const key = c.line
      const arr = map.get(key) ?? []
      arr.push(c)
      map.set(key, arr)
    }
    return map
  })

  // Ordered line keys (non-null first, sorted numerically; null last)
  const lineKeys = $derived.by(() => {
    const keys = [...commentsByLine.keys()]
    const nonNull = (keys.filter((k) => k !== null) as number[]).sort((a, b) => a - b)
    const hasNull = keys.includes(null)
    return hasNull ? ([...nonNull, null] as (number | null)[]) : nonNull
  })

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
  const diffFile = $derived(kind === 'diff' ? buildDiffFile(file, mode, contents) : null)

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

  // ---- Flash-highlight state for newly saved annotation entries (Fix-B) ----
  // Set of "line|side" strings that should flash after widget save
  let flashKeys = $state<Set<string>>(new Set())

  function addFlash(line: number, side: 'LEFT' | 'RIGHT') {
    const key = `${line}|${side}`
    flashKeys = new Set([...flashKeys, key])
    // Remove flash class after animation completes (1.5s)
    setTimeout(() => {
      flashKeys = new Set([...flashKeys].filter(k => k !== key))
    }, 1600)
  }

  // ---- Helpers for DraftThread handlers ----------------------------------

  function handleWidgetSave(line: number, side: SplitSide, body: string) {
    const sideStr = splitSideToSide(side)
    onAddDraft?.(line, sideStr, body)
    // Fix-B: DO NOT close the widget — stay open showing the saved draft in read view.
    // The widget will re-render with existingDraft set (since drafts prop updates).
    // onClose is NOT called here; only called on explicit cancel/delete.
    addFlash(line, sideStr)
  }

  function handleWidgetCancel(hasDraft: boolean, onClose: () => void) {
    // Fix-B: only close if there is no draft saved for this line
    if (!hasDraft) {
      onClose()
      openWidget = null
    }
    // If there's a draft, cancel means "go back to read view" (handled inside DraftThread)
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
            // Fix-B: do NOT call onClose here — widget stays open showing saved draft
            handleWidgetSave(lineNumber, side, body)
          }}
          ondelete={() => {
            handleExtendDelete(lineNumber, side)
            onClose()
            openWidget = null
          }}
          oncancel={() => {
            // Fix-B: only close widget if no draft saved for this line
            handleWidgetCancel(existingDraft !== undefined, onClose)
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
        {#each drafts as draft (draft.line + '|' + draft.side + '|' + (draft.n ?? 0))}
          {@const flashKey = `${draft.line}|${draft.side}`}
          <div class="annotation-entry" class:flash={flashKeys.has(flashKey)}>
            <DraftThread
              {draft}
              path={file.filename}
              line={draft.line}
              side={draft.side}
              onsave={(body) => handleExtendSave(draft.line, sideToSplitSide(draft.side), body)}
              ondelete={() => handleExtendDelete(draft.line, sideToSplitSide(draft.side))}
              oncancel={() => {}}
            />
          </div>
        {/each}
      </div>
    {/if}

    {#if comments.length > 0}
      <div class="existing-comments" aria-label="Existing review comments">
        {#each lineKeys as lineKey (lineKey)}
          <div class="existing-line-group">
            <div class="existing-line-label">
              {lineKey !== null ? `Line ${lineKey}` : 'General'} — {commentsByLine.get(lineKey)!.length} comment{commentsByLine.get(lineKey)!.length === 1 ? '' : 's'}
            </div>
            <CommentThread comments={commentsByLine.get(lineKey)!} />
          </div>
        {/each}
      </div>
    {/if}
  {/if}
  {/if}
</article>

<style>
  .file-diff { border: 1px solid var(--hairline); border-radius: 6px; margin-bottom: 1rem; overflow: hidden; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.8rem; background: var(--surface-raised); }
  header code { font-family: var(--font-mono); font-size: 0.8125rem; }
  header.clickable { cursor: pointer; }
  header.clickable:hover { background: color-mix(in srgb, var(--hairline) 30%, var(--surface-raised)); }
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
    background: var(--legend-changed-bg);
    color: var(--legend-changed-color);
    border: 1px solid var(--legend-changed-border);
    white-space: nowrap;
  }
  .is-collapsed { opacity: 0.85; }
  /* Apply the --font-mono token to the diff view container */
  :global(.unified-diff-table-wrapper),
  :global(.old-diff-table-wrapper),
  :global(.new-diff-table-wrapper) {
    font-family: var(--font-mono) !important;
  }
  .draft-annotations { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; border-top: 1px solid var(--border-draft); }

  /* Fix-B: flash-highlight animation on the annotation entry after widget save */
  @keyframes flash-new-draft {
    0%   { background: var(--legend-changed-bg); }
    80%  { background: var(--legend-changed-bg); }
    100% { background: transparent; }
  }

  .annotation-entry.flash {
    animation: flash-new-draft 1.5s ease-out forwards;
    border-radius: 4px;
  }

  .existing-comments {
    border-top: 1px solid var(--border-banner);
    background: var(--surface-banner);
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .existing-line-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .existing-line-label {
    font-size: 0.75rem;
    opacity: 0.6;
    font-family: var(--font-mono);
    padding: 0.1rem 0.25rem;
    border-left: 2px solid var(--border-banner-accent);
    margin-bottom: 0.15rem;
  }
</style>
