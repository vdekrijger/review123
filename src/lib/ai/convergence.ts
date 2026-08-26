/**
 * src/lib/ai/convergence.ts — cross-REVIEWER finding convergence (pure logic).
 *
 * Multiple reviewer personas often flag the SAME underlying issue at different
 * nearby lines (and a user's own draft comment may already make the point).
 * After all skill reviewers settle, one cheap LLM call clusters the surfaced
 * findings that describe the same underlying defect — across reviewers AND
 * against the user's existing draft comments. This module holds everything
 * about that pass EXCEPT the LLM call itself:
 *
 *   - enumerateFindings / enumerateDrafts — the deterministic, positional id
 *     scheme ("f0".."fN" / "draft-0"..) shared by prompt building AND merge
 *     application, plus a content FINGERPRINT so clusters computed against one
 *     finding set can never be mis-applied to another (retry / cache races).
 *   - validateConvergence — strict validation of the LLM's cluster output;
 *     anything invalid → null (the pass is skipped, originals render unmerged).
 *   - toAppliedClusters — resolves draft members into a concrete
 *     "covered by your comment on path:line" marker at compute time, so the
 *     stored value never depends on the live draft list again.
 *   - applyConvergence — the PURE merge: rebuilds the reviewers' finding lists
 *     with each cluster collapsed into its primary finding. Loss-proof by
 *     construction: it returns NEW arrays (input untouched), refuses to apply
 *     when the fingerprint doesn't match, and preserves every absorbed finding
 *     verbatim in `mergedFrom` (nothing is destroyed).
 *
 * No LLM, no network, no Svelte state — unit-testable in isolation.
 */

import type { SkillFinding, FindingVerification, AbsorbedFinding } from './schemas'

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** One reviewer's settled findings, in display order. */
export interface ReviewerFindings {
  skillId: string
  name: string
  findings: SkillFinding[]
}

/** Compact numbered finding row fed to the convergence prompt. */
export interface ConvergenceFindingInput {
  id: string
  reviewer: string
  path: string
  line: number | null
  severity: 'high' | 'medium' | 'low'
  body: string
}

