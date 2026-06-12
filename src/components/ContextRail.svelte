<script lang="ts">
  import AskAi from './AskAi.svelte'
  import SummaryPanel from './panels/SummaryPanel.svelte'
  import DiagramsSection from './panels/DiagramsSection.svelte'
  import TestInsightPanel from './panels/TestInsightPanel.svelte'
  import AlternativesPanel from './panels/AlternativesPanel.svelte'
  import VerdictPanel from './panels/VerdictPanel.svelte'
  import { track } from '../lib/analytics/analytics'
  import type { AiRun } from '../lib/ai/run.svelte'
  import type { AttentionResult } from '../lib/ai/schemas'

  interface Props {
    run: AiRun
    onhotspot: (path: string) => void
    collapsed: boolean
    oncollapse: (c: boolean) => void
    onbackdropclick?: () => void
  }

  let { run, onhotspot, collapsed, oncollapse, onbackdropclick }: Props = $props()

  const attention = $derived(
    run.attention.status === 'done' ? (run.attention.value as AttentionResult) : undefined
  )

  function levelIcon(level: 'high' | 'medium' | 'low'): string {
    if (level === 'high') return '⚠'
    if (level === 'medium') return '◆'
    return '●'
  }

  function handleHotspot(path: string) {
    onhotspot(path)
    track('hotspot_clicked')
  }

  // disabledReason: show hint when no API key available
  const askDisabledReason = $derived(
    run.summary.status === 'no-key'
      ? 'No API key configured. Add your DeepSeek key in Settings to use Ask AI.'
      : null
  )
</script>

<div
  class="rail-backdrop"
  class:visible={!collapsed}
  role="presentation"
  onclick={onbackdropclick}
  aria-hidden="true"
