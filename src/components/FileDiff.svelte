<script lang="ts">
  import { DiffView, DiffModeEnum, SplitSide } from '@git-diff-view/svelte'
  import '@git-diff-view/svelte/styles/diff-view.css'
  import { buildDiffFile, classifyFile } from '../lib/diff/diffFile'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import { type TestFileDisplay } from '../lib/settings/settings'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { isTestFile } from '../lib/testFile'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import DraftThread from './DraftThread.svelte'
  import CommentThread from './CommentThread.svelte'
  import type { PrComment } from '../lib/github/comments'
  import type { AskFocus } from '../lib/ai/tasks'
  import { excerptAround } from '../lib/diff/excerpt'
  import { track } from '../lib/analytics/analytics'

  /** A skill finding scoped to a specific line in this file */
  export interface SkillFinding {
    skillName: string
    line: number
    severity: 'high' | 'medium' | 'low'
    body: string
    key: string
  }

  interface Props {
    file: PrFile
    mode: DiffMode
    /** Drafts that belong to this file */
    drafts?: Draft[]
    /** Existing PR comments for this file */
    comments?: PrComment[]
    /** Set of comment databaseIds that belong to resolved review threads */
    resolvedCommentIds?: Set<number>
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
    /**
     * Optional Ask AI function threaded from Review via InspectStep.
     * When provided, DraftThread shows a "Comment | Ask AI" tab toggle.
     */
    askFn?: ((q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>) | null
    /**
     * Optional disabled hint for Ask AI gating (e.g. "No API key configured.").
     */
    askDisabledReason?: string | null
    /**
     * Line-bearing skill findings for this file, rendered inside the annotation
     * area at their respective lines (not stacked above the file).
     */
    skillFindings?: SkillFinding[]
    /**
     * Called when the user clicks "Add as draft" on a skill finding inside FileDiff.
     */
    onAddSkillFindingDraft?: (finding: { body: string; line: number; key: string }) => Promise<void>
  }

  let { file, mode, drafts = [], comments = [], resolvedCommentIds = new Set(), onAddDraft, onRemoveDraft, viewed = false, changedSinceViewed = false, onToggleViewed, contents, askFn = null, askDisabledReason = null, skillFindings = [], onAddSkillFindingDraft }: Props = $props()

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

  /**
   * Returns the root (top-level) comment of a thread group.
   * The root is the first comment with inReplyTo === null; falls back to the
   * first comment in the array if all are replies (orphan scenario).
   */
  function rootComment(group: PrComment[]): PrComment {
    return group.find((c) => c.inReplyTo === null) ?? group[0]
  }

  /** Whether a thread group is resolved (root comment id in resolvedCommentIds) */
  function isResolved(group: PrComment[]): boolean {
    return resolvedCommentIds.has(rootComment(group).id)
  }

  /** Truncates body to ~60 chars for the resolved summary line */
  function truncateBody(body: string, maxLen = 60): string {
    const oneLine = body.replace(/\s+/g, ' ').trim()
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine
  }

  // Ordered line keys (non-null first, sorted numerically; null last)
  const lineKeys = $derived.by(() => {
    const keys = [...commentsByLine.keys()]
    const nonNull = (keys.filter((k) => k !== null) as number[]).sort((a, b) => a - b)
    const hasNull = keys.includes(null)
    return hasNull ? ([...nonNull, null] as (number | null)[]) : nonNull
  })

  // Test-file display (must be declared before collapsed)
  const testFileDisplay = $derived<TestFileDisplay>(settingsState.current.testFileDisplay)
  const isTest = $derived(isTestFile(file.filename))

  // When viewed → collapse diff body; user can re-expand by clicking header or unchecking
  // dim mode reduces opacity only — it does NOT collapse the file
  let manuallyExpanded = $state(false)
  const collapsed = $derived(viewed && !manuallyExpanded)

  function handleHeaderClick() {
    if (collapsed) {
      manuallyExpanded = true
      // viewed-collapsed is the only collapse origin that also hides the diff body
      track('file_expanded', { origin: 'viewed' })
    }
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

  // Copy-path state
  let copyDone = $state(false)
  async function copyPath() {
    await navigator.clipboard.writeText(file.filename)
    copyDone = true
    setTimeout(() => { copyDone = false }, 1500)
  }

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

  // ---- Skill findings (line-anchored) state -------------------------------

  // Session-only dismissed finding keys within this FileDiff instance
  let dismissedSkillKeys = $state<Set<string>>(new Set())
  // Session-only "added" confirmation keys
  let addedSkillKeys = $state<Set<string>>(new Set())

  function dismissSkillFinding(key: string) {
    dismissedSkillKeys = new Set([...dismissedSkillKeys, key])
  }

  async function handleAddSkillFindingDraft(finding: SkillFinding) {
    if (onAddSkillFindingDraft) {
      await onAddSkillFindingDraft({ body: finding.body, line: finding.line, key: finding.key })
    }
    addedSkillKeys = new Set([...addedSkillKeys, finding.key])
    setTimeout(() => {
      addedSkillKeys = new Set([...addedSkillKeys].filter(k => k !== finding.key))
    }, 2000)
  }

  // Visible (non-dismissed) skill findings
  const visibleSkillFindings = $derived(skillFindings.filter(f => !dismissedSkillKeys.has(f.key)))
</script>

<article class="file-diff" class:is-collapsed={collapsed} class:test-dim={isTest && testFileDisplay === 'dim'} class:test-highlight={isTest && testFileDisplay === 'highlight'}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <header onclick={handleHeaderClick} class:clickable={collapsed} class:test-highlight={isTest && testFileDisplay === 'highlight'}>
    <code>{filename}</code>
    <div class="header-right">
      {#if changedSinceViewed}
        <span class="changed-badge" role="status">Changed since you viewed it</span>
      {/if}
      <button class="copy-path-btn" aria-label="Copy file path" onclick={(e) => { e.stopPropagation(); copyPath() }}>
        {#if copyDone}<span class="copy-done">Copied</span>{:else}<span class="copy-icon" aria-hidden="true">⎘</span>{/if}
      </button>
      <span class="stats">
        <span class="stat-add">+{file.additions}</span>
        <span class="stat-del"> −{file.deletions}</span>
      </span>
      {#if isTest && testFileDisplay !== 'normal'}
        <span class="test-chip chip">test</span>
      {/if}
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
        {@const lineExcerpt = file.patch ? excerptAround(file.patch, lineNumber, splitSideToSide(side), 6) : ''}
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
          {askFn}
          {askDisabledReason}
          excerpt={lineExcerpt}
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
              {askFn}
              {askDisabledReason}
              excerpt={file.patch ? excerptAround(file.patch, draft.line, draft.side, 6) : ''}
            />
          </div>
        {/each}
      </div>
    {/if}

    {#if visibleSkillFindings.length > 0}
      <div class="skill-findings-annotations" aria-label="Skill review findings for this file">
        {#each visibleSkillFindings as finding (finding.key)}
          <div class="skill-finding severity-{finding.severity}">
            <div class="skill-finding-header">
              <span class="skill-persona-label">{finding.skillName}</span>
              <span class="skill-severity-chip severity-chip-{finding.severity}">{finding.severity}</span>
            </div>
            <p class="skill-finding-body">{finding.body}</p>
            <div class="skill-finding-actions">
              <button
                class="skill-add-draft-btn"
                class:added={addedSkillKeys.has(finding.key)}
                onclick={() => handleAddSkillFindingDraft(finding)}
                disabled={addedSkillKeys.has(finding.key)}
                aria-label={addedSkillKeys.has(finding.key) ? 'Added to drafts' : 'Add as draft comment'}
              >{addedSkillKeys.has(finding.key) ? '✓ Added' : 'Add as draft'}</button>
              <button
                class="skill-dismiss-btn"
                onclick={() => dismissSkillFinding(finding.key)}
              >Dismiss</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if comments.length > 0}
      <div class="existing-comments" aria-label="Existing review comments">
        {#each lineKeys as lineKey (lineKey)}
          {@const group = commentsByLine.get(lineKey)!}
          {@const root = rootComment(group)}
          <div class="existing-line-group">
            <div class="existing-line-label">
              {lineKey !== null ? `Line ${lineKey}` : 'General'} — {group.length} comment{group.length === 1 ? '' : 's'}
            </div>
            {#if isResolved(group)}
              <details class="resolved-thread">
                <summary class="resolved-summary">
                  <span class="resolved-check" aria-hidden="true">✓</span>
                  <span class="resolved-label">Resolved</span>
                  <span class="resolved-snippet">{root.author}: {truncateBody(root.body)}</span>
                </summary>
                <CommentThread comments={group} />
              </details>
            {:else}
              <CommentThread comments={group} />
            {/if}
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

  /* Copy path button */
  .copy-path-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0 0.2rem;
    font-size: 0.85rem;
    line-height: 1;
    border-radius: 3px;
    transition: color 0.1s;
  }
  .copy-path-btn:hover { color: var(--text); }
  .copy-icon { font-size: 0.9rem; }
  .copy-done { font-size: 0.72rem; color: var(--legend-added-color); font-weight: 600; }

  /* Colored stat counts */
  .stat-add { color: var(--diff-add); }
  .stat-del { color: var(--diff-del); }

  /* Test chip (shown in highlight and dim modes) — verdigris accent tokens */
  .test-chip {
    background: var(--accent-subtle);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent);
    font-size: 0.68rem;
    padding: 0.08rem 0.4rem;
    border-radius: 999px;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  /* Test highlight: accent left border on the whole file card so test files
     are scannable in the file list at a glance. Code rows stay untouched. */
  article.test-highlight {
    border-left: 3px solid var(--accent);
  }

  /* Test highlight: subtle verdigris tint on the file header only.
     Both --accent and --surface-raised are theme-aware, so the tint adapts
     to light and dark palettes. */
  header.test-highlight {
    background: color-mix(in srgb, var(--accent) 9%, var(--surface-raised));
  }
  header.test-highlight.clickable:hover {
    background: color-mix(in srgb, var(--accent) 14%, var(--surface-raised));
  }

  /* Test dim */
  article.test-dim { opacity: 0.6; }
  article.test-dim header { opacity: 0.8; }
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

  /* Resolved thread — collapsed <details> */
  .resolved-thread {
    border: 1px solid var(--hairline);
    border-radius: 4px;
    overflow: hidden;
  }

  .resolved-summary {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-muted);
    background: var(--surface-raised);
    list-style: none;
    user-select: none;
  }

  .resolved-summary::-webkit-details-marker {
    display: none;
  }

  .resolved-check {
    color: var(--accent);
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  .resolved-label {
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .resolved-snippet {
    opacity: 0.7;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Expanded content padding */
  .resolved-thread[open] > :not(summary) {
    padding: 0.4rem;
  }

  /* ---- Skill findings annotations (line-anchored, dashed-accent style) ---- */
  .skill-findings-annotations {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem;
    border-top: 1px solid var(--border-draft, var(--hairline));
  }

  .skill-finding {
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.85rem;
    border-style: dashed;
    border-width: 1px;
  }

  .skill-finding.severity-high {
    border-color: var(--accent);
    background: var(--legend-removed-bg);
  }

  .skill-finding.severity-medium {
    border-color: var(--accent);
    background: var(--legend-changed-bg);
  }

  .skill-finding.severity-low {
    border-color: var(--border-subtle);
    background: var(--surface-raised);
  }

  .skill-finding-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.3rem;
  }

  .skill-persona-label {
    font-size: 0.75rem;
    font-weight: 600;
    opacity: 0.75;
    flex: 1;
  }

  .skill-severity-chip {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
  }

  .severity-chip-high {
    background: var(--legend-removed-bg);
    color: var(--legend-removed-color);
    border: 1px solid var(--legend-removed-border);
  }

  .severity-chip-medium {
    background: var(--legend-changed-bg);
    color: var(--legend-changed-color);
    border: 1px solid var(--legend-changed-border);
  }

  .severity-chip-low {
    background: var(--surface-raised);
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
  }

  .skill-finding-body {
    margin: 0 0 0.4rem;
    line-height: 1.4;
  }

  .skill-finding-actions {
    display: flex;
    gap: 0.4rem;
  }

  .skill-add-draft-btn {
    font-size: 0.78rem;
    padding: 0.18rem 0.55rem;
    border-radius: 4px;
    border: 1px solid var(--accent);
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-weight: 500;
  }

  .skill-add-draft-btn:hover:not(:disabled) {
    background: var(--legend-added-bg);
  }

  .skill-add-draft-btn.added {
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border, var(--accent));
    color: var(--legend-added-color, var(--accent));
    cursor: default;
    opacity: 0.85;
  }

  .skill-dismiss-btn {
    font-size: 0.78rem;
    padding: 0.18rem 0.55rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }

  .skill-dismiss-btn:hover {
    opacity: 1;
    background: var(--surface-raised);
  }
</style>
