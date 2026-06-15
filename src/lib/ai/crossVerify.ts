/**
 * src/lib/ai/crossVerify.ts — cross-model verification engine (Plan M).
 *
 * After the active ("generator") model raises review findings, the user's OTHER
 * configured providers independently JUDGE each finding adversarially. Findings
 * that survive cross-model agreement are surfaced; findings only the generator
 * believes are demoted into a "lower confidence" group. "Fusion beats frontier":
 * convergence surfaces, divergence demotes — higher precision, less fatigue.
 *
 * Pure orchestration over an injected verify function (real impl wraps
 * llmJsonWithRepairFor against each verifier provider config). The transport,
 * keys, and proxy routing all live in the llm layer; this module only builds the
 * adversarial prompt, fans out to verifiers in parallel, and aggregates votes.
 */

import type { LlmUsage } from '../llm/llm'
import type { ProviderConfig } from '../llm/llm'
import type { FindingVerdict, FindingVerification } from './schemas'
import { type Lens, lensFraming } from './lenses'
import { findingsMatch, type AnchoredFinding } from './findingMatch'

// ---------------------------------------------------------------------------
// Prompt version note: bumped in tasks.ts (PROMPT_VERSION) when this prompt or
// the aggregation changes, so cached verified results invalidate.
// ---------------------------------------------------------------------------

/** A finding handed to verification — minimal, code-anchored. */
export interface VerifiableFinding {
  /** Stable id used to correlate a verifier's verdict back to its finding. */
  id: string
  path: string
  line: number | null
  severity: 'high' | 'medium' | 'low'
  body: string
  /** Hunk excerpt around path:line (coachContext-style). '' when unavailable. */
  excerpt?: string
  /** Wider numbered file window around the line, when available. */
  fileWindow?: string
}

/** One verifier's judgement on a single finding. */
export interface VerifierVerdict {
  id: string
  verdict: 'confirm' | 'refute' | 'uncertain'
  reason: string
}

/** Validated verifier response: a verdict per finding id. */
export interface VerifierResponse {
  verdicts: VerifierVerdict[]
}

/**
 * The injected per-verifier call. Returns the verifier's verdicts + usage, or
 * throws (a failing verifier is skipped — its vote omitted, never blocks). The
 * optional `lens` (Plan O Part B) specializes the prompt framing for this
 * verifier; the real impl threads it into buildVerifyPrompt.
 */
export type VerifyFn = (
  cfg: ProviderConfig,
  findings: VerifiableFinding[],
  lens?: Lens,
) => Promise<{ result: VerifierResponse; usage?: LlmUsage }>

/** A finding with its aggregated verification attached. */
export interface VerifiedFinding {
  id: string
  verification: FindingVerification
}

/** Per-participant token usage (Plan N per-model cost attribution). */
export interface ParticipantUsage {
  providerId: string
  /** Model id this usage belongs to — distinguishes same-provider models. */
  modelId: string
  usage: LlmUsage
}

/**
 * One verifier's per-review IMPACT (Plan N). `decisive` counts findings whose
 * surface/demote outcome FLIPS when this verifier's vote is removed — the
 * keep-this/drop-that signal. A verifier that only rubber-stamps consensus has
 * many confirms but 0 decisive votes.
 */
export interface VerifierImpact {
  providerId: string
  modelId: string
  confirms: number
  refutes: number
  uncertains: number
  decisive: number
  /** Lens this verifier judged through (Plan O Part B). Absent in 'verify' mode. */
  lens?: Lens
}

export interface CrossVerifyOutcome {
  /** Per-finding verification keyed by finding id. Empty when no verifier ran. */
  byId: Map<string, FindingVerification>
  /** Summed verifier usage (for token-cost totals). */
  usage: LlmUsage | undefined
  /** Per-verifier-model usage (Plan N per-model cost). One entry per responder. */
  perModelUsage: ParticipantUsage[]
  /** Per-verifier impact (Plan N). One entry per responder. */
  verifierImpact: VerifierImpact[]
  /** Verifier providers that actually responded (for the progress line). */
  respondedProviders: string[]
}

// ---------------------------------------------------------------------------
// Adversarial verify prompt
// ---------------------------------------------------------------------------

