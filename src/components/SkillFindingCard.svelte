<script lang="ts">
  /**
   * SkillFindingCard — the ONE card used for every AI/skill reviewer finding,
   * whether it renders inline at a diff line, in the per-file fallback block,
   * or above the file (file-level findings).
   *
   * Visual contract (consistent in light + dark via Reading Instrument tokens):
   *   - SEVERITY is the only thing border + badge color encode:
   *       high   → red   (--legend-removed-*)
   *       medium → amber (--legend-changed-*)
   *       low    → neutral (--border-subtle / muted)
   *     Borders are solid and match the severity chip. No accent-colored or
   *     dashed "mystery" borders.
   *   - STATE is encoded ONLY by small labeled chips, never by border styling:
   *       added-as-draft → green "✓ added as draft" chip (--legend-added-*)
   *       unresolvable anchor → muted "line N — not in this diff" note
   */

  import MarkdownView from './MarkdownView.svelte'
  import VerifyVotesTooltip from './VerifyVotesTooltip.svelte'
  import AskBox from './AskBox.svelte'
  import type { FindingVerification, AbsorbedFinding } from '../lib/ai/schemas'
  import type { AskFocus } from '../lib/ai/tasks'

  interface Props {
    skillName: string
    severity: 'high' | 'medium' | 'low'
    body: string
    /** Cross-model verification (Plan M) — drives the "confirmed by N/M" chip. */
    verification?: FindingVerification
    /**
     * Multi-generator provenance (Plan O 'generate' mode): the models that
     * independently RAISED this finding. With ≥2 raisers a "raised by A,B" chip
     * shows. Absent / single raiser in 'verify' mode → no chip.
     */
    raisedBy?: string[]
    /** The line the finding is anchored to, if any (shown only when not anchored inline) */
    line?: number | null
    /** Whether the card is rendered inline at its anchored diff line */
    anchored?: boolean
    /** Whether this finding has been added as a draft comment (session state) */
    added?: boolean
    /** Compact spacing for inline-at-line rendering */
    compact?: boolean
    /**
     * Stable finding key — emitted as `data-finding-key` so the reviewer result
     * chips can scroll+flash THIS exact card (see jumpToFinding). Optional: cards
     * rendered without a key are simply not jump-targets.
     */
    findingKey?: string | null
    onAdd: () => void
    onDismiss: () => void
    /**
     * Optional streaming grounded Q&A function (mirrors FileDiff's / AiRun.ask).
     * When provided, an "Ask AI" button appears alongside Add/Dismiss; clicking it
     * opens an inline AskBox grounded with this finding's text + code location.
     * Absent → no Ask AI affordance (gated like the rest of the app on a key).
     */
    askFn?: ((q: string, onDelta: (t: string) => void, focus?: AskFocus) => Promise<{ ok: true; answer: string } | { ok: false; error: string }>) | null
    /** Path the finding is anchored to — part of the Ask AI focus. */
    askPath?: string
    /** Code excerpt around the finding's line — part of the Ask AI focus. */
    askExcerpt?: string
    /**
     * Cross-reviewer convergence: the sibling findings (other reviewers) merged
     * into this card. Renders the expandable "also flagged as…" disclosure —
     * every absorbed finding stays readable (reviewer + location + body).
     */
    mergedFrom?: AbsorbedFinding[]
    /** ≤100-char reason the cluster describes one underlying issue (tooltip). */
    mergedReason?: string
    /**
     * Cross-reviewer convergence: this finding makes the same point as the
     * user's own draft at path:line. The card renders COLLAPSED/de-emphasized
     * ("covered by your comment on path:line") — expandable, never vanishing.
     */
    coveredByDraft?: { path: string; line: number }
  }

  let { skillName, severity, body, verification = undefined, raisedBy = undefined, line = null, anchored = false, added = false, compact = false, findingKey = null, onAdd, onDismiss, askFn = null, askPath = undefined, askExcerpt = undefined, mergedFrom = undefined, mergedReason = undefined, coveredByDraft = undefined }: Props = $props()

  // Covered-by-draft cards start collapsed; the toggle discloses the full card.
  let coveredExpanded = $state(false)
  const coveredLabel = $derived(
    coveredByDraft ? `covered by your comment on ${coveredByDraft.path}:${coveredByDraft.line}` : '',
  )

  /** First line of an absorbed finding's body, for the one-line disclosure row. */
  function firstLine(text: string): string {
    return text.split('\n')[0]
  }

  // Ask AI is gated on a configured askFn (same convention as the rest of the app).
  const hasAsk = $derived(askFn !== null && askFn !== undefined)
  let askOpen = $state(false)

  // Grounding focus for the Ask box: the finding text is the primary anchor; the
  // path/line/excerpt locate it in the diff. line falls back to 1 for file-level
  // (null-line) findings — the `finding` text + path carry the grounding there.
  const askFocus = $derived<AskFocus>({
    path: askPath ?? '',
    line: line ?? 1,
    excerpt: askExcerpt ?? '',
    finding: body,
  })

  // "raised by A, B" provenance (Plan O 'generate' mode). Shown when the finding
  // was NOT raised by every polled model — i.e. it's a recall-relevant catch
  // (one/some models found it, the rest only confirmed). A finding everyone
  // raised gets no chip (the provenance carries no signal there). In 'verify'
  // mode raisedBy is absent → no chip.
  const raisedByLabel = $derived.by(() => {
    if (!raisedBy || raisedBy.length === 0) return ''
    const polled = verification?.polledModels ?? raisedBy.length
    if (raisedBy.length >= polled) return '' // everyone raised it → no signal
    return `raised by ${raisedBy.join(', ')}`
  })

  // Cross-model DEMOTED state (Plan M): one model flagged it, the others didn't
  // confirm (verification present but surfaced=false). The card stays visible —
  // dimmed, with a "lower confidence" badge — rather than being hidden in a
  // collapsed group. Distinct from "no verification" (single-key / off), where no
  // chip shows at all.
  const isLowerConfidence = $derived(!!verification && !verification.surfaced)
  const lowerConfidenceLabel = $derived(
    verification
      ? `flagged by ${verification.confirmedBy}/${verification.polledModels} · lower confidence`
      : '',
  )
