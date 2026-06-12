<script lang="ts">
  import SummaryPanel from './panels/SummaryPanel.svelte'
  import DiagramsSection from './panels/DiagramsSection.svelte'
  import TestInsightPanel from './panels/TestInsightPanel.svelte'
  import AlternativesPanel from './panels/AlternativesPanel.svelte'
  import VerdictPanel from './panels/VerdictPanel.svelte'
  import CiSummary from './CiSummary.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import { SECTION_REGISTRY } from './panels/sectionRegistry'
  import { track } from '../lib/analytics/analytics'
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
  }

  let { run, onhotspot, collapsed, oncollapse, onbackdropclick, ci = null, ciError = false, meta = null }: Props = $props()

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

  // --- Section engagement tracking (rail surface) ---
  // Debounce per mount: only fire once per section id (open events only; close ignored).
  const trackedRailSections = new Set<string>()

  function handleRailSectionToggle(e: Event, sectionId: string) {
    const el = e.currentTarget as HTMLDetailsElement
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
          <details class="rail-section-details" open={section.defaultOpen.rail} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">{section.title}</summary>
            <div class="rail-section-body">
              <SummaryPanel {run} />
            </div>
          </details>

          <!-- Hotspots injected after Summary (rail-specific: jump behaviour) -->
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

        {:else if section.id === 'diagrams'}
          <details class="rail-section-details" open={section.defaultOpen.rail} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">{section.title}</summary>
            <div class="rail-section-body">
              <DiagramsSection {run} />
            </div>
          </details>

        {:else if section.id === 'test-insight'}
          <details class="rail-section-details" open={section.defaultOpen.rail} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">{section.title}</summary>
            <div class="rail-section-body">
              <TestInsightPanel {run} {onhotspot} />
            </div>
          </details>

        {:else if section.id === 'alternatives'}
          <details class="rail-section-details" open={section.defaultOpen.rail} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">{section.title}</summary>
            <div class="rail-section-body">
              <AlternativesPanel {run} />
            </div>
          </details>

        {:else if section.id === 'verdict-evidence'}
          <details class="rail-section-details" open={section.defaultOpen.rail} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">{section.title}</summary>
            <div class="rail-section-body">
              <VerdictPanel {run} {onhotspot} />
            </div>
          </details>

        {:else if section.id === 'ci-details'}
          <details class="rail-section-details" open={section.defaultOpen.rail} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
            <summary class="rail-section-summary">{section.title}</summary>
            <div class="rail-section-body">
              <CiSummary {ci} error={ciError} />
            </div>
          </details>

        {:else if section.id === 'pr-description'}
          <details class="rail-section-details" open={section.defaultOpen.rail} ontoggle={(e) => handleRailSectionToggle(e, section.id)}>
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

  .no-desc {
    margin: 0;
    font-style: italic;
    opacity: 0.6;
    font-size: 0.9rem;
  }
</style>
