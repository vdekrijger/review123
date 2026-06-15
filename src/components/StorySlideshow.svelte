<script lang="ts">
  /**
   * StorySlideshow (Plan H) — a guided NARRATIVE walkthrough of the PR diff.
   *
   * Renders ONE story step at a time: a caption + layer chip + step counter,
   * the step's diff (one FileDiff per file — reused verbatim, NOT reimplemented),
   * and the related test files inline beneath for sense-checking. The change-map
   * diagram sits above the slides as a progress map (current node highlighted;
   * clicking a node jumps to that step). Prev/Next + ←/→ keyboard nav.
   *
   * Per-slide comments/drafts/viewed work because the SAME stores are threaded
   * through (keyed by file) — a file in a slide behaves exactly as in Files mode.
   * Viewed state stays MANUAL (matching InspectStep — no auto-mark on view).
   *
   * Fallback: if the story has no usable steps, the parent shows Files mode; this
   * component assumes it only renders with ≥1 step.
   */
  import FileDiff from './FileDiff.svelte'
  import type { SkillFinding } from './FileDiff.svelte'
  import DiagramPanel from './DiagramPanel.svelte'
  import SymbolTestPairing from './SymbolTestPairing.svelte'
  import { pairStepTests } from '../lib/diff/symbolTests'
  import type { SymbolTestPairing as Pairing } from '../lib/diff/symbolTests'
  import type { PrFile } from '../lib/github/types'
  import type { DiffMode } from '../lib/settings/settings'
  import type { createDraftStore } from '../lib/drafts/drafts.svelte'
  import type { createViewedStore } from '../lib/viewed/viewed.svelte'
  import type { PrComment } from '../lib/github/comments'
  import type { ReplyOutcome } from '../lib/provider/types'
  import type { AskFocus } from '../lib/ai/run.svelte'
  import type { StoryStep, StoryOrderResult, GraphResult } from '../lib/ai/schemas'
  import { STORY_LAYERS, matchStoryPath, dedupeStorySteps, sinkGeneratedSteps, appendCatchAllStep } from '../lib/ai/schemas'
  import type { WhitespaceDisplay } from '../lib/diff/whitespace'
  import { slugify } from '../lib/slug'
  import { track } from '../lib/analytics/analytics'
  import { renderInlineMarkdown } from '../lib/markdown/render'
  import { scrollToFileCard } from '../lib/diff/jumpToFile'

  let {
    story,
    files,
    mode,
    draftStore,
    viewedStore = null,
    prComments = [],
    resolvedCommentIds = new Set(),
    contentsMap = null,
    lineSkillFindingsByPath = new Map(),
    whitespaceByPath = new Map(),
    onAddDraft,
    onRemoveDraft,
    onAddSkillFindingDraft,
    askFn = null,
    askDisabledReason = null,
    replyFn = null,
    diagrams = null,
  }: {
    story: StoryOrderResult
    files: PrFile[]
    mode: DiffMode
    draftStore: ReturnType<typeof createDraftStore> | null
    viewedStore?: ReturnType<typeof createViewedStore> | null
    prComments?: PrComment[]
    resolvedCommentIds?: Set<number>
    contentsMap?: Map<string, { before: string | null; after: string | null }> | null
    lineSkillFindingsByPath?: Map<string, SkillFinding[]>
    whitespaceByPath?: Map<string, WhitespaceDisplay>
    onAddDraft: (path: string, line: number, side: 'LEFT' | 'RIGHT', body: string) => void
    onRemoveDraft: (path: string, line: number, side: 'LEFT' | 'RIGHT') => void
    onAddSkillFindingDraft: (path: string, finding: { body: string; line: number; key: string }) => Promise<void>
    askFn?: ((q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>) | null
    askDisabledReason?: string | null
    replyFn?: ((root: PrComment, body: string) => Promise<ReplyOutcome>) | null
    /** Change-map source for the progress map; null/pending → no map (never blocks). */
    diagrams?: GraphResult | null
  } = $props()

  const fileByPath = $derived(new Map(files.map((f) => [f.filename, f])))

  // The PR's changed-file paths — lets the "Tested by" affordance tell whether a
  // paired test file is part of THIS PR's diff (jump-to) or pre-existing context.
  const prPathSet = $derived(new Set(files.map((f) => f.filename)))

  // Map each step's paths to the PR's REAL filenames via tolerant matching
  // (exact → unique suffix → unique basename), then drop unmappable files and
  // any step left empty — render ONLY what maps, never discard the whole story.
  // A final dedupe pass guarantees no file appears in two steps (anti-overlap),
  // even if the model echoed a path differently across steps. Re-index after.
  const steps = $derived.by<StoryStep[]>(() => {
    const prFilenames = files.map((f) => f.filename)
    const mapped: StoryStep[] = []
    for (const s of story.steps) {
      const stepFiles = s.files
        .map((p) => matchStoryPath(p, prFilenames))
        .filter((p): p is string => p !== null)
      if (stepFiles.length === 0) continue
      const relatedTests = s.relatedTests
        .map((p) => matchStoryPath(p, prFilenames))
        .filter((p): p is string => p !== null)
      mapped.push({ ...s, files: stepFiles, relatedTests, index: mapped.length })
    }
    // De-duplicate against the resolved PR filenames so the same file can't be
    // shown twice (keeps it in its first step; strips relatedTests that collide),
    // then sink generated-file steps to the end (lowest reading priority).
    const shaped = sinkGeneratedSteps(dedupeStorySteps({ steps: mapped })).steps
    // Plan K — structural 100% coverage: any changed PR file the model left
    // unplaced (or that only ever appeared as a relatedTest) is swept into a
    // final synthetic "Other changes (N)" step, so union(all steps' files) ==
    // all changed files. The catch-all renders like a normal step.
    return appendCatchAllStep(shaped, prFilenames)
  })

  let current = $state(0)

  // Clamp current when the step list shrinks (e.g. recompute).
  $effect(() => {
    if (current > steps.length - 1) current = Math.max(0, steps.length - 1)
  })

  const currentStep = $derived<StoryStep | undefined>(steps[current])
  const total = $derived(steps.length)

  // ── Coverage accounting (Plan K) ──────────────────────────────────────────
  // The set of UNIQUE changed file paths the walkthrough is responsible for.
  // A file is "covered" when it's shown as a PRIMARY `files` entry in some step
  // OR as a relatedTest snippet — both put it on screen exactly once. After
  // appendCatchAllStep, union(primary files ∪ relatedTests) == every changed
  // file, so this is the denominator for "N / M files seen". A file referenced
  // by multiple steps counts ONCE (Set membership). relatedTest-shown files are
  // INCLUDED here: they're real changed files the reader sees, so they count
  // toward M and are markable seen (#63208) — they no longer get duplicated into
  // the catch-all just to be counted.
  const uniqueChangedFiles = $derived.by<Set<string>>(() => {
    const set = new Set<string>()
    for (const s of steps) {
      for (const f of s.files) set.add(f)
      for (const t of s.relatedTests) set.add(t)
    }
    return set
  })
  const totalUniqueFiles = $derived(uniqueChangedFiles.size)

  // path → the set of step indices that SHOW it (as a primary `files` entry OR a
  // relatedTest snippet). A file that legitimately spans MULTIPLE slides is only
  // "fully seen" once ALL of those slides have been visited (so seeing one hunk
  // doesn't falsely mark the whole file done). A relatedTest-shown file is fully
  // seen when its step is visited, same as a primary. dedupeStorySteps guarantees
  // a file is never simultaneously a primary AND a relatedTest, so there's no
  // double-count; Set membership dedupes by path regardless. Post-#94 dedupe the
  // common case is one slide per file.
  const primarySlidesByFile = $derived.by<Map<string, Set<number>>>(() => {
    const map = new Map<string, Set<number>>()
    const add = (f: string, i: number) => {
      const slides = map.get(f) ?? new Set<number>()
      slides.add(i)
      map.set(f, slides)
    }
    steps.forEach((s, i) => {
      for (const f of s.files) add(f, i)
      for (const t of s.relatedTests) add(t, i)
    })
    return map
  })

  // Which step indices the user has actually visited (current step included on
  // mount). Drives both the shared viewed-store marking and the change-map
  // visited state. Plain Set in reactive state — reassign to notify.
  let visitedSteps = $state<Set<number>>(new Set([0]))

  // Record the current step as visited whenever it changes (one-way: visiting
  // only ever ADDS — we never un-visit, so revision-aware un-viewing in Files
  // mode stays the user's prerogative).
  $effect(() => {
    if (currentStep && !visitedSteps.has(current)) {
      const next = new Set(visitedSteps)
      next.add(current)
      visitedSteps = next
    }
  })

  // Mark a file VIEWED in the SHARED per-file viewed store once ALL of its
  // primary slides have been visited (multi-slide files: only when every hunk's
  // slide is seen). Marked AT MOST ONCE per file (tracked in autoMarked) so that
  // if the user later MANUALLY un-views it (in Files mode or via FileDiff), this
  // effect does NOT keep re-asserting it — the manual un-view + revision-aware
  // re-view semantics stay the user's prerogative. Shared both directions: a
  // file auto-marked here shows ✓ in Files mode and vice-versa.
  const autoMarked = new Set<string>()
  $effect(() => {
    if (!viewedStore) return
    for (const [path, slides] of primarySlidesByFile) {
      if (autoMarked.has(path)) continue
      const allSeen = [...slides].every((i) => visitedSteps.has(i))
      if (!allSeen) continue
      const file = fileByPath.get(path)
      if (!file) continue
      autoMarked.add(path)
      if (!viewedStore.isViewed(path, file.patch)) viewedStore.toggle(path, file.patch)
    }
  })

  // Files seen so far (shared viewed store is the truth) — the numerator for the
  // progress readout and the list backing the reconciliation panel.
  const seenFiles = $derived.by<Set<string>>(() => {
    const set = new Set<string>()
    if (!viewedStore) return set
    for (const path of uniqueChangedFiles) {
      const file = fileByPath.get(path)
      if (file && viewedStore.isViewed(path, file.patch)) set.add(path)
    }
    return set
  })
  const seenCount = $derived(seenFiles.size)
  const allSeen = $derived(totalUniqueFiles > 0 && seenCount === totalUniqueFiles)
  // Unseen unique changed files, in PR order, for the reconciliation panel.
  const unseenFiles = $derived(files.map((f) => f.filename).filter((p) => uniqueChangedFiles.has(p) && !seenFiles.has(p)))
  // Files whose every primary slide has been visited → "visited" on the map
  // (best-effort visual layer; never gates the accounting above).
  const visitedFiles = $derived.by<string[]>(() => {
    const out: string[] = []
    for (const [path, slides] of primarySlidesByFile) {
      if ([...slides].every((i) => visitedSteps.has(i))) out.push(path)
    }
    return out
  })

  // The slideshow step container — scroll it back to the TOP on every step
  // change so the user starts at the top of the new step (Plan K "also").
  let stepEl = $state<HTMLElement | null>(null)
  $effect(() => {
    // Reference `current` so this re-runs on every step change.
    void current
    // Guarded: jsdom (tests) doesn't implement scrollIntoView.
    stepEl?.scrollIntoView?.({ block: 'start' })
  })

  // Fire once when the whole story has been covered (counts only, no content).
  let coverageReported = false
  $effect(() => {
    if (allSeen && !coverageReported) {
      coverageReported = true
      track('story_coverage_complete', { files: totalUniqueFiles })
    }
  })

  // Jump to the step covering a still-unseen file, then scroll its card in view.
  // Checks relatedTests too — a file shown only as an inline test snippet still
  // counts toward coverage and must be jumpable from the reconciliation panel.
  function jumpToFile(path: string): void {
    const idx = steps.findIndex((s) => s.files.includes(path) || s.relatedTests.includes(path))
    if (idx !== -1) go(idx)
    scrollToFileCard(path)
  }

  // Symbol-level function↔test pairings for the current step (Plan I).
  // Deterministic, LLM-free: extract changed symbols from the step's code files,
  // match them against the available test-file contents (the step's relatedTests
  // plus any PR test files), and surface the specific test block beneath each
  // function's diff. Grouped by impl-file path so we can render it in place.
  const stepPairingsByFile = $derived.by<Map<string, Pairing[]>>(() => {
    if (!currentStep) return new Map()
    const stepFiles = currentStep.files
      .map((p) => fileByPath.get(p))
      .filter((f): f is PrFile => f !== undefined)
    // Candidate tests: this step's relatedTests + every test file in the PR
    // (a test may not be listed in relatedTests but still exercise the symbol).
    const candidatePaths = new Set<string>(currentStep.relatedTests)
    for (const f of files) candidatePaths.add(f.filename)
    const testFiles = [...candidatePaths]
      .map((p) => fileByPath.get(p))
      .filter((f): f is PrFile => f !== undefined)
    return pairStepTests({ stepFiles, testFiles, contentsMap })
  })

  // path → full (after) test content, for slicing the test block in the snippet.
  const testContentsByPath = $derived.by<Map<string, string>>(() => {
    const out = new Map<string, string>()
    if (!contentsMap) return out
    for (const [path, c] of contentsMap) {
      if (c.after) out.set(path, c.after)
    }
    return out
  })

  // Fire story_mode_entered once on mount (this component only mounts in story mode).
  $effect(() => {
    track('story_mode_entered')
  })

  // Fire story_step_viewed whenever the current index changes (index only).
  $effect(() => {
    if (currentStep) track('story_step_viewed', { index: current })
  })

  function go(to: number): void {
    current = Math.max(0, Math.min(total - 1, to))
  }
  function next(): void { go(current + 1) }
  function prev(): void { go(current - 1) }

  function handleKeydown(e: KeyboardEvent): void {
    // Ignore when typing in an input/textarea/contenteditable (comment widgets).
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'ArrowRight') { next(); e.preventDefault() }
    else if (e.key === 'ArrowLeft') { prev(); e.preventDefault() }
  }

  // Files covered by all steps BEFORE the current one → "done" on the map.
  const doneFiles = $derived.by(() => {
    const set: string[] = []
    for (let i = 0; i < current; i++) set.push(...steps[i].files)
    return set
  })

  // Jump to the first step that covers a clicked map node's file.
  function handleNodeClick(file: string): void {
    const idx = steps.findIndex((s) => s.files.includes(file))
    if (idx !== -1) go(idx)
  }

  // Jump to the step where a paired TEST file appears (as a step file or a
  // related test), then scroll its diff card into view. Used by the "Tested by"
  // affordance for tests that ARE in this PR's diff.
  function jumpToTestFile(file: string): void {
    const idx = steps.findIndex((s) => s.files.includes(file) || s.relatedTests.includes(file))
    if (idx !== -1) go(idx)
    scrollToFileCard(file)
  }

  const LAYER_LABEL: Record<(typeof STORY_LAYERS)[number], string> = {
    data: 'Data model',
    api: 'API / service',
    logic: 'Business logic',
    config: 'Config / validation',
    tests: 'Tests',
    ui: 'UI / frontend',
    foundational: 'Foundational',
    other: 'Other changes',
  }

  function draftsFor(path: string) {
    return draftStore?.drafts.filter((d) => d.path === path) ?? []
  }
  function commentsFor(path: string): PrComment[] {
    return prComments.filter((c) => c.path === path)
  }
