/**
 * src/lib/ai/lenses.ts — diverse verifier lenses (Plan O, Part B).
 *
 * Instead of asking every verifier the SAME adversarial question, each verifier
 * judges findings THROUGH a distinct lens. Different perspectives decorrelate
 * verifier errors (review-swarm perspective diversity): a security-focused
 * verifier and a performance-focused verifier make independent mistakes, so
 * their agreement is more meaningful than two identical adversarial passes.
 *
 * The verdict schema (confirm/refute/uncertain + reason) is unchanged — only the
 * framing the verifier reads differs per lens.
 */

/** A verifier lens. Rotated through verifiers in this order, cycling if >5. */
export type Lens =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'reproducibility'
  | 'maintainability'

/** The lens rotation order. K verifiers get the first K (cycling past 5). */
export const LENSES: readonly Lens[] = [
  'correctness',
  'security',
  'performance',
  'reproducibility',
  'maintainability',
] as const

/**
 * Assign one lens per verifier, rotating through LENSES. With K ≤ 5 verifiers
 * each gets a DISTINCT lens; with K > 5 the rotation cycles (so verifier 6 gets
 * `correctness` again). Order is stable (verifier index i → LENSES[i % 5]) so a
 * given ensemble always assigns the same lenses.
 */
export function assignLenses(verifierCount: number): Lens[] {
  const out: Lens[] = []
  for (let i = 0; i < verifierCount; i++) out.push(LENSES[i % LENSES.length])
  return out
}

/**
 * The lens-specific framing injected into the verifier system prompt. Each tells
 * the verifier WHICH class of problem to weigh most when deciding confirm vs
 * refute/uncertain — it does not change the response shape.
 */
export function lensFraming(lens: Lens): string {
  switch (lens) {
    case 'correctness':
      return `Judge each finding through a CORRECTNESS lens: logic errors, off-by-one and \
boundary mistakes, null/undefined handling, wrong conditionals, broken control flow, \
incorrect edge-case behavior. Confirm only when the code clearly shows a real correctness defect.`
    case 'security':
      return `Judge each finding through a SECURITY lens: injection (SQL/command/XSS), \
missing authentication/authorization, leaked or hard-coded secrets, unsafe deserialization, \
path traversal, SSRF. Confirm only when the code clearly shows a real, exploitable risk.`
    case 'performance':
      return `Judge each finding through a PERFORMANCE lens: N+1 queries, unbounded loops or \
allocations, work inside hot paths, blocking I/O, resource leaks, missing pagination or limits. \
Confirm only when the code clearly shows a real performance problem that matters at scale.`
    case 'reproducibility':
      return `Judge each finding through a REPRODUCIBILITY lens: would this issue ACTUALLY \
trigger? Is the claim grounded in the provided diff/code, or speculative? Trace the conditions \
needed to hit it. Confirm only when the code shows the problem can genuinely occur in practice.`
    case 'maintainability':
      return `Judge each finding through a MAINTAINABILITY lens: confusing or duplicated logic, \
leaky abstractions, missing error handling at real boundaries, names that mislead, structure that \
will break under change. Confirm only when the issue would genuinely cost a future maintainer — \
not mere style preference.`
  }
}