export function buildVerifyPrompt(
  findings: VerifiableFinding[],
  lens?: Lens,
): {
  system: string
  user: string
} {
  // Plan O Part B: when a lens is assigned, the verifier judges findings THROUGH
  // that lens (decorrelating verifier errors). Without a lens the prompt is the
  // Plan M adversarial prompt verbatim (byte-identical for 'verify' mode).
  const lensLine = lens ? `\n\n${lensFraming(lens)}` : ''
  const system = `You are an ADVERSARIAL verifier auditing another AI reviewer's findings on a \
pull request. For EACH finding, decide whether it is a REAL, code-grounded issue worth \
surfacing to a human reviewer — or noise.${lensLine}

Default to "refute" or "uncertain". Only "confirm" when the provided code clearly shows the \
issue is real and matters. A finding is NOT confirmable when:
- the claim is not supported by the provided code (excerpt / fileWindow), or contradicts it;
- it is a nitpick, style preference, or moot/unchanged-code observation;
- it is speculative ("could", "might") with no concrete evidence in the code;
- you cannot tell from the provided context (then "uncertain", never "confirm").

You are scoring whether a tired reviewer would thank you for surfacing it. Be strict: a false \
positive wastes their attention.

Respond with JSON ONLY — no markdown, no fences, no prose outside the object:

{
  "verdicts": [
    { "id": "<finding id>", "verdict": "confirm" | "refute" | "uncertain", "reason": "<≤1 sentence>" }
  ]
}

Rules:
- One verdict per finding id provided. Do not invent ids.
- reason: at most one sentence; for "refute"/"uncertain" say briefly why.`

  const payload = {
    findings: findings.map((f) => ({
      id: f.id,
      path: f.path,
      line: f.line,
      severity: f.severity,
      body: f.body,
      ...(f.excerpt ? { excerpt: f.excerpt } : {}),
      ...(f.fileWindow ? { fileWindow: f.fileWindow } : {}),
    })),
  }
  return { system, user: JSON.stringify(payload, null, 2) }
}

// ---------------------------------------------------------------------------
// Validator for a verifier's JSON response
// ---------------------------------------------------------------------------

const VERDICT_VALUES = new Set<string>(['confirm', 'refute', 'uncertain'])

