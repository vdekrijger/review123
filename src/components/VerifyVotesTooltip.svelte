<script lang="ts">
  /**
   * VerifyVotesTooltip — the ONE readable cross-model verification tooltip,
   * shared by the reviewer finding cards (SkillFindingCard) and the AI Verdict
   * panel (VerdictPanel). Replaces the cramped native `title` tooltip with a
   * styled, scannable popover: one row per polled model showing a color-coded
   * verdict indicator (✓ confirm / ✗ refute / ? uncertain), the specific MODEL
   * (falling back to `provider` for old cached findings that predate `model`),
   * and the reason (muted, wraps). The generator/raiser row (`raised === true`)
   * shows a "raised it" tag instead of a reason.
   *
   * Markup contract (kept identical to the old inline SkillFindingCard tooltip
   * so its tests stay green):
   *   <span class="skill-verify-tip-anchor">
   *     {children}              ← the host chip (caller-supplied, stays focusable)
   *     <div class="skill-verify-tip" aria-hidden>…rows…</div>
   *   </span>
   *
   * The tooltip shows on hover OR keyboard focus of the chip (CSS :hover /
   * :focus-within — no JS), capped width + wrapping so it never overflows.
   */

  import type { FindingVerification } from '../lib/ai/schemas'
  import type { Snippet } from 'svelte'

  interface Props {
    /** Cross-model verification whose `perModel` votes drive the rows. */
    verification: FindingVerification
    /**
     * Tooltip heading. When omitted it's derived from the verification:
     * "Confirmed by N/M models" (surfaced) / "Flagged by C/P · lower confidence"
     * (demoted).
     */
    heading?: string
    /** The host chip — stays focusable so the tooltip is keyboard-reachable. */
    children: Snippet
  }

  let { verification, heading = undefined, children }: Props = $props()

  // Verdict indicator glyphs (color comes from the verdict-* class).
  const VERDICT_GLYPH = { confirm: '✓', refute: '✗', uncertain: '?' } as const

  // Structured per-vote rows. Model falls back to provider for old cached
  // findings that predate `model`; the generator/raiser row carries `raised`.
  const rows = $derived(
    (verification?.perModel ?? []).map((m) => ({
      verdict: m.verdict,
      glyph: VERDICT_GLYPH[m.verdict],
      model: m.model ?? m.provider,
      raised: m.raised ?? false,
      reason: m.reason,
    })),
  )

  // Derived heading (sentence case) when the caller doesn't pass one.
  const resolvedHeading = $derived(
    heading ??
      (verification.surfaced
        ? `Confirmed by ${verification.confirmedBy}/${verification.polledModels} models`
        : `Flagged by ${verification.confirmedBy}/${verification.polledModels} · lower confidence`),
  )
</script>

<span class="skill-verify-tip-anchor">
  {@render children()}
  <!-- Styled hover/focus tooltip: one scannable row per polled model. Hidden
       until the sibling chip is hovered or focused (CSS :hover/:focus-within),
       and removed from the a11y tree (aria-hidden) since the chip's aria-label
       already summarizes it for screen readers. -->
  <div class="skill-verify-tip" role="presentation" aria-hidden="true">
    <div class="skill-verify-tip-heading">{resolvedHeading}</div>
    <ul class="skill-verify-tip-list">
      {#each rows as row}
        <li class="skill-verify-tip-row">
          <span class="skill-verify-tip-glyph verdict-{row.verdict}" aria-hidden="true">{row.glyph}</span>
          <span class="skill-verify-tip-model">{row.model}</span>
          {#if row.raised}
            <span class="skill-verify-tip-raised">raised it</span>
          {/if}
          {#if row.reason}
            <span class="skill-verify-tip-reason">{row.reason}</span>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
</span>

<style>
  /* ---- Styled verify tooltip (Plan M verify-tooltip) ----
     Replaces the cramped native `title`: a readable, scannable popover with one
     row per polled model (verdict indicator + model + "raised it" tag + reason). Shown
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

  .skill-verify-tip-raised {
    font-size: 0.64rem;
    font-weight: 600;
    text-transform: lowercase;
    letter-spacing: 0.02em;
    padding: 0.02rem 0.3rem;
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    border: 1px dashed var(--border-subtle);
    white-space: nowrap;
    justify-self: start;
  }

  .skill-verify-tip-reason {
    grid-column: 2 / -1;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
</style>
