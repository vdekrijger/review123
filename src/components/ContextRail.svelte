<script lang="ts">
  import DiagramPanel from './DiagramPanel.svelte'
  import { track } from '../lib/analytics/analytics'
  import { stripReadingOrder } from '../lib/ai/tasks'
  import type { AiRun } from '../lib/ai/run.svelte'
  import type { AttentionResult, GraphResult, VerdictResult } from '../lib/ai/schemas'

  interface Props {
    run: AiRun
    onhotspot: (path: string) => void
    collapsed: boolean
    oncollapse: (c: boolean) => void
  }

  let { run, onhotspot, collapsed, oncollapse }: Props = $props()

  const attention = $derived(
    run.attention.status === 'done' ? (run.attention.value as AttentionResult) : undefined
  )

  const verdict = $derived(
    run.verdict.status === 'done' ? (run.verdict.value as VerdictResult) : undefined
  )

  const diagrams = $derived(
    run.diagrams.status === 'done' ? (run.diagrams.value as GraphResult) : undefined
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
</script>

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
      <!-- Summary — strip reading order for display; InspectStep uses parsed order -->
      {#if run.summary.status === 'done' || run.summary.status === 'streaming'}
        <details class="rail-section" open>
          <summary>Summary</summary>
          <p class="rail-summary-text">
            {run.summary.status === 'done'
              ? stripReadingOrder(run.summary.value as string)
              : (run.summary.value as string)}
          </p>
        </details>
      {:else if run.summary.status === 'loading'}
        <div class="rail-section">
          <span class="rail-loading">Loading summary…</span>
        </div>
      {/if}

      <!-- Diagrams -->
      {#if diagrams}
        <div class="rail-section">
          <h4 class="rail-section-title">Diagrams</h4>
          <DiagramPanel result={diagrams} panelState="idle" />
        </div>
      {/if}

      <!-- Hotspots -->
      {#if attention && attention.hotspots.length > 0}
        <div class="rail-section">
          <h4 class="rail-section-title">Hotspots</h4>
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
      {/if}

      <!-- Tests touched -->
      {#if attention}
        <div class="rail-section">
          <h4 class="rail-section-title">Tests</h4>
          <span class="tests-count">{attention.testFlags.length} AI-inferred</span>
        </div>
      {/if}

      <!-- Verdict level -->
      {#if verdict}
        <div class="rail-section">
          <h4 class="rail-section-title">Verdict</h4>
          <span class="verdict-pill level-{verdict.level}">{verdict.level}</span>
        </div>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .context-rail {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: 260px;
    background: #16161e;
    border-left: 1px solid #4444;
    overflow-y: auto;
    z-index: 50;
    display: flex;
    flex-direction: column;
    transition: width 0.2s ease;
  }

  .context-rail.collapsed {
    width: 2.5rem;
  }

  .rail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.75rem 0.5rem;
    border-bottom: 1px solid #4442;
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

  .rail-section {
    padding: 0.75rem;
    border-bottom: 1px solid #4441;
    font-size: 0.82rem;
  }

  .rail-section-title {
    margin: 0 0 0.4rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.6;
  }

  .rail-summary-text {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .rail-loading {
    font-size: 0.8rem;
    opacity: 0.5;
  }

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

  .hotspot-btn.level-high { color: #cf222e; }
  .hotspot-btn.level-medium { color: #9a6700; }
  .hotspot-btn.level-low { color: inherit; opacity: 0.8; }

  .hotspot-icon {
    flex-shrink: 0;
  }

  .hotspot-path {
    word-break: break-all;
  }

  .tests-count {
    font-size: 0.8rem;
    opacity: 0.8;
  }

  .verdict-pill {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border: 1px solid currentColor;
  }

  .verdict-pill.level-behavior-preserved { color: #1a7f37; }
  .verdict-pill.level-minor-changes { color: #9a6700; }
  .verdict-pill.level-significant-changes { color: #cf222e; }
</style>