export function validateVerifierResponse(x: unknown): VerifierResponse | null {
  if (typeof x !== 'object' || x === null) return null
  const obj = x as Record<string, unknown>
  if (!Array.isArray(obj['verdicts'])) return null
  const verdicts: VerifierVerdict[] = []
  for (const v of obj['verdicts']) {
    if (typeof v !== 'object' || v === null) return null
    const vo = v as Record<string, unknown>
    if (typeof vo['id'] !== 'string') return null
    if (typeof vo['verdict'] !== 'string' || !VERDICT_VALUES.has(vo['verdict'])) return null
    const reason = typeof vo['reason'] === 'string' ? vo['reason'] : ''
    verdicts.push({ id: vo['id'], verdict: vo['verdict'] as VerifierVerdict['verdict'], reason })
  }
  return { verdicts }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Numeric weight of a vote: confirm = 1, uncertain = 0.5 (neutral), refute = 0. */
function voteWeight(verdict: 'confirm' | 'refute' | 'uncertain'): number {
  if (verdict === 'confirm') return 1
  if (verdict === 'uncertain') return 0.5
  return 0
}

/**
 * Aggregate the generator's implicit confirm with each verifier's verdict for
 * one finding and decide surface vs demote.
 *
 * Threshold: SURFACE iff score >= polled / 2 — at least half of all polled
 * models (generator counted as 1 confirm, uncertain as a neutral 0.5) back it.
 * Ties go to surface (one dissent should not bury a real finding). Intent:
 * convergence surfaces, divergence demotes.
 */
export function aggregateFinding(
  generatorProvider: string,
  verifierVotes: { provider: string; verdict: 'confirm' | 'refute' | 'uncertain'; reason: string }[],
): FindingVerification {
  const perModel: FindingVerdict[] = [
    { provider: generatorProvider, verdict: 'confirm', reason: '' },
  ]
  let score = 1 // generator's implicit confirm
  let confirmedBy = 1
  for (const v of verifierVotes) {
    perModel.push({ provider: v.provider, verdict: v.verdict, reason: v.reason })
    score += voteWeight(v.verdict)
    if (v.verdict === 'confirm') confirmedBy += 1
  }
  const polledModels = 1 + verifierVotes.length
  const surfaced = score >= polledModels / 2
  return { confirmedBy, polledModels, surfaced, perModel }
}

/**
 * Multi-raiser aggregation (Plan O Part A). Generalizes `aggregateFinding` to a
 * finding raised by ONE OR MORE generators: each raiser is an implicit confirm,
 * the non-raising participants verify it.
 *
 *   score  = raiserCount + Σ verifierVoteWeight(uncertain = 0.5)
 *   polled = totalParticipants  (raisers + verifiers that responded)
 *   surface iff score >= polled / 2  (ties surface — same as Plan M).
 *
 * Recall win: a finding ONE model raised but OTHERS confirm now clears the bar;
 * one raised + others refute demotes. With raiserCount === 1 this reduces EXACTLY
 * to `aggregateFinding` — `aggregateFinding` is the 1-raiser delegating wrapper.
 *
 * @param raisers  display names/ids of the models that RAISED this finding.
 * @param verifierVotes  votes from the participants that did NOT raise it.
 * @param totalParticipants  raisers + responding verifiers (the poll size).
 */
export function aggregateMultiRaiser(
  raisers: string[],
  verifierVotes: { provider: string; verdict: 'confirm' | 'refute' | 'uncertain'; reason: string }[],
  totalParticipants: number,
): FindingVerification {
  const perModel: FindingVerdict[] = raisers.map((provider) => ({
    provider,
    verdict: 'confirm' as const,
    reason: '',
  }))
  let score = raisers.length
  let confirmedBy = raisers.length
  for (const v of verifierVotes) {
    perModel.push({ provider: v.provider, verdict: v.verdict, reason: v.reason })
    score += voteWeight(v.verdict)
    if (v.verdict === 'confirm') confirmedBy += 1
  }
  const polledModels = Math.max(totalParticipants, raisers.length + verifierVotes.length)
  const surfaced = score >= polledModels / 2
  return { confirmedBy, polledModels, surfaced, perModel }
}

/** The surface decision for a vote set (generator + given verifier votes). */
function decideSurface(
  verifierVotes: { verdict: 'confirm' | 'refute' | 'uncertain' }[],
): boolean {
  let score = 1 // generator's implicit confirm
  for (const v of verifierVotes) score += voteWeight(v.verdict)
  const polled = 1 + verifierVotes.length
  return score >= polled / 2
}

/**
 * Whether a single verifier's vote was DECISIVE for one finding (Plan N): the
 * surface/demote decision FLIPS when that verifier's vote is removed from the
 * tally. A redundant confirm on a finding that surfaces regardless is NOT
 * decisive; a refute that tips a finding from surface to demote IS.
 *
 * @param votes  all verifier votes for the finding, in order.
 * @param index  the position of the voter under test.
 */
export function isDecisiveVote(
  votes: { verdict: 'confirm' | 'refute' | 'uncertain' }[],
  index: number,
): boolean {
  const withVote = decideSurface(votes)
  const without = decideSurface(votes.filter((_, i) => i !== index))
  return withVote !== without
}

// ---------------------------------------------------------------------------
// crossVerify — orchestrate fan-out + aggregation
// ---------------------------------------------------------------------------

function sumUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  }
}

/**
 * Run cross-model verification over a set of findings.
 *
 * @param findings  the generated findings to verify (already code-anchored).
 * @param generatorProvider  display name / id of the active generator (its
 *   implicit confirm).
 * @param verifiers  verifier provider configs (already excludes the generator).
 * @param verify  injected per-verifier call.
 * @param lenses  optional per-verifier lens assignment (Plan O Part B), index-
 *   aligned with `verifiers`. When omitted, verifiers run the plain adversarial
 *   prompt (byte-identical to Plan M 'verify' mode).
 * @returns per-finding verification, summed usage, and which verifiers responded.
 *
 * Graceful: a verifier that throws is skipped (its votes omitted, polledModels
 * reflects only responders). When NO verifier responds, byId is empty — the
 * caller leaves findings unverified (no chip, no demotion).
 */
