<script lang="ts">
  import FileDiff from './FileDiff.svelte'
  import type { SkillFinding } from './FileDiff.svelte'
  import FileTree from './FileTree.svelte'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import { getSettings, setTreeOpen } from '../lib/settings/settings'
  import type { DiffWidth } from '../lib/settings/settings'
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

  // Diff width: 'centered' (default) | 'full'
  const diffWidth = $derived<DiffWidth>(getSettings().diffWidth)

  // ---- Viewport thresholds ----
  // The margin-vs-inline drawer decision is pure CSS (see the drawer CSS block
  // below — media query + .diff-full). No JS viewport tracking is needed for it.
  // NARROW_THRESHOLD (<900px): after picking a file on a small screen we close
  // the drawer so the diff gets its width back (checked at call time, no listener).
  const NARROW_THRESHOLD = 900

  function toggleTree(): void {
    treeOpen = !treeOpen
    setTreeOpen(treeOpen)
    if (treeOpen) {
      track('drawer_opened')
    }
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
    if (window.innerWidth < NARROW_THRESHOLD) closeTree()
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
  // Split into two maps: file-level (null line) stays above the file in InspectStep;
  // line-bearing findings are passed into FileDiff via skillFindings prop.
  // Shape: Map<path, entry[]>
  type SuggestionEntry = { skillName: string; findingPath: string; line: number | null; severity: 'high' | 'medium' | 'low'; body: string; key: string }

  const skillSuggestionsByPath = $derived.by(() => {
    const map = new Map<string, SuggestionEntry[]>()
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

  // File-level (null-line) suggestions — rendered above the FileDiff
  const fileLevelSuggestionsByPath = $derived.by(() => {
    const map = new Map<string, SuggestionEntry[]>()
    for (const [path, suggestions] of skillSuggestionsByPath) {
      const fileLevelOnly = suggestions.filter(s => s.line === null)
      if (fileLevelOnly.length > 0) map.set(path, fileLevelOnly)
    }
    return map
  })

  // Line-bearing suggestions — passed to FileDiff as skillFindings prop
  const lineSkillFindingsByPath = $derived.by(() => {
    const map = new Map<string, SkillFinding[]>()
    for (const [path, suggestions] of skillSuggestionsByPath) {
      const lineOnly = suggestions
        .filter(s => s.line !== null && !dismissedKeys.has(s.key))
        .map(s => ({
          skillName: s.skillName,
          line: s.line as number,
          severity: s.severity,
          body: s.body,
          key: s.key,
        }))
      if (lineOnly.length > 0) map.set(path, lineOnly)
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
  <button class="btn" class:btn-active={mode === 'unified'} aria-pressed={mode === 'unified'} onclick={() => onmode('unified')}>Unified</button>
  <button class="btn" class:btn-active={mode === 'split'} aria-pressed={mode === 'split'} onclick={() => onmode('split')}>Side-by-side</button>
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
  <div class="inspect-layout" class:diff-full={diffWidth === 'full'} data-diffwidth={diffWidth}>
    <!-- Collapsible drawer. Two CSS regimes (see drawer CSS block below):
         MARGIN mode (centered + wide viewport): zero-width flex placeholder, nav extends LEFTWARD into the margin.
         INLINE mode (full-width OR narrower viewport): in-flow 340px flex child right of the tab; diff shrinks while open.
         DOM order: drawer first → tab second → diff column (margin mode anchors nav's right edge to the tab's LEFT edge;
         inline mode reorders the tab visually via flex `order`). -->
    <div class="file-tree-drawer" data-open={treeOpen ? 'true' : 'false'} aria-hidden={!treeOpen}>
      {#if treeOpen}
        <nav class="file-tree-nav" aria-label="File tree">
          <div class="tree-drawer-header">
            <span class="tree-drawer-title">Files</span>
            <button
              class="tree-drawer-close"
              onclick={closeTree}
              aria-label="Close file tree"
              title="Close file tree (Escape)"
            >✕</button>
          </div>
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

    <!-- Slim toggle tab: at the content column's left edge (immediately right of drawer) -->
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

    <!-- No backdrop in any regime: the drawer never overlays the diff. In inline
         mode it pushes the diff over (flex), in margin mode it dwells in the margin. -->
    <div class="diff-column">
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
          {#if fileLevelSuggestionsByPath.has(file.filename)}
            {#each (fileLevelSuggestionsByPath.get(file.filename) ?? []) as suggestion (suggestion.key)}
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
            skillFindings={lineSkillFindingsByPath.get(file.filename) ?? []}
            onAddSkillFindingDraft={(finding) => addFindingAsDraft({ findingPath: file.filename, line: finding.line, body: finding.body, key: finding.key })}
          />
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /*
   * ==========================================================================
   * DRAWER CSS — TWO ADAPTIVE REGIMES (pure CSS, no JS viewport tracking)
   *
   * MARGIN mode — centered diff AND viewport ≥ 1750px (the left margin beside
   *   the 70rem column can fit the whole 340px tree): the drawer wrapper is a
   *   zero-width flex placeholder and the nav extends LEFTWARD into the margin.
   *   The diff column never moves. Exactly the historical wide behaviour.
   *
   * INLINE mode — everything else (full-width mode at ANY viewport, or a
   *   viewport too narrow for the margin): the drawer becomes an in-flow
   *   340px flex child to the RIGHT of its toggle tab, pushing the diff over.
   *   The diff shrinks while the tree is open — no overlay, no backdrop, the
   *   tree is always fully readable.
   *
   * Threshold derivation (1750px): the centered column is 70rem = 1050px at the
   * 15px root font plus 2 × 1rem .review padding → 1080px outer. The tree needs
   * 340px left of the column's content edge: (1750 − 1080) / 2 + 15 ≈ 350px. ✓
   * ==========================================================================
   */

  /* Inspect layout: relative+overflow-visible container for the drawer */
  .inspect-layout {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0;
    overflow: visible;
    /* Tree width: 340px, but never wider than the viewport minus tab + gutters */
    --tree-w: min(340px, calc(100vw - 80px));
  }

  /* Diff width: full mode overrides the content max-width via CSS custom property */
  .inspect-layout.diff-full {
    --content-max: none;
    max-width: none;
  }

  /* ---- Toggle tab: slim vertical strip at the content column's left edge ---- */
  /* INLINE mode (default): tab is visually FIRST (order -1) so the drawer opens
     to the RIGHT of its toggle. Margin mode restores DOM order (drawer | tab). */
  .tree-toggle-tab {
    order: -1;
    position: sticky;
    top: 0.5rem; /* same top as the drawer in both regimes */
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
    z-index: 21; /* above the drawer's z-index so tab stays clickable */
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

  /* ---- Collapsible drawer — sticky wrapper + nav panel anchored to its right edge ----
   *
   * The wrapper (.file-tree-drawer) is a sticky flex child. The nav panel
   * (.file-tree-nav) is absolutely positioned inside it, anchored to the
   * wrapper's RIGHT edge (right: 0).
   *
   * INLINE mode (default): the open wrapper is var(--tree-w) wide, so the nav
   *   exactly fills it IN FLOW — real flex space, the diff column shrinks.
   * MARGIN mode (media override below): the open wrapper stays 0 wide, so the
   *   nav extends 340px LEFTWARD into the page margin — out of flow, the diff
   *   column never moves.
   *
   * position: sticky on the wrapper gives scroll-following in both regimes.
   */
  .file-tree-drawer {
    position: sticky; /* sticky anchor follows scroll */
    top: 0.5rem;
    width: 0;
    flex-shrink: 0;
    align-self: flex-start;
    z-index: 20;
    max-height: calc(100vh - 5rem);
    overflow: visible; /* allow the absolutely-positioned nav to extend leftward */
  }

  /* INLINE mode (default): the open drawer takes real flex space → diff shrinks */
  .file-tree-drawer[data-open='true'] {
    width: var(--tree-w);
    margin: 0 0.75rem 0 0.5rem; /* breathing room: tab ←0.5rem→ tree ←0.75rem→ diff */
  }

  .file-tree-nav {
    /* Anchored to the wrapper's right edge; fills the wrapper in inline mode,
       extends leftward past it (width 0) in margin mode */
    position: absolute;
    right: 0;
    top: 0;
    width: var(--tree-w);
    box-sizing: border-box; /* total width = var(--tree-w) including border + padding */
    max-height: calc(100vh - 5rem);
    overflow-y: auto;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.5rem 0.25rem;
    scrollbar-width: thin;
    box-shadow: -2px 4px 20px rgba(0, 0, 0, 0.22);
  }

  /* ---- MARGIN mode: centered diff + viewport wide enough for the 340px tree ---- */
  @media (min-width: 1750px) {
    .inspect-layout:not(.diff-full) .file-tree-drawer[data-open='true'] {
      width: 0;   /* zero-width placeholder again — nav extends into the margin */
      margin: 0;
    }
    .inspect-layout:not(.diff-full) .tree-toggle-tab {
      order: 0;   /* restore DOM order: drawer (leftward nav) | tab | diff */
    }
  }

  /* Drawer header: "Files" label + ✕ close button */
  .tree-drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.3rem 0.5rem 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
    margin-bottom: 0.25rem;
  }

  .tree-drawer-title {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    user-select: none;
  }

  .tree-drawer-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.8rem;
    line-height: 1;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tree-drawer-close:hover {
    color: var(--text);
    background: var(--surface-hover, color-mix(in srgb, var(--surface-raised) 80%, var(--text) 10%));
  }

  .tree-drawer-close:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* ---- Diff column: takes the remaining flex space ---- */
  /* In inline mode the open drawer consumes flex space and the diff shrinks
     naturally; in margin mode the drawer is out of flow and the diff is untouched. */
  .diff-column {
    min-width: 0;
    flex: 1;
  }

  /* Mode toggle: active state via accent underline, consistent with stepper */
  .mode-toggle .btn-active {
    border-bottom: 2px solid var(--accent);
    font-weight: 700;
    color: var(--accent);
  }
  .mode-toggle .btn {
    border-radius: 4px 4px 0 0; /* flat bottom, pairs with underline indicator */
  }
  .run-reviewers-btn { margin-left: auto; }

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
