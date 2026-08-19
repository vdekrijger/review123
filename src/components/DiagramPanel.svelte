<script lang="ts">
  /**
   * DiagramPanel — renders before/after Mermaid flow/module diagrams.
   *
   * Props:
   *   result     - GraphResult from AI Task 6 (null → use panelState to decide display).
   *   panelState - Panel loading/error state ('idle'|'loading'|'error'|'declined').
   *
   * The plan spec calls this prop "state" but Svelte 5 reserves $state as a
   * rune keyword, causing a store_invalid_shape error. We use panelState as
   * the prop name; callers pass { panelState: ... }.
   *
   * EC-14a: empty graphs show "No structural changes detected".
   * EC-14j: mermaid initialized with securityLevel:'strict', startOnLoad:false.
   * EC-14k: click on diagram opens full-screen <dialog> overlay; Esc or
   *         backdrop click closes it.
   * REQ-14: track('diagram_viewed') once on first successful render.
   *
   * D1 change-map: when result.changeMap is present, renders the change-map
   * FIRST (full width) with a compact legend row and a "Before / After" toggle.
   * v3 cached results without changeMap fall back to the before/after layout.
   */
  import { track } from '../lib/analytics/analytics'
  import { graphToMermaid, impactToMermaid, impactIsRenderable } from '../lib/diagram/mermaid'
  import { getMermaid } from '../lib/diagram/mermaidInit'
  import type { GraphResult } from '../lib/diagram/types'
  import { resolvedTheme } from '../lib/settings/appearance.svelte'
  import AiProgress from './AiProgress.svelte'

  interface Props {
    result: GraphResult | null
    panelState: 'idle' | 'loading' | 'error' | 'declined'
    /**
     * The diagrams task's canned human error sentence (PanelState.error) —
     * shown in the 'error' state instead of the generic
     * "Diagram generation failed." fallback. Optional for compatibility.
     */
    error?: string
    /**
     * The concrete upstream failure detail (PanelState.errorDetail) — rendered
     * as a muted secondary line and hover title in the 'error' state.
     */
    errorDetail?: string
    /**
     * Story mode (Plan H): file paths covered by the CURRENT story step. The
     * change-map nodes whose label matches one of these files are highlighted
     * as "current"; nodes for files in an EARLIER step (doneFiles) are marked
     * "done"; the rest are "upcoming". Empty/absent → no highlighting (default
     * standalone diagram behaviour, byte-identical).
     */
    highlightFiles?: string[]
    /** File paths already visited (steps before the current one) → "done" state. */
    doneFiles?: string[]
    /**
     * File paths the user has actually walked (every primary slide showing them
     * visited) → "visited" check state on the map (Plan K coverage map). Purely
     * visual/best-effort: a node that can't map to a file just isn't checked,
     * and this never feeds the file-set accounting in StorySlideshow.
     */
    visitedFiles?: string[]
    /**
     * Story mode: called with a file path when the user clicks a change-map
     * node, so the slideshow can jump to the step covering that file. null/absent
     * → nodes are not click-to-jump (the existing zoom overlay still works).
     */
    onnodeclick?: ((file: string) => void) | null
  }

  let { result, panelState, error, errorDetail, highlightFiles = [], doneFiles = [], visitedFiles = [], onnodeclick = null }: Props = $props()

  // Containers for Mermaid SVG output
  let impactContainer = $state<HTMLDivElement | null>(null)
  let changeMapContainer = $state<HTMLDivElement | null>(null)
  let beforeContainer = $state<HTMLDivElement | null>(null)
  let afterContainer = $state<HTMLDivElement | null>(null)

  // Overlay state
  let overlayOpen = $state(false)
  let overlayContent = $state('')
  let overlayDialogEl = $state<HTMLDialogElement | null>(null)

  $effect(() => {
    if (!overlayDialogEl) return
    if (!overlayDialogEl.open) {
      overlayDialogEl.showModal()
    }
  })

  // Before/After toggle (visible only when changeMap is present)
  let showBeforeAfter = $state(false)

  // Track whether we have fired the analytics event
  let hasTracked = false

  async function renderDiagram(
    container: HTMLDivElement,
    mermaidText: string,
    idSuffix: string
  ): Promise<string | null> {
    if (!mermaidText) return null
    try {
      const m = await getMermaid()
      const { svg } = await m.render(`diagram-${idSuffix}`, mermaidText)
      container.innerHTML = svg
      return svg
    } catch {
      container.textContent = 'Diagram could not be rendered.'
      return null
    }
  }

  // ---- Story-mode node↔file matching (Plan H) ----------------------------
  // A change-map node's visible label is typically a file basename (e.g.
  // "settings.ts"). We match a node to a PR file path when the node's label
  // equals the path's basename (or the path ends with the label). Returns the
  // matched file path, or null when the node isn't one of the given files.
  function matchNodeToFile(label: string, files: string[]): string | null {
    const trimmed = label.trim()
    if (!trimmed) return null
    for (const f of files) {
      const base = f.split('/').pop() ?? f
      if (base === trimmed || f === trimmed || f.endsWith('/' + trimmed)) return f
    }
    return null
  }

  /**
   * After the change-map SVG renders, tag each node with a story-state class
   * (current / done) and wire click-to-jump. Re-runs when the highlight inputs
   * change. No-ops entirely when story mode isn't driving the panel
   * (no highlightFiles, no doneFiles, no onnodeclick) — keeps the standalone
   * diagram byte-identical.
   */
  function decorateStoryNodes(container: HTMLElement): void {
    if (highlightFiles.length === 0 && doneFiles.length === 0 && visitedFiles.length === 0 && !onnodeclick) return
    // Mermaid node groups carry the `.node` class. Match only those (NOT nested
    // label spans) so each rendered node is decorated exactly once.
    const nodes = container.querySelectorAll('g.node, .node')
    for (const node of nodes) {
      const label = node.textContent ?? ''
      const currentFile = matchNodeToFile(label, highlightFiles)
      const doneFile = currentFile ? null : matchNodeToFile(label, doneFiles)
      // Visited (Plan K): best-effort check on nodes whose file has been walked.
      const visitedFile = matchNodeToFile(label, visitedFiles)
      node.classList.toggle('story-node-current', currentFile !== null)
      node.classList.toggle('story-node-done', doneFile !== null)
      node.classList.toggle('story-node-visited', visitedFile !== null)
      const file = currentFile ?? doneFile ?? matchNodeToFile(label, [...highlightFiles, ...doneFiles])
      if (onnodeclick) {
        const target = file ?? matchNodeToFile(label, allMapFiles())
        ;(node as HTMLElement).style.cursor = target ? 'pointer' : ''
        node.classList.toggle('story-node-clickable', target !== null)
        // Avoid duplicate listeners by stamping a dataset flag
        if (target && !(node as HTMLElement).dataset['storyWired']) {
          ;(node as HTMLElement).dataset['storyWired'] = '1'
          node.addEventListener('click', (e) => {
            e.stopPropagation()
            onnodeclick?.(target)
          })
        }
      }
    }
  }

  // All file labels present in the change-map (for click-to-jump matching).
  function allMapFiles(): string[] {
    if (!result?.changeMap) return []
    return result.changeMap.nodes.map((n) => n.label)
  }

  // ---- Impact-mode (change-impact / blast radius): does the result carry it? --
  // An impact with at least one changed symbol is the primary view. An impact
  // present but EMPTY (or absent — old cached/retired-flow results) is the
  // AUTO-SUPPRESS signal: render an honest muted note, never a forced diagram.
  const hasImpact = $derived(impactIsRenderable(result?.impact))
  const impactSuppressed = $derived(!!result?.impact && !impactIsRenderable(result.impact))

  // ---- Impact node ↔ file matching for click-jump + coverage -----------------
  // Impact nodes are labeled "symbol — file-basename" (see impactLabel), so we
  // resolve a rendered node to its file by matching the node's file basename
  // against the changed/caller/callee entries. Entries without a file simply
  // don't check off / aren't clickable (graceful).
  function impactFileForLabel(label: string): string | null {
    const trimmed = label.trim()
    if (!trimmed || !result?.impact) return null
    const all = [...result.impact.changed, ...result.impact.callers, ...result.impact.callees]
    for (const entry of all) {
      if (!entry.file) continue
      const base = entry.file.split('/').pop() ?? entry.file
      if (trimmed.includes(base) || trimmed.includes(entry.symbol)) return entry.file
    }
    return null
  }

  /**
   * Decorate impact nodes after render: wire click-to-jump (by the entry's file)
   * and tag visited/current nodes. No-ops when no onnodeclick and no
   * visited/highlight inputs. Each node is decorated once (dataset stamp),
   * mirroring decorateStoryNodes.
   */
  function decorateImpactNodes(container: HTMLElement): void {
    if (!onnodeclick && visitedFiles.length === 0 && highlightFiles.length === 0) return
    const nodes = container.querySelectorAll('g.node, .node')
    for (const node of nodes) {
      const label = node.textContent ?? ''
      const file = impactFileForLabel(label)
      if (file && visitedFiles.includes(file)) node.classList.add('story-node-visited')
      if (file && highlightFiles.includes(file)) node.classList.add('story-node-current')
      if (onnodeclick && file) {
        ;(node as HTMLElement).style.cursor = 'pointer'
        node.classList.add('story-node-clickable')
        if (!(node as HTMLElement).dataset['impactWired']) {
          ;(node as HTMLElement).dataset['impactWired'] = '1'
          node.addEventListener('click', (e) => {
            e.stopPropagation()
            onnodeclick?.(file)
          })
        }
      }
    }
  }

  // Render the change-impact diagram — primary view when present + renderable.
  $effect(() => {
    if (!hasImpact || !result?.impact || !impactContainer) return

    const impactMermaid = impactToMermaid(result.impact, { palette: resolvedTheme() }).mermaid
    // Re-run when highlight/visited inputs change (re-decorate).
    void highlightFiles
    void visitedFiles

    let cancelled = false

    async function renderImpact() {
      const ic = impactContainer
      if (!ic) return
      const svg = await renderDiagram(ic, impactMermaid, 'impact')
      if (cancelled) return
      decorateImpactNodes(ic)
      if (svg && !hasTracked) {
        hasTracked = true
        track('diagram_viewed')
      }
    }

    renderImpact()

    return () => {
      cancelled = true
    }
  })

  // Render the change-map diagram when container and result.changeMap are ready
  $effect(() => {
    if (!result?.changeMap || !changeMapContainer) return

    const { changeMap, kind } = result
    const changeMapMermaid = graphToMermaid(changeMap, kind, { palette: resolvedTheme() }).mermaid
    // Reference the highlight inputs so this effect re-runs when the current
    // story step changes (re-renders + re-decorates the nodes).
    void highlightFiles
    void doneFiles
    void visitedFiles

    let cancelled = false

    async function renderChangeMap() {
      const cmc = changeMapContainer
      if (!cmc) return

      const svg = await renderDiagram(cmc, changeMapMermaid, 'changemap')

      if (cancelled) return

      decorateStoryNodes(cmc)

      if (svg && !hasTracked) {
        hasTracked = true
        track('diagram_viewed')
      }
    }

    renderChangeMap()

    return () => {
      cancelled = true
    }
  })

  // Render before/after diagrams when result and containers are ready
  $effect(() => {
    if (!result || !beforeContainer || !afterContainer) return

    const { before, after, kind } = result
    const beforeMermaid = graphToMermaid(before, kind).mermaid
    const afterMermaid = graphToMermaid(after, kind).mermaid

    let cancelled = false
    let beforeSvg: string | null = null
    let afterSvg: string | null = null

    async function renderAll() {
      const bc = beforeContainer
      const ac = afterContainer
      if (!bc || !ac) return

      if (beforeMermaid) {
        beforeSvg = await renderDiagram(bc, beforeMermaid, 'before')
      }
      if (afterMermaid) {
        afterSvg = await renderDiagram(ac, afterMermaid, 'after')
      }

      if (cancelled) return

      // EC-14 track: fire once on first successful render (if change-map didn't already)
      if ((beforeSvg || afterSvg) && !hasTracked) {
        hasTracked = true
        track('diagram_viewed')
      }
    }

    renderAll()

    return () => {
      cancelled = true
    }
  })

  function openOverlay(which: 'impact' | 'changemap' | 'before' | 'after') {
    if (!result) return
    let container: HTMLDivElement | null
    if (which === 'impact') {
      container = impactContainer
    } else if (which === 'changemap') {
      container = changeMapContainer
    } else if (which === 'before') {
      container = beforeContainer
    } else {
      container = afterContainer
    }
    overlayContent = container?.innerHTML ?? ''
    overlayOpen = true
  }

  function closeOverlay() {
    overlayOpen = false
  }

  function onBackdropClick(e: MouseEvent) {
    // Close if user clicked the <dialog> backdrop (i.e. the dialog element itself,
    // not a child of it)
    if (e.target === e.currentTarget) {
      closeOverlay()
    }
  }

  function onDialogKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      closeOverlay()
    }
  }

  // Derived: are both before/after graphs empty? An impact result is NEVER
  // "empty" here — it renders the impact (hasImpact) or the honest suppressed
  // note (impactSuppressed), so it must not fall through to "No structural
  // changes". An ABSENT impact (old cached / retired flow) still falls through
  // to the before/after / changeMap path below.
  const bothEmpty = $derived(
    !result ||
      (!result.impact &&
        result.before.nodes.length === 0 &&
        result.after.nodes.length === 0 &&
        !result.changeMap)
  )

  // Derived: whether we have a change-map to show
  const hasChangeMap = $derived(!!result?.changeMap && (result.changeMap.nodes.length > 0))
