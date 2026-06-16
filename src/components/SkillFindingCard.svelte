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
  import type { FindingVerification } from '../lib/ai/schemas'

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
  }

  let { skillName, severity, body, verification = undefined, raisedBy = undefined, line = null, anchored = false, added = false, compact = false, findingKey = null, onAdd, onDismiss }: Props = $props()

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

  // Verdict indicator glyphs for the readable tooltip (color comes from the
  // verdict class). confirm → ✓, refute → ✗, uncertain → ?.
  const VERDICT_GLYPH = { confirm: '✓', refute: '✗', uncertain: '?' } as const

  // Structured per-vote rows for the styled hover/focus tooltip. Each row shows a
  // color-coded verdict indicator, the specific MODEL (falling back to provider
  // for old cached findings that predate model/lens), the LENS as a muted tag
  // (the generator/raiser row has no lens → shows "raised it"), and the reason.
  const verifyRows = $derived(
    (verification?.perModel ?? []).map((m) => ({
      verdict: m.verdict,
      glyph: VERDICT_GLYPH[m.verdict],
      model: m.model ?? m.provider,
      lens: m.lens,
      reason: m.reason,
    })),
  )

  // Tooltip heading mirrors the chip but in sentence case.
  const verifyHeading = $derived(
    verification
      ? verification.surfaced
        ? `Confirmed by ${verification.confirmedBy}/${verification.polledModels} models`
        : lowerConfidenceLabel.charAt(0).toUpperCase() + lowerConfidenceLabel.slice(1)
      : '',
  )
</script>

<div class="skill-finding severity-{severity}" class:compact class:lower-confidence={isLowerConfidence} role="note" aria-label="{skillName} finding, severity {severity}" data-finding-key={findingKey ?? undefined}>
  <div class="skill-finding-header">
    <span class="skill-persona-label">{skillName}</span>
    {#if line !== null && !anchored}
      <span class="skill-line-note">line {line} — not in this diff</span>
    {/if}
    {#if added}
      <span class="skill-state-chip" role="status">✓ added as draft</span>
    {/if}
    {#if raisedByLabel}
      <span class="skill-raised-chip" aria-label={raisedByLabel}>{raisedByLabel}</span>
    {/if}
    {#if verification && verification.surfaced}
      <span class="skill-verify-tip-anchor">
        <span
          class="skill-verify-chip"
          tabindex="0"
          role="button"
          aria-label="Confirmed by {verification.confirmedBy} of {verification.polledModels} models"
        >✓ confirmed by {verification.confirmedBy}/{verification.polledModels} models</span>
        {@render verifyTip()}
      </span>
    {:else if isLowerConfidence}
      <span class="skill-verify-tip-anchor">
        <span
          class="skill-lower-confidence-chip"
          tabindex="0"
          role="button"
          aria-label={lowerConfidenceLabel}
        >{lowerConfidenceLabel}</span>
        {@render verifyTip()}
      </span>
    {/if}
    <span class="skill-severity-chip severity-chip-{severity}">{severity}</span>
  </div>

  {#snippet verifyTip()}
    <!-- Styled hover/focus tooltip: one scannable row per polled model. Hidden
         until the sibling chip is hovered or focused (CSS :hover/:focus-within),
         and removed from the a11y tree (aria-hidden) since the chip's aria-label
         already summarizes it for screen readers. -->
    <div class="skill-verify-tip" role="presentation" aria-hidden="true">
      <div class="skill-verify-tip-heading">{verifyHeading}</div>
      <ul class="skill-verify-tip-list">
        {#each verifyRows as row}
          <li class="skill-verify-tip-row">
            <span class="skill-verify-tip-glyph verdict-{row.verdict}" aria-hidden="true">{row.glyph}</span>
            <span class="skill-verify-tip-model">{row.model}</span>
            {#if row.lens}
              <span class="skill-verify-tip-lens">{row.lens}</span>
            {:else}
              <span class="skill-verify-tip-lens skill-verify-tip-lens-raised">raised it</span>
            {/if}
            {#if row.reason}
              <span class="skill-verify-tip-reason">{row.reason}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/snippet}
  <!-- Full block markdown (paragraphs, fenced code, lists, inline code/bold/links).
       MarkdownView enforces the sanitization boundary (marked → DOMPurify). -->
  <div class="skill-finding-body">
    <MarkdownView source={body} />
  </div>
  <div class="skill-finding-actions">
    <button
      class="skill-add-draft-btn"
      class:added
      onclick={onAdd}
      disabled={added}
      aria-label={added ? 'Added to drafts' : 'Add as draft comment'}
    >{added ? '✓ Added' : 'Add as draft'}</button>
    <button class="skill-dismiss-btn" onclick={onDismiss}>Dismiss</button>
  </div>
</div>

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

  /* ---- Styled verify tooltip (Plan M verify-tooltip) ----
     Replaces the cramped native `title`: a readable, scannable popover with one
     row per polled model (verdict indicator + model + lens tag + reason). Shown
     on hover OR keyboard focus of the sibling chip; capped width + wrapping so it
     never overflows the viewport. CSS-only (:hover / :focus-within) — no JS. */
  .skill-verify-tip-anchor {
    position: relative;
    display: inline-flex;
  }

  .skill-verify-tip {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    z-index: 20;
    width: max-content;
    max-width: min(22rem, 90vw);
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    background: var(--surface-raised, var(--bg));
    border: 1px solid var(--border-subtle);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--text, inherit);
    /* Hidden until the chip is hovered/focused; pointer-events off when hidden so
       it never blocks clicks on what's behind it. */
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.1s ease-out;
  }

  /* Right-align the tooltip when the chip sits near the right edge of the row so
     it doesn't push past the card / viewport. */
  .skill-verify-tip-anchor:last-of-type .skill-verify-tip {
    left: auto;
    right: 0;
  }

  .skill-verify-tip-anchor:hover .skill-verify-tip,
  .skill-verify-tip-anchor:focus-within .skill-verify-tip {
    opacity: 1;
    visibility: visible;
  }

  .skill-verify-tip-heading {
    font-weight: 700;
    font-size: 0.72rem;
    margin-bottom: 0.35rem;
    padding-bottom: 0.3rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .skill-verify-tip-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .skill-verify-tip-row {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: baseline;
    column-gap: 0.35rem;
    row-gap: 0.1rem;
  }

  .skill-verify-tip-glyph {
    font-weight: 700;
    text-align: center;
    width: 1em;
  }

  .skill-verify-tip-glyph.verdict-confirm {
    color: var(--legend-added-color, green);
  }

  .skill-verify-tip-glyph.verdict-refute {
    color: var(--legend-removed-color, var(--danger, crimson));
  }

  .skill-verify-tip-glyph.verdict-uncertain {
    color: var(--legend-changed-color, var(--text-muted));
  }

  .skill-verify-tip-model {
    font-weight: 600;
    white-space: nowrap;
  }

  .skill-verify-tip-lens {
    font-size: 0.64rem;
    font-weight: 600;
    text-transform: lowercase;
    letter-spacing: 0.02em;
    padding: 0.02rem 0.3rem;
    border-radius: 999px;
    background: var(--surface-sunken, var(--bg));
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
    white-space: nowrap;
    justify-self: start;
  }

  .skill-verify-tip-lens-raised {
    border-style: dashed;
    background: transparent;
  }

  .skill-verify-tip-reason {
    grid-column: 2 / -1;
    color: var(--text-muted);
    overflow-wrap: anywhere;
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
</style>