/** Compact numbered draft row fed to the convergence prompt. */
export interface ConvergenceDraftInput {
  id: string
  path: string
  line: number
  body: string
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** Raw (validated) LLM output: clusters of item ids. */
export interface ConvergenceClusters {
  clusters: { members: string[]; primary: string; reason: string }[]
}

/**
 * One cluster ready to apply: finding ids only. `coveredBy` is present when the
 * cluster contained ≥1 of the user's own drafts — its findings are then marked
 * "covered by your comment" instead of being merged away.
 */
export interface AppliedCluster {
  /** Finding ids ("fN") in the cluster — draft members already resolved out. */
  members: string[]
  /** The primary finding id (its path/line/body win). */
  primary: string
  /** ≤100-char LLM reason for the cluster (may be empty). */
  reason: string
  /** Present when a user draft was in the cluster: where the draft sits. */
  coveredBy?: { path: string; line: number }
}

/**
 * The convergence pass result carried in run state + cache: the applied-form
 * clusters plus the FINGERPRINT of the exact finding set they were computed
 * against. applyConvergence refuses to act when fingerprints differ.
 */
export interface ConvergenceValue {
  fingerprint: string
  clusters: AppliedCluster[]
}

// ---------------------------------------------------------------------------
// Hashing (local djb2 — keeps this module dependency-free and pure)
// ---------------------------------------------------------------------------

function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

// ---------------------------------------------------------------------------
// Enumeration — the shared positional id scheme + fingerprint
// ---------------------------------------------------------------------------

/**
 * Enumerate every finding across the reviewers in a deterministic order
 * (reviewer order, then finding order) as ids "f0".."fN", and fingerprint the
 * enumerated content. BOTH the prompt build and the merge application use this,
 * so an id always refers to the same finding — and a changed finding set
 * (retry, edited skill) changes the fingerprint, which blocks stale clusters.
 */
export function enumerateFindings(reviewers: ReviewerFindings[]): {
  inputs: ConvergenceFindingInput[]
  fingerprint: string
} {
  const inputs: ConvergenceFindingInput[] = []
  const parts: string[] = []
  let n = 0
  for (const r of reviewers) {
    for (const f of r.findings) {
      const id = `f${n++}`
      inputs.push({ id, reviewer: r.name, path: f.path, line: f.line, severity: f.severity, body: f.body })
      parts.push(`${id}|${r.skillId}|${f.path}|${f.line}|${f.severity}|${f.body}`)
    }
  }
  return { inputs, fingerprint: hashString(parts.join('#')) }
}

/** Enumerate the user's drafts as ids "draft-0".."draft-N" + a fingerprint. */
export function enumerateDrafts(drafts: { path: string; line: number; body: string }[]): {
  inputs: ConvergenceDraftInput[]
  fingerprint: string
} {
  const inputs = drafts.map((d, i) => ({ id: `draft-${i}`, path: d.path, line: d.line, body: d.body }))
  const fingerprint = hashString(inputs.map((d) => `${d.id}|${d.path}|${d.line}|${d.body}`).join('#'))
  return { inputs, fingerprint }
}

// ---------------------------------------------------------------------------
// validateConvergence — strict; anything invalid → null (pass skipped)
// ---------------------------------------------------------------------------

const CONVERGENCE_REASON_MAX = 100

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Normalize one member id: accept "f3"/"draft-1" strings, or bare numbers as fN. */
function normalizeMemberId(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return `f${raw}`
  if (typeof raw === 'string' && raw.length > 0) return raw
  return null
}

/**
 * Validate an unknown value as ConvergenceClusters against the known item ids.
 *
 * Rules (any violation → null, the pass is skipped and originals render):
 *   - `clusters` must be an array (empty is VALID — "nothing overlaps").
 *   - every member id must exist (finding or draft); bare integers are
 *     tolerated as fN (models sometimes drop the prefix).
 *   - each cluster: ≥2 distinct members, ≥1 of them a FINDING (a cluster of
 *     drafts alone is meaningless), primary ∈ members.
 *   - clusters must be pairwise DISJOINT (an id in two clusters is garbage).
 *   - reason: string, truncated to 100 chars; missing/non-string → "".
 */
export function validateConvergence(
  x: unknown,
  findingIds: ReadonlySet<string>,
  draftIds: ReadonlySet<string>,
): ConvergenceClusters | null {
  if (!isObject(x)) return null
  const rawClusters = x['clusters']
  if (!Array.isArray(rawClusters)) return null

  const seen = new Set<string>()
  const clusters: ConvergenceClusters['clusters'] = []

  for (const rawCluster of rawClusters) {
    if (!isObject(rawCluster)) return null
    const rawMembers = rawCluster['members']
    if (!Array.isArray(rawMembers)) return null

    const members: string[] = []
    for (const rawMember of rawMembers) {
      const id = normalizeMemberId(rawMember)
      if (id === null) return null
      if (!findingIds.has(id) && !draftIds.has(id)) return null
      if (members.includes(id)) continue // tolerate in-cluster duplicates
      members.push(id)
    }
    if (members.length < 2) return null
    if (!members.some((m) => findingIds.has(m))) return null

    // Disjointness across clusters.
    for (const m of members) {
      if (seen.has(m)) return null
      seen.add(m)
    }

    const primary = normalizeMemberId(rawCluster['primary'])
    if (primary === null || !members.includes(primary)) return null

    const rawReason = rawCluster['reason']
    const reason = typeof rawReason === 'string' ? rawReason.slice(0, CONVERGENCE_REASON_MAX) : ''

    clusters.push({ members, primary, reason })
  }

  return { clusters }
}

// ---------------------------------------------------------------------------
// toAppliedClusters — resolve draft members at compute time
// ---------------------------------------------------------------------------

/**
 * Turn validated clusters into their applied form: draft members are resolved
 * into a concrete `coveredBy` location NOW (so the stored value never depends
 * on the live draft list again), and only finding ids remain as members. When
 * the LLM picked a draft as primary (or the cluster contains any draft), the
 * cluster means "already covered by the user's own comment" — its findings are
 * marked, not merged; the surviving `primary` is the first finding member.
 */
export function toAppliedClusters(
  validated: ConvergenceClusters,
  draftById: ReadonlyMap<string, { path: string; line: number }>,
): AppliedCluster[] {
  const applied: AppliedCluster[] = []
  for (const c of validated.clusters) {
    const findingMembers = c.members.filter((m) => !draftById.has(m))
    const draftMembers = c.members.filter((m) => draftById.has(m))
    if (findingMembers.length === 0) continue // defensive (validator forbids)
    if (draftMembers.length > 0) {
      const draft = draftById.get(draftMembers[0])!
      applied.push({
        members: findingMembers,
        primary: findingMembers.includes(c.primary) ? c.primary : findingMembers[0],
        reason: c.reason,
        coveredBy: { path: draft.path, line: draft.line },
      })
    } else if (findingMembers.length >= 2) {
      applied.push({ members: findingMembers, primary: c.primary, reason: c.reason })
    }
    // A finding-only "cluster" reduced to 1 member merges nothing → dropped.
  }
  return applied
}

// ---------------------------------------------------------------------------
// applyConvergence — the pure merge
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 }

