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
  import { graphToMermaid } from '../lib/diagram/mermaid'
  import { getMermaid } from '../lib/diagram/mermaidInit'
  import type { GraphResult } from '../lib/diagram/types'

  interface Props {
    result: GraphResult | null
    panelState: 'idle' | 'loading' | 'error' | 'declined'
  }

  let { result, panelState }: Props = $props()

  // Containers for Mermaid SVG output
  let changeMapContainer = $state<HTMLDivElement | null>(null)
  let beforeContainer = $state<HTMLDivElement | null>(null)
  let afterContainer = $state<HTMLDivElement | null>(null)

  // Overlay state
  let overlayOpen = $state(false)
  let overlayContent = $state('')

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

  // Render the change-map diagram when container and result.changeMap are ready
  $effect(() => {
    if (!result?.changeMap || !changeMapContainer) return

    const { changeMap, kind } = result
    const changeMapMermaid = graphToMermaid(changeMap, kind).mermaid

    let cancelled = false

    async function renderChangeMap() {
      const cmc = changeMapContainer
      if (!cmc) return

      const svg = await renderDiagram(cmc, changeMapMermaid, 'changemap')

      if (cancelled) return

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

  function openOverlay(which: 'changemap' | 'before' | 'after') {
    if (!result) return
    let container: HTMLDivElement | null
    if (which === 'changemap') {
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

  // Derived: are both before/after graphs empty?
  const bothEmpty = $derived(
    !result ||
      (result.before.nodes.length === 0 && result.after.nodes.length === 0 && !result.changeMap)
  )

  // Derived: whether we have a change-map to show
  const hasChangeMap = $derived(!!result?.changeMap && (result.changeMap.nodes.length > 0))
</script>

{#if panelState === 'loading'}
  <div class="panel-loading" role="status" aria-label="Loading diagrams">
    <span class="spinner" aria-hidden="true"></span>
    Loading diagrams…
  </div>
{:else if panelState === 'error'}
  <div class="panel-error" role="alert">
    Diagram generation failed.
  </div>
{:else if panelState === 'declined'}
  <div class="panel-declined" role="status">
    AI features declined. No diagrams available.
  </div>
{:else if bothEmpty}
  <div class="panel-empty" role="status">
    No structural changes detected.
  </div>
{:else if result}
  <div class="diagram-panel">
    {#if hasChangeMap}
      <!-- D1: Change-map section (full width, rendered first) -->
      <div class="changemap-section">
        <!-- Legend row -->
        <div class="changemap-header">
          <span class="changemap-title">Change Map</span>
          <div class="legend" aria-label="Change map legend">
            <span class="legend-chip legend-added">Added</span>
            <span class="legend-chip legend-removed">Removed</span>
            <span class="legend-chip legend-changed">Changed</span>
            <span class="legend-chip legend-unchanged">Unchanged</span>
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
    open
    class="diagram-overlay"
    aria-label="Diagram full screen"
    onclick={onBackdropClick}
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
  .panel-loading,
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

  .panel-error {
    color: #dc2626;
    opacity: 1;
  }

  .spinner {
    display: inline-block;
    width: 1em;
    height: 1em;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
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
    background: #1a4731;
    border-color: #2ea44f;
    color: #7ee2a8;
  }

  .legend-removed {
    background: #4a1a1a;
    border-color: #d73a49;
    color: #f0a3a3;
  }

  .legend-changed {
    background: #4a3a10;
    border-color: #d4a72c;
    color: #ffd86e;
  }

  .legend-unchanged {
    background: #2a2a2e;
    border-color: #555;
    color: #aaa;
  }

  .toggle-btn {
    margin-left: auto;
    font-size: 0.78rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid #8883;
    background: transparent;
    border-radius: 4px;
    cursor: pointer;
    color: inherit;
    opacity: 0.8;
    white-space: nowrap;
  }

  .toggle-btn:hover {
    opacity: 1;
    background: #8881;
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
    border: 1px solid #8883;
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
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }

  .diagram-container :global(svg) {
    max-width: 100%;
    height: auto;
  }

  .empty-graph {
    font-style: italic;
    opacity: 0.6;
    font-size: 0.85rem;
    margin: 0;
  }

  /* EC-14k: full-screen overlay */
  .diagram-overlay {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .overlay-content {
    background: #fff;
    border-radius: 8px;
    padding: 2rem;
    width: 92vw;
    height: 88vh;
    max-width: 92vw;
    max-height: 88vh;
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
