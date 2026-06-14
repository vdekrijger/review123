<script lang="ts">
  import { DiffView, DiffModeEnum, SplitSide } from '@git-diff-view/svelte'
  import '@git-diff-view/svelte/styles/diff-view.css'
  import { buildDiffFile, classifyFile } from '../lib/diff/diffFile'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode, FocusMode } from '../lib/settings/settings'
  import { type TestFileDisplay } from '../lib/settings/settings'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { langForFilename, classifyNoise } from '../lib/diff/codeNoise'
  import { isTestFile } from '../lib/testFile'
  import type { Draft } from '../lib/drafts/drafts.svelte'
  import DraftThread from './DraftThread.svelte'
  import ExistingThread from './ExistingThread.svelte'
  import SkillFindingCard from './SkillFindingCard.svelte'
  import { patchLineNumbers } from '../lib/diff/patchLines'
  import type { PrComment } from '../lib/github/comments'
  import { groupThreads, type CommentThread as Thread } from '../lib/github/commentThreads'
  import type { ReplyOutcome } from '../lib/github/replies'
  import type { AskFocus } from '../lib/ai/tasks'
  import type { WhitespaceDisplay } from '../lib/diff/whitespace'
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
    /**
     * Posts a reply to an existing comment thread IMMEDIATELY (not queued
     * with the review). null → no Reply affordance (provider unsupported).
     */
    onReply?: ((root: PrComment, body: string) => Promise<ReplyOutcome>) | null
    /**
     * Whitespace-hiding decision for this file (computed in InspectStep).
     * null/undefined = toggle off or not applicable → render the provider diff.
     * 'collapsed'    = whole change is whitespace-only → placeholder instead of diff.
     * 'recomputed'   = render the recomputed patch; line-comment widgets disabled
     *                  because displayed rows no longer match provider-side anchors.
     * 'unavailable'  = full contents missing → provider diff + honest note.
     */
    whitespace?: WhitespaceDisplay | null
  }

  let { file, mode, drafts = [], comments = [], resolvedCommentIds = new Set(), onAddDraft, onRemoveDraft, viewed = false, changedSinceViewed = false, onToggleViewed, contents, askFn = null, askDisabledReason = null, skillFindings = [], onAddSkillFindingDraft, onReply = null, whitespace = null }: Props = $props()

  // Test-file display (must be declared before collapsed)
  const testFileDisplay = $derived<TestFileDisplay>(settingsState.current.testFileDisplay)
  const isTest = $derived(isTestFile(file.filename))

  // ---- Focus mode (dim code noise) ----------------------------------------
  // Reactive: dims import lines ('imports') or imports + comments
  // ('imports-comments') by toggling a `dimmed-noise` class on each matching
  // diff row AFTER the third-party DiffView renders. Lines are never hidden or
  // collapsed — text stays selectable and comment-anchorable.
  const focusMode = $derived<FocusMode>(settingsState.current.focusMode)
  const noiseLang = $derived(langForFilename(file.filename))

  /** True for lines we should dim under the active focusMode. */
  function shouldDim(rawText: string): boolean {
    if (focusMode === 'off' || noiseLang === null) return false
    const kind = classifyNoise(rawText, noiseLang)
    if (kind === 'import') return true
    if (kind === 'comment') return focusMode === 'imports-comments'
    return false
  }

  /**
   * Read the raw source text of a single content cell WITHOUT the +/- diff
   * marker. The library renders the marker in a separate
   * `.diff-line-content-operator` span and the line text in
   * `.diff-line-content-raw` (plain) or `.diff-line-syntax-raw` (highlighted).
   * We read those so classification sees the source line, not `+ import …`.
   */
  function cellText(cell: Element): string {
    const raws = cell.querySelectorAll('.diff-line-content-raw, .diff-line-syntax-raw')
    if (raws.length === 0) return ''
    return [...raws].map((s) => s.textContent ?? '').join('')
  }

  /**
   * Decorate each diff CONTENT CELL independently. Cell-level (not row-level)
   * matters in split mode, where one <tr> holds both the old (LEFT) and new
   * (RIGHT) sides — they may classify differently. Unified rows have a single
   * content cell, so behaviour is identical there.
   */
  function decorateRows(root: HTMLElement): void {
    const cells = root.querySelectorAll(
      '.diff-line-content, .diff-line-old-content, .diff-line-new-content',
    )
    for (const cell of cells) {
      cell.classList.toggle('dimmed-noise', shouldDim(cellText(cell)))
    }
  }

  /**
   * Svelte action: keep the diff rows decorated as focus mode / diff content
   * change. Re-runs on the reactive `_` arg (a tuple of focusMode + filename +
   * mode) and observes library re-renders (highlight load, context expansion)
   * via a MutationObserver so newly inserted rows get decorated too.
   */
  function focusDim(node: HTMLElement, _: unknown) {
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => decorateRows(node))
    }
    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(node, { childList: true, subtree: true })
    return {
      update() {
        schedule()
      },
      destroy() {
        cancelAnimationFrame(raf)
        mo.disconnect()
      },
    }
  }

  // ---- Diff view theme ----------------------------------------------------
  // The library scopes its syntax-highlight token colors (hljs-*) and diff row
  // backgrounds by a data-theme attribute on its own wrapper, driven by the
  // diffViewTheme prop. Resolve the app theme setting ('auto' via matchMedia)
  // reactively so the diff restyles live when the user flips the theme.
  let prefersDark = $state(
    typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false),
  )
  $effect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq?.addEventListener) return
    prefersDark = mq.matches
    const onChange = (e: MediaQueryListEvent) => {
      prefersDark = e.matches
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  })
  const diffTheme = $derived.by((): 'light' | 'dark' => {
    const t = settingsState.current.theme
    if (t === 'dark' || t === 'light') return t
    return prefersDark ? 'dark' : 'light'
  })

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

  // Whitespace-hiding display state for this file
  const wsCollapsed = $derived(kind === 'diff' && whitespace?.kind === 'collapsed')
  const wsActive = $derived(kind === 'diff' && whitespace?.kind === 'recomputed')
  const wsUnavailable = $derived(kind === 'diff' && whitespace?.kind === 'unavailable')

  const diffFile = $derived(
    kind === 'diff' && !wsCollapsed
      ? buildDiffFile(file, mode, contents, whitespace?.kind === 'recomputed' ? whitespace.patch : undefined)
      : null,
  )

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

  // ---- Skill findings (line-anchored) state -------------------------------

  // Session-only dismissed finding keys within this FileDiff instance
  let dismissedSkillKeys = $state<Set<string>>(new Set())
  // Session-only "added as draft" state keys (persist for the session — state chip)
  let addedSkillKeys = $state<Set<string>>(new Set())

  function dismissSkillFinding(key: string) {
    dismissedSkillKeys = new Set([...dismissedSkillKeys, key])
  }

  async function handleAddSkillFindingDraft(finding: SkillFinding) {
    if (onAddSkillFindingDraft) {
      await onAddSkillFindingDraft({ body: finding.body, line: finding.line, key: finding.key })
    }
    addedSkillKeys = new Set([...addedSkillKeys, finding.key])
  }

  // Visible (non-dismissed) skill findings
  const visibleSkillFindings = $derived(skillFindings.filter(f => !dismissedSkillKeys.has(f.key)))

  // ---- Anchor resolvability -----------------------------------------------
  // A line anchor (draft or finding) is resolvable when its line number is
  // present in the patch hunks for its side. Resolvable anchors render INLINE
  // at the line via extendData; unresolvable ones fall back to the per-file
  // annotation blocks below the diff. Never both.
  const leftAnchorLines = $derived(patchLineNumbers(file.patch, 'LEFT'))
  const rightAnchorLines = $derived(patchLineNumbers(file.patch, 'RIGHT'))

  function isAnchoredDraft(d: Draft): boolean {
    return d.side === 'LEFT' ? leftAnchorLines.has(d.line) : rightAnchorLines.has(d.line)
  }

  // ---- Existing comments: thread grouping + anchorability split ------------
  // Threads group a root comment with its replies (GitHub in_reply_to_id
  // chains / GitLab discussions). A thread is ANCHORED when its root line is
  // present in the patch hunks — anchored threads render INLINE at their line
  // (via extendData); only file-level / unanchorable threads go to the
  // bottom-of-file list. Same dedupe rule as drafts: never both.
  const threads = $derived(groupThreads(comments))

  function isAnchoredThread(t: Thread): boolean {
    const { line, side } = t.root
    if (line === null || side === null) return false
    return side === 'LEFT' ? leftAnchorLines.has(line) : rightAnchorLines.has(line)
  }

  const anchoredThreads = $derived(threads.filter(isAnchoredThread))
  const unanchoredThreads = $derived(threads.filter((t) => !isAnchoredThread(t)))

  /** Whether a thread is resolved (root comment id in resolvedCommentIds) */
  function isThreadResolved(thread: Thread): boolean {
    return resolvedCommentIds.has(thread.root.id)
  }

  // Bottom list: unanchorable threads grouped by line (null = "General", last)
  const unanchoredThreadsByLine = $derived.by(() => {
    const map = new Map<number | null, Thread[]>()
    for (const t of unanchoredThreads) {
      const key = t.root.line
      const arr = map.get(key) ?? []
      arr.push(t)
      map.set(key, arr)
    }
    return map
  })

  // Ordered line keys (non-null first, sorted numerically; null last)
  const lineKeys = $derived.by(() => {
    const keys = [...unanchoredThreadsByLine.keys()]
    const nonNull = (keys.filter((k) => k !== null) as number[]).sort((a, b) => a - b)
    const hasNull = keys.includes(null)
    return hasNull ? ([...nonNull, null] as (number | null)[]) : nonNull
  })

  function commentCountAt(lineKey: number | null): number {
    const group = unanchoredThreadsByLine.get(lineKey) ?? []
    return group.reduce((n, t) => n + 1 + t.replies.length, 0)
  }

  // ---- extendData — per-line annotation entries (drafts + skill findings) --
  // NOTE: @git-diff-view's unified-mode DiffUnifiedExtendLine shipped with an
  // inverted isHidden condition (extend rows only rendered for collapsed
  // lines). We patch the package (patches/@git-diff-view__svelte.patch) so
  // extendData renders inline at visible lines in BOTH unified and split
  // modes — the same path drafts already used in split mode.
  interface ExtendEntry {
    draft?: Draft
    findings: SkillFinding[]
    threads: Thread[]
  }

  const extendData = $derived.by(() => {
    const oldFile: Record<string, { data: ExtendEntry }> = {}
    const newFile: Record<string, { data: ExtendEntry }> = {}
    const entryAt = (map: Record<string, { data: ExtendEntry }>, line: number): ExtendEntry => {
      const key = String(line)
      if (!map[key]) map[key] = { data: { findings: [], threads: [] } }
      return map[key].data
    }
    for (const d of drafts) {
      if (!isAnchoredDraft(d)) continue
      // While the add/edit widget is open at this line, the widget shows the
      // draft — suppress the extend entry so the draft never renders twice.
      if (openWidget && openWidget.line === d.line && splitSideToSide(openWidget.side) === d.side) continue
      if (d.side === 'LEFT') {
        entryAt(oldFile, d.line).draft = d
      } else {
        entryAt(newFile, d.line).draft = d
      }
    }
    for (const f of visibleSkillFindings) {
      // Findings anchor to the new (RIGHT) side of the diff
      if (!rightAnchorLines.has(f.line)) continue
      entryAt(newFile, f.line).findings.push(f)
    }
    for (const t of anchoredThreads) {
      const map = t.root.side === 'LEFT' ? oldFile : newFile
      entryAt(map, t.root.line!).threads.push(t)
    }
    return { oldFile, newFile }
  })

  // Drafts whose anchor is NOT in the current diff — fallback block below the diff
  const unanchoredDrafts = $derived(drafts.filter((d) => !isAnchoredDraft(d)))

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

  // Skill findings whose anchor is NOT in the current diff — fallback block
  const unanchoredSkillFindings = $derived(visibleSkillFindings.filter(f => !rightAnchorLines.has(f.line)))
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
  {:else if wsCollapsed}
    <p class="note ws-collapsed-note" role="status">No changes when hiding whitespace.</p>
  {:else if kind === 'binary-or-too-large' || !diffFile}
    <p class="note">Binary or too large to display.</p>
  {:else}
    {#if wsUnavailable}
      <p class="ws-inline-note" role="note">Whitespace hiding isn't available for this file — showing the full diff.</p>
    {:else if wsActive}
      <p class="ws-inline-note" role="note">Line comments are disabled while whitespace changes are hidden — turn off "Hide whitespace" to comment on exact lines.</p>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="focus-dim-host"
      data-focus-mode={focusMode}
      use:focusDim={[focusMode, file.filename, mode]}
    >
    <DiffView
      {diffFile}
      diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewHighlight={true}
      diffViewTheme={diffTheme}
      diffViewWrap={true}
      diffViewAddWidget={!wsActive}
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
        {@const entry = data as ExtendEntry}
        {#if entry?.draft}
          {@const flashKey = `${entry.draft.line}|${entry.draft.side}`}
          <div class="draft-annotations inline-annotation" data-testid="inline-annotations" data-line={lineNumber} class:flash={flashKeys.has(flashKey)} aria-label="Draft comment at line {lineNumber}">
            <DraftThread
              draft={entry.draft}
              path={file.filename}
              line={lineNumber}
              side={splitSideToSide(side)}
              onsave={(body) => handleExtendSave(lineNumber, side, body)}
              ondelete={() => handleExtendDelete(lineNumber, side)}
              oncancel={() => {}}
              {askFn}
              {askDisabledReason}
              excerpt={file.patch ? excerptAround(file.patch, lineNumber, splitSideToSide(side), 6) : ''}
            />
          </div>
        {/if}
        {#if entry?.findings?.length}
          <div class="line-findings" data-line-findings={lineNumber} aria-label="Reviewer findings at line {lineNumber}">
            {#each entry.findings as finding (finding.key)}
              <SkillFindingCard
                skillName={finding.skillName}
                severity={finding.severity}
                body={finding.body}
                line={finding.line}
                anchored={true}
                compact={true}
                added={addedSkillKeys.has(finding.key)}
                onAdd={() => handleAddSkillFindingDraft(finding)}
                onDismiss={() => dismissSkillFinding(finding.key)}
              />
            {/each}
          </div>
        {/if}
        {#if entry?.threads?.length}
          <div class="inline-comment-threads" data-testid="inline-annotations" data-line={lineNumber} aria-label="Existing comment threads at line {lineNumber}">
            {#each entry.threads as thread (thread.root.id)}
              <ExistingThread {thread} resolved={isThreadResolved(thread)} {onReply} />
            {/each}
          </div>
        {/if}
      {/snippet}
    </DiffView>
    </div>

    <!-- Fallback draft annotations: ONLY drafts whose line anchor is not present
         in the current diff. Anchored drafts render inline at their line via
         extendData (see renderExtendLine above). -->
    {#if unanchoredDrafts.length > 0}
      <div class="draft-annotations" aria-label="Draft comments on this file">
        {#each unanchoredDrafts as draft (draft.line + '|' + draft.side + '|' + (draft.n ?? 0))}
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

    <!-- Fallback findings block: ONLY findings whose line anchor is not present
         in the current diff. Anchored findings render inline at their line. -->
    {#if unanchoredSkillFindings.length > 0}
      <div class="skill-findings-annotations" aria-label="Skill review findings for this file">
        {#each unanchoredSkillFindings as finding (finding.key)}
          <SkillFindingCard
            skillName={finding.skillName}
            severity={finding.severity}
            body={finding.body}
            line={finding.line}
            anchored={false}
            added={addedSkillKeys.has(finding.key)}
            onAdd={() => handleAddSkillFindingDraft(finding)}
            onDismiss={() => dismissSkillFinding(finding.key)}
          />
        {/each}
      </div>
    {/if}

    <!-- Bottom-of-file existing comments: ONLY file-level / unanchorable
         threads (root line null or not present in the patch hunks).
         Anchored threads render inline at their line via extendData. -->
    {#if unanchoredThreads.length > 0}
      <div class="existing-comments" aria-label="Existing review comments">
        {#each lineKeys as lineKey (lineKey)}
          {@const group = unanchoredThreadsByLine.get(lineKey)!}
          {@const count = commentCountAt(lineKey)}
          <div class="existing-line-group">
            <div class="existing-line-label">
              {lineKey !== null ? `Line ${lineKey}` : 'General'} — {count} comment{count === 1 ? '' : 's'}
            </div>
            {#each group as thread (thread.root.id)}
              <ExistingThread {thread} resolved={isThreadResolved(thread)} {onReply} />
            {/each}
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
  .ws-collapsed-note { font-style: italic; }
  .ws-inline-note {
    margin: 0;
    padding: 0.3rem 0.8rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    background: var(--surface-raised);
    border-bottom: 1px solid var(--hairline);
  }
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

  /* Focus mode — dim "code noise" (import / comment) content cells.
     Opacity-only so the text stays fully selectable and the cell remains
     comment-anchorable (the add-comment affordance and line number are
     untouched). Hover restores full opacity for legibility on demand. Works in
     unified (.diff-line-content) and split (old/new-content) layouts and in both
     themes (opacity is theme-agnostic). The class is toggled per content cell. */
  .focus-dim-host :global(.diff-line-content.dimmed-noise),
  .focus-dim-host :global(.diff-line-old-content.dimmed-noise),
  .focus-dim-host :global(.diff-line-new-content.dimmed-noise) {
    opacity: 0.45;
    transition: opacity 0.12s ease;
  }
  .focus-dim-host :global(.diff-line-content.dimmed-noise):hover,
  .focus-dim-host :global(.diff-line-old-content.dimmed-noise):hover,
  .focus-dim-host :global(.diff-line-new-content.dimmed-noise):hover {
    opacity: 1;
  }
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

  /* (Resolved-thread collapse styles live in ExistingThread.svelte) */

  /* ---- Per-file fallback block for unanchored findings ---- */
  .skill-findings-annotations {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem;
    border-top: 1px solid var(--border-draft, var(--hairline));
  }

  /* ---- Inline (at-line) annotation containers inside extend rows ---- */
  .draft-annotations.inline-annotation {
    border-top: none;
  }

  .draft-annotations.inline-annotation.flash {
    animation: flash-new-draft 1.5s ease-out forwards;
    border-radius: 4px;
  }

  .line-findings {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.35rem 0.5rem;
  }

  /* Inline existing-comment threads anchored at a line (extend row) */
  .inline-comment-threads {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    background: var(--surface-banner);
    border-top: 1px solid var(--border-banner);
    border-bottom: 1px solid var(--border-banner);
  }

  /*
   * ── Inline-widget theme-inheritance fix (dark-mode contrast bug) ──
   *
   * @git-diff-view's diff-view.css forces, on EVERY descendant of an inline
   * annotation row:
   *     .diff-line-extend-wrapper * { color: initial; }   (specificity 0,0,1,1)
   *     .diff-line-widget-wrapper * { color: initial; }
   * `initial` for `color` is canvastext (≈ black). Readable on the light
   * surface, but washed dark-on-dark in dark theme — for the existing comment
   * threads, draft threads, AI finding cards, and the add-comment editor that
   * render inline at a line. The SAME content in the bottom-of-file list sits
   * OUTSIDE these wrappers and renders fine, which is why only the inline
   * (extend-row / widget) context was broken.
   *
   * Fix: re-establish the app's text cascade. Our inline host containers are
   * pinned to the proper app token; their descendants are set to
   * `color: inherit` so body text resolves to the APP color, not the diff row
   * color. Every selector below sits at specificity 0,0,2,x — beating the
   * library's 0,0,1,1 universal rule WITHOUT depending on CSS load order (the
   * library and these styles ship in separate bundle chunks, so source order
   * is not a reliable tie-breaker).
   *
   * `color: inherit` would also flatten the few descendants that carry their
   * OWN design-system color (severity / state chips, accent + danger text,
   * muted notes). Those are re-pinned just below, again at 0,0,2,x, so the
   * proper tokens drive them in BOTH themes.
   */

  /* Host containers → app text tokens. */
  :global(.diff-line-extend-wrapper) .inline-comment-threads,
  :global(.diff-line-extend-wrapper) .line-findings {
    color: var(--text);
  }
  /* Draft threads carry their own dedicated --text-draft surface/text pair. */
  :global(.diff-line-extend-wrapper) .draft-annotations :global(.draft-thread),
  :global(.diff-line-widget-wrapper) :global(.draft-thread) {
    color: var(--text-draft);
  }

  /* Body text descendants inherit from the pinned host (not the diff row). */
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(*),
  :global(.diff-line-extend-wrapper) .line-findings :global(*),
  :global(.diff-line-extend-wrapper) .draft-annotations :global(.draft-thread) :global(*),
  :global(.diff-line-widget-wrapper) :global(.draft-thread) :global(*) {
    color: inherit;
  }

  /* Re-pin design-system token colors for non-body descendants (0,0,2,x). */
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.comment-header),
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.resolved-summary),
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.resolved-label),
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.reply-hint),
  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.reply-pending-label),
  :global(.diff-line-extend-wrapper) .line-findings :global(.skill-line-note) {
    color: var(--text-muted);
  }

  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.resolved-check),
  :global(.diff-line-extend-wrapper) .line-findings :global(.skill-add-draft-btn:not(.added)) {
    color: var(--accent);
  }

  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.avatar-initial) {
    color: var(--surface);
  }

  :global(.diff-line-extend-wrapper) .inline-comment-threads :global(.reply-error),
  :global(.diff-line-extend-wrapper) .line-findings :global(.severity-chip-high) {
    color: var(--legend-removed-color);
  }
  :global(.diff-line-extend-wrapper) .line-findings :global(.severity-chip-medium) {
    color: var(--legend-changed-color);
  }
  :global(.diff-line-extend-wrapper) .line-findings :global(.severity-chip-low) {
    color: var(--text-muted);
  }
  :global(.diff-line-extend-wrapper) .line-findings :global(.skill-state-chip),
  :global(.diff-line-extend-wrapper) .line-findings :global(.skill-add-draft-btn.added) {
    color: var(--legend-added-color);
  }
</style>
