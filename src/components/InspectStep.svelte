<script lang="ts">
  import FileDiff from './FileDiff.svelte'
  import FileTree from './FileTree.svelte'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import { getSettings, setTreeOpen } from '../lib/settings/settings'
  import type { createDraftStore } from '../lib/drafts/drafts.svelte'
  import { draftKey } from '../lib/drafts/drafts.svelte'
  import { track } from '../lib/analytics/analytics'
  import type { AttentionResult } from '../lib/ai/schemas'
  import type { createViewedStore } from '../lib/viewed/viewed.svelte'
  import type { PrComment } from '../lib/github/comments'
  import { slugify } from '../lib/slug'
  import type { SkillReviewEntry, AskFocus } from '../lib/ai/run.svelte'
  import type { SkillReviewResult } from '../lib/ai/schemas'
  import { listSkills } from '../lib/skills/skills'

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
    resolvedCommentIds = new Set(),
    contentsMap = null,
    skillReviews = [],
    runSkillReviewsFn = null,
    askFn = null,
    askDisabledReason = null,
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
    /** Set of comment databaseIds that belong to resolved review threads */
    resolvedCommentIds?: Set<number>
    /**
     * Map from filename → { before, after } full file contents, used to enable
     * context-line expansion in the diff view. Undefined while loading.
     * Files not in the map (beyond the 30-file cap) render hunk-only.
     */
    contentsMap?: Map<string, { before: string | null; after: string | null }> | null
    /** Skill reviews from the AI run — populated after runSkillReviews() */
    skillReviews?: SkillReviewEntry[]
    /** Optional callback to trigger runSkillReviews on the AiRun instance */
    runSkillReviewsFn?: (() => void) | null
    /**
     * Optional Ask AI function — when provided, DraftThread widgets show the
     * "Comment | Ask AI" tab toggle. Threaded from Review via AiRun.ask.
     */
    askFn?: ((q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>) | null
    /**
     * Optional disabled hint for Ask AI gating (e.g. "No API key configured.").
     */
    askDisabledReason?: string | null
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

  // Active path: set on tree click only (no IntersectionObserver)
  let activePath = $state<string | null>(null)

  // Collapsible tree drawer — default false (diff-first); read from settings on mount
  let treeOpen = $state(getSettings().treeOpen)
  let toggleTabEl = $state<HTMLButtonElement | null>(null)

  // Wide-viewport detection: viewport ≥ 1200px means enough left margin space to float the drawer
  // without pushing the diff column (70rem ≈ 1120px, so 1200px gives ~40px + 260px drawer margin)
  // Threshold: 70rem (1120px) + 28px (toggle) + 260px (drawer) + 32px padding = ~1440px
  // We use 1200 as a practical threshold — at this point free margin ≥ drawer width.
  const WIDE_THRESHOLD = 1200
  let isWideViewport = $state(typeof window !== 'undefined' ? window.innerWidth >= WIDE_THRESHOLD : false)

  $effect(() => {
    function onResize() {
      isWideViewport = window.innerWidth >= WIDE_THRESHOLD
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  function toggleTree(): void {
    treeOpen = !treeOpen
    setTreeOpen(treeOpen)
  }

  function closeTree(): void {
    if (!treeOpen) return
    treeOpen = false
    setTreeOpen(false)
    // Return focus to toggle tab
    toggleTabEl?.focus()
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && treeOpen) closeTree()
  }

  function handleTreeSelect(path: string): void {
    activePath = path
    const slug = slugify(path)
    const wrapper = document.getElementById(`file-${slug}`)
    if (!wrapper) return
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // If the article inside is collapsed (viewed), click its header to expand
    const article = wrapper.querySelector('article.file-diff.is-collapsed')
    if (article) {
      const header = article.querySelector('header') as HTMLElement | null
      header?.click()
    }
    // On narrow viewport (<900px), close the drawer after selecting a file
    if (window.innerWidth < 900) closeTree()
  }

  // ---------------------------------------------------------------------------
  // Skill suggestions
  // ---------------------------------------------------------------------------

  // Build a Set of paths in this PR for filtering
  const prPathSet = $derived(new Set(files.map(f => f.filename)))

  // Auto-scroll to first finding's file when a run completes with findings
  let prevRunning = $state(false)
  $effect(() => {
    const nowRunning = isRunning
    if (prevRunning && !nowRunning) {
      // Run just finished — find first finding across all done reviews
      for (const review of skillReviews) {
        if (review.state.status !== 'done' || !review.state.value) continue
        const result = review.state.value as { findings?: { path: string }[] }
        const firstValid = result.findings?.find(f => prPathSet.has(f.path))
        if (firstValid) {
          const slug = slugify(firstValid.path)
          const el = document.getElementById(`file-${slug}`)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
          break
        }
      }
    }
    prevRunning = nowRunning
  })

  // Per-file skill suggestions, filtered to only paths in the PR
  // Shape: Map<path, { skillName, finding, reviewIdx, findingIdx }[]>
  const skillSuggestionsByPath = $derived.by(() => {
    const map = new Map<string, { skillName: string; findingPath: string; line: number | null; severity: 'high' | 'medium' | 'low'; body: string; key: string }[]>()
    for (const review of skillReviews) {
      if (review.state.status !== 'done' || !review.state.value) continue
      const result = review.state.value as SkillReviewResult
      for (const finding of result.findings) {
        if (!prPathSet.has(finding.path)) continue
        const arr = map.get(finding.path) ?? []
        arr.push({
          skillName: review.name,
          findingPath: finding.path,
          line: finding.line,
          severity: finding.severity,
          body: finding.body,
          key: `${review.skillId}:${finding.path}:${finding.line}:${finding.body.slice(0, 30)}`,
        })
        map.set(finding.path, arr)
      }
    }
    return map
  })

  // Summary per persona: { name, count }
  const skillPersonaSummaries = $derived.by(() => {
    const counts = new Map<string, number>()
    for (const review of skillReviews) {
      if (review.state.status !== 'done' || !review.state.value) continue
      const result = review.state.value as SkillReviewResult
      const validFindings = result.findings.filter((f: SkillReviewResult['findings'][number]) => prPathSet.has(f.path))
      if (validFindings.length > 0) {
        counts.set(review.name, (counts.get(review.name) ?? 0) + validFindings.length)
      }
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count }))
  })

  // Session-only dismissed finding keys
  let dismissedKeys = $state<Set<string>>(new Set())

  function dismissFinding(key: string) {
    dismissedKeys = new Set([...dismissedKeys, key])
  }

  // Add-as-draft confirmation: track which finding keys have been "added" (session-only)
  let addedDraftKeys = $state<Set<string>>(new Set())

  async function addFindingAsDraft(finding: { findingPath: string; line: number | null; body: string; key: string }) {
    if (!draftStore) return
    await draftStore.upsert({
      path: finding.findingPath,
      line: finding.line ?? 1,
      side: 'RIGHT',
      body: finding.body,
    })
    track('comment_drafted')
    addedDraftKeys = new Set([...addedDraftKeys, finding.key])
    // Reset the "Added" confirmation state after 2s
    setTimeout(() => {
      addedDraftKeys = new Set([...addedDraftKeys].filter(k => k !== finding.key))
    }, 2000)
  }

  // Show the run button when: skills exist + key present + runSkillReviewsFn provided
  const enabledSkillCount = $derived(listSkills().filter(s => s.enabled).length)
  const hasKey = $derived(!!getSettings().deepseekKey)
  const showRunButton = $derived(enabledSkillCount > 0 && hasKey && runSkillReviewsFn !== null)

  // Running state: true when any skill entry is in loading status
  const isRunning = $derived(skillReviews.some(e => e.state.status === 'loading'))
</script>

<div class="mode-toggle" role="group" aria-label="Diff mode">
  <button class:active={mode === 'unified'} aria-pressed={mode === 'unified'} onclick={() => onmode('unified')}>Unified</button>
  <button class:active={mode === 'split'} aria-pressed={mode === 'split'} onclick={() => onmode('split')}>Side-by-side</button>
  {#if showRunButton}
    <button
      class="run-reviewers-btn"
      class:running={isRunning}
      onclick={() => !isRunning && runSkillReviewsFn?.()}
      disabled={isRunning}
      aria-busy={isRunning}
    >
      {#if isRunning}
        <span class="run-spinner" aria-hidden="true"></span>Running…
      {:else}
        Run my reviewers ({enabledSkillCount})
      {/if}
    </button>
  {/if}
</div>

{#if skillReviews.length > 0}
  <div class="skill-run-status-bar" role="status" aria-label="Reviewer run status">
    {#each skillReviews as entry (entry.skillId)}
      <span class="skill-run-entry">
        <span class="skill-run-name">{entry.name}</span>
        {#if entry.state.status === 'loading'}
          <span class="skill-status-chip chip-running" aria-label="Running">
            <span class="chip-spinner" aria-hidden="true"></span>running
          </span>
        {:else if entry.state.status === 'done'}
          {@const findingCount = (entry.state.value as { findings?: unknown[] } | undefined)?.findings?.filter((f: unknown) => {
            const finding = f as { path?: string }
            return prPathSet.has(finding.path ?? '')
          }).length ?? 0}
          <span class="skill-status-chip chip-done" aria-label="Done, {findingCount} finding{findingCount !== 1 ? 's' : ''}">
            ✓ {findingCount} finding{findingCount !== 1 ? 's' : ''}
          </span>
        {:else if entry.state.status === 'error'}
          <span class="skill-status-chip chip-error" aria-label="Error, retry available">
            ↻ error
          </span>
        {:else}
          <span class="skill-status-chip chip-queued" aria-label="Queued">
            ⏳ queued
          </span>
        {/if}
      </span>
    {/each}
  </div>
{/if}

{#if skillPersonaSummaries.length > 0}
  <div class="skill-summaries">
    {#each skillPersonaSummaries as s (s.name)}
      <span class="skill-summary-line">{s.name}: {s.count} {s.count === 1 ? 'suggestion' : 'suggestions'}</span>
    {/each}
  </div>
{/if}
{#if files.length < changedFiles}
  <p role="alert">Showing {files.length} of {changedFiles} changed files — the list was truncated.</p>
{/if}
<svelte:document onkeydown={handleKeyDown} />

{#if files.length === 0}
  <p>This PR has no changed files.</p>
{:else}
  <div class="inspect-layout" data-wide={isWideViewport ? 'true' : 'false'}>
    <!-- Slim toggle tab fixed to the left edge -->
    <button
      bind:this={toggleTabEl}
      class="tree-toggle-tab"
      aria-expanded={treeOpen}
      aria-label={treeOpen ? 'Close file tree' : 'Open file tree'}
      onclick={toggleTree}
      title={treeOpen ? 'Close file tree (Escape)' : 'Open file tree'}
    >
      <span class="tree-toggle-icon" aria-hidden="true">{treeOpen ? '‹' : '☰'}</span>
      <span class="tree-toggle-label">Files</span>
    </button>

    <!-- Collapsible drawer -->
    <div class="file-tree-drawer" data-open={treeOpen ? 'true' : 'false'} aria-hidden={!treeOpen}>
      {#if treeOpen}
        <nav class="file-tree-nav" aria-label="File tree">
          <FileTree
            {files}
            {attention}
            {viewedStore}
            {activePath}
            onselect={handleTreeSelect}
          />
        </nav>
      {/if}
    </div>

    <!-- Narrow-viewport backdrop (overlays content when drawer open on <900px) -->
    {#if treeOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="tree-backdrop" onclick={closeTree} aria-hidden="true"></div>
    {/if}

    <!-- Diff column: gets margin-left only when drawer is open on NARROW viewport -->
    <!-- On wide viewport, drawer floats into left margin — diff keeps full width -->
    <div class="diff-column" class:drawer-open={treeOpen && !isWideViewport}>
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
          {#if skillSuggestionsByPath.has(file.filename)}
            {#each (skillSuggestionsByPath.get(file.filename) ?? []) as suggestion (suggestion.key)}
              {#if !dismissedKeys.has(suggestion.key)}
                <div class="skill-finding severity-{suggestion.severity}">
                  <div class="skill-finding-header">
                    <span class="skill-persona-label">{suggestion.skillName}</span>
                    <span class="skill-severity-chip severity-chip-{suggestion.severity}">{suggestion.severity}</span>
                  </div>
                  <p class="skill-finding-body">{suggestion.body}</p>
                  <div class="skill-finding-actions">
                    <button
                      class="skill-add-draft-btn"
                      class:added={addedDraftKeys.has(suggestion.key)}
                      onclick={() => addFindingAsDraft(suggestion)}
                      disabled={addedDraftKeys.has(suggestion.key)}
                      aria-label={addedDraftKeys.has(suggestion.key) ? 'Added to drafts' : 'Add as draft comment'}
                    >{addedDraftKeys.has(suggestion.key) ? '✓ Added' : 'Add as draft'}</button>
                    <button
                      class="skill-dismiss-btn"
                      onclick={() => dismissFinding(suggestion.key)}
                    >Dismiss</button>
                  </div>
                </div>
              {/if}
            {/each}
          {/if}
          <FileDiff
            {file}
            {mode}
            drafts={draftsForFile(file.filename)}
            comments={commentsForFile(file.filename)}
            {resolvedCommentIds}
            onAddDraft={(line, side, body) => handleAddDraft(file.filename, line, side, body)}
            onRemoveDraft={(line, side) => handleRemoveDraft(file.filename, line, side)}
            viewed={viewedStore?.isViewed(file.filename, file.patch) ?? false}
            changedSinceViewed={viewedStore?.changedSinceViewed(file.filename, file.patch) ?? false}
            onToggleViewed={() => viewedStore?.toggle(file.filename, file.patch)}
            contents={contentsMap?.get(file.filename)}
            {askFn}
            {askDisabledReason}
          />
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* Inspect layout: relative container for the drawer + toggle tab */
  .inspect-layout {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0;
  }

  /* ---- Wide viewport: drawer floats into left margin (absolute positioning) ---- */
  /* When viewport ≥ 1200px the centered 70rem content has free left margin space.  */
  /* The drawer is absolutely positioned to the left of the toggle tab, so the      */
  /* diff column keeps its full width and is never pushed.                           */
  @media (min-width: 1200px) {
    .file-tree-drawer[data-open="true"] {
      position: absolute;
      /* Place drawer to the left of the toggle tab (28px wide).                    */
      /* right: 100% positions the right edge of the drawer at the left edge of     */
      /* its containing block. We add a 4px gap.                                    */
      right: calc(100% - 28px + 4px);
      top: 0;
      z-index: 10;
      box-shadow: -2px 4px 16px rgba(0,0,0,0.18);
    }

    .file-tree-nav {
      /* On wide viewport the drawer doesn't need a left margin since it's absolute */
      margin-left: 0;
    }
  }

  /* ---- Toggle tab: slim vertical strip on the left edge ---- */
  .tree-toggle-tab {
    position: sticky;
    top: 0.5rem;
    flex-shrink: 0;
    width: 28px;
    height: calc(100vh - 5rem);
    max-height: calc(100vh - 5rem);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 0.75rem 0 0.5rem;
    gap: 0.4rem;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    cursor: pointer;
    color: inherit;
    font-size: 0.78rem;
    z-index: 10;
    transition: background 0.15s;
    align-self: flex-start;
  }

  .tree-toggle-tab:hover {
    background: var(--surface-hover, color-mix(in srgb, var(--surface-raised) 80%, var(--text) 10%));
  }

  .tree-toggle-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .tree-toggle-icon {
    font-size: 1rem;
    line-height: 1;
  }

  .tree-toggle-label {
    writing-mode: vertical-lr;
    text-orientation: mixed;
    transform: rotate(180deg);
    font-size: 0.7rem;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    user-select: none;
  }

  /* ---- Collapsible drawer ---- */
  .file-tree-drawer {
    /* When closed: zero width, no overflow */
    width: 0;
    overflow: hidden;
    flex-shrink: 0;
    transition: width 0.2s ease;
    position: sticky;
    top: 0.5rem;
    align-self: flex-start;
    max-height: calc(100vh - 5rem);
  }

  .file-tree-drawer[data-open="true"] {
    width: 260px;
  }

  .file-tree-nav {
    width: 260px;
    max-height: calc(100vh - 5rem);
    overflow-y: auto;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.5rem 0.25rem;
    scrollbar-width: thin;
    margin-left: 0.25rem;
  }

  /* ---- Diff column: takes remaining space; gains margin when drawer open ---- */
  .diff-column {
    min-width: 0;
    flex: 1;
    transition: none; /* margin change handled by flex; instant */
  }

  /* ---- Narrow viewport (<900px): drawer overlays (backdrop) instead of pushing ---- */
  @media (max-width: 900px) {
    .file-tree-drawer[data-open="true"] {
      position: fixed;
      top: 0;
      left: 32px; /* just past the toggle tab */
      height: 100vh;
      max-height: 100vh;
      z-index: 50;
      box-shadow: 2px 0 12px rgba(0,0,0,0.2);
    }

    .file-tree-nav {
      height: 100%;
      max-height: 100vh;
      border-radius: 0 6px 6px 0;
      margin-left: 0;
    }

    /* Backdrop covers the rest of the screen */
    .tree-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.35);
      z-index: 45;
      cursor: pointer;
    }
  }

  /* Hide backdrop on wide viewport */
  @media (min-width: 901px) {
    .tree-backdrop {
      display: none;
    }
  }

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

  .hotspot-badge.level-high { color: var(--legend-removed-color); background: var(--legend-removed-bg); }
  .hotspot-badge.level-medium { color: var(--legend-changed-color); background: var(--legend-changed-bg); }
  .hotspot-badge.level-low { color: var(--text-muted); background: var(--surface-raised); }

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
    background: var(--legend-changed-bg);
    color: var(--legend-changed-color);
    border-left: 3px solid var(--legend-changed-border);
  }

  /* ---- Run button ---- */
  .run-reviewers-btn {
    margin-left: auto;
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .run-reviewers-btn:hover:not(:disabled) {
    background: var(--surface-raised);
  }

  .run-reviewers-btn:disabled {
    cursor: default;
    opacity: 0.85;
  }

  .run-spinner {
    display: inline-block;
    width: 0.75em;
    height: 0.75em;
    border: 2px solid var(--text-muted);
    border-top-color: var(--text);
    border-radius: 50%;
    animation: run-spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes run-spin {
    to { transform: rotate(360deg); }
  }

  /* ---- Per-reviewer run status bar ---- */
  .skill-run-status-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    padding: 0.4rem 0;
    font-size: 0.8rem;
    align-items: center;
  }

  .skill-run-entry {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .skill-run-name {
    color: var(--text-muted);
    font-weight: 500;
  }

  .skill-status-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .chip-queued {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
  }

  .chip-running {
    background: var(--legend-changed-bg);
    border: 1px solid var(--legend-changed-border);
    color: var(--legend-changed-color);
  }

  .chip-done {
    background: var(--legend-added-bg);
    border: 1px solid var(--legend-added-border);
    color: var(--legend-added-color);
  }

  .chip-error {
    background: var(--legend-removed-bg);
    border: 1px solid var(--legend-removed-border);
    color: var(--legend-removed-color);
    cursor: pointer;
  }

  .chip-spinner {
    display: inline-block;
    width: 0.65em;
    height: 0.65em;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: run-spin 0.6s linear infinite;
  }

  /* ---- Skill persona summaries ---- */
  .skill-summaries {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.4rem 0;
    font-size: 0.82rem;
    opacity: 0.8;
  }

  .skill-summary-line {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
  }

  /* ---- Skill finding annotations (dashed accent border) ---- */
  .skill-finding {
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.4rem;
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
