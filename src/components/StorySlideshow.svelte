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
  import { STORY_LAYERS, matchStoryPath, dedupeStorySteps } from '../lib/ai/schemas'
  import type { WhitespaceDisplay } from '../lib/diff/whitespace'
  import { slugify } from '../lib/slug'
  import { track } from '../lib/analytics/analytics'

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
    // shown twice (keeps it in its first step; strips relatedTests that collide).
    return dedupeStorySteps({ steps: mapped }).steps
  })

  let current = $state(0)

  // Clamp current when the step list shrinks (e.g. recompute).
  $effect(() => {
    if (current > steps.length - 1) current = Math.max(0, steps.length - 1)
  })

  const currentStep = $derived<StoryStep | undefined>(steps[current])
  const total = $derived(steps.length)

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

  const LAYER_LABEL: Record<(typeof STORY_LAYERS)[number], string> = {
    data: 'Data model',
    api: 'API / service',
    logic: 'Business logic',
    config: 'Config / validation',
    tests: 'Tests',
    ui: 'UI / frontend',
    foundational: 'Foundational',
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

    <div class="story-step" data-step-index={current}>
      <div class="story-caption-row">
        <span class="story-layer-chip layer-{currentStep.layer}">{LAYER_LABEL[currentStep.layer]}</span>
        <p class="story-caption">{currentStep.caption}</p>
      </div>

      {#each currentStep.files as path (path)}
        {@const file = fileByPath.get(path)}
        {#if file}
          <div id="file-{slugify(path)}" class="story-file">
            <FileDiff
              {file}
              {mode}
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
                  <SymbolTestPairing {pairing} testContents={testContentsByPath} />
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