></div>
<aside class="context-rail" class:collapsed>
  <div class="rail-header">
    <span class="rail-title">Context</span>
    <button
      class="collapse-btn"
      onclick={() => oncollapse(!collapsed)}
      aria-label={collapsed ? 'Expand context rail' : 'Collapse context rail'}
    >
      {collapsed ? '›' : '‹'}
    </button>
  </div>

  {#if !collapsed}
    <div class="rail-body">

      <!-- Summary -->
      <details class="rail-section-details" open>
        <summary class="rail-section-summary">Summary</summary>
        <div class="rail-section-body">
          <SummaryPanel {run} />
        </div>
      </details>

      <!-- Diagrams -->
      <details class="rail-section-details">
        <summary class="rail-section-summary">Diagrams</summary>
        <div class="rail-section-body">
          <DiagramsSection {run} />
        </div>
      </details>

      <!-- Hotspots (rail-specific: jump behaviour) -->
      {#if attention && attention.hotspots.length > 0}
        <details class="rail-section-details" open>
          <summary class="rail-section-summary">Hotspots</summary>
          <div class="rail-section-body">
            <ul class="hotspot-list">
              {#each attention.hotspots as hotspot (hotspot.path)}
                <li>
                  <button
                    class="hotspot-btn level-{hotspot.level}"
                    onclick={() => handleHotspot(hotspot.path)}
                    aria-label={hotspot.path}
                  >
                    <span class="hotspot-icon" aria-hidden="true">{levelIcon(hotspot.level)}</span>
                    <span class="hotspot-path">{hotspot.path}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        </details>
      {/if}

      <!-- Test coverage (AI-inferred) -->
      <details class="rail-section-details">
        <summary class="rail-section-summary">Test coverage (AI-inferred)</summary>
        <div class="rail-section-body">
          <TestInsightPanel {run} {onhotspot} />
        </div>
      </details>

      <!-- Verdict evidence -->
      <details class="rail-section-details">
        <summary class="rail-section-summary">Verdict evidence</summary>
        <div class="rail-section-body">
          <VerdictPanel {run} {onhotspot} />
        </div>
      </details>

      <!-- Alternative approaches -->
      <details class="rail-section-details">
        <summary class="rail-section-summary">Alternative approaches (AI)</summary>
        <div class="rail-section-body">
          <AlternativesPanel {run} />
        </div>
      </details>

      <!-- Ask AI -->
      <div class="rail-section-ask">
        <AskAi ask={run.ask} disabledReason={askDisabledReason} />
      </div>
    </div>
  {/if}
</aside>

<style>
  .context-rail {
    position: fixed;
    right: 0;
    top: var(--topbar-h, 2.75rem);
    height: calc(100vh - var(--topbar-h, 2.75rem));
    /*
     * Wide viewport (≥1444px): free space ≥ 300px — fill half the surplus, capped at 480px.
     * Medium viewport (1100–1443px): overridden to 300px fixed by media query below.
     * Narrow viewport (<1100px): collapsed by default, overlay when open (media query below).
     */
    width: clamp(300px, calc((100vw - var(--content-max, 70rem)) / 2 - 24px), 480px);
    background: var(--surface);
    border-left: 1px solid var(--hairline);
    overflow-y: auto;
    z-index: 100;
    display: flex;
    flex-direction: column;
    transition: width 0.2s ease;
  }

  .context-rail.collapsed {
    width: 1.75rem;
  }

  /* Medium regime (1100–1443px): not enough free space beside content → fix rail at 300px */
  @media (max-width: 1443px) and (min-width: 1100px) {
    .context-rail:not(.collapsed) {
      width: 300px;
    }
  }

  /* Narrow regime (<1100px): collapsed by default; expanded = overlay on top of everything */
  @media (max-width: 1099px) {
    .context-rail:not(.collapsed) {
      width: 300px;
      z-index: 300; /* above topbar (z-index: 200) */
      box-shadow: -4px 0 16px rgba(0, 0, 0, 0.4);
    }
  }

  /* Backdrop: hidden by default, visible only in narrow mode when rail is open */
  .rail-backdrop {
    display: none;
  }

  @media (max-width: 1099px) {
    .rail-backdrop.visible {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 299; /* just below the rail (300) */
    }
  }

  .rail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.75rem 0.5rem;
    border-bottom: 1px solid var(--hairline);
    flex-shrink: 0;
  }

  .rail-title {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
  }

  .collapsed .rail-title {
    display: none;
  }

  .collapse-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1rem;
    opacity: 0.6;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    line-height: 1;
    flex-shrink: 0;
  }

  .collapse-btn:hover {
    opacity: 1;
    background: #8881;
  }

  .rail-body {
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow-y: auto;
    flex: 1;
  }

  /* Each section is a <details> expander */
  .rail-section-details {
    border-bottom: 1px solid var(--hairline);
    font-size: 0.82rem;
  }

  .rail-section-summary {
    cursor: pointer;
    padding: 0.55rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.7;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    user-select: none;
  }

  .rail-section-summary::-webkit-details-marker { display: none; }

  .rail-section-summary::before {
    content: '›';
    display: inline-block;
    transition: transform 0.15s;
    font-size: 1rem;
    opacity: 0.5;
    flex-shrink: 0;
  }

  details[open] > .rail-section-summary::before {
    transform: rotate(90deg);
  }

  .rail-section-body {
    padding: 0.5rem 0.75rem 0.75rem;
  }

  /* Hotspot list (rail-specific jump behaviour) */
  .hotspot-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .hotspot-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    cursor: pointer;
    width: 100%;
    text-align: left;
    padding: 0.25rem 0.4rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-family: var(--font-mono);
    word-break: break-all;
  }

  .hotspot-btn:hover {
    background: #8881;
  }

  .hotspot-btn.level-high { color: var(--legend-removed-color); }
  .hotspot-btn.level-medium { color: var(--legend-changed-color); }
  .hotspot-btn.level-low { color: inherit; opacity: 0.8; }

  .hotspot-icon {
    flex-shrink: 0;
  }

  .hotspot-path {
    word-break: break-all;
  }

  .rail-section-ask {
    padding: 0.75rem;
  }
</style>