</script>

{#if panelState === 'loading'}
  <!-- Unified AI progress: status line ("Mapping the architecture…") + skeleton. -->
  <div class="panel-loading" aria-label="Loading diagrams">
    <AiProgress task="diagrams" state={{ status: 'loading' }} skeletonVariant="block" />
  </div>
{:else if panelState === 'error'}
  <div class="panel-error" role="alert" title={errorDetail}>
    <span>{error ?? 'Diagram generation failed.'}</span>
    {#if errorDetail}
      <span class="panel-error-detail">{errorDetail}</span>
    {/if}
  </div>
{:else if panelState === 'declined'}
  <div class="panel-declined" role="status">
    AI features declined. No diagrams available.
  </div>
{:else if bothEmpty}
  <div class="panel-empty" role="status">
    No structural changes detected.
  </div>
{:else if impactSuppressed}
  <!-- Auto-suppress: the change has no notable blast radius (pure
       data/config/schema/CRUD/dependency change). Honest muted note, never a
       forced or fabricated diagram. -->
  <div class="panel-empty impact-suppressed" role="status">
    No notable call-graph impact for this change.
  </div>
{:else if result}
  <div class="diagram-panel">
    {#if hasImpact}
      <!-- Change-impact / blast-radius (primary view, full width):
           callers (de-emphasized) → changed (accent) → callees (de-emphasized). -->
      <div class="impact-section">
        <div class="changemap-header">
          <span class="changemap-title">Change impact</span>
          <div class="legend" aria-label="Change impact legend">
            <span class="chip legend-chip legend-changed">Affected by this change</span>
            <span class="chip legend-chip legend-unchanged">This change uses</span>
          </div>
        </div>
        <div
          class="diagram-container diagram-container--full"
          role="button"
          tabindex="0"
          aria-label="View change impact full screen"
          bind:this={impactContainer}
          onclick={() => openOverlay('impact')}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openOverlay('impact') }}
        ></div>
      </div>
    {:else if hasChangeMap}
      <!-- D1: Change-map section (full width, rendered first) -->
      <div class="changemap-section">
        <!-- Legend row -->
        <div class="changemap-header">
          <span class="changemap-title">Change Map</span>
          <div class="legend" aria-label="Change map legend">
            <span class="chip legend-chip legend-added">Added</span>
            <span class="chip legend-chip legend-removed">Removed</span>
            <span class="chip legend-chip legend-changed">Changed</span>
            <span class="chip legend-chip legend-unchanged">Unchanged</span>
          </div>
          <button
            class="toggle-btn"
            onclick={() => { showBeforeAfter = !showBeforeAfter }}
            aria-expanded={showBeforeAfter}
            aria-controls="before-after-section"
          >
            {showBeforeAfter ? 'Hide Before / After' : 'Before / After'}
          </button>
        </div>

        <!-- Change-map diagram (full width) -->
        <div
          class="diagram-container diagram-container--full"
          role="button"
          tabindex="0"
          aria-label="View change map full screen"
          bind:this={changeMapContainer}
          onclick={() => openOverlay('changemap')}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openOverlay('changemap') }}
        ></div>
      </div>

      <!-- Before/After toggle section -->
      {#if showBeforeAfter}
        <div id="before-after-section" class="diagrams-row">
          <!-- Before diagram -->
          <div class="diagram-side">
            <h4 class="diagram-label">Before</h4>
            {#if result.before.nodes.length === 0}
              <p class="empty-graph">No structural changes detected.</p>
            {:else}
              <div
                class="diagram-container"
                role="button"
                tabindex="0"
                aria-label="View before diagram full screen"
                bind:this={beforeContainer}
                onclick={() => openOverlay('before')}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openOverlay('before') }}
              ></div>
            {/if}
          </div>

          <!-- After diagram -->
          <div class="diagram-side">
            <h4 class="diagram-label">After</h4>
            {#if result.after.nodes.length === 0}
              <p class="empty-graph">No structural changes detected.</p>
            {:else}
              <div
                class="diagram-container"
                role="button"
                tabindex="0"
                aria-label="View after diagram full screen"
                bind:this={afterContainer}
                onclick={() => openOverlay('after')}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openOverlay('after') }}
              ></div>
            {/if}
          </div>
        </div>
      {/if}
    {:else}
      <!-- v3 fallback: no changeMap → render before/after side-by-side as before -->
      <div class="diagrams-row">
        <!-- Before diagram -->
        <div class="diagram-side">
          <h4 class="diagram-label">Before</h4>
          {#if result.before.nodes.length === 0}
            <p class="empty-graph">No structural changes detected.</p>
          {:else}
            <div
              class="diagram-container"
              role="button"
              tabindex="0"
              aria-label="View before diagram full screen"
              bind:this={beforeContainer}
              onclick={() => openOverlay('before')}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openOverlay('before') }}
            ></div>
          {/if}
        </div>

        <!-- After diagram -->
        <div class="diagram-side">
          <h4 class="diagram-label">After</h4>
          {#if result.after.nodes.length === 0}
            <p class="empty-graph">No structural changes detected.</p>
          {:else}
            <div
              class="diagram-container"
              role="button"
              tabindex="0"
              aria-label="View after diagram full screen"
              bind:this={afterContainer}
              onclick={() => openOverlay('after')}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openOverlay('after') }}
            ></div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<!-- EC-14k: full-screen overlay dialog -->
{#if overlayOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <dialog
    bind:this={overlayDialogEl}
    class="diagram-overlay"
    aria-label="Diagram full screen"
    onclick={onBackdropClick}
    oncancel={(e) => { e.preventDefault(); closeOverlay() }}
    onkeydown={onDialogKeydown}
  >
    <div class="overlay-content">
      <button class="close-btn" onclick={closeOverlay} aria-label="Close">✕</button>
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html overlayContent}
    </div>
  </dialog>
{/if}

