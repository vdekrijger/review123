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

  import { renderInlineMarkdown } from '../lib/markdown/render'

  interface Props {
    skillName: string
    severity: 'high' | 'medium' | 'low'
    body: string
    /** The line the finding is anchored to, if any (shown only when not anchored inline) */
    line?: number | null
    /** Whether the card is rendered inline at its anchored diff line */
    anchored?: boolean
    /** Whether this finding has been added as a draft comment (session state) */
    added?: boolean
    /** Compact spacing for inline-at-line rendering */
    compact?: boolean
    onAdd: () => void
    onDismiss: () => void
  }

  let { skillName, severity, body, line = null, anchored = false, added = false, compact = false, onAdd, onDismiss }: Props = $props()
</script>

<div class="skill-finding severity-{severity}" class:compact role="note" aria-label="{skillName} finding, severity {severity}">
  <div class="skill-finding-header">
    <span class="skill-persona-label">{skillName}</span>
    {#if line !== null && !anchored}
      <span class="skill-line-note">line {line} — not in this diff</span>
    {/if}
    {#if added}
      <span class="skill-state-chip" role="status">✓ added as draft</span>
    {/if}
    <span class="skill-severity-chip severity-chip-{severity}">{severity}</span>
  </div>
  <!-- {@html} is acceptable ONLY with renderInlineMarkdown() output (sanitization boundary) -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  <p class="skill-finding-body">{@html renderInlineMarkdown(body)}</p>
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

  /* Inline markdown in the model-generated finding body: code spans use the
     same inline-code styling tokens as comment bodies / VerdictPanel evidence. */
  .skill-finding-body :global(code) {
    font-size: 0.85em;
    background: var(--surface-raised);
    padding: 0.1em 0.3em;
    border-radius: 3px;
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
