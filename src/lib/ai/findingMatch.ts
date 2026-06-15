/**
 * src/lib/ai/findingMatch.ts — shared "do two findings refer to the same issue?"
 * predicate (Plan O, Part A).
 *
 * The eval scorer (src/lib/eval/scorer.ts) matches a produced finding against a
 * hand-labeled expectation by file + line proximity + fuzzy description overlap.
 * Multi-generator dedup needs the SAME notion to collapse two generators'
 * findings that describe one issue. Rather than duplicate the logic, this module
 * owns the ONE matching definition; the scorer re-uses it.
 *
 * Pure, dependency-free (no Node, no DOM, no settings) so it runs under vitest.
 */

/** A finding anchored to a file + (optional) line + free-text description. */
export interface AnchoredFinding {
  file: string
  /** 1-based line, or null for a file-level finding. */
  line: number | null
  description: string
}

/** Tuning knobs for the matcher. Defaults in DEFAULT_FINDING_MATCH. */
export interface FindingMatchConfig {
  /** Two findings' lines must be within this many lines (when both have lines). */
  lineTolerance: number
  /** Minimum token-overlap (Jaccard, 0–1) for a description match. */
  descOverlapThreshold: number
}

export const DEFAULT_FINDING_MATCH: FindingMatchConfig = {
  lineTolerance: 3,
  descOverlapThreshold: 0.12,
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'this', 'that', 'it', 'its', 'as', 'at', 'by', 'with',
  'not', 'no', 'but', 'if', 'then', 'than', 'so', 'will', 'would', 'should',
])

/** Tokenize a description into lowercased word tokens, dropping stop words. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}

/**
 * Jaccard token overlap between two descriptions (0 = disjoint, 1 = identical
 * token sets). Empty-on-either-side returns 0.
 */
export function descOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Do two findings refer to the same issue?
 *
 * Rules (symmetric):
 * - File must match exactly.
 * - Line: a file-level finding (line null) on either side matches any line on
 *   the same file. Otherwise both lines must be within `lineTolerance`.
 * - Description: token Jaccard must be ≥ descOverlapThreshold — required so a
 *   same-line finding about a different concern does not spuriously merge.
 */
export function findingsMatch(
  a: AnchoredFinding,
  b: AnchoredFinding,
  config: FindingMatchConfig = DEFAULT_FINDING_MATCH,
): boolean {
  if (a.file !== b.file) return false
  const lineOk =
    a.line === null ||
    b.line === null ||
    Math.abs(a.line - b.line) <= config.lineTolerance
  if (!lineOk) return false
  return descOverlap(a.description, b.description) >= config.descOverlapThreshold
}
