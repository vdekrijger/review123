<script lang="ts">
  /**
   * UnderstandStep — "At a Glance" redesign (v2 user feedback round 2).
   *
   * Layout:
   *  GLANCE CARD (always visible, no expander):
   *    Row 1: verdict pill + CI badge + file count + total +/- lines
   *    Row 2: TL;DR (first sentence / 200 chars of stripped summary)
   *    Row 3: top-3 high/medium hotspot chips (clickable → jump to file)
   *    Row 4: mini churn chart (top 8 files by additions+deletions)
   *
   *  DETAILS PANELS (all collapsed by default):
   *    • Full summary     (MarkdownView of stripped summary)
   *    • Diagrams         (DiagramPanel)
   *    • Verdict evidence (evidence + notAnalyzed)
   *    • CI details       (CiSummary)
   *    • Original PR desc (MarkdownView)
   *
   * Security: MarkdownView uses renderMarkdown() internally — the ONLY
   * acceptable use of {@html} in this codebase.
   */
  import CiSummary from './CiSummary.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import FileTree from './FileTree.svelte'
  import SummaryPanel from './panels/SummaryPanel.svelte'
  import DiagramsSection from './panels/DiagramsSection.svelte'
  import TestInsightPanel from './panels/TestInsightPanel.svelte'
  import AlternativesPanel from './panels/AlternativesPanel.svelte'
  import VerdictPanel from './panels/VerdictPanel.svelte'
  import Spinner from './Spinner.svelte'
  import SectionStatus from './panels/SectionStatus.svelte'
  import { aiProgressLabel } from '../lib/ai/progressLabel'
  import { SECTION_REGISTRY, resolveUnderstandSections, type SectionId } from './panels/sectionRegistry'
  import { track } from '../lib/analytics/analytics'
  import { stripReadingOrder } from '../lib/ai/tasks'
  import { settingsState } from '../lib/settings/settingsState.svelte'
  import { formatUsageLabel } from '../lib/ai/tokenCost'
  import type { PrMeta, PrFile } from '../lib/github/types'
  import type { CiSummary as CiSummaryType } from '../lib/github/checks'
  import type { AiRun } from '../lib/ai/run.svelte'
  import type { AttentionResult, TestInsight, AlternativesResult, VerdictResult, SkillReviewResult, GraphResult, RiskJudgeResult } from '../lib/ai/schemas'
  import { computePrRisk } from '../lib/risk/risk'

  interface Props {
    meta: PrMeta
    files: PrFile[]
    ci: CiSummaryType | null
    ciError: boolean
    run: AiRun
    onhotspot?: (path: string) => void
    /** Re-read CI status without a page reload (passed through to CiSummary). */
    onRefreshCi?: () => void
    /** True while a CI refresh is in flight. */
    ciRefreshing?: boolean
  }

  let { meta, files, ci, ciError, run, onhotspot, onRefreshCi, ciRefreshing = false }: Props = $props()

  // --- Page sections: resolved from the user's per-browser Understand-step
  // layout preference (order + enable/disable) against the canonical registry.
  // Reactive: reordering / toggling in settings reflects live here. Only ENABLED
  // sections render; the per-section RUNTIME guards below still apply on top, so
  // an enabled section can still hide for lack of data. With no stored
  // preference this is byte-identical to the registry's show.page order.
  const pageSections = $derived(
    resolveUnderstandSections(settingsState.current.understandSections)
      .filter((s) => s.enabled)
      .map((s) => s.descriptor),
  )

  const openState = $state<Record<string, boolean>>(
    Object.fromEntries(
      SECTION_REGISTRY.filter((s) => s.show.page).map((s) => [s.id, s.defaultOpen.page]),
    ),
  )

  // The bulk control's label/state derives reactively from whether EVERY page
  // section is currently open. Not-all-open → "Expand all" (next click opens
  // all); all-open → "Collapse all" (next click closes all).
  const allExpanded = $derived(pageSections.every((s) => openState[s.id]))

  function toggleExpandAll() {
    const next = !allExpanded
    for (const s of pageSections) openState[s.id] = next
    track('expand_all', { expanded: next, surface: 'page' })
  }

  function openSection(id: SectionId) {
    openState[id] = true
  }

  // --- Derived: stripped summary ---
  const summaryText = $derived.by(() => {
    if (run.summary.status === 'done' || run.summary.status === 'streaming') {
      const raw = run.summary.value as string
      return run.summary.status === 'done' ? stripReadingOrder(raw) : raw
    }
    return ''
  })

  // --- TL;DR: first sentence / first 200 chars to sentence boundary ---
  const tldr = $derived.by(() => {
    const text = summaryText
    if (!text) return ''
    const slice = text.slice(0, 200)
    const match = slice.match(/^.*?[.!?](?:\s|$)/)
    if (match) return match[0].trim()
    return slice.trim()
  })

  // --- Attention / hotspots ---
  const attention = $derived(
    run.attention.status === 'done' ? (run.attention.value as AttentionResult) : null
  )

  const topHotspots = $derived.by(() => {
    if (!attention) return []
    return attention.hotspots
      .filter((h) => h.level === 'high' || h.level === 'medium')
      .slice(0, 3)
  })

  // --- Tests ---
  const tests = $derived(
    run.tests.status === 'done' ? (run.tests.value as TestInsight) : null
  )

  function openTestsPanel() {
    openSection('test-insight')
  }

  // --- Alternatives ---
  const alternatives = $derived(
    run.alternatives.status === 'done' ? (run.alternatives.value as AlternativesResult) : null
  )

  // Glance chip: show only if any alternative has assessment 'alternative-is-better'
  const hasWorthConsidering = $derived(
    alternatives !== null &&
    alternatives.alternatives.some((a) => a.assessment === 'alternative-is-better')
  )

  function openAlternativesPanel() {
    openSection('alternatives')
  }

  // --- Verdict ---
  const verdict = $derived(
    run.verdict.status === 'done' ? (run.verdict.value as VerdictResult) : null
  )

  // --- File/line stats ---
  const totalAdditions = $derived(files.reduce((s, f) => s + f.additions, 0))
  const totalDeletions = $derived(files.reduce((s, f) => s + f.deletions, 0))

  // --- Review effort (deterministic, client-side — src/lib/risk) ------------
  // Advisory low/medium/high estimate of the ATTENTION this PR needs, fused
  // from signals we already have. No LLM call of its own; async inputs
  // (findings / attention / impact) flow in reactively, so the badge refines
  // as analysis completes. Framed as review effort — never defect probability.
  // (run.skillReviews is guarded — some test doubles of AiRun omit it)
  const riskFindings = $derived(
    (run.skillReviews ?? []).flatMap((e) =>
      e.state.status === 'done' && e.state.value
        ? (e.state.value as SkillReviewResult).findings.map((f) => ({
            severity: f.severity,
            verification: f.verification,
          }))
        : [],
    ),
  )
  const riskFindingsPending = $derived(
    (run.skillReviews ?? []).some((e) => e.state.status === 'loading' || e.state.status === 'queued'),
  )
  const riskImpact = $derived(
    run.diagrams.status === 'done' ? ((run.diagrams.value as GraphResult).impact ?? null) : null,
  )
  const riskImpactPending = $derived(
    run.diagrams.status === 'loading' || run.diagrams.status === 'streaming',
  )
  const riskAttentionPending = $derived(
    run.attention.status === 'loading' || run.attention.status === 'streaming',
  )
  const riskVerdictPending = $derived(
    run.verdict.status === 'loading' || run.verdict.status === 'streaming',
  )
  // LLM risk judge — ONE more factor ("AI judgment") in the breakdown. The
  // deterministic score never blocks on it: in flight → the factor renders
  // pending; failed/absent → unavailable (exactly like blast radius without
  // impact). (run.riskJudge is guarded — some test doubles of AiRun omit it)
  const riskJudge = $derived(
    run.riskJudge?.status === 'done' ? (run.riskJudge.value as RiskJudgeResult) : null,
  )
  const riskJudgePending = $derived(
    run.riskJudge?.status === 'loading' || run.riskJudge?.status === 'streaming',
  )
  const riskJudgeSnippets = $derived(riskJudge?.snippets ?? [])

  const prRisk = $derived(
    computePrRisk({
      files,
      impact: riskImpact,
      impactPending: riskImpactPending,
      attention,
      attentionPending: riskAttentionPending,
      findings: riskFindings,
      findingsPending: riskFindingsPending,
      ci,
      verdictLevel: verdict?.level ?? null,
      verdictPending: riskVerdictPending,
      riskJudge,
      riskJudgePending,
    }),
  )

  function riskDots(score: number): string {
    return '●'.repeat(score) + '○'.repeat(3 - score)
  }

  // --- Churn chart: top 8 files by additions+deletions ---
  const churns = $derived.by(() => {
    const sorted = [...files]
      .map((f) => ({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        churn: f.additions + f.deletions,
        level: attention?.hotspots.find((h) => h.path === f.filename)?.level ?? null,
      }))
      .sort((a, b) => b.churn - a.churn)
      .slice(0, 8)

    const maxChurn = sorted.reduce((m, f) => Math.max(m, f.churn), 1)
    return sorted.map((f) => ({ ...f, maxChurn }))
  })

  // --- CI badge text ---
  const ciBadge = $derived.by(() => {
    if (ciError) return null
    if (!ci) return '⏳ CI loading'
    if (ci.total === 0) return null
    if (ci.pending > 0) return `⏳ ${ci.pending} pending`
    if (ci.failed === 0) return `✓ ${ci.passed} passed`
    return `✗ ${ci.failed} failed`
  })

  // --- CI badge tooltip: which checks failed (first few names + "and N more").
  // Revealed on hover/focus so the compact "✗ N failed" badge is legible without
  // expanding the CI details. Null when there are no failures (no tooltip needed).
  const ciFailureTooltip = $derived.by(() => {
    if (!ci || ci.failed === 0 || ci.failures.length === 0) return null
    const names = ci.failures.map((f) => f.name)
    const shown = names.slice(0, 3)
    const rest = names.length - shown.length
    const list = shown.join(', ')
    return rest > 0 ? `Failed: ${list} and ${rest} more` : `Failed: ${list}`
  })

  // The badge is actionable only when there's a real CI result to jump to (any
  // settled, non-empty CI). Clicking expands the CI details section and scrolls
  // it into view — no page reload, no hunting for the panel.
  const ciBadgeActionable = $derived(!!ci && ci.total > 0)

  let ciDetailsEl = $state<HTMLDetailsElement | null>(null)

  function jumpToCiDetails() {
    openSection('ci-details')
    // Wait a tick so the section's bind:open flush + render settle before we
    // scroll the now-open panel into view. Guard scrollIntoView — not every
    // environment implements it (e.g. jsdom in tests).
    queueMicrotask(() => {
      ciDetailsEl?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    })
  }

  // --- Per-review token TOTAL (opt-in: settings.showTokenCost, default OFF) ---
  // Sums every AI task's captured usage for this PR. Null = toggle off or no
  // usage captured yet → nothing renders (byte-identical to the prior UI).
  const totalUsageLabel = $derived(
    settingsState.current.showTokenCost ? formatUsageLabel(run.totalUsage) : null,
  )

  function handleHotspotClick(path: string) {
    onhotspot?.(path)
  }

  function truncatePath(path: string, max = 40): string {
    if (path.length <= max) return path
    const parts = path.split('/')
    const filename = parts[parts.length - 1]
    if (filename.length >= max) return '…/' + filename.slice(-max)
    return '…/' + parts.slice(-2).join('/')
  }

  // --- Section engagement tracking ---
  // Debounce per mount: only fire once per section id (open events only; close ignored).
  const trackedPageSections = new Set<string>()

  function handleSectionToggle(e: Event, sectionId: string) {
    const el = e.currentTarget as HTMLDetailsElement
    if (el.open && !trackedPageSections.has(sectionId)) {
      trackedPageSections.add(sectionId)
      track('section_expanded', { section: sectionId, surface: 'page' })
    }
  }

