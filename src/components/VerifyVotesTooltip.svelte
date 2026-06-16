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
   * The tooltip shows on hover OR keyboard focus of the chip. It renders in the
   * browser TOP LAYER via the Popover API (popover="manual" + showPopover/
   * hidePopover) so it escapes every overflow:hidden / clip ancestor (the old
   * position:absolute version was cropped by .detail-panel and the ContextRail).
   * It's positioned with position:fixed from the chip's rect — below by default,
   * flipping above near the viewport bottom and clamping horizontally near the
   * left/right edges — capped width + wrapping so it never overflows.
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

  // ---- Top-layer popover positioning (escapes overflow:hidden clip ancestors) -
  // The tooltip is a `popover="manual"` element: the browser promotes it to the
  // top layer, so NO ancestor's `overflow:hidden` / `border-radius` / clip can
  // crop it (the old position:absolute tooltip was clipped by .detail-panel and
  // the ContextRail). We anchor it to the chip with position:fixed from the
  // chip's getBoundingClientRect(): below by default, FLIPPED above when it would
  // overflow the viewport bottom, and CLAMPED horizontally so it never runs off
  // the left/right edge. Hover OR keyboard focus shows it; mouseleave/blur/Esc
  // hides it — so it stays keyboard-reachable.
  let anchorEl = $state<HTMLSpanElement | null>(null)
  let tipEl = $state<HTMLDivElement | null>(null)
  const GAP = 6 // px between chip and tooltip
  const MARGIN = 8 // px min distance from any viewport edge

  // Does this build support the Popover API? (jsdom / very old browsers don't.)
  const supportsPopover = (): boolean =>
    typeof HTMLElement !== 'undefined' &&
    typeof (HTMLElement.prototype as { showPopover?: unknown }).showPopover === 'function'

  function position(): void {
    const chip = anchorEl
    const tip = tipEl
    if (!chip || !tip) return
    const r = chip.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Measure the tooltip's natural size (it's already in the top layer when
    // visible). max-width caps width at min(22rem, 90vw) via CSS.
    const tw = tip.offsetWidth
    const th = tip.offsetHeight

    // Vertical: below by default, flip above if it would overflow the bottom and
    // there's more room above.
    const spaceBelow = vh - r.bottom
    const spaceAbove = r.top
    const placeAbove = spaceBelow < th + GAP + MARGIN && spaceAbove > spaceBelow
    const top = placeAbove
      ? Math.max(MARGIN, r.top - GAP - th)
      : Math.min(vh - th - MARGIN, r.bottom + GAP)

    // Horizontal: left-align to the chip, then clamp into the viewport.
    let left = r.left
    left = Math.min(left, vw - tw - MARGIN)
    left = Math.max(MARGIN, left)

    tip.style.left = `${Math.round(left)}px`
    tip.style.top = `${Math.round(top)}px`
  }

  function show(): void {
    const tip = tipEl
    if (!tip) return
    if (supportsPopover()) {
      try {
        ;(tip as unknown as { showPopover: () => void }).showPopover()
      } catch {
        // Already-open popovers throw — ignore.
      }
    }
    // Position after it's in the top layer so offsetWidth/Height are real.
    position()
  }

  function hide(): void {
    const tip = tipEl
    if (!tip) return
    if (supportsPopover()) {
      try {
        ;(tip as unknown as { hidePopover: () => void }).hidePopover()
      } catch {
        // Not-open popovers throw — ignore.
      }
    }
  }

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

<!-- The anchor is a passive hover/focus REGION wrapping the caller's focusable
     chip (the chip carries role+tabindex and is keyboard-reachable); these
     handlers only show/hide the descriptive tooltip, so the static-element rule
     doesn't apply. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="skill-verify-tip-anchor"
  bind:this={anchorEl}
  onmouseenter={show}
  onmouseleave={hide}
  onfocusin={show}
  onfocusout={hide}
  onkeydown={(e) => { if (e.key === 'Escape') hide() }}
>
  {@render children()}
  <!-- Styled hover/focus tooltip: one scannable row per polled model. Rendered
       in the browser TOP LAYER via the Popover API (popover="manual") so no
       ancestor's overflow:hidden / clip can crop it; positioned with
       position:fixed from the chip's rect (below by default, flipping above /
       clamping horizontally near viewport edges). Shown on hover OR keyboard
       focus, hidden on leave/blur/Esc. Removed from the a11y tree (aria-hidden)
       since the chip's aria-label already summarizes it for screen readers. -->
  <div
    class="skill-verify-tip"
    role="presentation"
    aria-hidden="true"
    popover="manual"
    bind:this={tipEl}
  >
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
     row per polled model (verdict indicator + model + "raised it" tag + reason).
     Rendered in the browser TOP LAYER via the Popover API so it escapes every
     overflow:hidden / clip ancestor (the old absolute version was cropped by
     .detail-panel and the ContextRail). Shown on hover OR keyboard focus of the
     sibling chip (JS toggles showPopover/hidePopover); position:fixed coords are
     set in JS (flip above / clamp horizontally near the viewport edges). Capped
     width + wrapping so it never overflows. */
  .skill-verify-tip-anchor {
    position: relative;
    display: inline-flex;
  }

  /* Base box for the popover. As a popover it's display:none until open; we
     reset margin/inset so our JS-set fixed left/top fully control placement. */
  .skill-verify-tip {
    position: fixed;
    margin: 0;
    inset: auto;
    left: 0;
    top: 0;
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
    /* Never blocks clicks on what's behind it. */
    pointer-events: none;
    overflow: visible;
  }

  /* When the Popover API is unsupported (jsdom / very old browsers) the element
     keeps `display:none` from the popover UA style only when supported; here we
     guarantee it stays hidden unless open, then reveal it once open. */
  .skill-verify-tip:not(:popover-open) {
    display: none;
  }
  .skill-verify-tip:popover-open {
    display: block;
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
