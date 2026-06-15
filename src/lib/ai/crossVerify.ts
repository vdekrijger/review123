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
 * throws (a failing verifier is skipped — its vote omitted, never blocks).
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

export interface CrossVerifyOutcome {
  /** Per-finding verification keyed by finding id. Empty when no verifier ran. */
  byId: Map<string, FindingVerification>
  /** Summed verifier usage (for token-cost totals). */
  usage: LlmUsage | undefined
  /** Verifier providers that actually responded (for the progress line). */
  respondedProviders: string[]
}

// ---------------------------------------------------------------------------
// Adversarial verify prompt
// ---------------------------------------------------------------------------

export function buildVerifyPrompt(findings: VerifiableFinding[]): {
  system: string
  user: string
} {
  const system = `You are an ADVERSARIAL verifier auditing another AI reviewer's findings on a \
pull request. For EACH finding, decide whether it is a REAL, code-grounded issue worth \
surfacing to a human reviewer — or noise.

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
): Promise<CrossVerifyOutcome> {
  if (findings.length === 0 || verifiers.length === 0) {
    return { byId: new Map(), usage: undefined, respondedProviders: [] }
  }

  const results = await Promise.allSettled(
    verifiers.map((cfg) => verify(cfg, findings)),
  )

  // Collect per-finding verifier votes; track usage + responders.
  const votesByFinding = new Map<
    string,
    { provider: string; verdict: 'confirm' | 'refute' | 'uncertain'; reason: string }[]
  >()
  for (const f of findings) votesByFinding.set(f.id, [])

  let usage: LlmUsage | undefined
  const respondedProviders: string[] = []

  results.forEach((res, i) => {
    if (res.status !== 'fulfilled') return // verifier failed → skip its votes
    const cfg = verifiers[i]
    respondedProviders.push(cfg.providerId)
    usage = sumUsage(usage, res.value.usage)
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
  if (respondedProviders.length === 0) {
    return { byId: new Map(), usage: undefined, respondedProviders: [] }
  }

  const out = new Map<string, FindingVerification>()
  for (const f of findings) {
    out.set(f.id, aggregateFinding(generatorProvider, votesByFinding.get(f.id)!))
  }
  return { byId: out, usage, respondedProviders }
}
