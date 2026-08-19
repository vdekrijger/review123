<script lang="ts">
  import SummaryPanel from './panels/SummaryPanel.svelte'
  import DiagramsSection from './panels/DiagramsSection.svelte'
  import TestInsightPanel from './panels/TestInsightPanel.svelte'
  import AlternativesPanel from './panels/AlternativesPanel.svelte'
  import VerdictPanel from './panels/VerdictPanel.svelte'
  import CiSummary from './CiSummary.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import Skeleton from './Skeleton.svelte'
  import SectionStatus from './panels/SectionStatus.svelte'
  import { SECTION_REGISTRY } from './panels/sectionRegistry'
  import { isRailSectionExpanded, setRailSectionExpanded, type RailSectionId } from '../lib/rail/collapse'
  import { track } from '../lib/analytics/analytics'
  import { navigate } from '../lib/router/router.svelte'
  import type { AiRun } from '../lib/ai/run.svelte'
  import type { AttentionResult } from '../lib/ai/schemas'
  import type { CiSummary as CiSummaryType } from '../lib/github/checks'
  import type { PrMeta } from '../lib/github/types'

  interface Props {
    run: AiRun
    onhotspot: (path: string) => void
    collapsed: boolean
    oncollapse: (c: boolean) => void
    onbackdropclick?: () => void
    /** Forwarded so the registry can render ci-details and pr-description. */
    ci?: CiSummaryType | null
    ciError?: boolean
    meta?: PrMeta | null
    /** Re-read CI status without a page reload (passed through to CiSummary). */
    onRefreshCi?: () => void
    /** True while a CI refresh is in flight. */
    ciRefreshing?: boolean
  }

  let { run, onhotspot, collapsed, oncollapse, onbackdropclick, ci = null, ciError = false, meta = null, onRefreshCi, ciRefreshing = false }: Props = $props()

  // Plan J: link to settings from a disabled (off) section, preserving return-to.
  function goToSettings(e: MouseEvent) {
    e.preventDefault()
    sessionStorage.setItem('review123:settingsReturnTo', location.pathname)
    navigate('/settings')
  }

  const attention = $derived(
    run.attention.status === 'done' ? (run.attention.value as AttentionResult) : undefined
  )

  // Hotspots pending: attention run hasn't settled yet ('idle' = queued before
  // the run signals 'loading') — show a skeleton section instead of nothing so
  // the section doesn't pop in late.
  const attentionPending = $derived(
    run.attention.status === 'idle' || run.attention.status === 'loading'
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

  // --- Section open state (rail surface) ---
  // ALL rail sections default to COLLAPSED (the rail must not eat screen real
  // estate duplicating the Understand step). A user's expand/collapse choices
  // persist per browser in one localStorage map (src/lib/rail/collapse.ts) —
  // the registry's defaultOpen only governs the Understand page panels.
  //
  // Engagement tracking debounces per mount: only fire once per section id
  // (open events only; close ignored).
  const trackedRailSections = new Set<string>()

  function handleRailSectionToggle(e: Event, sectionId: RailSectionId) {
    const el = e.currentTarget as HTMLDetailsElement
    setRailSectionExpanded(sectionId, el.open)
    if (el.open && !trackedRailSections.has(sectionId)) {
      trackedRailSections.add(sectionId)
      track('section_expanded', { section: sectionId, surface: 'rail' })
    }
  }

  function handleCollapseToggle(newCollapsed: boolean) {
    oncollapse(newCollapsed)
    // Fire rail_expanded only when transitioning from collapsed → expanded
    if (!newCollapsed) {
      track('rail_expanded')
    }
  }
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
      onclick={() => handleCollapseToggle(!collapsed)}
      aria-label={collapsed ? 'Expand context rail' : 'Collapse context rail'}
    >
      {collapsed ? '›' : '‹'}
    </button>
  </div>

  {#if !collapsed}
    <div class="rail-body">

      {#each SECTION_REGISTRY.filter((s) => s.show.rail) as section (section.id)}

        {#if section.id === 'summary'}
          <details class="rail-section-details" open={isRailSectionExpanded(section.id)} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">
              <span class="rail-section-title">{section.title}</span>
              <SectionStatus status={run.summary.status} error={run.summary.error} errorDetail={run.summary.errorDetail} title={section.title} />
            </summary>
            <div class="rail-section-body">
              <SummaryPanel {run} />
            </div>
          </details>

          <!-- Hotspots injected after Summary (rail-specific: jump behaviour) -->
          {#if attention && attention.hotspots.length > 0}
            <details class="rail-section-details" open={isRailSectionExpanded('hotspots')} ontoggle={(e) => handleRailSectionToggle(e, 'hotspots')}>
              <summary class="rail-section-summary">Hotspots</summary>
              <div class="rail-section-body">
                <!-- Legend: marker = AI-assessed attention level (AttentionResult.hotspots[].level) -->
                <p class="hotspot-legend">
                  <span class="legend-level level-high">⚠ high risk</span>
                  <span class="legend-sep" aria-hidden="true">·</span>
                  <span class="legend-level level-medium">◆ medium</span>
                  <span class="legend-sep" aria-hidden="true">·</span>
                  <span class="legend-level level-low">● low attention</span>
                </p>
                <ul class="hotspot-list">
                  {#each attention.hotspots as hotspot (hotspot.path)}
                    <li>
                      <button
                        class="hotspot-btn level-{hotspot.level}"
                        onclick={() => handleHotspot(hotspot.path)}
                        aria-label="{hotspot.path} ({hotspot.level} attention)"
                        title="{hotspot.level} attention — {hotspot.reason}"
                      >
                        <span class="hotspot-icon" aria-hidden="true">{levelIcon(hotspot.level)}</span>
                        <span class="hotspot-path">{hotspot.path}</span>
                      </button>
                    </li>
                  {/each}
                </ul>
                <!-- Deep review: "verified with N tool calls" footer (same
                     run.attention channel the other deep panels use). -->
                {#if run.attention.toolCallsUsed !== undefined && run.attention.toolCallsUsed > 0}
                  <p class="ai-deep-footer">
                    Deep review: verified with {run.attention.toolCallsUsed} tool {run.attention.toolCallsUsed === 1 ? 'call' : 'calls'}
                  </p>
                {/if}
              </div>
            </details>
          {:else if run.attention.status === 'disabled'}
            <!-- Plan J: hotspots task turned off — compact muted state, no skeleton. -->
            <details class="rail-section-details" open={isRailSectionExpanded('hotspots')} ontoggle={(e) => handleRailSectionToggle(e, 'hotspots')}>
              <summary class="rail-section-summary">Hotspots</summary>
              <div class="rail-section-body">
                <p class="rail-disabled-note">Disabled — <a href="/settings" onclick={goToSettings}>enable in AI settings</a></p>
              </div>
            </details>
          {:else if attentionPending}
            <!-- Pending state must NOT force the section open — the skeleton
                 lives inside the (collapsed-by-default) section body. -->
            <details class="rail-section-details rail-hotspots-pending" open={isRailSectionExpanded('hotspots')} ontoggle={(e) => handleRailSectionToggle(e, 'hotspots')}>
              <summary class="rail-section-summary">Hotspots</summary>
              <div class="rail-section-body">
                <Skeleton lines={3} />
                {#if run.attention.activity && run.attention.activity.length > 0}
                  <!-- Deep review: live tool activity from the agentic loop -->
                  <ul class="hotspot-tool-activity" aria-live="polite" aria-label="Deep review activity">
                    {#each run.attention.activity as line, i (i)}
                      <li>{line}</li>
                    {/each}
                  </ul>
                {/if}
              </div>
            </details>
          {/if}

        {:else if section.id === 'diagrams'}
          <details class="rail-section-details" open={isRailSectionExpanded(section.id)} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">
              <span class="rail-section-title">{section.title}</span>
              <SectionStatus status={run.diagrams.status} error={run.diagrams.error} errorDetail={run.diagrams.errorDetail} title={section.title} />
            </summary>
            <div class="rail-section-body">
              <DiagramsSection {run} />
            </div>
          </details>

        {:else if section.id === 'test-insight'}
          <details class="rail-section-details" open={isRailSectionExpanded(section.id)} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">
              <span class="rail-section-title">{section.title}</span>
              <SectionStatus status={run.tests.status} error={run.tests.error} errorDetail={run.tests.errorDetail} title={section.title} />
            </summary>
            <div class="rail-section-body">
              <TestInsightPanel {run} {onhotspot} />
            </div>
          </details>

        {:else if section.id === 'alternatives'}
          <details class="rail-section-details" open={isRailSectionExpanded(section.id)} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">
              <span class="rail-section-title">{section.title}</span>
              <SectionStatus status={run.alternatives.status} error={run.alternatives.error} errorDetail={run.alternatives.errorDetail} title={section.title} />
            </summary>
            <div class="rail-section-body">
              <AlternativesPanel {run} />
            </div>
          </details>

        {:else if section.id === 'verdict-evidence'}
          <details class="rail-section-details" open={isRailSectionExpanded(section.id)} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">
              <span class="rail-section-title">{section.title}</span>
              <SectionStatus status={run.verdict.status} error={run.verdict.error} errorDetail={run.verdict.errorDetail} title={section.title} />
            </summary>
            <div class="rail-section-body">
              <VerdictPanel {run} {onhotspot} />
            </div>
          </details>

        {:else if section.id === 'ci-details'}
          <details class="rail-section-details" open={isRailSectionExpanded(section.id)} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">{section.title}</summary>
            <div class="rail-section-body">
              <CiSummary {ci} error={ciError} {onRefreshCi} refreshing={ciRefreshing} />
            </div>
          </details>

        {:else if section.id === 'pr-description'}
          <details class="rail-section-details" open={isRailSectionExpanded(section.id)} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">{section.title}</summary>
            <div class="rail-section-body">
              {#if meta?.body}
                <MarkdownView source={meta.body} />
              {:else}
                <p class="no-desc">No description.</p>
              {/if}
            </div>
          </details>

        {/if}
      {/each}

    </div>
  {/if}
</aside>

<style>
  /* Plan J: compact muted "disabled" note for an off section (no skeleton). */
  .rail-disabled-note {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .rail-disabled-note a {
    color: var(--accent);
  }

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

  /* Marker (rotating triangle) comes from the global details > summary
     pattern in app.css — re-declaring a ::before here merges with it on the
     same pseudo-element and renders a double chevron. Only sizing below. */
  .rail-section-summary {
    padding: 0.55rem 0.75rem;
    font-size: 0.75rem;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }

  /* Title takes the row; the header status indicator sits at the far right so
     it's visible whether the rail section is expanded or collapsed. */
  .rail-section-title {
    flex: 1;
    min-width: 0;
  }

  .rail-section-body {
    padding: 0.5rem 0.75rem 0.75rem;
  }

  /* Hotspot legend — compact muted caption explaining the level markers */
  .hotspot-legend {
    margin: 0 0 0.4rem;
    padding: 0 0.4rem;
    font-size: 0.7rem;
    letter-spacing: 0.02em;
    opacity: 0.75;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .legend-level { white-space: nowrap; }
  .legend-level.level-high { color: var(--legend-removed-color); }
  .legend-level.level-medium { color: var(--legend-changed-color); }
  .legend-level.level-low { color: var(--text-muted); }
  .legend-sep { color: var(--text-muted); }

  /* Hotspot list (rail-specific jump behaviour) */
  .hotspot-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .ai-deep-footer {
    margin: 0.6rem 0 0;
    padding-top: 0.4rem;
    border-top: 1px solid var(--hairline);
    font-size: 0.78rem;
    opacity: 0.65;
  }

  .hotspot-tool-activity {
    margin: 0.4rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.78rem;
    font-family: var(--font-mono, monospace);
    opacity: 0.65;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
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

  .no-desc {
    margin: 0;
    font-style: italic;
    opacity: 0.6;
    font-size: 0.9rem;
  }
</style>
