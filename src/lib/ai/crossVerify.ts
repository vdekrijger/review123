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
import { findingsMatch, type AnchoredFinding } from './findingMatch'

// ---------------------------------------------------------------------------
// Prompt version note: when this prompt or the aggregation changes, bump the
// entries of the tasks it verifies in tasks.ts (PROMPT_VERSIONS — 'skills' and
// 'verdict'), so their cached verified results invalidate.
// ---------------------------------------------------------------------------

/**
 * Whether a finding is grounded in the diff or hinges on EXTERNAL evidence —
 * an absence/existence claim about code OUTSIDE the shown diff (no test, not
 * called, not handled/validated, missing guard/index/handler). 'needs-external'
 * findings are the false-positive class this harness suppresses: they can only
 * surface at full confidence when their absence is POSITIVELY verified (by a
 * tool-backed check, when tools are available) — otherwise they are demoted.
 */
export type ClaimType = 'in-diff' | 'needs-external'

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
  /**
   * External-evidence classification (Part B). Optional — when omitted the
   * caller may classify on the fly with classifyClaim(body). 'needs-external'
   * findings are demoted unless their absence is positively verified.
   */
  claimType?: ClaimType
}

// ---------------------------------------------------------------------------
// External-evidence (absence-claim) classification
// ---------------------------------------------------------------------------

/**
 * Phrasings that mark a finding as an ABSENCE / EXTERNAL-EVIDENCE claim — one
 * that asserts something OUTSIDE the shown diff does not exist (a test, a
 * caller, a handler, a guard/index). Matched case-insensitively against the
 * finding body. Deliberately broad but anchored on the verb so ordinary
 * in-diff findings ("handles the null case", "validates input") do not trip it.
 */
const ABSENCE_CLAIM_PATTERNS: RegExp[] = [
  // tests / coverage
  /\bno\s+test\b/i,
  /\bnot\s+tested\b/i,
  /\buntested\b/i,
  /\bno\s+(?:test\s+)?coverage\b/i,
  /\b(?:test|tests)\s+(?:is|are)\s+missing\b/i,
  /\bmissing\s+(?:an?\s+)?(?:unit\s+|integration\s+)?tests?\b/i,
  /\bno\s+test\s+(?:verifies|covers|exercises|asserts)\b/i,
  // callers / usage
  /\bnot\s+called\b/i,
  /\bnever\s+called\b/i,
  /\bnot\s+used\b/i,
  /\bnever\s+used\b/i,
  /\bunused\b/i,
  /\bno\s+(?:callers?|consumers?|references?)\b/i,
  // handling / validation / guards
  /\bnot\s+handled\b/i,
  /\bunhandled\b/i,
  /\bnot\s+validated\b/i,
  /\bnot\s+sanitized\b/i,
  /\bmissing\s+(?:an?\s+)?(?:guard|check|handler|validation|index|migration|null\s+check|error\s+handl)/i,
  /\bno\s+(?:guard|handler|validation|index|migration|error\s+handling)\b/i,
  // "unless … not visible in the diff" shape
  /\bunless\b[^.]*\b(?:not\s+visible|not\s+shown|outside|elsewhere|custom\s+(?:exception\s+)?handler)\b/i,
  /\bnot\s+visible\s+(?:in|from)\s+the\s+diff\b/i,
]

/**
 * Classify a finding body as 'needs-external' (an absence/external-evidence
 * claim that hinges on code outside the diff) or 'in-diff' (an ordinary
 * diff-local finding). Detection lives in the VERIFY step (not a generator tag)
 * because it is the simpler, robust path: it needs no generator-prompt change,
 * works on cached/older findings, and applies uniformly to verdict evidence and
 * skill findings alike. Pure + cheap (regex over the body).
 */
