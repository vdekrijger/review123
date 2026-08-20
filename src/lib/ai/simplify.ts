/**
 * src/lib/ai/simplify.ts — post-review finding SIMPLIFY pass (pure logic).
 *
 * AI reviewer findings read like dense model-ese and fatigue reviewers. After
 * the reviewers (and the convergence merge) settle, one batched LLM call
 * rewrites every finding body into plain, human-sounding English focused on
 * the core of the issue. This module holds everything about that pass EXCEPT
 * the LLM call itself (mirrors convergence.ts):
 *
 *   - enumerateForSimplify — the deterministic positional id scheme
 *     ("f0".."fN") shared by prompt building AND apply, plus a content
 *     FINGERPRINT so rewrites computed against one finding set can never be
 *     mis-applied to another (retry / cache races). Delegates to convergence's
 *     enumerateFindings so the id scheme + fingerprint stay ONE definition.
 *   - validateSimplify — per-item SALVAGE validation of the LLM's rewrites:
 *     a bad item (unknown id, missing/empty/non-string/oversized simple) is
 *     skipped and the rest kept; whole-result garbage → null (pass does
 *     nothing, originals render).
 *   - applySimplify — the PURE application: rebuilds the reviewers' finding
 *     lists with `simpleBody` attached where a rewrite exists. Loss-proof by
 *     construction: it returns NEW arrays (input untouched), refuses to apply
 *     when the fingerprint doesn't match, and NEVER touches `body` — the
 *     original text is always renderable behind the card's "Show original"
 *     toggle, and every non-display consumer keeps reading `body`.
 *
 * No LLM, no network, no Svelte state — unit-testable in isolation.
 */

import { enumerateFindings, type ReviewerFindings } from './convergence'
export type { ReviewerFindings }

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

/** Compact numbered finding row fed to the simplify prompt. */
export interface SimplifyFindingInput {
  id: string
  body: string
}

/** One validated rewrite: the finding's positional id + its plain-English text. */
export interface SimplifyRewrite {
  id: string
  simple: string
}

/** Raw (validated) LLM output: the salvaged rewrites. */
export interface SimplifyRewrites {
  rewrites: SimplifyRewrite[]
}

/**
 * The simplify pass result carried in run state + cache: the rewrites plus the
 * FINGERPRINT of the exact (post-convergence) finding set they were computed
 * against. applySimplify refuses to act when fingerprints differ.
 */
export interface SimplifyValue {
  fingerprint: string
  rewrites: SimplifyRewrite[]
}

// ---------------------------------------------------------------------------
// Enumeration — the shared positional id scheme + fingerprint
// ---------------------------------------------------------------------------

/**
 * Enumerate every finding across the reviewers (reviewer order, then finding
 * order) as ids "f0".."fN" plus a content fingerprint. The SAME scheme and
 * fingerprint as the convergence pass (one definition, re-projected to the
 * two fields the simplify prompt needs) — so an id always refers to the same
 * finding, and a changed finding set changes the fingerprint, which blocks
 * stale rewrites. Callers pass the POST-convergence (merged) reviewer lists:
 * we simplify the bodies users actually see.
 */
export function enumerateForSimplify(reviewers: ReviewerFindings[]): {
  inputs: SimplifyFindingInput[]
  fingerprint: string
} {
  const { inputs, fingerprint } = enumerateFindings(reviewers)
  return { inputs: inputs.map((i) => ({ id: i.id, body: i.body })), fingerprint }
}

// ---------------------------------------------------------------------------
// validateSimplify — per-item salvage; whole-result garbage → null
// ---------------------------------------------------------------------------

/**
 * Sanity cap on one rewrite's length. The contract is ≤3 short sentences; a
 * "simplification" longer than this is not one — the item is skipped and the
 * original body renders (per-item salvage, never a whole-pass failure).
 */
export const SIMPLIFY_MAX_CHARS = 1200

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Normalize one rewrite id: accept "f3" strings, or bare integers as fN. */
function normalizeId(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return `f${raw}`
  if (typeof raw === 'string' && raw.length > 0) return raw
  return null
}

/**
 * Validate an unknown value as SimplifyRewrites against the known finding ids.
 *
 * Whole-result rules (violation → null, the pass does nothing):
 *   - the value must be `{ rewrites: [...] }` OR a bare array (models emit
 *     both); anything else is garbage.
 * Per-item rules (violation → that item is SKIPPED, the rest kept — a partial
 * simplification beats none):
 *   - the item must be an object with a known finding id (bare integers are
 *     tolerated as fN) and a non-empty string `simple` of sane length
 *     (≤ SIMPLIFY_MAX_CHARS after trimming).
 *   - duplicate ids keep the FIRST occurrence.
 * An empty rewrites list is VALID ("nothing needed rewriting").
 */
export function validateSimplify(
  x: unknown,
  findingIds: ReadonlySet<string>,
): SimplifyRewrites | null {
  let rawItems: unknown
  if (Array.isArray(x)) rawItems = x
  else if (isObject(x) && Array.isArray(x['rewrites'])) rawItems = x['rewrites']
  else return null

  const seen = new Set<string>()
  const rewrites: SimplifyRewrite[] = []
  for (const raw of rawItems as unknown[]) {
    if (!isObject(raw)) continue
    const id = normalizeId(raw['id'])
    if (id === null || !findingIds.has(id) || seen.has(id)) continue
    const rawSimple = raw['simple']
    if (typeof rawSimple !== 'string') continue
    const simple = rawSimple.trim()
    if (simple.length === 0 || simple.length > SIMPLIFY_MAX_CHARS) continue
    seen.add(id)
    rewrites.push({ id, simple })
  }
  return { rewrites }
}

// ---------------------------------------------------------------------------
// applySimplify — the pure, loss-proof application
// ---------------------------------------------------------------------------

/**
 * Attach `simpleBody` to the reviewers' findings from a simplify result. PURE
 * and loss-proof:
 *   - fingerprint mismatch (the finding set changed since the pass ran) →
 *     returns the input UNCHANGED — stale rewrites are never applied.
 *   - `body` is NEVER modified; `simpleBody` is added alongside it, so the
 *     render-time choice (card display / add-as-draft) can always fall back
 *     to the original.
 *   - a rewrite identical to the original body is dropped (nothing to toggle).
 * Returns NEW entry + finding objects; the input arrays are never mutated.
 * Callers pass the same POST-convergence (merged) lists the pass enumerated.
 */
export function applySimplify(
  reviewers: ReviewerFindings[],
  value: SimplifyValue,
): ReviewerFindings[] {
  const { fingerprint } = enumerateForSimplify(reviewers)
  if (fingerprint !== value.fingerprint || value.rewrites.length === 0) return reviewers

  const simpleById = new Map<string, string>()
  for (const r of value.rewrites) {
    if (!simpleById.has(r.id)) simpleById.set(r.id, r.simple)
  }

  let n = 0
  return reviewers.map((rev) => ({
    ...rev,
    findings: rev.findings.map((finding) => {
      const simple = simpleById.get(`f${n++}`)
      // No rewrite, or a rewrite that is byte-identical to the original
      // ("already minimal — returned unchanged") → the original object as-is,
      // so the card shows no toggle for an unchanged body.
      if (simple === undefined || simple === finding.body) return finding
      return { ...finding, simpleBody: simple }
    }),
  }))
}
