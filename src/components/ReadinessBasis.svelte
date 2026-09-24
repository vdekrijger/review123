<script lang="ts">
  /**
   * ReadinessBasis — the computed readiness grade, on Step 3 (Verdict).
   *
   * WHERE IT LIVES, AND WHY. The question "is this ready?" is asked at the
   * moment the user decides what to submit, not while they are still reading
   * diffs — so this sits on Step 3, immediately ABOVE the verdict radios: the
   * last thing read before the choice, and never in place of it. Step 2 is
   * where the evidence is gathered; this is where it is totted up.
   *
   * WHAT IT IS NOT. It is not a model's opinion of the code. Every number here
   * is counted by src/lib/ai/readiness.ts from facts the app already holds
   * (which reviewers ran, whether a verification poll could vote at all, the
   * findings by tier, whether a test run happened, how much of the diff anyone
   * saw, where the code was read from, whether a human signed it off). Nothing
   * on this surface is generated.
   *
   * So the component's whole job is to make the computation AUDITABLE: every
   * input is a row, every row shows its own points and the counted fact behind
   * them, and the limits are stated underneath at the same weight as the grade.
   * A reader who disagrees with the grade can see exactly which row to
   * disagree with — which is the only thing that makes a grade worth having.
   *
   * Presentational and pure: one prop, no state, no store reads, no network.
   * The ReviewCostPanel idiom (the other Step-3 recap panel).
   */
  import { READINESS_DISCLAIMER, type ReadinessReport } from '../lib/ai/readiness'

  interface Props {
    /** The computed report. Null → nothing renders (no AI run, demo mounts). */
    report: ReadinessReport | null
  }

  let { report }: Props = $props()
</script>

{#if report}
  <section class="readiness" data-band={report.band} data-testid="readiness-basis" aria-labelledby="readiness-title">
    <h3 class="readiness-title" id="readiness-title">Readiness basis</h3>

    <p class="readiness-headline" data-testid="readiness-headline">
      <span class="readiness-band">{report.label}</span><span class="readiness-dash"> — </span><span
        class="readiness-reason">{report.reason}</span>
    </p>

    <p class="readiness-provenance" data-testid="readiness-provenance">
      <span>Counted from {report.checks.length} stated facts — {report.score} of {report.max} points.</span>
      <span>No model produced this grade.</span>
    </p>

    <ul class="readiness-checks">
      {#each report.checks as check (check.id)}
        <li class="readiness-check" data-state={check.state} data-check={check.id} data-testid="readiness-check">
          <span
            class="readiness-points"
            title={`${check.points} of ${check.max}, weighted ×${check.weight}`}
            aria-label={`${check.points} of ${check.max} points, weighted ${check.weight}`}>{check.points}/{check.max}</span
          >
          <span class="readiness-check-label">{check.label}</span>
          <span class="readiness-check-detail">{check.detail}</span>
        </li>
      {/each}
    </ul>

    <div class="readiness-limits">
      <h4 class="readiness-limits-title">What this did not check</h4>
      {#if report.notChecked.length > 0}
        <ul class="readiness-notchecked" data-testid="readiness-notchecked">
          {#each report.notChecked as line, i (i)}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
      <p class="readiness-disclaimer" data-testid="readiness-disclaimer">{READINESS_DISCLAIMER}</p>
    </div>
  </section>
{/if}

<style>
  /* One panel, one sunken ground, and a single band-coloured edge. The grade
     itself stays in body ink: colour supports the reading, it never carries it
     (the band LABEL is the signal, and it is a word). */
  .readiness {
    margin: var(--space-5) 0 var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--hairline);
    border-left: 3px solid var(--legend-changed-color);
    border-radius: 8px;
  }
  .readiness[data-band='broad'] {
    border-left-color: var(--legend-added-color);
  }
  .readiness[data-band='minimal'],
  .readiness[data-band='none'] {
    border-left-color: var(--legend-removed-color);
  }

  .readiness-title {
    margin: 0 0 var(--space-1);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .readiness-headline {
    margin: 0;
    font-size: var(--text-base);
    line-height: 1.45;
    color: var(--text-secondary);
  }
  .readiness-band {
    font-weight: 600;
    color: var(--text);
  }
  .readiness-dash {
    color: var(--text-muted);
  }

  .readiness-provenance {
    margin: var(--space-1) 0 var(--space-3);
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* The audit trail: one row per input, each carrying its own arithmetic. */
  .readiness-checks {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hairline);
  }
  .readiness-check {
    display: grid;
    grid-template-columns: 2.5rem minmax(0, 11rem) minmax(0, 1fr);
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--hairline);
  }
  .readiness-points {
    font-size: var(--text-xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--legend-changed-color);
  }
  .readiness-check[data-state='met'] .readiness-points {
    color: var(--legend-added-color);
  }
  .readiness-check[data-state='unmet'] .readiness-points {
    color: var(--legend-removed-color);
  }
  .readiness-check-label {
    font-size: var(--text-sm);
    color: var(--text);
  }
  .readiness-check-detail {
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-secondary);
  }

  /* The limits sit at the same weight as the grade — they are half the point,
     not a footnote, so they get their own heading rather than a smaller grey. */
  .readiness-limits {
    margin: var(--space-3) 0 0;
  }
  .readiness-limits-title {
    margin: 0 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .readiness-notchecked {
    margin: 0 0 var(--space-2);
    padding: 0 0 0 var(--space-4);
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .readiness-notchecked li {
    margin: 0 0 var(--space-1);
  }
  .readiness-disclaimer {
    margin: 0;
    max-width: var(--measure-prose);
    font-size: var(--text-sm);
    line-height: 1.55;
    color: var(--text-secondary);
  }

  /* Narrow window: the three-column audit row stacks, so nothing is clipped
     and the detail keeps a readable measure. */
  @media (max-width: 36rem) {
    .readiness-check {
      grid-template-columns: 2.5rem minmax(0, 1fr);
    }
    .readiness-check-detail {
      grid-column: 2 / -1;
    }
  }
</style>