export async function crossVerify(
  findings: VerifiableFinding[],
  generatorProvider: string,
  verifiers: ProviderConfig[],
  verify: VerifyFn,
  lenses?: Lens[],
): Promise<CrossVerifyOutcome> {
  const empty: CrossVerifyOutcome = {
    byId: new Map(),
    usage: undefined,
    perModelUsage: [],
    verifierImpact: [],
    respondedProviders: [],
  }
  if (findings.length === 0 || verifiers.length === 0) return empty

  const results = await Promise.allSettled(
    verifiers.map((cfg, i) => verify(cfg, findings, lenses?.[i])),
  )

  // Collect per-finding verifier votes; track usage + responders. Votes are
  // pushed in RESPONDER order (matching `responders` below) so the vote index
  // lines up with the responder for decisiveness attribution.
  const votesByFinding = new Map<
    string,
    { provider: string; verdict: 'confirm' | 'refute' | 'uncertain'; reason: string }[]
  >()
  for (const f of findings) votesByFinding.set(f.id, [])

  let usage: LlmUsage | undefined
  const respondedProviders: string[] = []
  const responders: ProviderConfig[] = []
  const responderLenses: (Lens | undefined)[] = []
  const perModelUsage: ParticipantUsage[] = []

  results.forEach((res, i) => {
    if (res.status !== 'fulfilled') return // verifier failed → skip its votes
    const cfg = verifiers[i]
    respondedProviders.push(cfg.providerId)
    responders.push(cfg)
    responderLenses.push(lenses?.[i])
    usage = sumUsage(usage, res.value.usage)
    if (res.value.usage) {
      perModelUsage.push({ providerId: cfg.providerId, modelId: cfg.model.id, usage: res.value.usage })
    }
    const byId = new Map<string, VerifierVerdict>()
    for (const v of res.value.result.verdicts) byId.set(v.id, v)
    for (const f of findings) {
      const v = byId.get(f.id)
      // A verifier that omits a finding → treat as 'uncertain' (neutral),
      // so a sloppy verifier neither buries nor inflates a finding.
      const verdict = v?.verdict ?? 'uncertain'
      const reason = v?.reason ?? 'no verdict returned'
      votesByFinding.get(f.id)!.push({ provider: cfg.providerId, verdict, reason })
    }
  })

  // No verifier responded → leave everything unverified.
  if (respondedProviders.length === 0) return empty

  const out = new Map<string, FindingVerification>()
  for (const f of findings) {
    out.set(f.id, aggregateFinding(generatorProvider, votesByFinding.get(f.id)!))
  }

  // Per-verifier impact (Plan N): confirms/refutes/uncertains + decisive votes.
  const verifierImpact: VerifierImpact[] = responders.map((cfg, idx) => ({
    providerId: cfg.providerId,
    modelId: cfg.model.id,
    confirms: 0,
    refutes: 0,
    uncertains: 0,
    decisive: 0,
    ...(responderLenses[idx] ? { lens: responderLenses[idx] } : {}),
    _idx: idx,
  })).map((row) => {
    for (const f of findings) {
      const votes = votesByFinding.get(f.id)!
      const vote = votes[row._idx]
      if (!vote) continue
      if (vote.verdict === 'confirm') row.confirms += 1
      else if (vote.verdict === 'refute') row.refutes += 1
      else row.uncertains += 1
      if (isDecisiveVote(votes, row._idx)) row.decisive += 1
    }
    const { _idx, ...rest } = row
    void _idx
    return rest
  })

  return { byId: out, usage, perModelUsage, verifierImpact, respondedProviders }
}

// ---------------------------------------------------------------------------
// Multi-generator fusion (Plan O Part A) — RECALL
//
// Each ensemble participant generates findings independently. The union is
// dedup-merged (findings referring to the same issue collapse, attributed to
// all raisers via `raisedBy`). Each merged finding is then cross-confirmed by
// the participants that did NOT raise it (the raisers are implicit confirms),
// using the same lensed verify fan-out as crossVerify. A finding only one model
// raised but others CONFIRM now surfaces (the recall win); one others refute
// demotes.
// ---------------------------------------------------------------------------

