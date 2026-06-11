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
  import AiPanel from './AiPanel.svelte'
  import DiagramPanel from './DiagramPanel.svelte'
  import MarkdownView from './MarkdownView.svelte'
  import { stripReadingOrder } from '../lib/ai/tasks'
  import type { PrMeta, PrFile } from '../lib/github/types'
  import type { CiSummary as CiSummaryType } from '../lib/github/checks'
  import type { AiRun } from '../lib/ai/run.svelte'
  import type { AttentionResult, GraphResult, VerdictResult, TestInsight } from '../lib/ai/schemas'

  interface Props {
    meta: PrMeta
    files: PrFile[]
    ci: CiSummaryType | null
    ciError: boolean
    run: AiRun
    onhotspot?: (path: string) => void
  }

  let { meta, files, ci, ciError, run, onhotspot }: Props = $props()

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

  let testsPanelEl: HTMLDetailsElement | undefined = $state()

  function openTestsPanel() {
    if (testsPanelEl) testsPanelEl.open = true
  }

  // --- Verdict ---
  const verdict = $derived(
    run.verdict.status === 'done' ? (run.verdict.value as VerdictResult) : null
  )

  // --- File/line stats ---
  const totalAdditions = $derived(files.reduce((s, f) => s + f.additions, 0))
  const totalDeletions = $derived(files.reduce((s, f) => s + f.deletions, 0))

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
        <span class="glance-loading-pill" aria-label="Verdict loading">⏳ verdict…</span>
      {/if}

      {#if ciBadge}
        <span
          class="ci-badge"
          class:ci-pass={ci && ci.failed === 0 && ci.pending === 0 && ci.total > 0}
          class:ci-fail={ci && ci.failed > 0}
          class:ci-pending={ci && ci.pending > 0}
        >
          {ciBadge}
        </span>
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
        <span class="glance-loading-inline" aria-busy="true">
          <span class="spinner-sm" aria-hidden="true"></span>
          Analyzing tests…
        </span>
      {/if}
    </div>

    <!-- Row 2: TL;DR -->
    <div class="glance-row glance-row-tldr">
      {#if run.summary.status === 'streaming'}
        <p class="tldr-text tldr-streaming">{summaryText}</p>
      {:else if run.summary.status === 'loading'}
        <span class="glance-loading-inline" aria-busy="true">
          <span class="spinner-sm" aria-hidden="true"></span>
          Summarizing…
        </span>
      {:else if tldr}
        <p class="tldr-text">{tldr}</p>
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
        <span class="glance-loading-inline" aria-busy="true">
          <span class="spinner-sm" aria-hidden="true"></span>
          Analyzing hotspots…
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

  </section>

  <!-- ===== COLLAPSED DETAIL PANELS ===== -->

  <!-- Full summary -->
  <details class="detail-panel summary-panel">
    <summary class="detail-summary">Full summary</summary>
    <div class="detail-body">
      <AiPanel title="Summary" state={run.summary} onretry={() => run.retry('summary')}>
        {#if run.summary.status === 'streaming'}
          <pre class="prose">{summaryText}</pre>
        {:else if run.summary.status === 'done'}
          <MarkdownView source={summaryText} />
        {/if}
      </AiPanel>
    </div>
  </details>

  <!-- Diagrams -->
  <details class="detail-panel diagrams-panel">
    <summary class="detail-summary">Diagrams</summary>
    <div class="detail-body">
      <AiPanel title="Diagrams" state={run.diagrams} onretry={() => run.retry('diagrams')}>
        {#if run.diagrams.status === 'done'}
          <DiagramPanel result={run.diagrams.value as GraphResult} panelState="idle" />
        {/if}
      </AiPanel>
    </div>
  </details>

  <!-- Test coverage (AI-inferred) -->
  <details class="detail-panel tests-panel" bind:this={testsPanelEl}>
    <summary class="detail-summary">Test coverage (AI-inferred)</summary>
    <div class="detail-body">
      <AiPanel title="Test coverage (AI-inferred)" state={run.tests} onretry={() => run.retry('tests')}>
        {#if tests}
          {#if tests.covered.length > 0}
            <p class="tests-ai-inferred-note">AI-inferred — not measured coverage</p>
            <ul class="tests-covered-list">
              {#each tests.covered as item (item.behavior)}
                <li class="tests-covered-item">
                  <span class="tests-covered-check">✓</span>
                  <span class="tests-covered-content">
                    <span class="tests-covered-behavior">{item.behavior}</span>
                    <span class="tests-covered-meta">
                      {item.test} ·
                      <button
                        class="tests-file-link"
                        onclick={() => onhotspot?.(item.file)}
                        title="Jump to {item.file} in Inspect"
                        aria-label="Jump to {item.file}"
                      >{item.file}</button>
                    </span>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if tests.gaps.length > 0}
            <p class="tests-gaps-heading">AI-inferred gaps — behaviors changed without test coverage:</p>
            <ul class="tests-gaps-list">
              {#each tests.gaps as gap (gap)}
                <li class="tests-gap-item">
                  <span class="tests-gap-icon">⚠</span>
                  <span class="tests-gap-text">{gap}</span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if tests.covered.length === 0 && tests.gaps.length === 0}
            <p class="tests-empty">No AI-inferred test coverage data available.</p>
          {/if}
        {/if}
      </AiPanel>
    </div>
  </details>

  <!-- Verdict evidence -->
  <details class="detail-panel verdict-panel">
    <summary class="detail-summary">Verdict evidence</summary>
    <div class="detail-body">
      <AiPanel title="Verdict" state={run.verdict} onretry={() => run.retry('verdict')}>
        {#if verdict}
          {#if verdict.evidence.length > 0}
            <ul class="verdict-evidence">
              {#each verdict.evidence as item}
                <li>{item}</li>
              {/each}
            </ul>
          {/if}
          {#if verdict.notAnalyzed.length > 0}
            <div class="not-analyzed">
              <h4>Not analyzed</h4>
              <ul>
                {#each verdict.notAnalyzed as path}
                  <li>{path}</li>
                {/each}
              </ul>
            </div>
          {/if}
        {/if}
      </AiPanel>
    </div>
  </details>

  <!-- CI details -->
  <details class="detail-panel ci-panel">
    <summary class="detail-summary">CI details</summary>
    <div class="detail-body">
      <CiSummary {ci} error={ciError} />
    </div>
  </details>

  <!-- Original PR description -->
  <details class="detail-panel pr-description-details">
    <summary class="detail-summary">Original PR description</summary>
    <div class="detail-body pr-description-body">
      {#if meta.body}
        <MarkdownView source={meta.body} />
      {:else}
        <p class="no-desc">No description.</p>
      {/if}
    </div>
  </details>

</div>

<style>
  .understand-step {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* ===== Glance Card ===== */

  .glance-card {
    background: #8880;
    border: 1px solid #8882;
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
    color: #1a7f37;
    background: #1a7f3715;
  }

  .verdict-level.level-minor-changes {
    color: #9a6700;
    background: #9a670015;
  }

  .verdict-level.level-significant-changes {
    color: #cf222e;
    background: #cf222e15;
  }

  .glance-loading-pill {
    font-size: 0.8rem;
    opacity: 0.6;
    padding: 0.2rem 0.6rem;
    border: 1px solid #8884;
    border-radius: 12px;
  }

  .ci-badge {
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.2rem 0.5rem;
    border-radius: 10px;
    background: #8882;
    white-space: nowrap;
  }

  .ci-badge.ci-pass { color: #1a7f37; background: #1a7f3715; }
  .ci-badge.ci-fail { color: #cf222e; background: #cf222e15; }
  .ci-badge.ci-pending { color: #9a6700; background: #9a670015; }

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

  .additions { color: #1a7f37; font-weight: 500; }
  .deletions { color: #cf222e; font-weight: 500; }

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

  .spinner-sm {
    display: inline-block;
    width: 0.75em;
    height: 0.75em;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

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

  .churn-add { background: #1a7f37; }
  .churn-del { background: #cf222e; }

  .churn-nums {
    display: flex;
    gap: 0.25rem;
    font-size: 0.7rem;
    white-space: nowrap;
  }

  /* ===== Detail panels ===== */

  .detail-panel {
    border: 1px solid #8882;
    border-radius: 6px;
    overflow: hidden;
  }

  .detail-summary {
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    list-style: none;
    user-select: none;
    background: #8880;
  }

  .detail-summary::-webkit-details-marker { display: none; }
  .detail-summary::before { content: '▶ '; font-size: 0.7em; opacity: 0.6; }
  details[open] > .detail-summary::before { content: '▼ '; }

  .detail-body {
    padding: 0.75rem;
    border-top: 1px solid #8882;
  }

  .detail-body .prose {
    font-family: inherit;
    white-space: pre-wrap;
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.5;
  }

  /* ===== Verdict evidence ===== */

  .verdict-evidence {
    margin: 0 0 0.5rem 0;
    padding-left: 1.5em;
    font-size: 0.9rem;
  }

  .not-analyzed {
    margin-top: 0.5rem;
  }

  .not-analyzed h4 {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
    font-weight: 600;
    opacity: 0.75;
  }

  .not-analyzed ul {
    margin: 0;
    padding-left: 1.5em;
    font-size: 0.85rem;
    font-family: var(--font-mono, monospace);
    opacity: 0.8;
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
    color: #1a7f37;
    font-weight: 500;
  }

  .tests-chip-gaps {
    color: #9a6700;
    font-weight: 500;
  }

  /* ===== Test coverage panel ===== */

  .tests-ai-inferred-note {
    margin: 0 0 0.6rem;
    font-size: 0.8rem;
    opacity: 0.6;
    font-style: italic;
  }

  .tests-covered-list,
  .tests-gaps-list {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
  }

  .tests-covered-item {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid #8881;
    font-size: 0.88rem;
  }

  .tests-covered-item:last-child { border-bottom: none; }

  .tests-covered-check {
    color: #1a7f37;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 0.05rem;
  }

  .tests-covered-content {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .tests-covered-behavior {
    font-weight: 500;
  }

  .tests-covered-meta {
    font-size: 0.78rem;
    opacity: 0.65;
  }

  .tests-file-link {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: #2563eb;
    font-size: inherit;
    font-family: var(--font-mono, monospace);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .tests-file-link:hover { opacity: 0.75; }

  .tests-gaps-heading {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: #9a6700;
  }

  .tests-gap-item {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0.2rem 0;
    font-size: 0.88rem;
  }

  .tests-gap-icon {
    color: #9a6700;
    font-weight: 700;
    flex-shrink: 0;
  }

  .tests-gap-text {
    opacity: 0.9;
  }

  .tests-empty {
    margin: 0;
    font-size: 0.88rem;
    opacity: 0.6;
    font-style: italic;
  }
</style>