</script>

<div class="understand-step">

  <!-- ===== GLANCE CARD (always visible) ===== -->
  <section class="glance-card" aria-label="PR at a glance">

    <!-- Row 1: Verdict pill + CI badge + file/line counts -->
    <div class="glance-row glance-row-stats">
      {#if verdict}
        <span class="verdict-level level-{verdict.level}" aria-label="Verdict: {verdict.level}">
          {verdict.level}
        </span>
      {:else if run.verdict.status === 'loading'}
        <span class="glance-loading-pill" role="status" aria-live="polite">
          <Spinner size="0.7em" />{aiProgressLabel('verdict')}
        </span>
      {/if}

      {#if ciBadge}
        {#if ciBadgeActionable}
          <button
            type="button"
            class="ci-badge ci-badge-btn"
            class:ci-pass={ci && ci.failed === 0 && ci.pending === 0 && ci.total > 0}
            class:ci-fail={ci && ci.failed > 0}
            class:ci-pending={ci && ci.pending > 0}
            onclick={jumpToCiDetails}
            title={ciFailureTooltip ?? 'Open CI details'}
            aria-label={ciFailureTooltip
              ? `${ciFailureTooltip}. Open CI details`
              : `${ciBadge}. Open CI details`}
          >
            {ciBadge}
          </button>
        {:else}
          <span
            class="ci-badge"
            class:ci-pass={ci && ci.failed === 0 && ci.pending === 0 && ci.total > 0}
            class:ci-fail={ci && ci.failed > 0}
            class:ci-pending={ci && ci.pending > 0}
          >
            {ciBadge}
          </span>
        {/if}
      {/if}

      <span class="file-count">{files.length} file{files.length === 1 ? '' : 's'}</span>
      <span class="line-counts">
        <span class="additions">+{totalAdditions}</span>
        <span class="deletions">−{totalDeletions}</span>
      </span>

      {#if tests}
        <button
          class="tests-chip"
          onclick={openTestsPanel}
          aria-label="Test coverage: {tests.covered.length} behaviors tested{tests.gaps.length ? `, ${tests.gaps.length} gaps` : ''}"
        >
          <span class="tests-chip-covered">✓ {tests.covered.length} behaviors tested</span>
          {#if tests.gaps.length > 0}
            <span class="tests-chip-gaps">⚠ {tests.gaps.length} gaps</span>
          {/if}
        </button>
      {:else if run.tests.status === 'loading'}
        <span class="glance-loading-inline" role="status" aria-live="polite" aria-busy="true">
          <Spinner size="0.75em" />
          {aiProgressLabel('tests')}
        </span>
      {/if}

      {#if hasWorthConsidering}
        <button
          class="alternatives-glance-chip"
          onclick={openAlternativesPanel}
          aria-label="Alternative worth considering — open Alternative approaches panel"
        >
          💡 alternative worth considering
        </button>
      {/if}
    </div>

    <!-- Row 1.5: Review effort — deterministic, advisory attention estimate -->
    <details class="risk-details">
      <summary class="risk-summary" title="Deterministic estimate of the review attention this PR needs — advisory, not a defect prediction">
        <span class="risk-title">Review effort</span>
        <span class="risk-badge risk-{prRisk.level}" aria-label="Review effort: {prRisk.level}">{prRisk.level}</span>
        {#if prRisk.pending}
          <span class="risk-refining" role="status">refines as analysis completes</span>
        {/if}
        <span class="risk-caret" aria-hidden="true">⌄</span>
      </summary>
      <ul class="risk-factors">
        {#each prRisk.factors as f (f.id)}
          <li class="risk-factor" data-factor={f.id}>
            <span class="risk-factor-label">{f.label}</span>
            <span class="risk-factor-score" aria-label={f.pending ? `${f.label}: pending` : f.unavailable ? `${f.label}: unavailable` : `${f.label}: ${f.score} of 3`}>
              {#if f.pending}…{:else if f.unavailable}n/a{:else}{riskDots(f.score)}{/if}
            </span>
            <span class="risk-factor-detail">{f.detail}</span>
            {#if f.id === 'ai-judge' && riskJudgeSnippets.length > 0}
              <!-- Risky snippets the judge highlighted: compact path:line — reason
                   lines. The path is clickable and jumps to the file's diff, the
                   same affordance as the hotspot chips above. -->
              <ul class="risk-snippets" aria-label="Risky snippets flagged by the AI judgment">
                {#each riskJudgeSnippets as s, i (`${s.path}:${s.line ?? ''}:${i}`)}
                  <li class="risk-snippet">
                    <button
                      type="button"
                      class="risk-snippet-path"
                      onclick={() => handleHotspotClick(s.path)}
                      title="Open {s.path} in the diff"
                    >{truncatePath(s.path, 40)}{s.line != null ? `:${s.line}` : ''}</button>
                    <span class="risk-snippet-reason">— {s.reason}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
      {#if prRisk.heuristics.length > 0}
        <p class="risk-heuristics-head">AI-pattern risks</p>
        <ul class="risk-heuristics">
          {#each prRisk.heuristics as h, i (`${h.id}:${h.file}:${i}`)}
            <li class="risk-heuristic">
              <span class="risk-heuristic-label">{h.label}</span>
              <span class="risk-heuristic-file">{truncatePath(h.file, 40)}</span>
              <span class="risk-heuristic-evidence">{h.evidence}</span>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="risk-disclaimer">Advisory — estimates the review attention needed, not defect probability.</p>
    </details>

    <!-- Row 2: TL;DR -->
    <div class="glance-row glance-row-tldr">
      {#if run.summary.status === 'streaming'}
        <p class="tldr-text tldr-streaming">{summaryText}</p>
      {:else if run.summary.status === 'loading'}
        <span class="glance-loading-inline" role="status" aria-live="polite" aria-busy="true">
          <Spinner size="0.75em" />
          {aiProgressLabel('summary')}
        </span>
      {:else if tldr}
        <p class="tldr-text tldr-done"><MarkdownView source={tldr} /></p>
      {/if}
    </div>

    <!-- Row 3: Top-3 hotspot chips -->
    {#if topHotspots.length > 0}
      <div class="glance-row glance-row-hotspots" aria-label="Top hotspots">
        {#each topHotspots as hs (hs.path)}
          <button
            class="hotspot-chip level-{hs.level}"
            onclick={() => handleHotspotClick(hs.path)}
            title="{hs.path} — {hs.reason}"
            aria-label="{hs.path}: {hs.reason}"
          >
            <span class="chip-path">{truncatePath(hs.path, 30)}</span>
            <span class="chip-reason">{hs.reason.slice(0, 40)}{hs.reason.length > 40 ? '…' : ''}</span>
          </button>
        {/each}
      </div>
    {:else if run.attention.status === 'loading'}
      <div class="glance-row">
        <span class="glance-loading-inline" role="status" aria-live="polite" aria-busy="true">
          <Spinner size="0.75em" />
          {aiProgressLabel('attention')}
        </span>
      </div>
    {/if}

    <!-- Row 4: Mini churn chart (pure HTML/CSS, no dep) -->
    {#if churns.length > 0}
      <div class="glance-row glance-row-chart" aria-label="File churn chart">
        {#each churns as file (file.path)}
          <button
            class="churn-row"
            class:border-high={file.level === 'high'}
            class:border-medium={file.level === 'medium'}
            onclick={() => handleHotspotClick(file.path)}
            aria-label="{file.path}: +{file.additions} −{file.deletions}"
          >
            <span class="churn-path">{truncatePath(file.path, 35)}</span>
            <span class="churn-bar-wrap" aria-hidden="true">
              <span
                class="churn-bar churn-add"
                style="width: {(file.additions / file.maxChurn) * 100}%"
              ></span>
              <span
                class="churn-bar churn-del"
                style="width: {(file.deletions / file.maxChurn) * 100}%"
              ></span>
            </span>
            <span class="churn-nums">
              <span class="additions">+{file.additions}</span>
              <span class="deletions">−{file.deletions}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}

    {#if totalUsageLabel}
      <div class="glance-row glance-row-usage">
        <span class="usage-total" aria-label="Total token usage for this review">·· {totalUsageLabel} total</span>
      </div>
    {/if}

  </section>

  <!-- ===== EXPAND ALL / COLLAPSE ALL (one bulk toggle) ===== -->
  <div class="sections-control">
    <button
      type="button"
      class="expand-all-btn"
      onclick={toggleExpandAll}
      aria-pressed={allExpanded}
      aria-label={allExpanded ? 'Collapse all sections' : 'Expand all sections'}
    >
      {allExpanded ? 'Collapse all' : 'Expand all'}
    </button>
  </div>

  <!-- ===== COLLAPSED DETAIL PANELS (registry order) ===== -->

  {#each pageSections as section (section.id)}
    {#if section.id === 'summary'}
      <details class="detail-panel summary-panel" bind:open={openState[section.id]} ontoggle={(e) => handleSectionToggle(e, section.id)}>
        <summary class="detail-summary">
          <span class="detail-summary-title">{section.title}</span>
          <SectionStatus status={run.summary.status} title={section.title} />
        </summary>
        <div class="detail-body">
          <SummaryPanel {run} />
        </div>
      </details>

    {:else if section.id === 'diagrams'}
      <details class="detail-panel diagrams-panel" bind:open={openState[section.id]} ontoggle={(e) => handleSectionToggle(e, section.id)}>
        <summary class="detail-summary">
          <span class="detail-summary-title">{section.title}</span>
          <SectionStatus status={run.diagrams.status} title={section.title} />
        </summary>
        <div class="detail-body">
          <DiagramsSection {run} />
        </div>
      </details>

    {:else if section.id === 'file-structure'}
      <details class="detail-panel file-structure-panel" bind:open={openState[section.id]} ontoggle={(e) => handleSectionToggle(e, section.id)}>
        <summary class="detail-summary">
          <span class="detail-summary-title">{section.title}</span>
        </summary>
        <div class="detail-body file-structure-body">
          <FileTree
            {files}
            attention={attention}
            viewedStore={null}
            activePath={null}
            onselect={(path) => onhotspot?.(path)}
          />
        </div>
      </details>

    {:else if section.id === 'test-insight'}
      <details class="detail-panel tests-panel" bind:open={openState[section.id]} ontoggle={(e) => handleSectionToggle(e, section.id)}>
        <summary class="detail-summary">
          <span class="detail-summary-title">{section.title}</span>
          <SectionStatus status={run.tests.status} title={section.title} />
        </summary>
        <div class="detail-body">
          <TestInsightPanel {run} {onhotspot} />
        </div>
      </details>

    {:else if section.id === 'alternatives'}
      <details class="detail-panel alternatives-panel" bind:open={openState[section.id]} ontoggle={(e) => handleSectionToggle(e, section.id)}>
        <summary class="detail-summary">
          <span class="detail-summary-title">{section.title}</span>
          <SectionStatus status={run.alternatives.status} title={section.title} />
        </summary>
        <div class="detail-body">
          <AlternativesPanel {run} />
        </div>
      </details>

    {:else if section.id === 'verdict-evidence'}
      <details class="detail-panel verdict-panel" bind:open={openState[section.id]} ontoggle={(e) => handleSectionToggle(e, section.id)}>
        <summary class="detail-summary">
          <span class="detail-summary-title">{section.title}</span>
          <SectionStatus status={run.verdict.status} title={section.title} />
        </summary>
        <div class="detail-body">
          <VerdictPanel {run} {onhotspot} />
        </div>
      </details>

    {:else if section.id === 'ci-details'}
      <details class="detail-panel ci-panel" bind:this={ciDetailsEl} bind:open={openState[section.id]} ontoggle={(e) => handleSectionToggle(e, section.id)}>
        <summary class="detail-summary">
          <span class="detail-summary-title">{section.title}</span>
        </summary>
        <div class="detail-body">
          <CiSummary {ci} error={ciError} {onRefreshCi} refreshing={ciRefreshing} />
        </div>
      </details>

    {:else if section.id === 'pr-description'}
      <details class="detail-panel pr-description-details" bind:open={openState[section.id]} ontoggle={(e) => handleSectionToggle(e, section.id)}>
        <summary class="detail-summary">
          <span class="detail-summary-title">{section.title}</span>
        </summary>
        <div class="detail-body pr-description-body">
          {#if meta.body}
            <MarkdownView source={meta.body} />
          {:else}
            <p class="no-desc">No description.</p>
          {/if}
        </div>
      </details>
    {/if}
  {/each}

</div>

<style>
  .understand-step {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* ===== Glance Card ===== */

  .glance-card {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .glance-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Row 1 — stats */

  .verdict-level {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 12px;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
    white-space: nowrap;
  }

  .verdict-level.level-behavior-preserved {
    color: var(--legend-added-color);
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border);
  }

  .verdict-level.level-minor-changes {
    color: var(--legend-changed-color);
    background: var(--legend-changed-bg);
    border-color: var(--legend-changed-border);
  }

  .verdict-level.level-significant-changes {
    color: var(--legend-removed-color);
    background: var(--legend-removed-bg);
    border-color: var(--legend-removed-border);
  }

  .glance-loading-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    opacity: 0.6;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--hairline);
    border-radius: 12px;
  }

  .ci-badge {
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.2rem 0.5rem;
    border-radius: 10px;
    background: var(--surface-raised);
    white-space: nowrap;
  }

  .ci-badge.ci-pass { color: var(--legend-added-color); background: var(--legend-added-bg); }
  .ci-badge.ci-fail { color: var(--legend-removed-color); background: var(--legend-removed-bg); }
  .ci-badge.ci-pending { color: var(--legend-changed-color); background: var(--legend-changed-bg); }

  /* Actionable badge: same pill, now a button that jumps to CI details. */
  .ci-badge-btn {
    border: none;
    cursor: pointer;
    font-family: inherit;
    transition: filter 0.1s;
  }

  .ci-badge-btn:hover { filter: brightness(0.95); }
  .ci-badge-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .file-count {
    font-size: 0.85rem;
    opacity: 0.7;
    white-space: nowrap;
  }

  .line-counts {
    font-size: 0.85rem;
    display: flex;
    gap: 0.3rem;
    white-space: nowrap;
  }

  .additions { color: var(--legend-added-color); font-weight: 500; }
  .deletions { color: var(--legend-removed-color); font-weight: 500; }

  /* Row 1.5 — Review effort (deterministic badge + expandable breakdown) */

  .risk-details {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 0;
  }

  .risk-summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.55rem;
    cursor: pointer;
    list-style: none;
    font-size: 0.8rem;
  }

  .risk-summary::-webkit-details-marker { display: none; }

  .risk-title {
    font-weight: 600;
    white-space: nowrap;
  }

  .risk-badge {
    display: inline-block;
    padding: 0.1rem 0.55rem;
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
    white-space: nowrap;
  }

  .risk-badge.risk-low {
    color: var(--legend-added-color);
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border);
  }

  .risk-badge.risk-medium {
    color: var(--legend-changed-color);
    background: var(--legend-changed-bg);
    border-color: var(--legend-changed-border);
  }

  .risk-badge.risk-high {
    color: var(--legend-removed-color);
    background: var(--legend-removed-bg);
    border-color: var(--legend-removed-border);
  }

  .risk-refining {
    font-size: 0.72rem;
    font-style: italic;
    opacity: 0.55;
    white-space: nowrap;
  }

  .risk-caret {
    margin-left: auto;
    opacity: 0.5;
    transition: transform 0.15s;
  }

  .risk-details[open] .risk-caret { transform: rotate(180deg); }

  .risk-factors {
    list-style: none;
    margin: 0;
    padding: 0.4rem 0.55rem 0.2rem;
    border-top: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .risk-factor {
    display: grid;
    grid-template-columns: minmax(9rem, auto) auto 1fr;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.78rem;
  }

  .risk-factor-label { font-weight: 500; }

  .risk-factor-score {
    font-size: 0.7rem;
    letter-spacing: 0.15em;
    opacity: 0.75;
    white-space: nowrap;
  }

  .risk-factor-detail { opacity: 0.65; }

  /* Risky snippets under the "AI judgment" factor row (path:line — reason). */

  .risk-snippets {
    grid-column: 1 / -1;
    list-style: none;
    margin: 0.1rem 0 0.15rem;
    padding: 0 0 0 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .risk-snippet {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 0.75rem;
  }

  .risk-snippet-path {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: var(--font-mono, monospace);
    font-size: inherit;
    color: inherit;
    opacity: 0.85;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .risk-snippet-path:hover { opacity: 1; }

  .risk-snippet-reason { opacity: 0.6; }

  .risk-heuristics-head {
    margin: 0.35rem 0 0.15rem;
    padding: 0 0.55rem;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.6;
  }

  .risk-heuristics {
    list-style: none;
    margin: 0;
    padding: 0 0.55rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .risk-heuristic {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.75rem;
  }

  .risk-heuristic-label {
    font-weight: 500;
    color: var(--legend-changed-color);
    white-space: nowrap;
  }

  .risk-heuristic-file {
    font-family: var(--font-mono, monospace);
    opacity: 0.8;
  }

  .risk-heuristic-evidence { opacity: 0.6; }

  .risk-disclaimer {
    margin: 0.35rem 0 0;
    padding: 0.25rem 0.55rem 0.4rem;
    font-size: 0.7rem;
    font-style: italic;
    opacity: 0.5;
  }

  /* Row 2 — TL;DR */

  .glance-row-tldr {
    align-items: flex-start;
  }

  .tldr-text {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
    line-height: 1.45;
  }

  .tldr-streaming {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-weight: 400;
    font-size: 0.9rem;
    opacity: 0.8;
  }

  /* MarkdownView inside done-state TL;DR: constrain to inline, no block margin */
  .tldr-done :global(.markdown-view) {
    font-size: inherit;
    line-height: inherit;
    display: inline;
  }

  .tldr-done :global(p) {
    margin: 0;
    display: inline;
  }

  .glance-loading-inline {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    opacity: 0.65;
  }

  .glance-nokey,
  .glance-error {
    font-size: 0.85rem;
    opacity: 0.8;
  }

  .inline-retry {
    font-size: inherit;
    background: none;
    border: none;
    cursor: pointer;
    color: #2563eb;
    padding: 0;
    text-decoration: underline;
  }


  /* Row 3 — hotspot chips */

  .glance-row-hotspots {
    gap: 0.4rem;
  }

  .hotspot-chip {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    border: 1px solid #8883;
    background: none;
    cursor: pointer;
    font-size: 0.75rem;
    text-align: left;
    max-width: 200px;
    transition: background 0.1s;
  }

  .hotspot-chip:hover { background: #8881; }

  .hotspot-chip.level-high { border-color: #cf222e55; }
  .hotspot-chip.level-medium { border-color: #9a670055; }

  .chip-path {
    font-family: var(--font-mono, monospace);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .chip-reason {
    opacity: 0.65;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  /* Row 4 — mini churn chart */

  .glance-row-chart {
    flex-direction: column;
    align-items: stretch;
    gap: 0.15rem;
  }

  .churn-row {
    display: grid;
    grid-template-columns: 1fr 3fr auto;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.4rem;
    border: none;
    border-left: 3px solid transparent;
    background: none;
    cursor: pointer;
    border-radius: 0 4px 4px 0;
    font-size: 0.78rem;
    text-align: left;
    transition: background 0.1s;
    width: 100%;
  }

  .churn-row:hover { background: #8881; }

  .churn-row.border-high { border-left-color: #cf222e; }
  .churn-row.border-medium { border-left-color: #9a6700; }

  .churn-path {
    font-family: var(--font-mono, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.85;
  }

  .churn-bar-wrap {
    display: flex;
    height: 8px;
    border-radius: 3px;
    overflow: hidden;
    background: #8882;
    gap: 1px;
  }

  .churn-bar {
    height: 100%;
    min-width: 1px;
    border-radius: 2px;
  }

  .churn-add { background: var(--accent); }
  .churn-del { background: var(--legend-removed-color); }

  .churn-nums {
    display: flex;
    gap: 0.25rem;
    font-size: 0.7rem;
    white-space: nowrap;
  }

  /* Per-review token total (opt-in power-user footer) */
  .glance-row-usage {
    margin-top: 0.1rem;
  }

  .usage-total {
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    opacity: 0.5;
  }

  /* ===== Expand all / Collapse all control ===== */

  .sections-control {
    display: flex;
    justify-content: flex-end;
    margin-bottom: -0.1rem;
  }

  .expand-all-btn {
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0.25rem 0.6rem;
    transition: background 0.1s, color 0.1s;
  }

  .expand-all-btn:hover {
    background: #8881;
    color: var(--text);
  }

  /* ===== Detail panels ===== */

  .detail-panel {
    border: 1px solid var(--hairline);
    border-radius: 6px;
    overflow: hidden;
  }

  /* Title takes the row; the header status indicator sits at the far right so
     it's visible whether the section is expanded or collapsed. */
  .detail-summary-title {
    flex: 1;
    min-width: 0;
  }

  .detail-body {
    padding: 0.75rem;
    border-top: 1px solid var(--hairline);
  }

  .no-desc {
    margin: 0;
    font-style: italic;
    opacity: 0.6;
    font-size: 0.9rem;
  }

  /* ===== Tests chip (glance card Row 1) ===== */

  .tests-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.55rem;
    border-radius: 10px;
    border: 1px solid #8883;
    background: none;
    cursor: pointer;
    font-size: 0.8rem;
    white-space: nowrap;
    transition: background 0.1s;
  }

  .tests-chip:hover { background: #8881; }

  .tests-chip-covered {
    color: var(--legend-added-color);
    font-weight: 500;
  }

  .tests-chip-gaps {
    color: var(--legend-changed-color);
    font-weight: 500;
  }

  /* ===== Alternatives glance chip ===== */

  .alternatives-glance-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.55rem;
    border-radius: 10px;
    border: 1px solid #d97706aa;
    background: #d9770610;
    cursor: pointer;
    font-size: 0.8rem;
    color: #b45309;
    font-weight: 500;
    white-space: nowrap;
    transition: background 0.1s;
  }

  .alternatives-glance-chip:hover { background: #d9770620; }

  /* ===== File structure panel ===== */

  .file-structure-body {
    padding: 0.5rem 0.25rem;
  }
</style>