/** One generator's produced findings, tagged with that generator's identity. */
export interface GeneratorFindings {
  /** Display name / id of the generator (e.g. provider displayName). */
  generator: string
  /** Provider+model that generated, for per-model cost/impact attribution. */
  cfg: ProviderConfig
  findings: VerifiableFinding[]
}

/** A merged finding after union-dedup across generators. */
export interface MergedFinding {
  /** Stable merged id (the representative finding's id). */
  id: string
  /** Representative finding (highest severity raiser; ties → first). */
  finding: VerifiableFinding
  /** Display names of every generator that raised this (≥1). */
  raisedBy: string[]
  /** ProviderConfigs of the raisers (index-aligned with raisedBy). */
  raiserCfgs: ProviderConfig[]
}

/** Per-generator impact in fusion (Plan O): generation usage + unique catches. */
export interface GeneratorImpact {
  providerId: string
  modelId: string
  generator: string
  /** Findings this generator raised that SURVIVED (surfaced). */
  surfaced: number
  /** Of those, findings ONLY this generator raised (others missed). The recall headline. */
  uniqueCatch: number
}

export interface FusionOutcome {
  /** Merged findings with their aggregated verification, in surface-then-demote order. */
  merged: { merged: MergedFinding; verification: FindingVerification }[]
  /** Summed verifier usage across all cross-confirm calls. */
  usage: LlmUsage | undefined
  /** Per-verifier usage (one entry per responding verifier-model). */
  perModelUsage: ParticipantUsage[]
  /** Per-generator impact (surfaced + uniqueCatch). */
  generatorImpact: GeneratorImpact[]
  /** Verifier providers that responded across the fusion. */
  respondedProviders: string[]
}

const SEVERITY_RANK: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 }

function anchor(f: VerifiableFinding): AnchoredFinding {
  return { file: f.path, line: f.line, description: f.body }
}

/**
 * Merge per-generator findings into a deduped union. Findings that refer to the
 * SAME issue (file + line proximity + fuzzy description, via findingsMatch)
 * collapse into one `MergedFinding` attributed to every raiser. Grouping is
 * transitive: A~B and B~C put A, B, C in one group even if A and C don't match
 * directly. The representative is the highest-severity finding in the group.
 */
export function mergeGeneratorFindings(generators: GeneratorFindings[]): MergedFinding[] {
  // Flatten with provenance.
  type Tagged = { f: VerifiableFinding; generator: string; cfg: ProviderConfig }
  const all: Tagged[] = []
  for (const g of generators) {
    for (const f of g.findings) all.push({ f, generator: g.generator, cfg: g.cfg })
  }

  // Union-find over indices by pairwise match.
  const parent = all.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (findingsMatch(anchor(all[i].f), anchor(all[j].f))) union(i, j)
    }
  }

  // Collect groups by root.
  const groups = new Map<number, number[]>()
  for (let i = 0; i < all.length; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(i)
  }

  const merged: MergedFinding[] = []
  for (const idxs of groups.values()) {
    // Representative = highest severity (ties → first in encounter order).
    let repIdx = idxs[0]
    for (const i of idxs) {
      if (SEVERITY_RANK[all[i].f.severity] > SEVERITY_RANK[all[repIdx].f.severity]) repIdx = i
    }
    // Distinct raisers (a generator that raised the issue twice counts once).
    const seen = new Set<string>()
    const raisedBy: string[] = []
    const raiserCfgs: ProviderConfig[] = []
    for (const i of idxs) {
      if (seen.has(all[i].generator)) continue
      seen.add(all[i].generator)
      raisedBy.push(all[i].generator)
      raiserCfgs.push(all[i].cfg)
    }
    merged.push({ id: all[repIdx].f.id, finding: all[repIdx].f, raisedBy, raiserCfgs })
  }
  return merged
}