</script>

<svelte:document onkeydown={handleKeydown} />

<div class="story" aria-label="Story walkthrough">
  {#if diagrams}
    <!-- Change-map as the progress map (above the slides). Never blocks: only
         shown once diagrams arrive; highlight wires in when present. -->
    <div class="story-map">
      <DiagramPanel
        result={diagrams}
        panelState="idle"
        highlightFiles={currentStep?.files ?? []}
        {doneFiles}
        {visitedFiles}
        onnodeclick={handleNodeClick}
      />
    </div>
  {/if}

  {#if currentStep}
    <div class="story-controls">
      <button class="story-nav" onclick={prev} disabled={current === 0} aria-label="Previous step">← Prev</button>
      <span class="story-counter" role="status" aria-live="polite">{current + 1} of {total}</span>
      <button class="story-nav" onclick={next} disabled={current === total - 1} aria-label="Next step">Next →</button>
    </div>

    {#if viewedStore && totalUniqueFiles > 0}
      <!-- Coverage parity with Files mode: "N / M files seen" (M = unique changed
           files; a file in multiple steps counts once). Shared viewed store. -->
      <div class="story-coverage" role="status" aria-live="polite">
        <span class="story-coverage-bar" aria-hidden="true">
          <span class="story-coverage-fill" style="width: {Math.round((seenCount / totalUniqueFiles) * 100)}%"></span>
        </span>
        <span class="story-coverage-label" class:complete={allSeen}>
          {#if allSeen}✓ {/if}{seenCount} / {totalUniqueFiles} files seen
        </span>
      </div>
    {/if}

    <div class="story-step" data-step-index={current} bind:this={stepEl}>
      <div class="story-caption-row">
        <span class="story-layer-chip layer-{currentStep.layer}">{LAYER_LABEL[currentStep.layer]}</span>
<!-- Inline markdown so `code spans`, **bold**, _emphasis_ render (no block
             wrapping). renderInlineMarkdown sanitizes — safe for {@html}. -->
        <p class="story-caption">{@html renderInlineMarkdown(currentStep.caption)}</p>
      </div>

      {#each currentStep.files as path (path)}
        {@const file = fileByPath.get(path)}
        {#if file}
          <div id="file-{slugify(path)}" class="story-file">
            <FileDiff
              {file}
              {mode}
              sticky={false}
              drafts={draftsFor(path)}
              comments={commentsFor(path)}
              {resolvedCommentIds}
              onAddDraft={(line, side, body) => onAddDraft(path, line, side, body)}
              onRemoveDraft={(line, side) => onRemoveDraft(path, line, side)}
              viewed={viewedStore?.isViewed(path, file.patch) ?? false}
              changedSinceViewed={viewedStore?.changedSinceViewed(path, file.patch) ?? false}
              onToggleViewed={() => viewedStore?.toggle(path, file.patch)}
              contents={contentsMap?.get(path)}
              {askFn}
              {askDisabledReason}
              onReply={replyFn}
              skillFindings={lineSkillFindingsByPath.get(path) ?? []}
              onAddSkillFindingDraft={(finding) => onAddSkillFindingDraft(path, finding)}
              whitespace={whitespaceByPath.get(path) ?? null}
            />
            {#if stepPairingsByFile.get(path)}
              <div class="story-pairings">
                {#each stepPairingsByFile.get(path) ?? [] as pairing (pairing.symbol)}
                  <SymbolTestPairing {pairing} testContents={testContentsByPath} {prPathSet} onJumpToFile={jumpToTestFile} />
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      {/each}

      {#if currentStep.relatedTests.length > 0}
        <div class="story-tests">
          <h4 class="story-tests-title">Related tests — sense-check the change</h4>
          {#each currentStep.relatedTests as path (path)}
            {@const file = fileByPath.get(path)}
            {#if file}
              <div id="file-{slugify(path)}" class="story-related-test">
                <span class="related-test-tag">Related test</span>
                <FileDiff
                  {file}
                  {mode}
              sticky={false}
                  drafts={draftsFor(path)}
                  comments={commentsFor(path)}
                  {resolvedCommentIds}
                  onAddDraft={(line, side, body) => onAddDraft(path, line, side, body)}
                  onRemoveDraft={(line, side) => onRemoveDraft(path, line, side)}
                  viewed={viewedStore?.isViewed(path, file.patch) ?? false}
                  changedSinceViewed={viewedStore?.changedSinceViewed(path, file.patch) ?? false}
                  onToggleViewed={() => viewedStore?.toggle(path, file.patch)}
                  contents={contentsMap?.get(path)}
                  {askFn}
                  {askDisabledReason}
                  onReply={replyFn}
                  whitespace={whitespaceByPath.get(path) ?? null}
                />
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if current === total - 1 && viewedStore && totalUniqueFiles > 0}
        <!-- End-of-story reconciliation (Plan K): the explicit "you saw
             everything" moment. All seen → confirmation; otherwise list the
             unseen files with a Jump affordance back to their step + card. -->
        <div class="story-reconcile" class:complete={allSeen} role="status" aria-live="polite">
          {#if allSeen}
            <p class="story-reconcile-done">✓ You've walked all {totalUniqueFiles} changed {totalUniqueFiles === 1 ? 'file' : 'files'}.</p>
          {:else}
            <p class="story-reconcile-title">You haven't viewed {unseenFiles.length} {unseenFiles.length === 1 ? 'file' : 'files'} yet:</p>
            <ul class="story-reconcile-list">
              {#each unseenFiles as path (path)}
                <li class="story-reconcile-item">
                  <code class="story-reconcile-path">{path}</code>
                  <button class="story-jump-btn" onclick={() => jumpToFile(path)} aria-label={`Jump to ${path}`}>Jump →</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>

    <div class="story-controls story-controls-bottom">
      <button class="story-nav" onclick={prev} disabled={current === 0} aria-label="Previous step">← Prev</button>
      <span class="story-counter">{current + 1} of {total}</span>
      <button class="story-nav" onclick={next} disabled={current === total - 1} aria-label="Next step">Next →</button>
    </div>
  {/if}
</div>

<style>
  .story {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .story-map {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    background: var(--surface-raised);
  }

  /* Coverage parity readout — "N / M files seen" + a thin progress bar. */
  .story-coverage {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    justify-content: center;
  }
  .story-coverage-bar {
    flex: 0 1 14rem;
    height: 5px;
    border-radius: 999px;
    background: var(--surface-raised);
    border: 1px solid var(--hairline);
    overflow: hidden;
  }
  .story-coverage-fill {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
  .story-coverage-label {
    font-size: 0.78rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .story-coverage-label.complete {
    color: var(--legend-added-color);
    font-weight: 600;
  }

  /* End-of-story reconciliation panel. */
  .story-reconcile {
    border-top: 1px solid var(--hairline);
    padding-top: 0.75rem;
    margin-top: 0.25rem;
  }
  .story-reconcile.complete {
    border-top-color: var(--legend-added-border);
  }
  .story-reconcile-done {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--legend-added-color);
  }
  .story-reconcile-title {
    margin: 0 0 0.5rem;
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--legend-changed-color);
  }
  .story-reconcile-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .story-reconcile-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    justify-content: space-between;
  }
  .story-reconcile-path {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.8rem;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .story-jump-btn {
    flex-shrink: 0;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .story-jump-btn:hover { background: var(--surface-raised); }
  .story-jump-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .story-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
    justify-content: center;
  }
  .story-controls-bottom {
    border-top: 1px solid var(--hairline);
    padding-top: 0.75rem;
  }

  .story-nav {
    padding: 0.35rem 0.9rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .story-nav:hover:not(:disabled) { background: var(--surface-raised); }
  .story-nav:disabled { opacity: 0.4; cursor: default; }

  .story-counter {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    min-width: 4.5rem;
    text-align: center;
  }

  .story-step {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .story-caption-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .story-caption {
    margin: 0;
    font-size: 1.02rem;
    line-height: 1.5;
  }

  /* Inline markdown in the model-generated caption: code spans use the same
     inline-code tokens as comment bodies / skill findings (readable in both
     themes). */
  .story-caption :global(code) {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.85em;
    background: var(--surface-raised);
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }

  .story-layer-chip {
    flex-shrink: 0;
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.18rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    color: var(--text-muted);
  }
  .layer-data { color: var(--legend-added-color); border-color: var(--legend-added-border); background: var(--legend-added-bg); }
  .layer-ui { color: var(--legend-changed-color); border-color: var(--legend-changed-border); background: var(--legend-changed-bg); }

  .story-tests {
    border-top: 1px dashed var(--hairline);
    padding-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .story-tests-title {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .story-pairings {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.2rem;
  }

  .story-related-test {
    position: relative;
  }

  .related-test-tag {
    display: inline-block;
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--legend-changed-color);
    background: var(--legend-changed-bg);
    border: 1px solid var(--legend-changed-border);
    border-radius: 3px;
    padding: 0.1rem 0.4rem;
    margin-bottom: 0.25rem;
  }
</style>