</script>

{#if coveredByDraft && !coveredExpanded}
  <!-- Collapsed covered-by-draft state: the finding makes the same point as the
       user's own draft. De-emphasized one-liner — expandable, never deleted
       (silent disappearance would look like data loss). -->
  <div class="skill-finding covered-collapsed" class:compact role="note" aria-label="{skillName} finding, {coveredLabel}" data-finding-key={findingKey ?? undefined}>
    <button
      type="button"
      class="covered-toggle"
      aria-expanded="false"
      onclick={() => (coveredExpanded = true)}
    >
      <span class="skill-persona-label">{skillName}</span>
      <span class="covered-chip">✓ {coveredLabel}</span>
      <span class="covered-expand-hint" aria-hidden="true">⌄</span>
    </button>
  </div>
{:else}
<div class="skill-finding severity-{severity}" class:compact class:lower-confidence={isLowerConfidence} class:covered-by-draft={!!coveredByDraft} role="note" aria-label="{skillName} finding, severity {severity}" data-finding-key={findingKey ?? undefined}>
  <div class="skill-finding-header">
    <span class="skill-persona-label">{skillName}</span>
    {#if line !== null && !anchored}
      <span class="skill-line-note">line {line} — not in this diff</span>
    {/if}
    {#if coveredByDraft}
      <span class="covered-chip">✓ {coveredLabel}</span>
      <button
        type="button"
        class="covered-expand-hint covered-collapse-btn"
        aria-expanded="true"
        aria-label="Collapse this covered finding"
        onclick={() => (coveredExpanded = false)}
      >⌃</button>
    {/if}
    {#if added}
      <span class="skill-state-chip" role="status">✓ added as draft</span>
    {/if}
    {#if raisedByLabel}
      <span class="skill-raised-chip" aria-label={raisedByLabel}>{raisedByLabel}</span>
    {/if}
    {#if verification && verification.surfaced}
      <VerifyVotesTooltip {verification}>
        <span
          class="skill-verify-chip"
          tabindex="0"
          role="button"
          aria-label="Confirmed by {verification.confirmedBy} of {verification.polledModels} models"
        >✓ confirmed by {verification.confirmedBy}/{verification.polledModels} models</span>
      </VerifyVotesTooltip>
    {:else if isLowerConfidence && verification}
      <VerifyVotesTooltip {verification}>
        <span
          class="skill-lower-confidence-chip"
          tabindex="0"
          role="button"
          aria-label={lowerConfidenceLabel}
        >{lowerConfidenceLabel}</span>
      </VerifyVotesTooltip>
    {/if}
    <span class="skill-severity-chip severity-chip-{severity}">{severity}</span>
  </div>
  <!-- Full block markdown (paragraphs, fenced code, lists, inline code/bold/links).
       MarkdownView enforces the sanitization boundary (marked → DOMPurify). -->
  <div class="skill-finding-body">
    <MarkdownView source={body} />
  </div>
  {#if mergedFrom && mergedFrom.length > 0}
    <!-- Convergence disclosure: every absorbed sibling finding stays readable
         (reviewer + location + one-line body) — the merge destroys nothing. -->
    <details class="merged-from" title={mergedReason || undefined}>
      <summary class="merged-from-summary">also flagged as… ({mergedFrom.length})</summary>
      <ul class="merged-from-list">
        {#each mergedFrom as m, i (i)}
          <li class="merged-from-item">
            <span class="merged-from-reviewer">{m.reviewer}</span>
            <span class="merged-from-loc">{m.path}{m.line !== null ? `:${m.line}` : ''}</span>
            <span class="merged-from-body">{firstLine(m.body)}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
  <div class="skill-finding-actions">
    <button
      class="skill-add-draft-btn"
      class:added
      onclick={onAdd}
      disabled={added}
      aria-label={added ? 'Added to drafts' : 'Add as draft comment'}
    >{added ? '✓ Added' : 'Add as draft'}</button>
    <button class="skill-dismiss-btn" onclick={onDismiss}>Dismiss</button>
    {#if hasAsk}
      <button
        type="button"
        class="skill-ask-btn"
        class:active={askOpen}
        onclick={() => (askOpen = !askOpen)}
        aria-expanded={askOpen}
        aria-label="Ask AI a follow-up about this finding"
        data-testid="skill-ask-btn"
      >Ask AI</button>
    {/if}
  </div>
  {#if hasAsk && askOpen && askFn}
    <AskBox
      {askFn}
      focus={askFocus}
      onclose={() => (askOpen = false)}
    />
  {/if}
</div>
{/if}

<style>
  /* ---- Card: severity drives the (solid) border + background tint ---- */
  .skill-finding {
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-size: 0.85rem;
    border-width: 1px;
    border-style: solid;
    border-left-width: 3px;
  }

  .skill-finding.compact {
    padding: 0.4rem 0.6rem;
    border-radius: 3px;
  }

  /* ---- Lower-confidence (cross-model demoted, Plan M) ----
     One model flagged it, the others didn't confirm. Still shown (never hidden),
     but dimmed and muted so it reads as a weaker signal than a surfaced finding.
     Severity still drives the chip; the muted overlay just lowers the emphasis. */
  .skill-finding.lower-confidence {
    border-style: dashed;
    border-color: var(--border-subtle);
    background: var(--surface-raised);
    opacity: 0.72;
  }
  .skill-finding.lower-confidence:hover,
  .skill-finding.lower-confidence:focus-within {
    opacity: 1;
  }

  /* Transient highlight when a reviewer chip jumps to this finding. Themed
     light/dark via the same changed-bg token the draft flash uses. The class is
     toggled imperatively by jumpToFinding (added on jump, removed after 1.5s). */
  .skill-finding.finding-flash {
    animation: finding-flash 1.5s ease-out forwards;
  }

  @keyframes finding-flash {
    0%   { box-shadow: 0 0 0 3px var(--legend-changed-border, var(--accent)); }
    80%  { box-shadow: 0 0 0 3px var(--legend-changed-border, var(--accent)); }
    100% { box-shadow: 0 0 0 0 transparent; }
  }

  @media (prefers-reduced-motion: reduce) {
    .skill-finding.finding-flash { animation: none; }
  }

  .skill-finding.severity-high {
    border-color: var(--legend-removed-border);
    background: var(--legend-removed-bg);
  }

  .skill-finding.severity-medium {
    border-color: var(--legend-changed-border);
    background: var(--legend-changed-bg);
  }

  .skill-finding.severity-low {
    border-color: var(--border-subtle);
    background: var(--surface-raised);
  }

  .skill-finding-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.3rem;
    flex-wrap: wrap;
  }

  .skill-persona-label {
    font-size: 0.75rem;
    font-weight: 600;
    opacity: 0.75;
    flex: 1;
  }

  /* ---- Severity chip: same palette as the card border ---- */
  .skill-severity-chip {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
  }

  .severity-chip-high {
    background: var(--legend-removed-bg);
    color: var(--legend-removed-color);
    border: 1px solid var(--legend-removed-border);
  }

  .severity-chip-medium {
    background: var(--legend-changed-bg);
    color: var(--legend-changed-color);
    border: 1px solid var(--legend-changed-border);
  }

  .severity-chip-low {
    background: var(--surface-raised);
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
  }

  /* ---- State chip: the ONLY state styling — small, labeled, green ---- */
  .skill-state-chip {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--legend-added-bg);
    color: var(--legend-added-color);
    border: 1px solid var(--legend-added-border);
    white-space: nowrap;
  }

  /* ---- Raised-by chip: multi-generator provenance "raised by A,B" (Plan O) ---- */
  .skill-raised-chip {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--surface-raised);
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
    white-space: nowrap;
  }

  /* ---- Verification chip: cross-model "confirmed by N/M" (Plan M) ---- */
  .skill-verify-chip {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--legend-added-bg);
    color: var(--legend-added-color);
    border: 1px solid var(--legend-added-border);
    white-space: nowrap;
    cursor: help;
  }

  /* ---- Lower-confidence chip: cross-model demoted "flagged by N/M" (Plan M) ---- */
  .skill-lower-confidence-chip {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--surface-raised);
    color: var(--text-muted);
    border: 1px dashed var(--border-subtle);
    white-space: nowrap;
    cursor: help;
  }

  .skill-verify-chip:focus-visible,
  .skill-lower-confidence-chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* ---- Covered-by-draft (convergence): collapsed, de-emphasized ---- */
  .skill-finding.covered-collapsed {
    border-style: dashed;
    border-color: var(--border-subtle);
    background: var(--surface-raised);
    opacity: 0.72;
    padding: 0.25rem 0.5rem;
  }

  .skill-finding.covered-collapsed:hover,
  .skill-finding.covered-collapsed:focus-within {
    opacity: 1;
  }

  /* Expanded covered card: still visibly weaker than a live finding. */
  .skill-finding.covered-by-draft {
    border-style: dashed;
    opacity: 0.85;
  }

  .covered-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }

  .covered-chip {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--surface-raised);
    color: var(--text-muted);
    border: 1px dashed var(--border-subtle);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .covered-expand-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .covered-collapse-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0 0.2rem;
  }

  /* ---- Merged-from disclosure (convergence "also flagged as…") ---- */
  .merged-from {
    margin: 0 0 0.4rem;
    font-size: 0.75rem;
  }

  .merged-from-summary {
    cursor: pointer;
    color: var(--text-muted);
    font-weight: 600;
  }

  .merged-from-list {
    margin: 0.25rem 0 0;
    padding-left: 1rem;
    list-style: disc;
  }

  .merged-from-item {
    margin-bottom: 0.15rem;
    line-height: 1.35;
  }

  .merged-from-reviewer {
    font-weight: 600;
  }

  .merged-from-loc {
    font-family: var(--font-mono);
    color: var(--text-muted);
    margin: 0 0.3rem;
  }

  /* ---- Unresolvable-anchor note: muted, labeled, mono ---- */
  .skill-line-note {
    font-size: 0.7rem;
    font-family: var(--font-mono);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .skill-finding-body {
    margin: 0 0 0.4rem;
    line-height: 1.4;
  }

  /* The common case is a single-paragraph finding: strip the leading/trailing
     paragraph margins from MarkdownView so the card stays compact (no extra
     vertical padding from <p> wrapping). Block content (code fences, lists)
     keeps its internal spacing. Works in both light and dark themes. */
  .skill-finding-body :global(p:first-child) {
    margin-top: 0;
  }

  .skill-finding-body :global(p:last-child) {
    margin-bottom: 0;
  }

  /* Block + inline markdown in the model-generated finding body: code spans
     and fenced blocks use the same code styling tokens as comment bodies /
     VerdictPanel evidence (overriding MarkdownView's neutral defaults). */
  .skill-finding-body :global(code) {
    font-size: 0.85em;
    background: var(--surface-raised);
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }

  .skill-finding-body :global(pre) {
    background: var(--surface-raised);
    padding: 0.5rem;
    border-radius: 4px;
    overflow-x: auto;
  }

  .skill-finding-body :global(pre code) {
    background: none;
    padding: 0;
  }

  .skill-finding-actions {
    display: flex;
    gap: 0.4rem;
  }

  .skill-add-draft-btn {
    font-size: 0.78rem;
    padding: 0.18rem 0.55rem;
    border-radius: 4px;
    border: 1px solid var(--accent);
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-weight: 500;
  }

  .skill-add-draft-btn:hover:not(:disabled) {
    background: var(--legend-added-bg);
  }

  .skill-add-draft-btn.added {
    background: var(--legend-added-bg);
    border-color: var(--legend-added-border, var(--accent));
    color: var(--legend-added-color, var(--accent));
    cursor: default;
    opacity: 0.85;
  }

  .skill-dismiss-btn {
    font-size: 0.78rem;
    padding: 0.18rem 0.55rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }

  .skill-dismiss-btn:hover {
    opacity: 1;
    background: var(--surface-raised);
  }

  .skill-ask-btn {
    font-size: 0.78rem;
    padding: 0.18rem 0.55rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.85;
  }

  .skill-ask-btn:hover {
    opacity: 1;
    background: var(--surface-raised);
  }

  .skill-ask-btn.active {
    border-color: var(--accent);
    color: var(--accent);
    opacity: 1;
  }
</style>