/**
 * Cross-confirm a merged union (Plan O Part A). For each merged finding, the
 * participants that did NOT raise it verify it (lensed); raisers are implicit
 * confirms. Surfaces via aggregateMultiRaiser. Returns merged findings with
 * verification + per-generator impact (surfaced, uniqueCatch).
 *
 * @param merged  the deduped union from mergeGeneratorFindings.
 * @param participants  ALL ensemble participants (each can verify findings it
 *   didn't raise). The total poll size per finding is the participant count.
 * @param verify  injected per-participant verify call (same VerifyFn shape).
 * @param lensFor  optional lens per participant id (index-aligned with participants).
 */
export async function fuseConfirm(
  merged: MergedFinding[],
  participants: { generator: string; cfg: ProviderConfig }[],
  verify: VerifyFn,
  lenses?: Lens[],
): Promise<FusionOutcome> {
  const empty: FusionOutcome = {
    merged: [],
    usage: undefined,
    perModelUsage: [],
    generatorImpact: [],
    respondedProviders: [],
  }
  if (merged.length === 0 || participants.length === 0) return empty

  // For each participant, the subset of merged findings it did NOT raise (it
  // verifies those). A participant raises a finding iff its generator name is in
  // raisedBy.
  const totalParticipants = participants.length

  // Fan out: each participant verifies the findings it didn't raise. We send the
  // full union and ignore verdicts on findings the participant raised (it's an
  // implicit confirm there).
  const results = await Promise.allSettled(
    participants.map((p, i) =>
      verify(
        p.cfg,
        merged.map((m) => m.finding),
        lenses?.[i],
      ),
    ),
  )

  // votesByFinding[mergedId] = verifier votes from NON-raisers that responded.
  const votesByFinding = new Map<string, { provider: string; verdict: 'confirm' | 'refute' | 'uncertain'; reason: string }[]>()
  for (const m of merged) votesByFinding.set(m.id, [])

  let usage: LlmUsage | undefined
  const respondedProviders: string[] = []
  const perModelUsage: ParticipantUsage[] = []

  results.forEach((res, i) => {
    if (res.status !== 'fulfilled') return
    const p = participants[i]
    respondedProviders.push(p.cfg.providerId)
    usage = sumUsage(usage, res.value.usage)
    if (res.value.usage) {
      perModelUsage.push({ providerId: p.cfg.providerId, modelId: p.cfg.model.id, usage: res.value.usage })
    }
    const byId = new Map<string, VerifierVerdict>()
    for (const v of res.value.result.verdicts) byId.set(v.id, v)
    for (const m of merged) {
      if (m.raisedBy.includes(p.generator)) continue // raiser → implicit confirm, skip vote
      const v = byId.get(m.id)
      const verdict = v?.verdict ?? 'uncertain'
      const reason = v?.reason ?? 'no verdict returned'
      votesByFinding.get(m.id)!.push({ provider: p.cfg.providerId, verdict, reason })
    }
  })

  if (respondedProviders.length === 0) return empty

  const scored = merged.map((m) => ({
    merged: m,
    verification: aggregateMultiRaiser(m.raisedBy, votesByFinding.get(m.id)!, totalParticipants),
  }))

  // Per-generator impact: surfaced (raised + survived), uniqueCatch (raised ALONE + survived).
  const genImpact = new Map<string, GeneratorImpact>()
  for (const p of participants) {
    genImpact.set(p.generator, {
      providerId: p.cfg.providerId,
      modelId: p.cfg.model.id,
      generator: p.generator,
      surfaced: 0,
      uniqueCatch: 0,
    })
  }
  for (const s of scored) {
    if (!s.verification.surfaced) continue
    const soleRaiser = s.merged.raisedBy.length === 1
    for (const raiser of s.merged.raisedBy) {
      const imp = genImpact.get(raiser)
      if (!imp) continue
      imp.surfaced += 1
      if (soleRaiser) imp.uniqueCatch += 1
    }
  }

  // Order: surfaced first (stable), then demoted.
  scored.sort((a, b) => Number(b.verification.surfaced) - Number(a.verification.surfaced))

  return {
    merged: scored,
    usage,
    perModelUsage,
    generatorImpact: [...genImpact.values()],
    respondedProviders,
  }
}