export function classifyClaim(body: string): ClaimType {
  for (const re of ABSENCE_CLAIM_PATTERNS) {
    if (re.test(body)) return 'needs-external'
  }
  return 'in-diff'
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
 * throws (a failing verifier is skipped — its vote omitted, never blocks). Every
 * verifier runs the SAME comprehensive adversarial prompt; decorrelation comes
 * from MODEL/PROVIDER diversity, not from per-judge framing.
 */
export type VerifyFn = (
  cfg: ProviderConfig,
  findings: VerifiableFinding[],
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

/**
 * The COMPREHENSIVE adversarial framing every verifier reads. It weighs ALL five
 * review dimensions at once (so a real defect under ANY one is caught) — folding
 * the concrete per-dimension wording that used to live in per-lens framings into
 * a single strong prompt. Decorrelation comes from MODEL/PROVIDER diversity, not
 * from blinkering each judge through one narrow lens.
 */
export const COMPREHENSIVE_VERIFY_FRAMING = `Judge each finding skeptically across ALL of these \
dimensions — confirm when the code clearly shows a real defect under ANY of them:
- CORRECTNESS: logic errors, off-by-one and boundary mistakes, null/undefined handling, wrong \
conditionals, broken control flow, incorrect edge-case behavior.
- SECURITY: injection (SQL/command/XSS), missing authentication/authorization, leaked or \
hard-coded secrets, unsafe deserialization, path traversal, SSRF — a real, exploitable risk.
- PERFORMANCE: N+1 queries, unbounded loops or allocations, work inside hot paths, blocking I/O, \
resource leaks, missing pagination or limits — a real problem that matters at scale.
- REPRODUCIBILITY: would this issue ACTUALLY trigger? Is the claim grounded in the provided \
diff/code, or speculative? Trace the conditions needed to hit it.
- MAINTAINABILITY: confusing or duplicated logic, leaky abstractions, missing error handling at \
real boundaries, names that mislead, structure that will break under change — issues that would \
genuinely cost a future maintainer, not mere style preference.

ABSENCE / EXTERNAL-EVIDENCE CLAIMS (REFUTE-BY-DEFAULT — the burden of proof is on the finding): \
a claim that something ELSEWHERE does not exist — "no test verifies/covers X", "X is not called/\
unused", "not handled/validated", "missing a guard/index/handler", or "the assertion fails UNLESS \
some handler not visible in the diff rewrites it" — hinges on code that is NOT in the provided \
context. The diff/excerpt NOT showing a test, caller, handler, or index is NOT proof it is absent \
(it almost certainly lives in another file you were not given). For such a finding you MUST return \
"refute" or "uncertain" UNLESS the provided context itself positively establishes the absence — \
NEVER "confirm" a plausible-sounding absence you cannot actually verify. Suppressing an \
unsubstantiated absence claim is the correct outcome.`

export function buildVerifyPrompt(findings: VerifiableFinding[]): {
  system: string
  user: string
} {
  const system = `You are an ADVERSARIAL verifier auditing another AI reviewer's findings on a \
pull request. For EACH finding, decide whether it is a REAL, code-grounded issue worth \
surfacing to a human reviewer — or noise.

${COMPREHENSIVE_VERIFY_FRAMING}

Default to "refute" or "uncertain". Only "confirm" when the provided code clearly shows the \
issue is real and matters under at least one of those dimensions. A finding is NOT confirmable when:
- the claim is not supported by the provided code (excerpt / fileWindow), or contradicts it;
- it is a nitpick, style preference, or moot/unchanged-code observation;
- it is speculative ("could", "might") with no concrete evidence in the code;
- it asserts an ABSENCE of something elsewhere (no test, not called, not handled/validated, \
missing guard/index/handler) that the provided context does NOT positively establish — the diff \
not showing it is not proof; return "refute" or "uncertain", never "confirm";
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

/**
 * A collected verifier vote, carrying the model for the tooltip (Plan M
 * verify-tooltip). `model` is optional so old call shapes still compile; the
 * assembly sites populate it from the verifier participant config.
 */
type VerifierVote = {
  provider: string
  verdict: 'confirm' | 'refute' | 'uncertain'
  reason: string
  model?: string
}

/** Numeric weight of a vote: confirm = 1, uncertain = 0.5 (neutral), refute = 0. */
function voteWeight(verdict: 'confirm' | 'refute' | 'uncertain'): number {
  if (verdict === 'confirm') return 1
  if (verdict === 'uncertain') return 0.5
  return 0
}

/**
 * Absence-claim demotion (Part B). A 'needs-external' finding must be DEMOTED
 * (surfaced=false) unless its absence was POSITIVELY verified — i.e. a
 * tool-backed check (search_code / find_references / read_file) actually
 * confirmed the test/caller/handler is missing. Without that positive
 * confirmation, the plausible-but-unverified absence is suppressed so the
 * "✓ confirmed" chip only shows when the absence was really checked. For
 * 'in-diff' findings (the default) this is a no-op — the normal vote threshold
 * decides. When `absence` is omitted the function behaves exactly as before.
 */
export interface AbsenceOpts {
  claimType: ClaimType
  /** True iff a tool-backed check positively confirmed the absence. */
  toolConfirmed: boolean
}

/** Apply the absence-claim floor to a vote-threshold surface decision. */
function applyAbsenceFloor(surfaced: boolean, absence?: AbsenceOpts): boolean {
  if (!absence || absence.claimType !== 'needs-external') return surfaced
  // needs-external surfaces at full confidence ONLY when its absence was
  // positively tool-confirmed; otherwise it is demoted regardless of votes.
  return surfaced && absence.toolConfirmed
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
  verifierVotes: VerifierVote[],
  generatorModel?: string,
  absence?: AbsenceOpts,
): FindingVerification {
  const perModel: FindingVerdict[] = [
    // Generator/raiser row: carries its model + `raised` (it raised, not verified).
    { provider: generatorProvider, verdict: 'confirm', reason: '', raised: true, ...(generatorModel ? { model: generatorModel } : {}) },
  ]
  let score = 1 // generator's implicit confirm
  let confirmedBy = 1
  for (const v of verifierVotes) {
    perModel.push({
      provider: v.provider,
      verdict: v.verdict,
      reason: v.reason,
      ...(v.model ? { model: v.model } : {}),
    })
    score += voteWeight(v.verdict)
    if (v.verdict === 'confirm') confirmedBy += 1
  }
  const polledModels = 1 + verifierVotes.length
  const surfaced = applyAbsenceFloor(score >= polledModels / 2, absence)
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
  verifierVotes: VerifierVote[],
  totalParticipants: number,
  raiserModels?: string[],
  absence?: AbsenceOpts,
): FindingVerification {
  const perModel: FindingVerdict[] = raisers.map((provider, i) => ({
    provider,
    verdict: 'confirm' as const,
    reason: '',
    raised: true,
    // Raiser row carries its model (it raised, didn't verify).
    ...(raiserModels?.[i] ? { model: raiserModels[i] } : {}),
  }))
  let score = raisers.length
  let confirmedBy = raisers.length
  for (const v of verifierVotes) {
    perModel.push({
      provider: v.provider,
      verdict: v.verdict,
      reason: v.reason,
      ...(v.model ? { model: v.model } : {}),
    })
    score += voteWeight(v.verdict)
    if (v.verdict === 'confirm') confirmedBy += 1
  }
  const polledModels = Math.max(totalParticipants, raisers.length + verifierVotes.length)
  const surfaced = applyAbsenceFloor(score >= polledModels / 2, absence)
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
 * A tool-backed check of ONE absence/external-evidence finding (Part B). The
 * caller wires this to the deep toolkit (search_code / find_references /
 * read_file) — it should look for the referenced test/caller/handler and return:
 *   - 'confirm'   the absence genuinely holds (no test/caller/handler found) →
 *                 the finding may surface at full confidence;
 *   - 'refute'    a test/caller/handler WAS found → the absence is false, demote;
 *   - 'uncertain' could not tell (budget exhausted, tools unavailable) → demote.
 * Only 'confirm' positively verifies the absence. The function is GATED and
 * BUDGETED by the caller; crossVerify treats it as opaque and never calls it for
 * 'in-diff' findings. Throwing is treated as 'uncertain' (never blocks).
 */
export type ToolCheckFn = (
  finding: VerifiableFinding,
) => Promise<'confirm' | 'refute' | 'uncertain'>

/**
 * Run cross-model verification over a set of findings.
 *
 * @param findings  the generated findings to verify (already code-anchored).
 * @param generatorProvider  display name / id of the active generator (its
 *   implicit confirm).
 * @param verifiers  verifier provider configs (already excludes the generator).
 * @param verify  injected per-verifier call.
 * @param generatorModel  the generator's model id (for the raiser row).
 * @param toolCheck  optional tool-backed absence check (Part B). When provided,
 *   each finding classified 'needs-external' is checked: only a 'confirm' lets it
 *   surface at full confidence; anything else demotes it. When omitted (no key /
 *   tools unavailable) every needs-external finding falls back to the Part A
 *   prompt floor — demoted unless its absence was positively confirmed, which it
 *   cannot be without a tool, so it is demoted. 'in-diff' findings are unaffected.
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
  generatorModel?: string,
  toolCheck?: ToolCheckFn,
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
    verifiers.map((cfg) => verify(cfg, findings)),
  )

  // Collect per-finding verifier votes; track usage + responders. Votes are
  // pushed in RESPONDER order (matching `responders` below) so the vote index
  // lines up with the responder for decisiveness attribution.
  const votesByFinding = new Map<string, VerifierVote[]>()
  for (const f of findings) votesByFinding.set(f.id, [])

  let usage: LlmUsage | undefined
  const respondedProviders: string[] = []
  const responders: ProviderConfig[] = []
  const perModelUsage: ParticipantUsage[] = []

  results.forEach((res, i) => {
    if (res.status !== 'fulfilled') return // verifier failed → skip its votes
    const cfg = verifiers[i]
    respondedProviders.push(cfg.providerId)
    responders.push(cfg)
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
      votesByFinding.get(f.id)!.push({
        provider: cfg.providerId,
        verdict,
        reason,
        model: cfg.model.id,
      })
    }
  })

  // No verifier responded → leave everything unverified.
  if (respondedProviders.length === 0) return empty

  // Tool-backed absence verification (Part B): for each finding classified as an
  // absence/external-evidence claim, run the caller's tool check (gated/budgeted
  // there). Only a 'confirm' positively verifies the absence and lets the finding
  // surface; anything else (refute/uncertain/no-tool) demotes it. 'in-diff'
  // findings skip the check entirely. Sequential so the caller's shared tool
  // budget is consumed deterministically; a throw is treated as 'uncertain'.
  const toolConfirmedById = new Map<string, boolean>()
  if (toolCheck) {
    for (const f of findings) {
      const claimType = f.claimType ?? classifyClaim(f.body)
      if (claimType !== 'needs-external') continue
      let verdict: 'confirm' | 'refute' | 'uncertain'
      try {
        verdict = await toolCheck(f)
      } catch {
        verdict = 'uncertain'
      }
      toolConfirmedById.set(f.id, verdict === 'confirm')
    }
  }

  const out = new Map<string, FindingVerification>()
  for (const f of findings) {
    const claimType = f.claimType ?? classifyClaim(f.body)
    const absence: AbsenceOpts | undefined =
      claimType === 'needs-external'
        ? { claimType, toolConfirmed: toolConfirmedById.get(f.id) ?? false }
        : undefined
    out.set(f.id, aggregateFinding(generatorProvider, votesByFinding.get(f.id)!, generatorModel, absence))
  }

  // Per-verifier impact (Plan N): confirms/refutes/uncertains + decisive votes.
  const verifierImpact: VerifierImpact[] = responders.map((cfg, idx) => ({
    providerId: cfg.providerId,
    modelId: cfg.model.id,
    confirms: 0,
    refutes: 0,
    uncertains: 0,
    decisive: 0,
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
// using the same comprehensive verify fan-out as crossVerify. A finding only one
// model raised but others CONFIRM now surfaces (the recall win); one others
// refute demotes.
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
 * participants that did NOT raise it verify it (comprehensive prompt); raisers
 * are implicit confirms. Surfaces via aggregateMultiRaiser. Returns merged
 * findings with verification + per-generator impact (surfaced, uniqueCatch).
 *
 * @param merged  the deduped union from mergeGeneratorFindings.
 * @param participants  ALL ensemble participants (each can verify findings it
 *   didn't raise). The total poll size per finding is the participant count.
 * @param verify  injected per-participant verify call (same VerifyFn shape).
 * @param toolCheck  optional tool-backed absence check (Part B) — same gating/
 *   budget contract as crossVerify: a 'needs-external' merged finding only
 *   surfaces at full confidence when its absence is positively confirmed;
 *   otherwise it is demoted. 'in-diff' findings are unaffected. Omitted (no key /
 *   tools off) → needs-external findings fall back to the Part A prompt floor.
 */
export async function fuseConfirm(
  merged: MergedFinding[],
  participants: { generator: string; cfg: ProviderConfig }[],
  verify: VerifyFn,
  toolCheck?: ToolCheckFn,
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
    participants.map((p) => verify(p.cfg, merged.map((m) => m.finding))),
  )

  // votesByFinding[mergedId] = verifier votes from NON-raisers that responded.
  const votesByFinding = new Map<string, VerifierVote[]>()
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
      votesByFinding.get(m.id)!.push({
        provider: p.cfg.providerId,
        verdict,
        reason,
        model: p.cfg.model.id,
      })
    }
  })

  if (respondedProviders.length === 0) return empty

  // Tool-backed absence verification (Part B) for needs-external merged findings.
  const toolConfirmedById = new Map<string, boolean>()
  if (toolCheck) {
    for (const m of merged) {
      const claimType = m.finding.claimType ?? classifyClaim(m.finding.body)
      if (claimType !== 'needs-external') continue
      let verdict: 'confirm' | 'refute' | 'uncertain'
      try {
        verdict = await toolCheck(m.finding)
      } catch {
        verdict = 'uncertain'
      }
      toolConfirmedById.set(m.id, verdict === 'confirm')
    }
  }

  const scored = merged.map((m) => {
    const claimType = m.finding.claimType ?? classifyClaim(m.finding.body)
    const absence: AbsenceOpts | undefined =
      claimType === 'needs-external'
        ? { claimType, toolConfirmed: toolConfirmedById.get(m.id) ?? false }
        : undefined
    return {
      merged: m,
      verification: aggregateMultiRaiser(
        m.raisedBy,
        votesByFinding.get(m.id)!,
        totalParticipants,
        m.raiserCfgs.map((c) => c.model.id),
        absence,
      ),
    }
  })

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