<style>
  .panel-error,
  .panel-declined,
  .panel-empty {
    padding: 1rem;
    font-size: 0.9rem;
    opacity: 0.7;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .panel-loading {
    padding: 0.5rem 1rem;
  }

  .panel-error {
    color: #dc2626;
    opacity: 1;
    flex-wrap: wrap;
  }

  /* Concrete upstream failure detail — muted secondary line under the message. */
  .panel-error-detail {
    flex-basis: 100%;
    font-size: 0.78rem;
    opacity: 0.75;
  }

  .diagram-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* D1: Change-map section */
  .changemap-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .changemap-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .changemap-title {
    font-size: 0.85rem;
    font-weight: 600;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .legend {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .legend-chip {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.45rem;
    border-radius: 3px;
    border: 1px solid transparent;
    letter-spacing: 0.02em;
  }

  .legend-added {
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border);
    color: var(--legend-added-color);
  }

  .legend-removed {
    background: var(--legend-removed-bg);
    border-color: var(--legend-removed-border);
    color: var(--legend-removed-color);
  }

  .legend-changed {
    background: var(--legend-changed-bg);
    border-color: var(--legend-changed-border);
    color: var(--legend-changed-color);
  }

  .legend-unchanged {
    background: var(--legend-unchanged-bg);
    border-color: var(--legend-unchanged-border);
    color: var(--legend-unchanged-color);
  }

  .toggle-btn {
    margin-left: auto;
    font-size: 0.78rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--hairline);
    background: transparent;
    border-radius: 4px;
    cursor: pointer;
    color: inherit;
    opacity: 0.8;
    white-space: nowrap;
  }

  .toggle-btn:hover {
    opacity: 1;
    background: var(--surface-raised);
  }

  .diagram-container--full {
    width: 100%;
  }

  .diagrams-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .diagram-side {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0.75rem;
    overflow: hidden;
  }

  .diagram-label {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    font-weight: 600;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .diagram-container {
    cursor: zoom-in;
    overflow: auto;
    max-height: 300px;
  }

  .diagram-container:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .diagram-container :global(svg) {
    max-width: 100%;
    height: auto;
  }

  /* ---- Story-mode node states (Plan H) ---- */
  /* CURRENT step: accent ring + emphasis. */
  .diagram-container :global(.story-node-current rect),
  .diagram-container :global(.story-node-current circle),
  .diagram-container :global(.story-node-current polygon) {
    stroke: var(--accent) !important;
    stroke-width: 3px !important;
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--accent) 55%, transparent));
  }
  /* DONE steps: dimmed (already walked). */
  .diagram-container :global(.story-node-done) {
    opacity: 0.55;
  }
  /* VISITED files (Plan K coverage map): a soft "checked" tint on the node so
     the diagram doubles as a "what's left" map. Visual only — graceful when a
     node can't map to a file (no class applied). */
  .diagram-container :global(.story-node-visited rect),
  .diagram-container :global(.story-node-visited circle),
  .diagram-container :global(.story-node-visited polygon) {
    stroke: var(--legend-added-border) !important;
    fill: var(--legend-added-bg) !important;
  }
  .diagram-container :global(.story-node-clickable) {
    cursor: pointer;
  }

  .empty-graph {
    font-style: italic;
    opacity: 0.6;
    font-size: 0.85rem;
    margin: 0;
  }

  /* EC-14k: full-screen overlay — now a true modal via showModal() */
  .diagram-overlay {
    width: 92vw;
    height: 88vh;
    max-width: 92vw;
    max-height: 88vh;
    padding: 0;
    border: none;
    background: transparent;
    overflow: visible;
  }

  .diagram-overlay::backdrop {
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(2px);
  }

  .overlay-content {
    background: var(--surface-overlay, #fff);
    border-radius: 8px;
    padding: 2rem;
    width: 100%;
    height: 100%;
    overflow: auto;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .overlay-content :global(svg) {
    max-width: 100%;
    max-height: 100%;
    height: auto;
    flex: 1 1 auto;
  }

  .close-btn {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    opacity: 0.6;
    line-height: 1;
    padding: 0.25rem;
    border-radius: 4px;
  }

  .close-btn:hover {
    opacity: 1;
    background: #8881;
  }
</style>
