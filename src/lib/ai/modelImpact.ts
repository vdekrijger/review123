/**
 * modelImpact.ts — pure formatting for the per-model IMPACT readout (Plan N,
 * step 3). Leads with DECISIVENESS (a vote that flipped a finding's surface/
 * demote outcome) so a model that only rubber-stamps consensus reads low-impact
 * even with many confirms. Display-only, no network, no analytics.
 */

export interface VerifierImpactRow {
  confirms: number
  refutes: number
  uncertains: number
  decisive: number
}

/** Pluralize: "1 finding" / "2 findings". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Impact phrase for the GENERATOR: how many of its findings survived
 * verification (surfaced), plus — in Plan O 'generate' mode — how many it caught
 * that NO other model did (the recall headline). E.g. "4 surfaced findings" or
 * "4 surfaced findings · caught 2 the others missed".
 */
export function formatGeneratorImpact(surfaced: number, uniqueCatch = 0): string {
  const base = plural(surfaced, 'surfaced finding')
  if (uniqueCatch > 0) return `${base} · caught ${uniqueCatch} the others missed`
  return base
}

/**
 * Impact phrase for a VERIFIER, leading with decisiveness. Examples:
 *   "1 decisive refute (removed a finding)"
 *   "2 decisive votes · 3c/2r"
 *   "rubber-stamped · 4c/0r"   (confirms, nothing decisive)
 *   "no findings"              (nothing to verify)
 */
export function formatVerifierImpact(row: VerifierImpactRow): string {
  const total = row.confirms + row.refutes + row.uncertains
  if (total === 0) return 'no findings'
  const tally = `${row.confirms}c/${row.refutes}r`
  if (row.decisive === 0) {
    return `rubber-stamped · ${tally}`
  }
  // A single decisive refute is the highest-signal case: it removed a finding.
  if (row.decisive === 1 && row.refutes >= 1) {
    return `1 decisive refute (removed a finding) · ${tally}`
  }
  return `${plural(row.decisive, 'decisive vote')} · ${tally}`
}