/** Max severity across a cluster ("severity honesty" still holds — no invention). */
function maxSeverity(sevs: ('high' | 'medium' | 'low')[]): 'high' | 'medium' | 'low' {
  return sevs.reduce((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a))
}

/** Strength of a verification for "strongest wins": confirm ratio, absent → -1. */
function verificationStrength(v: FindingVerification | undefined): number {
  if (!v || v.polledModels <= 0) return v ? 0 : -1
  return v.confirmedBy / v.polledModels
}

/**
 * Apply the convergence clusters to the reviewers' finding lists. PURE and
 * loss-proof:
 *   - fingerprint mismatch (the finding set changed since the pass ran) →
 *     returns the input UNCHANGED — stale clusters are never applied.
 *   - merge clusters: the primary finding keeps its path/line/body; severity =
 *     max of the cluster; raisedBy = union; verification = strongest (highest
 *     confirmed ratio); every absorbed finding is preserved verbatim in
 *     `mergedFrom` (reviewer + location + body — nothing destroyed).
 *   - draft-covered clusters: findings are NOT removed — each is marked
 *     `coveredByDraft` so the card renders collapsed/de-emphasized instead of
 *     silently vanishing.
 * Returns NEW entry + finding objects; the input arrays are never mutated.
 */
export function applyConvergence(
  reviewers: ReviewerFindings[],
  value: ConvergenceValue,
): ReviewerFindings[] {
  const { fingerprint } = enumerateFindings(reviewers)
  if (fingerprint !== value.fingerprint || value.clusters.length === 0) return reviewers

  // Rebuild the positional id → (reviewer index, finding index) map.
  const byId = new Map<string, { r: number; f: number }>()
  let n = 0
  reviewers.forEach((rev, r) => {
    rev.findings.forEach((_finding, f) => {
      byId.set(`f${n++}`, { r, f })
    })
  })

  // Planned edits: replacements (primary / covered) and removals (absorbed).
  const replace = new Map<string, SkillFinding>() // id → new finding object
  const remove = new Set<string>() // absorbed ids

  for (const cluster of value.clusters) {
    // Defensive: every id must resolve (fingerprint match makes this certain).
    if (cluster.members.some((m) => !byId.get(m))) return reviewers

    if (cluster.coveredBy) {
      for (const id of cluster.members) {
        const pos = byId.get(id)!
        const original = reviewers[pos.r].findings[pos.f]
        replace.set(id, { ...original, coveredByDraft: { ...cluster.coveredBy } })
      }
      continue
    }

    const primaryPos = byId.get(cluster.primary)!
    const primaryFinding = reviewers[primaryPos.r].findings[primaryPos.f]
    const absorbedIds = cluster.members.filter((m) => m !== cluster.primary)

    const memberFindings = cluster.members.map((id) => {
      const pos = byId.get(id)!
      return { finding: reviewers[pos.r].findings[pos.f], reviewer: reviewers[pos.r].name }
    })

    // severity = max of the cluster.
    const severity = maxSeverity(memberFindings.map((m) => m.finding.severity))

    // raisedBy = union across the cluster (order: primary's first).
    const raisedBy = [...new Set(memberFindings.flatMap((m) => m.finding.raisedBy ?? []))]

    // verification = strongest; primary considered first so ties keep it.
    let verification = primaryFinding.verification
    let best = verificationStrength(verification)
    for (const m of memberFindings) {
      const s = verificationStrength(m.finding.verification)
      if (s > best) {
        best = s
        verification = m.finding.verification
      }
    }

    // Absorbed findings preserved verbatim (reviewer + path:line + body +
    // their own suggestedFix — the merge destroys nothing, fixes included).
    const mergedFrom: AbsorbedFinding[] = absorbedIds.map((id) => {
      const pos = byId.get(id)!
      const f = reviewers[pos.r].findings[pos.f]
      return {
        reviewer: reviewers[pos.r].name,
        path: f.path,
        line: f.line,
        severity: f.severity,
        body: f.body,
        ...(f.suggestedFix ? { suggestedFix: f.suggestedFix } : {}),
      }
    })

    // suggestedFix: the PRIMARY's wins (its path/line/body already anchor the
    // card). When the primary arrived without one, adopt the first member's
    // fix (cluster order) so the merged card still carries a fix; the absorbed
    // fixes are preserved verbatim in mergedFrom either way.
    const suggestedFix =
      primaryFinding.suggestedFix ??
      memberFindings.find((m) => m.finding.suggestedFix)?.finding.suggestedFix

    replace.set(cluster.primary, {
      ...primaryFinding,
      severity,
      ...(suggestedFix ? { suggestedFix } : {}),
      ...(raisedBy.length > 0 ? { raisedBy } : {}),
      ...(verification ? { verification } : {}),
      mergedFrom,
      ...(cluster.reason ? { mergedReason: cluster.reason } : {}),
    })
    for (const id of absorbedIds) remove.add(id)
  }

  // Rebuild each reviewer's list with the planned edits.
  let m = 0
  return reviewers.map((rev) => ({
    ...rev,
    findings: rev.findings.flatMap((finding) => {
      const id = `f${m++}`
      if (remove.has(id)) return []
      const replacement = replace.get(id)
      return [replacement ?? finding]
    }),
  }))
}

// ---------------------------------------------------------------------------
// mergedReviewerLabel — display credit for a merged card / its draft
// ---------------------------------------------------------------------------

const MERGED_LABEL_MAX = 60

/**
 * The reviewer credit for a merged finding: the primary reviewer plus every
 * absorbed finding's reviewer, deduped, joined "A · B". Falls back to
 * "N reviewers" when the joined label would be unwieldy (>3 names or >60 chars).
 * With no mergedFrom (or only same-reviewer absorbed findings) → primary name.
 */
export function mergedReviewerLabel(primaryName: string, mergedFrom: readonly { reviewer: string }[] | undefined): string {
  const names = [primaryName]
  for (const m of mergedFrom ?? []) {
    if (!names.includes(m.reviewer)) names.push(m.reviewer)
  }
  if (names.length === 1) return primaryName
  const joined = names.join(' · ')
  if (names.length > 3 || joined.length > MERGED_LABEL_MAX) return `${names.length} reviewers`
  return joined
}
